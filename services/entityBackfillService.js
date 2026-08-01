const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityBackfillService {
  constructor({ store, judgeMin }) {
    this.store = store;
    this.judgeMin = judgeMin;
  }

  run(entityType, existingEntities) {
    let inserted = 0;

    for (let i = 0; i < existingEntities.length; i++) {
      for (let j = i + 1; j < existingEntities.length; j++) {
        const a = existingEntities[i];
        const b = existingEntities[j];

        // Aeltere (kleinere) id gilt als kanonisch, die neuere als moeglicher Dublette-Kandidat -
        // dieselbe Richtung, die auch der Live-Pfad fuer Merge annimmt (proposed -> candidate).
        const [candidate, proposed] = a.id < b.id ? [a, b] : [b, a];

        const normalizedCandidate = normalizeForType(candidate.name, entityType);
        const normalizedProposed = normalizeForType(proposed.name, entityType);
        const similarity = diceCoefficient(normalizedCandidate, normalizedProposed);

        if (similarity < this.judgeMin) {
          continue;
        }
        if (this.store.findRejectedPair(entityType, normalizedProposed, normalizedCandidate)) {
          continue;
        }

        const written = this.store.insertQueueEntry({
          entityType,
          proposedName: proposed.name,
          proposedId: proposed.id,
          candidateName: candidate.name,
          candidateId: candidate.id,
          similarity,
          llmVerdict: null,
          llmReason: null,
          status: 'open',
          documentId: null
        });
        if (written) inserted++;
      }
    }

    return { inserted };
  }
}

module.exports = EntityBackfillService;
