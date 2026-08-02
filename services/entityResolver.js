// services/entityResolver.js
const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityResolver {
  constructor({ store, judge, embeddingService = null, config = {} }) {
    this.store = store;
    this.judge = judge; // async (type, nameA, nameB) => { verdict, reason }
    this.embeddingService = embeddingService; // { embed, cosineSimilarity, getOrComputeEmbedding }
    this.autoThreshold = config.autoThreshold ?? 0.90;
    this.judgeMin = config.judgeMin ?? 0.65;
    this.embeddingEnabled = Boolean(config.embeddingEnabled) && Boolean(embeddingService);
    this.embedAutoThreshold = config.embedAutoThreshold ?? 0.90;
    this.embedJudgeMin = config.embedJudgeMin ?? 0.65;
  }

  async resolve(type, proposedName, existingEntities) {
    if (!proposedName || !proposedName.trim()) {
      return { action: 'skip' };
    }

    const normalizedProposed = normalizeForType(proposedName, type);

    // Stufe 1: Alias-Tabelle
    const alias = this.store.findAlias(type, normalizedProposed);
    if (alias) {
      const stillExists = existingEntities.some(e => e.id === alias.canonical_id);
      if (stillExists) {
        return { action: 'map', id: alias.canonical_id, canonicalName: alias.canonical_name, via: 'alias' };
      }
      // Fehlerverhalten: Alias zeigt ins Leere -> verwerfen und neu entscheiden
      console.warn(`[WARNING] entityResolver: Alias "${normalizedProposed}" (${type}) zeigt auf geloeschte ID ${alias.canonical_id}, wird verworfen`);
      this.store.deleteAlias(type, normalizedProposed);
    }

    // Stufe 2: exakter Treffer (heutiges Verhalten)
    const exact = existingEntities.find(e => e.name.toLowerCase() === proposedName.toLowerCase());
    if (exact) {
      return { action: 'map', id: exact.id, canonicalName: exact.name, via: 'exact' };
    }

    // Stufe 3: normalisierter Treffer
    for (const entity of existingEntities) {
      if (normalizeForType(entity.name, type) === normalizedProposed) {
        this.store.insertAlias({
          entityType: type, aliasNormalized: normalizedProposed,
          canonicalName: entity.name, canonicalId: entity.id, source: 'auto'
        });
        return { action: 'map', id: entity.id, canonicalName: entity.name, via: 'normalized' };
      }
    }

    // Stufe 4: kombinierte Kandidatenauswahl. combinedScore = max(trigram, embedding)
    // pro Bestandsentitaet waehlt den Kandidaten, unabhaengig davon, welcher Kanal ihn
    // erkennt. Die Entscheidung darunter prueft dagegen den rohen Wert jedes Kanals
    // gegen dessen EIGENEN Schwellwert - Cosine-Aehnlichkeit und Dice-Koeffizient liegen
    // nicht auf derselben Skala, ein gemeinsamer Schwellwert auf dem Max-Wert waere
    // statistisch nicht belastbar (siehe Design-Doc Phase 4).
    let proposedVector = null;
    if (this.embeddingEnabled) {
      try {
        proposedVector = await this.embeddingService.embed(proposedName);
      } catch (error) {
        console.warn(`[WARNING] entityResolver: Embedding fuer Vorschlag "${proposedName}" nicht berechenbar, faellt auf Trigram-only zurueck:`, error.message);
        proposedVector = null;
      }
    }

    let best = null;
    let bestTrigram = null;
    for (const entity of existingEntities) {
      const trigramSim = diceCoefficient(normalizedProposed, normalizeForType(entity.name, type));
      const embeddingSim = await this._embeddingSimilarityFor(type, proposedVector, entity);
      const combined = Math.max(trigramSim, embeddingSim ?? -1);

      if (!best || combined > best.combined) {
        best = { entity, trigramSim, embeddingSim, combined };
      }
      if (!bestTrigram || trigramSim > bestTrigram.trigramSim) {
        bestTrigram = { entity, trigramSim };
      }
    }

    if (!best) {
      return { action: 'create' };
    }

    // Trigram-Treffer gehen unveraendert vor: reicht die reine Trigram-Aehnlichkeit
    // irgendeines Kandidaten fuer sich genommen schon fuer Auto-Merge, entscheidet
    // das wie vor Phase 4 - unabhaengig davon, ob ein anderer Kandidat per Embedding
    // einen hoeheren kombinierten Score haette. Sonst koennte ein orthografisch
    // fernes, aber semantisch nahes "false friend" einen bereits sicheren
    // Trigram-Match verdraengen.
    if (bestTrigram.trigramSim >= this.autoThreshold) {
      const normalizedTrigramCandidate = normalizeForType(bestTrigram.entity.name, type);
      const rejectedTrigram = this.store.findRejectedPair(type, normalizedProposed, normalizedTrigramCandidate);
      if (rejectedTrigram) {
        return { action: 'create' }; // Stufe 4b: Nutzerentscheidung uebersticht hohe Aehnlichkeit
      }
      this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: bestTrigram.entity.name, canonicalId: bestTrigram.entity.id, source: 'auto'
      });
      return { action: 'map', id: bestTrigram.entity.id, canonicalName: bestTrigram.entity.name, via: 'similarity' };
    }

    // Negativ-Cache geht auch dem Embedding-Auto-Merge und dem Judge vor. findRejectedPair
    // vergleicht normalisiert, damit Gross-/Kleinschreibung oder Whitespace-Varianten des
    // Paars denselben Cache-Treffer liefern (siehe entityStore.js).
    const normalizedCandidate = normalizeForType(best.entity.name, type);
    const rejected = this.store.findRejectedPair(type, normalizedProposed, normalizedCandidate);

    if (!rejected && best.embeddingSim !== null && best.embeddingSim >= this.embedAutoThreshold) {
      this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'auto_embedding'
      });
      return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'embedding_similarity' };
    }

    if (rejected) {
      return { action: 'create' };
    }

    const reachesJudgeZone = best.trigramSim >= this.judgeMin
      || (best.embeddingSim !== null && best.embeddingSim >= this.embedJudgeMin);

    if (reachesJudgeZone) {
      const verdict = await this._askJudge(type, proposedName, best.entity.name);

      if (verdict.verdict === 'same') {
        this.store.insertAlias({
          entityType: type, aliasNormalized: normalizedProposed,
          canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'llm'
        });
        return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'llm' };
      }

      if (verdict.verdict === 'different') {
        this.store.insertQueueEntry({
          entityType: type, proposedName, proposedId: null,
          candidateName: best.entity.name, candidateId: best.entity.id,
          similarity: best.combined, trigramSimilarity: best.trigramSim, embeddingSimilarity: best.embeddingSim,
          llmVerdict: 'different', llmReason: verdict.reason,
          status: 'rejected'
        });
        return { action: 'create' };
      }

      // 'unsure': proposed_id ist hier noch unbekannt, der Resolver legt nichts an.
      // Der Aufrufer ruft nach dem tatsaechlichen Anlegen recordCreatedAndQueued auf.
      return {
        action: 'create_and_queue',
        candidate: { id: best.entity.id, name: best.entity.name },
        similarity: best.combined,
        trigramSimilarity: best.trigramSim,
        embeddingSimilarity: best.embeddingSim,
        verdict: verdict.verdict
      };
    }

    // Stufe 4d/5: unter beiden Judge-Schwellen
    return { action: 'create' };
  }

  async _embeddingSimilarityFor(type, proposedVector, entity) {
    if (!proposedVector) {
      return null;
    }
    try {
      const entityVector = await this.embeddingService.getOrComputeEmbedding(this.store, type, entity);
      const similarity = this.embeddingService.cosineSimilarity(proposedVector, entityVector);
      return Number.isFinite(similarity) ? similarity : null;
    } catch (error) {
      console.warn(`[WARNING] entityResolver: Embedding-Aehnlichkeit fuer "${entity.name}" (${type}) nicht berechenbar, wird ignoriert:`, error.message);
      return null;
    }
  }

  async _askJudge(type, nameA, nameB) {
    try {
      const result = await this.judge(type, nameA, nameB);
      if (!result || !['same', 'different', 'unsure'].includes(result.verdict)) {
        return { verdict: 'unsure', reason: 'ungueltige oder leere Judge-Antwort' };
      }
      return result;
    } catch (error) {
      console.warn(`[WARNING] entityResolver: Judge nicht erreichbar fuer "${nameA}" vs "${nameB}", werte als unsure:`, error.message);
      return { verdict: 'unsure', reason: `judge nicht erreichbar: ${error.message}` };
    }
  }

  recordCreatedAndQueued({ type, proposedName, proposedId, candidate, similarity, trigramSimilarity = null, embeddingSimilarity = null, verdict, documentId }) {
    this.store.insertQueueEntry({
      entityType: type, proposedName, proposedId,
      candidateName: candidate.name, candidateId: candidate.id,
      similarity, trigramSimilarity, embeddingSimilarity,
      llmVerdict: verdict, llmReason: null,
      status: 'open', documentId
    });
  }
}

module.exports = EntityResolver;
