// models/documentFingerprintStore.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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

    this._ensureColumn('document_fingerprints', 'model', 'TEXT');
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
        `SELECT * FROM document_fingerprints WHERE correspondent_id = ?`
      ).all(correspondentId);
      return rows.map(row => ({
        documentId: row.document_id,
        correspondentId: row.correspondent_id,
        documentTypeId: row.document_type_id,
        tagIds: JSON.parse(row.tag_ids),
        embedding: this._bufferToVector(row.content_embedding),
        model: row.model
      }));
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.findCandidates:', error.message);
      return [];
    }
  }

  upsertFingerprint({ documentId, correspondentId, documentTypeId, tagIds, embedding, model }) {
    try {
      this.db.prepare(`
        INSERT INTO document_fingerprints (document_id, correspondent_id, document_type_id, tag_ids, content_embedding, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          correspondent_id = excluded.correspondent_id,
          document_type_id = excluded.document_type_id,
          tag_ids = excluded.tag_ids,
          content_embedding = excluded.content_embedding,
          model = excluded.model,
          created_at = excluded.created_at
      `).run(
        documentId, correspondentId, documentTypeId ?? null,
        JSON.stringify(tagIds), this._vectorToBuffer(embedding), model ?? null, new Date().toISOString()
      );
      return true;
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.upsertFingerprint:', error.message);
      return false;
    }
  }

  _vectorToBuffer(vector) {
    return Buffer.from(Float32Array.from(vector).buffer);
  }

  _bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
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
