const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityBackfillService {
  constructor({ store, judgeMin, embeddingService = null, embeddingEnabled = false, embedJudgeMin = 0.65 }) {
    this.store = store;
    this.judgeMin = judgeMin;
    this.embeddingService = embeddingService;
    this.embeddingEnabled = Boolean(embeddingEnabled) && Boolean(embeddingService);
    this.embedJudgeMin = embedJudgeMin;
  }

  async run(entityType, existingEntities) {
    let inserted = 0;

    // Embeddings werden VOR der quadratischen Vergleichsschleife einmal pro Entitaet
    // vorgezogen (Cache-Treffer oder ein Call), damit die eigentliche Paarvergleichsschleife
    // ohne weitere Ollama-Calls auskommt - sonst waere jedes Paar ein eigener Call.
    const vectors = new Map();
    if (this.embeddingEnabled) {
      for (const entity of existingEntities) {
        try {
          const vector = await this.embeddingService.getOrComputeEmbedding(this.store, entityType, entity);
          vectors.set(entity.id, vector);
        } catch (error) {
          console.warn(`[WARNING] entityBackfillService: Embedding fuer "${entity.name}" (${entityType}) nicht berechenbar, wird ignoriert:`, error.message);
        }
      }
    }

    for (let i = 0; i < existingEntities.length; i++) {
      for (let j = i + 1; j < existingEntities.length; j++) {
        const a = existingEntities[i];
        const b = existingEntities[j];

        // Aeltere (kleinere) id gilt als kanonisch, die neuere als moeglicher Dublette-Kandidat -
        // dieselbe Richtung, die auch der Live-Pfad fuer Merge annimmt (proposed -> candidate).
        const [candidate, proposed] = a.id < b.id ? [a, b] : [b, a];

        const normalizedCandidate = normalizeForType(candidate.name, entityType);
        const normalizedProposed = normalizeForType(proposed.name, entityType);
        const trigramSim = diceCoefficient(normalizedCandidate, normalizedProposed);

        let embeddingSim = null;
        if (vectors.has(candidate.id) && vectors.has(proposed.id)) {
          embeddingSim = this.embeddingService.cosineSimilarity(vectors.get(candidate.id), vectors.get(proposed.id));
        }

        const reachesThreshold = trigramSim >= this.judgeMin
          || (embeddingSim !== null && embeddingSim >= this.embedJudgeMin);
        if (!reachesThreshold) {
          continue;
        }
        // Ueberspringt jedes bereits existierende Paar (egal ob open/merged/rejected) - verhindert,
        // dass ein erneuter Backfill-Lauf ein echtes LLM-Urteil auf noch offenen Eintraegen ueberschreibt.
        if (this.store.findQueueEntryPair(entityType, normalizedProposed, normalizedCandidate)) {
          continue;
        }

        const written = this.store.insertQueueEntry({
          entityType,
          proposedName: proposed.name,
          proposedId: proposed.id,
          candidateName: candidate.name,
          candidateId: candidate.id,
          similarity: Math.max(trigramSim, embeddingSim ?? -1),
          trigramSimilarity: trigramSim,
          embeddingSimilarity: embeddingSim,
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
