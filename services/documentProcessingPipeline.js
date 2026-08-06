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

  // AUDIT-006/AUDIT-010: ersetzt applyDocumentFingerprint. Wird jetzt VOR buildUpdateData
  // aufgerufen (aus server.js/routes/setup.js), damit ein Treffer die Tag-/Dokumenttyp-
  // Neuanlage verhindern kann, statt sie nur nachtraeglich zu ueberschreiben - die neu
  // angelegten Entitaeten blieben sonst als Waisen in Paperless zurueck (AUDIT-010). Die
  // Kandidaten-IDs werden gegen den aktuellen Paperless-Bestand geprueft (AUDIT-006) - eine
  // zwischenzeitlich geloeschte/gemergte ID wird verworfen statt ungeprueft in den PATCH zu
  // wandern (der sonst mit HTTP 400 fehlschlaegt und das gesamte Update verwirft).
  async findFingerprintMatch(correspondentId, content, documentId) {
    if (!this.config.documentFingerprint.enabled || !correspondentId || !this.documentFingerprintService) {
      return null;
    }
    try {
      const match = await this.documentFingerprintService.findMatch(correspondentId, content);
      if (!match) {
        return null;
      }
      const validTagIds = [];
      for (const tagId of match.tagIds) {
        if (await this.paperlessService.hasTagId(tagId)) {
          validTagIds.push(tagId);
        }
      }
      const documentTypeId = (match.documentTypeId && await this.paperlessService.hasDocumentTypeId(match.documentTypeId))
        ? match.documentTypeId
        : null;
      // Review-Fix: eine Validierung, die ALLES verworfen hat (alle Tag-IDs geloescht/gemergt,
      // keine gueltige Dokumentart), ist kein verwertbarer Treffer - der Aufrufer wuerde ihn
      // sonst trotzdem als Treffer werten und die LLM-Klassifikation verwerfen, ohne etwas
      // Brauchbares an ihrer Stelle zu setzen.
      if (validTagIds.length === 0 && documentTypeId === null) {
        return null;
      }

      // NACHAUDIT-11 (Audit Abschnitt 18.6, Bedingung 5): im Beobachtungsmodus wird der
      // (bereits AUDIT-006-validierte) Treffer protokolliert, aber NICHT zurueckgegeben -
      // buildUpdateData() faehrt dann exakt wie bei keinem Treffer fort. So laesst sich die
      // Trefferqualitaet unter echter Last beobachten, ohne dass ein Fehltreffer bereits live
      // Tags/Dokumentart ueberschreibt.
      if (this.config.documentFingerprint.mode === 'observe') {
        this.documentFingerprintService.store.recordObservation({
          documentId,
          correspondentId,
          matchedDocumentId: match.matchedDocumentId,
          similarity: match.similarity,
          tagIds: validTagIds,
          documentTypeId
        });
        return null;
      }

      return { tagIds: validTagIds, documentTypeId };
    } catch (error) {
      console.warn('[WARNING] documentProcessingPipeline.findFingerprintMatch: Fingerprint-Check fehlgeschlagen, Klassifikation laeuft ohne ihn weiter:', error.message);
      return null;
    }
  }

  async recordDocumentFingerprint(doc, correspondentId, documentTypeId, tagIds, content, source = 'llm') {
    if (!this.config.documentFingerprint.enabled || !correspondentId || !this.documentFingerprintService) {
      return;
    }
    try {
      await this.documentFingerprintService.recordFingerprint({
        documentId: doc.id,
        correspondentId,
        documentTypeId: documentTypeId ?? null,
        tagIds: tagIds ?? [],
        content,
        source
      });
    } catch (error) {
      console.warn('[WARNING] documentProcessingPipeline.recordDocumentFingerprint: Fingerprint konnte nicht gespeichert werden:', error.message);
    }
  }

  invalidateFingerprintsForMerge(type, fromId, toId) {
    if (!this.documentFingerprintService) {
      return;
    }
    try {
      this.documentFingerprintService.store.invalidateForMerge(type, fromId, toId);
    } catch (error) {
      console.warn('[WARNING] documentProcessingPipeline.invalidateFingerprintsForMerge:', error.message);
    }
  }

  pruneOrphanedFingerprints(validDocumentIds) {
    if (!this.documentFingerprintService) {
      return;
    }
    try {
      const removed = this.documentFingerprintService.store.pruneOrphaned(validDocumentIds);
      if (removed > 0) {
        console.log(`[INFO] documentProcessingPipeline.pruneOrphanedFingerprints: ${removed} verwaiste Fingerprint(s) entfernt.`);
      }
    } catch (error) {
      console.warn('[WARNING] documentProcessingPipeline.pruneOrphanedFingerprints:', error.message);
    }
  }

  // NACHAUDIT-12 (Audit Abschnitt 18.6, Bedingung 6): original_documents speichert bereits den
  // Vorzustand (Tags, Korrespondent, Titel) vor jeder KI-Aenderung, aber es gab bisher keine
  // Funktion, die daraus wiederherstellt. Nutzt overwriteDocumentFields (Replace-Semantik) statt
  // saveDocumentChanges/updateDocument - eine Wiederherstellung muss auch seither hinzugekommene
  // Tags/einen seither gesetzten Korrespondenten entfernen koennen, nicht nur ergaenzen.
  async restoreOriginalData(documentId) {
    const original = await this.documentModel.getOriginalData(documentId);
    // documentModel.getOriginalData faengt interne DB-Fehler (z.B. SQLITE_BUSY) ab und liefert
    // in diesem Fehlerfall ein leeres Array [] statt null/undefined zurueck (bestehende
    // Konvention in models/document.js, nicht Teil dieses Tasks). [] ist truthy - ohne diese
    // Zusatzpruefung wuerde ein DB-Hickup unbemerkt als "kein Original vorhanden" durchrutschen
    // und mit undefined-Feldern einen echten PATCH nach Paperless ausloesen, der Tags/
    // Korrespondent des Dokuments faelschlich leert, waehrend restored:true gemeldet wird.
    if (!original || Array.isArray(original)) {
      return { restored: false, reason: 'no_original_data' };
    }

    const restoredFields = {
      title: original.title,
      tags: JSON.parse(original.tags || '[]'),
      correspondent: original.correspondent ? Number(original.correspondent) : null
    };

    await this.paperlessService.overwriteDocumentFields(documentId, restoredFields);

    // Review-Fix (Finding 4, Paket 4): ein Fingerprint, der aus der gerade zurueckgerollten
    // Klassifikation gebaut wurde, darf nicht als lebender Kandidat fuer findCandidates()
    // bestehen bleiben - sonst propagiert sich der Fehler, den der Operator gerade zurueckgerollt
    // hat, auf ein drittes Dokument weiter. Gleiche Guard-Bedingung wie
    // invalidateFingerprintsForMerge/pruneOrphanedFingerprints: restoreOriginalData muss auch
    // funktionieren, wenn das Fingerprint-Feature deaktiviert ist (documentFingerprintService
    // dann null).
    if (this.documentFingerprintService) {
      try {
        this.documentFingerprintService.store.deleteForDocument(documentId);
      } catch (error) {
        console.warn('[WARNING] documentProcessingPipeline.restoreOriginalData: Fingerprint konnte nicht bereinigt werden:', error.message);
      }
    }

    return { restored: true, original: restoredFields };
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
  async processAndSave({ doc, updateData, analysis, originalData, content, correspondentId, usedFingerprint = false }) {
    const updatedDoc = await this.saveDocumentChanges(doc.id, updateData, analysis, originalData);
    // AUDIT-011: updatedDoc.tags/document_type sind die tatsaechlich in Paperless geschriebenen
    // Werte (updateDocument() vereinigt updateData.tags mit den bereits vorhandenen Tags des
    // Dokuments) - das vorher hier verwendete updateData.tags/document_type war nur die "neue"
    // Teilmenge dieses Laufs, wodurch ein spaeterer Fingerprint-Treffer eine unvollstaendige
    // Tag-Liste geerbt haette.
    // AUDIT-003: usedFingerprint kommt vom Aufrufer (buildUpdateData in server.js/
    // routes/setup.js hat findFingerprintMatch bereits VOR der Tag-/Dokumenttyp-Erzeugung
    // aufgerufen, siehe AUDIT-010) - eine geerbte Klassifikation wird als 'inherited'
    // gespeichert und darf selbst nicht mehr als Kandidat fuer ein drittes Dokument dienen.
    await this.recordDocumentFingerprint(
      doc, correspondentId, updatedDoc?.document_type ?? null, updatedDoc?.tags ?? updateData.tags, content,
      usedFingerprint ? 'inherited' : 'llm'
    );
  }
}

