const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityBackfillService {
  constructor({ store, judgeMin, embeddingService = null, embeddingEnabled = false, embedJudgeMin = 0.65, excludedTypes = [] }) {
    this.store = store;
    this.judgeMin = judgeMin;
    this.embeddingService = embeddingService;
    this.embeddingEnabled = Boolean(embeddingEnabled) && Boolean(embeddingService);
    this.embedJudgeMin = embedJudgeMin;
    this.excludedTypes = new Set(excludedTypes);
  }

  async run(entityType, existingEntities) {
    let inserted = 0;
    const embeddingActiveForType = this.embeddingEnabled && !this.excludedTypes.has(entityType);

    // Embeddings werden VOR der quadratischen Vergleichsschleife einmal pro Entitaet
    // vorgezogen (Cache-Treffer oder ein Call), damit die eigentliche Paarvergleichsschleife
    // ohne weitere Ollama-Calls auskommt - sonst waere jedes Paar ein eigener Call.
    const vectors = new Map();
    if (embeddingActiveForType) {
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

        // Bevorzugt die Seite mit mehr Dokumenten als kanonisch (3.1/B-3) - ein Merge in die
        // falsche Richtung loescht sonst die etablierte Variante zugunsten einer kaum genutzten,
        // z.B. "Zeugnis" (5 Dokumente) haette "Zeugniss" (0 Dokumente) verloren, weil Zeugniss
        // die kleinere id hatte. Bei Gleichstand (typischerweise 0 = 0, oder wenn der Aufrufer
        // eine Liste ohne document_count uebergibt) faellt der Tiebreak auf die aeltere
        // (kleinere) id zurueck, wie bisher.
        const countA = a.document_count ?? 0;
        const countB = b.document_count ?? 0;
        const [candidate, proposed] = countA !== countB
          ? (countA > countB ? [a, b] : [b, a])
          : (a.id < b.id ? [a, b] : [b, a]);

        const normalizedCandidate = normalizeForType(candidate.name, entityType);
        const normalizedProposed = normalizeForType(proposed.name, entityType);
        const trigramSim = diceCoefficient(normalizedCandidate, normalizedProposed);

        let embeddingSim = null;
        if (vectors.has(candidate.id) && vectors.has(proposed.id)) {
          const sim = this.embeddingService.cosineSimilarity(vectors.get(candidate.id), vectors.get(proposed.id));
          embeddingSim = Number.isFinite(sim) ? sim : null;
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
          similarity: trigramSim, // AUDIT-029: einheitliche Skala statt Dice/Cosinus-Mischwert; siehe entityResolver.js
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
