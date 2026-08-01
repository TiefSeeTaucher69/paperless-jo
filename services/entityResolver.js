// services/entityResolver.js
const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityResolver {
  constructor({ store, judge, config = {} }) {
    this.store = store;
    this.judge = judge; // async (type, nameA, nameB) => { verdict, reason }
    this.autoThreshold = config.autoThreshold ?? 0.90;
    this.judgeMin = config.judgeMin ?? 0.65;
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

    // Stufe 4: Ähnlichkeit gegen den besten Kandidaten
    let best = null;
    for (const entity of existingEntities) {
      const sim = diceCoefficient(normalizedProposed, normalizeForType(entity.name, type));
      if (!best || sim > best.similarity) {
        best = { entity, similarity: sim };
      }
    }

    if (!best) {
      return { action: 'create' };
    }

    // Negativ-Cache geht sowohl 4a als auch 4c vor. findRejectedPair vergleicht
    // normalisiert, damit Gross-/Kleinschreibung oder Whitespace-Varianten des
    // Paars denselben Cache-Treffer liefern (siehe entityStore.js).
    const normalizedCandidate = normalizeForType(best.entity.name, type);
    const rejected = this.store.findRejectedPair(type, normalizedProposed, normalizedCandidate);

    if (best.similarity >= this.autoThreshold) {
      if (rejected) {
        return { action: 'create' }; // Stufe 4b: Nutzerentscheidung uebersticht hohe Aehnlichkeit
      }
      this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'auto'
      });
      return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'similarity' };
    }

    if (rejected) {
      return { action: 'create' };
    }

    if (best.similarity >= this.judgeMin) {
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
          similarity: best.similarity, llmVerdict: 'different', llmReason: verdict.reason,
          status: 'rejected'
        });
        return { action: 'create' };
      }

      // 'unsure': proposed_id ist hier noch unbekannt, der Resolver legt nichts an.
      // Der Aufrufer ruft nach dem tatsaechlichen Anlegen recordCreatedAndQueued auf.
      return {
        action: 'create_and_queue',
        candidate: { id: best.entity.id, name: best.entity.name },
        similarity: best.similarity,
        verdict: verdict.verdict
      };
    }

    // Stufe 4d
    return { action: 'create' };
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

  recordCreatedAndQueued({ type, proposedName, proposedId, candidate, similarity, verdict, documentId }) {
    this.store.insertQueueEntry({
      entityType: type, proposedName, proposedId,
      candidateName: candidate.name, candidateId: candidate.id,
      similarity, llmVerdict: verdict, llmReason: null,
      status: 'open', documentId
    });
  }
}

module.exports = EntityResolver;