// NACHAUDIT-13: gemeinsame Anwendungslogik fuer server.js/routes/setup.js#buildUpdateData -
// beide Dateien duplizieren buildUpdateData bereits vollstaendig (AUDIT-014); diese zwei
// Funktionen verhindern, dass die Entscheidung "wurde der Fingerprint-Treffer tatsaechlich
// uebernommen" ein zweites Mal dupliziert wird, und machen sie isoliert testbar. Ein Treffer,
// der wegen activateTagging='no'/activateDocumentType='no' NIE hier ankommt, oder dessen
// tagIds/documentTypeId leer sind, darf nicht als angewendet gelten - sonst wird er trotzdem
// als 'inherited' gespeichert und faellt faelschlich als Kandidat fuer ein drittes Dokument
// weg (source='inherited' wird von findCandidates() ausgeschlossen, siehe
// models/documentFingerprintStore.js), obwohl er in Paperless nie etwas bewirkt hat.
function applyFingerprintTags(fingerprintMatch, updateData) {
  if (fingerprintMatch && fingerprintMatch.tagIds.length > 0) {
    updateData.tags = fingerprintMatch.tagIds;
    return true;
  }
  return false;
}

function applyFingerprintDocumentType(fingerprintMatch, updateData) {
  if (fingerprintMatch && fingerprintMatch.documentTypeId) {
    updateData.document_type = fingerprintMatch.documentTypeId;
    return true;
  }
  return false;
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

module.exports = { DocumentProcessingPipeline, getInstance, applyFingerprintTags, applyFingerprintDocumentType };
