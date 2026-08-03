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
    this.embeddingExcludedTypes = new Set(config.embeddingExcludedTypes || []);
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
        if (!this.store.insertAlias({
          entityType: type, aliasNormalized: normalizedProposed,
          canonicalName: entity.name, canonicalId: entity.id, source: 'auto'
        })) {
          console.error(`[ERROR] entityResolver: Alias "${normalizedProposed}" -> "${entity.name}" (${type}) konnte nicht gespeichert werden - Zuordnung wird fuer dieses Dokument angewendet, aber nicht gelernt; der naechste Lauf ermittelt die Zuordnung erneut ueber die Normalisierung statt ueber den Alias-Cache`);
        }
        return { action: 'map', id: entity.id, canonicalName: entity.name, via: 'normalized' };
      }
    }

    // Stufe 4: kombinierte Kandidatenauswahl. combinedScore = max(trigram, embedding)
    // pro Bestandsentitaet waehlt den Kandidaten, unabhaengig davon, welcher Kanal ihn
    // erkennt. Die Entscheidung darunter prueft dagegen den rohen Wert jedes Kanals
    // gegen dessen EIGENEN Schwellwert - Cosine-Aehnlichkeit und Dice-Koeffizient liegen
    // nicht auf derselben Skala, ein gemeinsamer Schwellwert auf dem Max-Wert waere
    // statistisch nicht belastbar (siehe Design-Doc Phase 4).
    const embeddingActiveForType = this.embeddingEnabled && !this.embeddingExcludedTypes.has(type);

    let proposedVector = null;
    if (embeddingActiveForType) {
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
        bestTrigram = { entity, trigramSim, embeddingSim };
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
      if (!this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: bestTrigram.entity.name, canonicalId: bestTrigram.entity.id, source: 'auto'
      })) {
        console.error(`[ERROR] entityResolver: Alias "${normalizedProposed}" -> "${bestTrigram.entity.name}" (${type}) konnte nicht gespeichert werden - Zuordnung wird fuer dieses Dokument angewendet, aber nicht gelernt; der naechste Lauf wiederholt Trigram/Judge fuer diesen Namen`);
      }
      return { action: 'map', id: bestTrigram.entity.id, canonicalName: bestTrigram.entity.name, via: 'similarity' };
    }

    // Negativ-Cache geht auch dem Embedding-Auto-Merge und dem Judge vor. findRejectedPair
    // vergleicht normalisiert, damit Gross-/Kleinschreibung oder Whitespace-Varianten des
    // Paars denselben Cache-Treffer liefern (siehe entityStore.js).
    const normalizedCandidate = normalizeForType(best.entity.name, type);
    const bestRejected = this.store.findRejectedPair(type, normalizedProposed, normalizedCandidate);

    if (!bestRejected && best.embeddingSim !== null && best.embeddingSim >= this.embedAutoThreshold) {
      if (!this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'auto_embedding'
      })) {
        console.error(`[ERROR] entityResolver: Alias "${normalizedProposed}" -> "${best.entity.name}" (${type}) konnte nicht gespeichert werden - Zuordnung wird fuer dieses Dokument angewendet, aber nicht gelernt; der naechste Lauf wiederholt Trigram/Judge fuer diesen Namen`);
      }
      return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'embedding_similarity' };
    }

    // Dieselbe Vorrangregel wie beim Auto-Merge, nur eine Stufe tiefer: qualifiziert sich
    // bestTrigram schon per reiner Trigram-Aehnlichkeit fuer die Judge-Zone, wird der Judge
    // zu genau diesem Kandidaten gefragt. Sonst koennte ein orthografisch fernes, aber
    // semantisch nahes "false friend" mit hoeherem kombinierten Score dem Kandidaten den
    // Judge-Call wegnehmen, den Phase 3 (vor Embeddings) vorgelegt haette.
    // Jeder Kandidat wird gegen seinen EIGENEN Negativ-Cache-Eintrag geprueft - beide
    // koennen verschiedene Entitaeten sein, eine Ablehnung des einen Paars darf die
    // Bewertung des anderen nicht blockieren.
    let judgeCandidate = null;
    if (bestTrigram.trigramSim >= this.judgeMin) {
      // Gleiche Entitaet wie best (Normalfall)? Dann den obigen Cache-Lookup wiederverwenden.
      const trigramRejected = bestTrigram.entity.id === best.entity.id
        ? bestRejected
        : this.store.findRejectedPair(type, normalizedProposed, normalizeForType(bestTrigram.entity.name, type));
      if (!trigramRejected) {
        judgeCandidate = bestTrigram;
      }
    }
    if (!judgeCandidate && !bestRejected && best.embeddingSim !== null && best.embeddingSim >= this.embedJudgeMin) {
      judgeCandidate = best;
    }

    if (!judgeCandidate) {
      // Stufe 4b/4d/5: Negativ-Cache-Treffer oder unter beiden Judge-Schwellen
      return { action: 'create' };
    }

    const candidateEntity = judgeCandidate.entity;
    const candidateCombined = Math.max(judgeCandidate.trigramSim, judgeCandidate.embeddingSim ?? -1);
    const verdict = await this._askJudge(type, proposedName, candidateEntity.name);

    if (verdict.verdict === 'same') {
      if (!this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: candidateEntity.name, canonicalId: candidateEntity.id, source: 'llm'
      })) {
        console.error(`[ERROR] entityResolver: Alias "${normalizedProposed}" -> "${candidateEntity.name}" (${type}) konnte nicht gespeichert werden - Zuordnung wird fuer dieses Dokument angewendet, aber nicht gelernt; der naechste Lauf ruft erneut den Judge auf`);
      }
      return { action: 'map', id: candidateEntity.id, canonicalName: candidateEntity.name, via: 'llm' };
    }

    if (verdict.verdict === 'different') {
      if (!this.store.insertQueueEntry({
        entityType: type, proposedName, proposedId: null,
        candidateName: candidateEntity.name, candidateId: candidateEntity.id,
        similarity: candidateCombined,
        trigramSimilarity: judgeCandidate.trigramSim, embeddingSimilarity: judgeCandidate.embeddingSim,
        llmVerdict: 'different', llmReason: verdict.reason,
        status: 'rejected'
      })) {
        console.error(`[ERROR] entityResolver: Ablehnung von "${proposedName}" vs. "${candidateEntity.name}" (${type}) konnte nicht in den Negativ-Cache geschrieben werden - ein spaeterer Lauf mit hoher Trigram-Aehnlichkeit koennte dieses Paar faelschlich automatisch zusammenfuehren`);
      }
      return { action: 'create' };
    }

    // 'unsure': proposed_id ist hier noch unbekannt, der Resolver legt nichts an.
    // Der Aufrufer ruft nach dem tatsaechlichen Anlegen recordCreatedAndQueued auf.
    return {
      action: 'create_and_queue',
      candidate: { id: candidateEntity.id, name: candidateEntity.name },
      similarity: candidateCombined,
      trigramSimilarity: judgeCandidate.trigramSim,
      embeddingSimilarity: judgeCandidate.embeddingSim,
      verdict: verdict.verdict
    };
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
    if (!this.store.insertQueueEntry({
      entityType: type, proposedName, proposedId,
      candidateName: candidate.name, candidateId: candidate.id,
      similarity, trigramSimilarity, embeddingSimilarity,
      llmVerdict: verdict, llmReason: null,
      status: 'open', documentId
    })) {
      console.error(`[ERROR] entityResolver: Neu angelegte Entitaet "${proposedName}" (${type}, id=${proposedId}) konnte nicht in die Review-Queue eingetragen werden - sie erscheint nie zur Pruefung, obwohl sie als "unsure" markiert war`);
    }
  }
}

module.exports = EntityResolver;
