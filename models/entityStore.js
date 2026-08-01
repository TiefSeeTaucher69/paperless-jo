// models/entityStore.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { normalizeForType } = require('../services/entityNormalizer');

class EntityStore {
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
      CREATE TABLE IF NOT EXISTS entity_aliases (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        alias_normalized TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        canonical_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, alias_normalized)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS entity_review_queue (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        proposed_name TEXT NOT NULL,
        proposed_normalized TEXT NOT NULL,
        proposed_id INTEGER,
        candidate_name TEXT NOT NULL,
        candidate_normalized TEXT NOT NULL,
        candidate_id INTEGER NOT NULL,
        similarity REAL NOT NULL,
        llm_verdict TEXT,
        llm_reason TEXT,
        status TEXT NOT NULL,
        document_id INTEGER,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(entity_type, proposed_normalized, candidate_normalized)
      )
    `).run();
  }

  findAlias(entityType, aliasNormalized) {
    try {
      return this.db.prepare(
        `SELECT * FROM entity_aliases WHERE entity_type = ? AND alias_normalized = ?`
      ).get(entityType, aliasNormalized) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.findAlias:', error.message);
      return null;
    }
  }

  insertAlias({ entityType, aliasNormalized, canonicalName, canonicalId, source }) {
    try {
      this.db.prepare(`
        INSERT INTO entity_aliases (entity_type, alias_normalized, canonical_name, canonical_id, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, alias_normalized) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          canonical_id = excluded.canonical_id,
          source = excluded.source
      `).run(entityType, aliasNormalized, canonicalName, canonicalId, source, new Date().toISOString());
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertAlias:', error.message);
      return false;
    }
  }

  deleteAlias(entityType, aliasNormalized) {
    try {
      this.db.prepare(`DELETE FROM entity_aliases WHERE entity_type = ? AND alias_normalized = ?`)
        .run(entityType, aliasNormalized);
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.deleteAlias:', error.message);
      return false;
    }
  }

  // proposedNormalized/candidateNormalized MUESSEN bereits normalisiert sein (siehe
  // services/entityNormalizer.js#normalizeForType) - der Aufrufer normalisiert, damit
  // z.B. "meldebescheinigung" und "Meldebescheinigung" denselben Cache-Eintrag treffen.
  findRejectedPair(entityType, proposedNormalized, candidateNormalized) {
    try {
      return this.db.prepare(`
        SELECT * FROM entity_review_queue
        WHERE entity_type = ? AND proposed_normalized = ? AND candidate_normalized = ? AND status = 'rejected'
      `).get(entityType, proposedNormalized, candidateNormalized) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.findRejectedPair:', error.message);
      return null;
    }
  }

  insertQueueEntry({ entityType, proposedName, proposedId, candidateName, candidateId, similarity, llmVerdict, llmReason, status, documentId }) {
    try {
      const now = new Date().toISOString();
      // proposed_name/candidate_name bleiben roh (fuer Anzeige), proposed_normalized/
      // candidate_normalized dienen ausschliesslich dem Negativ-Cache-Abgleich in findRejectedPair.
      const proposedNormalized = normalizeForType(proposedName, entityType);
      const candidateNormalized = normalizeForType(candidateName, entityType);
      this.db.prepare(`
        INSERT INTO entity_review_queue
          (entity_type, proposed_name, proposed_normalized, proposed_id, candidate_name, candidate_normalized, candidate_id, similarity, llm_verdict, llm_reason, status, document_id, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, proposed_normalized, candidate_normalized) DO UPDATE SET
          proposed_id = excluded.proposed_id,
          status = excluded.status,
          llm_verdict = excluded.llm_verdict,
          llm_reason = excluded.llm_reason,
          resolved_at = CASE WHEN excluded.status != 'open' THEN excluded.created_at ELSE entity_review_queue.resolved_at END
      `).run(
        entityType, proposedName, proposedNormalized, proposedId ?? null, candidateName, candidateNormalized, candidateId, similarity,
        llmVerdict ?? null, llmReason ?? null, status, documentId ?? null,
        now, status !== 'open' ? now : null
      );
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertQueueEntry:', error.message);
      return false;
    }
  }

  close() {
    try {
      this.db.close();
    } catch (error) {
      console.error('[ERROR] entityStore.close:', error.message);
    }
  }
}

module.exports = EntityStore;
