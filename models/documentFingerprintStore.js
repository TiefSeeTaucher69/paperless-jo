// models/documentFingerprintStore.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// AUDIT-020: unbegrenzte Kandidatensuche skaliert linear mit der Anzahl Fingerprints eines
// Korrespondenten - bei bge-m3 (1024 Dimensionen, 4 KB/Vektor) waeren das bei 2000 Dokumenten
// 8 MB Rohdaten und 2 Mio. Multiplikationen PRO neu verarbeitetem Dokument. Begrenzt auf die
// zuletzt gespeicherten N - aeltere, seltener wiederkehrende Vorlagen sind fuer den
// Aehnlichkeitsvergleich ohnehin die am wenigsten relevanten Kandidaten.
const MAX_CANDIDATES_PER_CORRESPONDENT = 300;

class DocumentFingerprintStore {
  constructor(dbPath) {
    const resolvedPath = dbPath || path.join(process.cwd(), 'data', 'entities.db');

    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this._createTables();
  }

  _createTables() {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS document_fingerprints (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL UNIQUE,
        correspondent_id INTEGER NOT NULL,
        document_type_id INTEGER,
        tag_ids TEXT NOT NULL,
        content_embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_document_fingerprints_correspondent
      ON document_fingerprints(correspondent_id)
    `).run();

    // NACHAUDIT-11 (Audit Abschnitt 18.6, Bedingung 5): Beobachtungsmodus - protokolliert einen
    // Treffer, der im Modus 'observe' NICHT auf updateData angewendet wurde, damit die
    // Trefferqualitaet vor einer Aktivierungsentscheidung stichprobenartig geprueft werden kann.
    // Eigene Tabelle statt Wiederverwendung von document_fingerprints: eine Beobachtung ist kein
    // gespeicherter Fingerprint-Kandidat und darf nicht in findCandidates() auftauchen.
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS document_fingerprint_observations (
        id INTEGER PRIMARY KEY,
        correspondent_id INTEGER NOT NULL,
        matched_document_id INTEGER NOT NULL,
        similarity REAL NOT NULL,
        tag_ids TEXT NOT NULL,
        document_type_id INTEGER,
        created_at TEXT NOT NULL
      )
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_document_fingerprint_observations_created_at
      ON document_fingerprint_observations(created_at)
    `).run();

    this._ensureColumn('document_fingerprints', 'model', 'TEXT');
    // AUDIT-003: 'llm' = direkt aus einer eigenen KI-Klassifikation, 'inherited' = von einem
    // Fingerprint-Treffer uebernommen. inherited-Eintraege duerfen selbst nicht mehr als
    // Kandidat fuer ein drittes Dokument dienen (siehe findCandidates) - das bricht die
    // zirkulaere Vererbungskette eines einzelnen Fehltreffers, die sich sonst unbegrenzt durch
    // eine ganze Dokumentserie fortpflanzt.
    this._ensureColumn('document_fingerprints', 'source', "TEXT NOT NULL DEFAULT 'llm'");

    // Review-Fix (Finding 1, Paket 4): eine Beobachtung protokollierte bisher nur die
    // matched_document_id (den historischen Kandidaten), nie die ID des Dokuments, das gerade
    // verarbeitet wurde. Ohne diese ID laesst sich bei einer spaeteren Stichprobenpruefung nicht
    // feststellen, welche zwei Dokumente tatsaechlich verglichen werden muessen.
    this._ensureColumn('document_fingerprint_observations', 'document_id', 'INTEGER');
  }

  // Additive Spalten-Migration: CREATE TABLE IF NOT EXISTS legt bei einer bereits
  // existierenden Alt-Datenbank keine neuen Spalten an - das muss ALTER TABLE
  // uebernehmen, idempotent per PRAGMA table_info-Check.
  _ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(c => c.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }

