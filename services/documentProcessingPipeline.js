// services/documentProcessingPipeline.js
//
// Ersetzt die zuvor vierfach wortgleich kopierte Verdrahtung aus applyDocumentFingerprint /
// saveDocumentChanges / recordDocumentFingerprint / getDocumentFingerprintService, die in
// server.js (2x) und routes/setup.js (2x) stand (AUDIT-014). Ueber require()-Caching liefert
// getInstance() aus beiden Dateien dieselbe Modulinstanz und damit einen einzigen
// DocumentFingerprintService/eine einzige SQLite-Verbindung statt zuvor zwei.

class DocumentProcessingPipeline {
  constructor({ paperlessService, documentModel, documentFingerprintService, config }) {
    this.paperlessService = paperlessService;
    this.documentModel = documentModel;
    this.documentFingerprintService = documentFingerprintService;
    this.config = config;
  }

  async applyDocumentFingerprint(doc, updateData, content, correspondentId) {
    if (!this.config.documentFingerprint.enabled || !correspondentId || !this.documentFingerprintService) {
      return;
    }
    try {
      const match = await this.documentFingerprintService.findMatch(correspondentId, content);
      if (!match) {
        return;
      }
      // Respektiert dieselben Aktivierungs-Schalter wie buildUpdateData selbst - ein per
      // activateTagging='no'/activateDocumentType='no' abgeschaltetes Feld darf der
      // Fingerprint nicht wieder anschalten.
      if (this.config.limitFunctions?.activateTagging !== 'no') {
        updateData.tags = match.tagIds;
      }
      if (this.config.limitFunctions?.activateDocumentType !== 'no' && match.documentTypeId) {
        updateData.document_type = match.documentTypeId;
      }
    } catch (error) {
      console.warn('[WARNING] documentProcessingPipeline.applyDocumentFingerprint: Fingerprint-Check fehlgeschlagen, Klassifikation laeuft ohne ihn weiter:', error.message);
    }
  }

  async recordDocumentFingerprint(doc, correspondentId, documentTypeId, tagIds, content) {
    if (!this.config.documentFingerprint.enabled || !correspondentId || !this.documentFingerprintService) {
      return;
    }
    try {
      await this.documentFingerprintService.recordFingerprint({
        documentId: doc.id,
        correspondentId,
        documentTypeId: documentTypeId ?? null,
        tagIds: tagIds ?? [],
        content
      });
    } catch (error) {
      console.warn('[WARNING] documentProcessingPipeline.recordDocumentFingerprint: Fingerprint konnte nicht gespeichert werden:', error.message);
    }
  }

  // AUDIT-004: der PATCH nach Paperless muss zuerst und fuer sich stehen. updateDocument()
  // wirft jetzt statt still null zurueckzugeben (services/paperlessService.js) - schlaegt er
  // fehl, duerfen addProcessedDocument/addOpenAIMetrics/addToHistory nicht laufen, sonst gilt
  // ein nie geschriebenes Dokument als erledigt und wird von isDocumentProcessed() beim
  // naechsten Scan uebersprungen, ohne dass der Fehler je sichtbar wird.
  async saveDocumentChanges(docId, updateData, analysis, originalData) {
    const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;

    await this.documentModel.saveOriginalData(docId, originalTags, originalCorrespondent, originalTitle);
    const updatedDoc = await this.paperlessService.updateDocument(docId, updateData);

    await Promise.all([
      this.documentModel.addProcessedDocument(docId, updateData.title),
      this.documentModel.addOpenAIMetrics(
        docId,
        analysis.metrics.promptTokens,
        analysis.metrics.completionTokens,
        analysis.metrics.totalTokens
      ),
      this.documentModel.addToHistory(docId, updateData.tags, updateData.title, analysis.document.correspondent)
    ]);

    return updatedDoc;
  }

  // recordDocumentFingerprint laeuft nur, wenn saveDocumentChanges nicht wirft - sonst wuerde
  // ein Dokument, dessen PATCH fehlgeschlagen ist, trotzdem einen Fingerprint bekommen, der beim
  // naechsten aehnlichen Dokument Tags anwendet, die nie in Paperless ankamen (AUDIT-004).
  async processAndSave({ doc, updateData, analysis, originalData, content, correspondentId }) {
    await this.applyDocumentFingerprint(doc, updateData, content, correspondentId);
    const updatedDoc = await this.saveDocumentChanges(doc.id, updateData, analysis, originalData);
    // AUDIT-011: updatedDoc.tags/document_type sind die tatsaechlich in Paperless geschriebenen
    // Werte (updateDocument() vereinigt updateData.tags mit den bereits vorhandenen Tags des
    // Dokuments) - das vorher hier verwendete updateData.tags/document_type war nur die "neue"
    // Teilmenge dieses Laufs, wodurch ein spaeterer Fingerprint-Treffer eine unvollstaendige
    // Tag-Liste geerbt haette.
    await this.recordDocumentFingerprint(doc, correspondentId, updatedDoc.document_type, updatedDoc.tags, content);
  }
}

let instance = null;

// Lazy statt Modul-Top-Level: verhindert, dass jeder Server-Boot data/entities.db oeffnet, auch
// wenn DOCUMENT_FINGERPRINT_ENABLED=no (dieselbe Begruendung wie zuvor in server.js/routes/setup.js).
function getInstance() {
  if (!instance) {
    const paperlessService = require('./paperlessService');
    const documentModel = require('../models/document');
    const config = require('../config/config');

    let documentFingerprintService = null;
    if (config.documentFingerprint.enabled) {
      const DocumentFingerprintStore = require('../models/documentFingerprintStore');
      const DocumentFingerprintService = require('./documentFingerprintService');
      const entityEmbeddingService = require('./entityEmbeddingService');
      const store = new DocumentFingerprintStore(config.entityResolver.dbPath);
      documentFingerprintService = new DocumentFingerprintService({
        store,
        embeddingService: entityEmbeddingService,
        similarityThreshold: config.documentFingerprint.similarityThreshold,
        model: config.embedding.model
      });
    }

    instance = new DocumentProcessingPipeline({ paperlessService, documentModel, documentFingerprintService, config });
  }
  return instance;
}

module.exports = { DocumentProcessingPipeline, getInstance };
