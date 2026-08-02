// services/documentFingerprintService.js

// Nur ein struktureller Fingerabdruck noetig, kein vollstaendiges Verstaendnis -
// deutlich kuerzer als die 50000 Zeichen vor dem eigentlichen LLM-Klassifikationscall.
const FINGERPRINT_CONTENT_CHARS = 3000;

function truncate(content) {
  return (content || '').slice(0, FINGERPRINT_CONTENT_CHARS);
}

class DocumentFingerprintService {
  constructor({ store, embeddingService, similarityThreshold = 0.90, model }) {
    this.store = store;
    this.embeddingService = embeddingService;
    this.similarityThreshold = similarityThreshold;
    this.model = model;
    this._lastEmbeddedText = null;
    this._lastEmbedding = null;
  }

  // Ein-Slot-Memo: findMatch und recordFingerprint werden pro Dokument direkt
  // hintereinander mit demselben content aufgerufen - das waeren sonst zwei
  // identische Ollama-Calls.
  async _embed(content) {
    const text = truncate(content);
    if (this._lastEmbeddedText === text) {
      return this._lastEmbedding;
    }
    const vector = await this.embeddingService.embed(text);
    this._lastEmbeddedText = text;
    this._lastEmbedding = vector;
    return vector;
  }

  async findMatch(correspondentId, content) {
    const candidates = this.store.findCandidates(correspondentId);
    if (candidates.length === 0) {
      return null;
    }

    let vector;
    try {
      vector = await this._embed(content);
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Embedding fehlgeschlagen, kein Treffer:', error.message);
      return null;
    }

    let best = null;
    for (const candidate of candidates) {
      // Ein mit einem anderen (oder vor dieser Migration gar keinem) Modell erzeugter
      // Vektor liegt in einem fremden Vektorraum - er darf gar nicht erst am
      // Aehnlichkeitsvergleich teilnehmen.
      if (candidate.model !== this.model) {
        continue;
      }
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
      const vector = await this._embed(content);
      this.store.upsertFingerprint({ documentId, correspondentId, documentTypeId, tagIds, embedding: vector, model: this.model });
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Fingerprint konnte nicht gespeichert werden:', error.message);
    }
  }
}

module.exports = DocumentFingerprintService;