  findCandidates(correspondentId) {
    try {
      const rows = this.db.prepare(
        `SELECT * FROM document_fingerprints
         WHERE correspondent_id = ? AND source != 'inherited'
         ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(correspondentId, MAX_CANDIDATES_PER_CORRESPONDENT);
      return rows.map(row => ({
        documentId: row.document_id,
        correspondentId: row.correspondent_id,
        documentTypeId: row.document_type_id,
        tagIds: JSON.parse(row.tag_ids),
        embedding: this._bufferToVector(row.content_embedding),
        model: row.model,
        source: row.source
      }));
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.findCandidates:', error.message);
      return [];
    }
  }

  upsertFingerprint({ documentId, correspondentId, documentTypeId, tagIds, embedding, model, source = 'llm' }) {
    try {
      this.db.prepare(`
        INSERT INTO document_fingerprints (document_id, correspondent_id, document_type_id, tag_ids, content_embedding, model, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          correspondent_id = excluded.correspondent_id,
          document_type_id = excluded.document_type_id,
          tag_ids = excluded.tag_ids,
          content_embedding = excluded.content_embedding,
          model = excluded.model,
          source = excluded.source,
          created_at = excluded.created_at
      `).run(
        documentId, correspondentId, documentTypeId ?? null,
        JSON.stringify(tagIds), this._vectorToBuffer(embedding), model ?? null, source, new Date().toISOString()
      );
      return true;
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.upsertFingerprint:', error.message);
      return false;
    }
  }

  // AUDIT-006: ein Fingerprint zeigt sonst weiterhin auf eine per Merge geloeschte
  // Korrespondenten-/Tag-/Dokumenttyp-ID. Wird nur nach einem ECHTEN (nicht dryRun-) Merge
  // aufgerufen, siehe services/paperlessService.js#mergeEntity.
  invalidateForMerge(type, fromId, toId) {
    try {
      if (type === 'correspondent') {
        this.db.prepare(`UPDATE document_fingerprints SET correspondent_id = ? WHERE correspondent_id = ?`).run(toId, fromId);
      } else if (type === 'document_type') {
        this.db.prepare(`UPDATE document_fingerprints SET document_type_id = ? WHERE document_type_id = ?`).run(toId, fromId);
      } else if (type === 'tag') {
        // LIKE ist nur ein Vorfilter (kann false positives wie "12" bei fromId=1 treffen) -
        // die exakte Pruefung passiert danach in JS ueber das geparste Array.
        const rows = this.db.prepare(`SELECT id, tag_ids FROM document_fingerprints WHERE tag_ids LIKE ?`).all(`%${fromId}%`);
        const update = this.db.prepare(`UPDATE document_fingerprints SET tag_ids = ? WHERE id = ?`);
        for (const row of rows) {
          const tagIds = JSON.parse(row.tag_ids);
          if (!tagIds.includes(fromId)) continue;
          const merged = [...new Set(tagIds.map(id => (id === fromId ? toId : id)))];
          update.run(JSON.stringify(merged), row.id);
        }
      }
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.invalidateForMerge:', error.message);
    }
  }

  // AUDIT-020: die Tabelle waechst monoton, ohne Aufraeumpfad fuer Dokumente, die in
  // Paperless geloescht wurden. Wird einmal pro Scan-Zyklus mit den gerade abgerufenen,
  // tatsaechlich noch existierenden Dokument-IDs aufgerufen (server.js#scanDocuments) -
  // kostet dadurch keinen zusaetzlichen Paperless-API-Aufruf.
  pruneOrphaned(validDocumentIds) {
    try {
      const rows = this.db.prepare(`SELECT document_id FROM document_fingerprints`).all();
      const validSet = new Set(validDocumentIds);
      const orphanIds = rows.map(r => r.document_id).filter(id => !validSet.has(id));
      if (orphanIds.length === 0) {
        return 0;
      }
      // Review-Fix: eine partiell abgebrochene Paperless-Paginierung liefert eine unvollstaendige
      // "gueltige" Liste, gegen die fast die gesamte Tabelle als "verwaist" erscheinen wuerde. Ein
      // Loeschlauf, der mehr als die Haelfte der Tabelle betreffen wuerde, wird deshalb verweigert
      // statt blind durchgefuehrt - ein sichtbar ausbleibendes Aufraeumen faellt eher auf als eine
      // leise Teilloeschung echter Daten.
      if (rows.length >= 20 && orphanIds.length > rows.length / 2) {
        console.warn(`[WARNING] documentFingerprintStore.pruneOrphaned: ${orphanIds.length} von ${rows.length} Fingerprints wuerden als verwaist geloescht - das ueberschreitet die Sicherheitsschwelle (50%). Loeschung uebersprungen, moeglicherweise unvollstaendige Dokumentliste.`);
        return 0;
      }
      const placeholders = orphanIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM document_fingerprints WHERE document_id IN (${placeholders})`).run(...orphanIds);
      return orphanIds.length;
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.pruneOrphaned:', error.message);
      return 0;
    }
  }

  // Review-Fix (Finding 4, Paket 4): restoreOriginalData (documentProcessingPipeline.js) rollt
  // eine abgelehnte KI-Klassifikation zurueck, liess den daraus gebauten Fingerprint bisher aber
  // unangetastet - der blieb dadurch ein lebender Kandidat fuer findCandidates() und haette den
  // gerade zurueckgerollten Fehler auf ein drittes Dokument weitervererben koennen.
  deleteForDocument(documentId) {
    try {
      this.db.prepare(`DELETE FROM document_fingerprints WHERE document_id = ?`).run(documentId);
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.deleteForDocument:', error.message);
    }
  }

  recordObservation({ documentId, correspondentId, matchedDocumentId, similarity, tagIds, documentTypeId }) {
    try {
      this.db.prepare(`
        INSERT INTO document_fingerprint_observations
          (document_id, correspondent_id, matched_document_id, similarity, tag_ids, document_type_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(documentId ?? null, correspondentId, matchedDocumentId, similarity, JSON.stringify(tagIds), documentTypeId ?? null, new Date().toISOString());
      return true;
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.recordObservation:', error.message);
      return false;
    }
  }

  listObservations({ limit = 500 } = {}) {
    try {
      return this.db.prepare(`
        SELECT * FROM document_fingerprint_observations ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(limit);
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.listObservations:', error.message);
      return [];
    }
  }

  // AUDIT-026: Float64->Float32-Abwertung (Ollama liefert Float64) verliert Praezision (~1e-7
  // relativ) - fuer Cosinus-Aehnlichkeit unkritisch, aber "frisch berechnet" und "aus dem Cache
  // gelesen" sind dadurch nicht mehr bitidentisch; ein Schwellwert exakt an der Kante kann
  // deshalb je nach Quelle unterschiedlich entscheiden.
  _vectorToBuffer(vector) {
    return Buffer.from(Float32Array.from(vector).buffer);
  }

  _bufferToVector(buffer) {
    // AUDIT-020: Array.from() materialisierte bisher bei jedem Kandidaten ein neues natives
    // JS-Array (kopiert alle Zahlen einzeln) - eine Float32Array-View auf den bestehenden
    // Buffer reicht, cosineSimilarity() (entityEmbeddingService.js) indiziert nur ueber
    // Zahlen und length, beide Typen unterstuetzen das identisch.
    //
    // AUDIT-026: diese View setzt voraus, dass buffer.byteOffset ein Vielfaches von 4 ist -
    // sonst wirft der Float32Array-Konstruktor selbst einen RangeError (kein stiller
    // Datenfehler, siehe Test "_bufferToVector wirft RangeError..."). Node allokiert Buffer
    // unterhalb der Pool-Grenze (Buffer.poolSize/2, Default 4 KB) aus einem gemeinsamen,
    // 8-Byte-ausgerichteten Pool; groessere Buffer (>= 4096 Byte, d.h. Vektoren ab 1024
    // Dimensionen wie bge-m3) werden einzeln alloziert und sind Betriebssystem-seitenaligniert.
    // Beide Faelle sind ein Vielfaches von 4 - die Annahme haelt fuer jede in diesem Projekt
    // verwendete Embedding-Dimension, ist aber nicht durch better-sqlite3 vertraglich
    // garantiert, falls sich dessen BLOB-Rueckgabe je aendert.
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  }

  close() {
    try {
      this.db.close();
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.close:', error.message);
    }
  }
}

module.exports = DocumentFingerprintStore;
