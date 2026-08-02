// services/documentFingerprintService.js

// Nur ein struktureller Fingerabdruck noetig, kein vollstaendiges Verstaendnis -
// deutlich kuerzer als die 50000 Zeichen vor dem eigentlichen LLM-Klassifikationscall.
const FINGERPRINT_CONTENT_CHARS = 3000;

function truncate(content) {
  return (content || '').slice(0, FINGERPRINT_CONTENT_CHARS);
}

class DocumentFingerprintService {
  constructor({ store, embeddingService, similarityThreshold = 0.90 }) {
    this.store = store;
    this.embeddingService = embeddingService;
    this.similarityThreshold = similarityThreshold;
  }

  async findMatch(correspondentId, content) {
    const candidates = this.store.findCandidates(correspondentId);
    if (candidates.length === 0) {
      return null;
    }

    let vector;
    try {
      vector = await this.embeddingService.embed(truncate(content));
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Embedding fehlgeschlagen, kein Treffer:', error.message);
      return null;
    }

    let best = null;
    for (const candidate of candidates) {
      const similarity = this.embeddingService.cosineSimilarity(vector, candidate.embedding);
      if (Number.isFinite(similarity) && (!best || similarity > best.similarity)) {
        best = { similarity, candidate };
      }
    }

    if (!best || best.similarity < this.similarityThreshold) {
      return null;
    }

    console.log(`[INFO] documentFingerprintService: Treffer fuer correspondent=${correspondentId}, similarity=${best.similarity.toFixed(3)}, document_id=${best.candidate.documentId}`);
    return { tagIds: best.candidate.tagIds, documentTypeId: best.candidate.documentTypeId };
  }

  async recordFingerprint({ documentId, correspondentId, documentTypeId, tagIds, content }) {
    try {
      const vector = await this.embeddingService.embed(truncate(content));
      this.store.upsertFingerprint({ documentId, correspondentId, documentTypeId, tagIds, embedding: vector });
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Fingerprint konnte nicht gespeichert werden:', error.message);
    }
  }
}

module.exports = DocumentFingerprintService;
