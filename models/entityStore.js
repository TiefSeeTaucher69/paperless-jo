// models/entityStore.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { normalizeForType } = require('../services/entityNormalizer');

// AUDIT-030: Whitelist statt direkter String-Interpolation des sort-Parameters (der aus der
// Review-UI kommt) - ORDER BY-Spalten lassen sich in SQLite nicht als gebundene Parameter
// uebergeben, deshalb hier ein fester, serverseitiger Satz erlaubter Ausdruecke.
const QUEUE_SORT_COLUMNS = {
  created_at_asc: 'created_at ASC',
  created_at_desc: 'created_at DESC',
  similarity_asc: 'similarity ASC',
  similarity_desc: 'similarity DESC'
};

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
        similarity REAL NOT NULL, -- AUDIT-029: Trigram/Dice-Skala, NICHT der historische Mischwert
                                   -- aus Dice und Cosinus; siehe trigram_similarity/embedding_similarity
                                   -- fuer beide Kanaele einzeln.
        llm_verdict TEXT,
        llm_reason TEXT,
        status TEXT NOT NULL,
        document_id INTEGER,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(entity_type, proposed_normalized, candidate_normalized)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS entity_embeddings (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        entity_name TEXT NOT NULL,
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, entity_id)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS entity_merge_log (
        id INTEGER PRIMARY KEY,
        queue_entry_id INTEGER,
        entity_type TEXT NOT NULL,
        from_id INTEGER,
        to_id INTEGER NOT NULL,
        affected_count INTEGER NOT NULL,
        chunks_completed INTEGER NOT NULL,
        chunks_total INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL
      )
    `).run();

    this._ensureColumn('entity_review_queue', 'trigram_similarity', 'REAL');
    this._ensureColumn('entity_review_queue', 'embedding_similarity', 'REAL');
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

  _insertAliasRaw({ entityType, aliasNormalized, canonicalName, canonicalId, source }) {
    this.db.prepare(`
      INSERT INTO entity_aliases (entity_type, alias_normalized, canonical_name, canonical_id, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, alias_normalized) DO UPDATE SET
        canonical_name = excluded.canonical_name,
        canonical_id = excluded.canonical_id,
        source = excluded.source
    `).run(entityType, aliasNormalized, canonicalName, canonicalId, source, new Date().toISOString());
  }

  insertAlias(args) {
    try {
      this._insertAliasRaw(args);
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

  getEmbedding(entityType, entityId) {
    try {
      const row = this.db.prepare(
        `SELECT entity_name, model, vector FROM entity_embeddings WHERE entity_type = ? AND entity_id = ?`
      ).get(entityType, entityId);
      if (!row) return null;
      return { entity_name: row.entity_name, model: row.model, vector: this._bufferToVector(row.vector) };
    } catch (error) {
      console.error('[ERROR] entityStore.getEmbedding:', error.message);
      return null;
    }
  }

  upsertEmbedding({ entityType, id, name, model, vector }) {
    try {
      this.db.prepare(`
        INSERT INTO entity_embeddings (entity_type, entity_id, entity_name, model, vector, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          entity_name = excluded.entity_name,
          model = excluded.model,
          vector = excluded.vector,
          created_at = excluded.created_at
      `).run(entityType, id, name, model, this._vectorToBuffer(vector), new Date().toISOString());
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.upsertEmbedding:', error.message);
      return false;
    }
  }

  deleteEmbedding(entityType, entityId) {
    try {
      this.db.prepare(`DELETE FROM entity_embeddings WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.deleteEmbedding:', error.message);
      return false;
    }
  }

  // AUDIT-026: Float64->Float32-Abwertung (Ollama liefert Float64) verliert Praezision (~1e-7
  // relativ) - fuer Cosinus-Aehnlichkeit unkritisch, aber "frisch berechnet" und "aus dem Cache
  // gelesen" sind dadurch nicht mehr bitidentisch; ein Schwellwert exakt an der Kante kann
  // deshalb je nach Quelle unterschiedlich entscheiden.
  _vectorToBuffer(vector) {
    return Buffer.from(Float32Array.from(vector).buffer);
  }

  // _bufferToVector setzt voraus, dass buffer.byteOffset ein Vielfaches von 4 ist - sonst wirft
  // der Float32Array-Konstruktor selbst einen RangeError (kein stiller Datenfehler, siehe Test
  // "_bufferToVector wirft RangeError..."). Node allokiert Buffer unterhalb der Pool-Grenze
  // (Buffer.poolSize/2, Default 4 KB) aus einem gemeinsamen, 8-Byte-ausgerichteten Pool;
  // groessere Buffer (>= 4096 Byte, d.h. Vektoren ab 1024 Dimensionen wie bge-m3) werden einzeln
  // alloziert und sind Betriebssystem-seitenaligniert. Beide Faelle sind ein Vielfaches von 4 -
  // die Annahme haelt fuer jede in diesem Projekt verwendete Embedding-Dimension, ist aber nicht
  // durch better-sqlite3 vertraglich garantiert, falls sich dessen BLOB-Rueckgabe je aendert.
  _bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }

  // Symmetrisch: der Altbestands-Scan legt die Richtung nach ID fest (kleinere ID = candidate,
  // entityBackfillService.js), der Live-Resolver dagegen nach Rolle (LLM-Vorschlag = proposed).
  // Ohne symmetrische Pruefung wuerde eine Ablehnung des einen Scans die andere Richtung nicht
  // sperren - siehe AUDIT-012.
  // proposedNormalized/candidateNormalized MUESSEN bereits normalisiert sein (siehe
  // services/entityNormalizer.js#normalizeForType) - der Aufrufer normalisiert, damit
  // z.B. "meldebescheinigung" und "Meldebescheinigung" denselben Cache-Eintrag treffen.
  findRejectedPair(entityType, proposedNormalized, candidateNormalized) {
    try {
      return this.db.prepare(`
        SELECT * FROM entity_review_queue
        WHERE entity_type = ? AND status = 'rejected'
          AND (
            (proposed_normalized = ? AND candidate_normalized = ?)
            OR (proposed_normalized = ? AND candidate_normalized = ?)
          )
      `).get(entityType, proposedNormalized, candidateNormalized, candidateNormalized, proposedNormalized) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.findRejectedPair:', error.message);
      return null;
    }
  }

  // Symmetrisch wie findRejectedPair (AUDIT-012): der Backfill legt die Richtung nach ID fest,
  // der Live-Resolver nach Rolle - ohne symmetrische Pruefung koennte ein Backfill-Lauf einen
  // vom Live-Resolver bereits angelegten Eintrag in der Gegenrichtung erneut anlegen. Im
  // Unterschied zu findRejectedPair wird hier NICHT nach status gefiltert - jeder Status
  // (open/merged/rejected) soll das erneute Anlegen verhindern.
  findQueueEntryPair(entityType, proposedNormalized, candidateNormalized) {
    try {
      return this.db.prepare(`
        SELECT * FROM entity_review_queue
        WHERE entity_type = ?
          AND (
            (proposed_normalized = ? AND candidate_normalized = ?)
            OR (proposed_normalized = ? AND candidate_normalized = ?)
          )
      `).get(entityType, proposedNormalized, candidateNormalized, candidateNormalized, proposedNormalized) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.findQueueEntryPair:', error.message);
      return null;
    }
  }

  insertQueueEntry({ entityType, proposedName, proposedId, candidateName, candidateId, similarity, trigramSimilarity = null, embeddingSimilarity = null, llmVerdict, llmReason, status, documentId }) {
    try {
      const now = new Date().toISOString();
      // proposed_name/candidate_name bleiben roh (fuer Anzeige), proposed_normalized/
      // candidate_normalized dienen ausschliesslich dem Negativ-Cache-Abgleich in findRejectedPair.
      const proposedNormalized = normalizeForType(proposedName, entityType);
      const candidateNormalized = normalizeForType(candidateName, entityType);
      this.db.prepare(`
        INSERT INTO entity_review_queue
          (entity_type, proposed_name, proposed_normalized, proposed_id, candidate_name, candidate_normalized, candidate_id, similarity, trigram_similarity, embedding_similarity, llm_verdict, llm_reason, status, document_id, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, proposed_normalized, candidate_normalized) DO UPDATE SET
          proposed_id = excluded.proposed_id,
          status = excluded.status,
          llm_verdict = excluded.llm_verdict,
          llm_reason = excluded.llm_reason,
          trigram_similarity = excluded.trigram_similarity,
          embedding_similarity = excluded.embedding_similarity,
          resolved_at = CASE WHEN excluded.status != 'open' THEN excluded.created_at ELSE entity_review_queue.resolved_at END
      `).run(
        entityType, proposedName, proposedNormalized, proposedId ?? null, candidateName, candidateNormalized, candidateId, similarity,
        trigramSimilarity, embeddingSimilarity,
        llmVerdict ?? null, llmReason ?? null, status, documentId ?? null,
        now, status !== 'open' ? now : null
      );
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertQueueEntry:', error.message);
      return false;
    }
  }

  listOpenQueueEntries({ entityType = null, sort = 'created_at_asc', limit = null, offset = 0 } = {}) {
    try {
      const orderBy = QUEUE_SORT_COLUMNS[sort] || QUEUE_SORT_COLUMNS.created_at_asc;
      const params = [];
      let sql = `SELECT * FROM entity_review_queue WHERE status = 'open'`;
      if (entityType) {
        sql += ` AND entity_type = ?`;
        params.push(entityType);
      }
      sql += ` ORDER BY ${orderBy}`;
      if (limit != null) {
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limit, offset);
      }
      return this.db.prepare(sql).all(...params);
    } catch (error) {
      console.error('[ERROR] entityStore.listOpenQueueEntries:', error.message);
      return [];
    }
  }

  getQueueEntryById(id) {
    try {
      return this.db.prepare(`SELECT * FROM entity_review_queue WHERE id = ?`).get(id) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.getQueueEntryById:', error.message);
      return null;
    }
  }

  _updateQueueStatusRaw(id, status) {
    const result = this.db.prepare(`
      UPDATE entity_review_queue SET status = ?, resolved_at = ? WHERE id = ?
    `).run(status, new Date().toISOString(), id);
    return result.changes > 0;
  }

  updateQueueStatus(id, status) {
    try {
      return this._updateQueueStatusRaw(id, status);
    } catch (error) {
      console.error('[ERROR] entityStore.updateQueueStatus:', error.message);
      return false;
    }
  }

  countOpenQueueEntries({ entityType = null } = {}) {
    try {
      const params = [];
      let sql = `SELECT COUNT(*) as count FROM entity_review_queue WHERE status = 'open'`;
      if (entityType) {
        sql += ` AND entity_type = ?`;
        params.push(entityType);
      }
      return this.db.prepare(sql).get(...params).count;
    } catch (error) {
      console.error('[ERROR] entityStore.countOpenQueueEntries:', error.message);
      return 0;
    }
  }

  // AUDIT-030: Massenaktion fuer die Review-UI - lehnt alle offenen Eintraege unterhalb einer
  // Aehnlichkeits-Schwelle ab, optional gefiltert auf einen Entity-Typ. similarity traegt seit
  // AUDIT-029 nur noch die Trigram-Skala, ist also fuer diesen Vergleich unzweideutig.
  bulkRejectBelowSimilarity({ entityType = null, maxSimilarity }) {
    try {
      const params = [new Date().toISOString(), maxSimilarity];
      let sql = `UPDATE entity_review_queue SET status = 'rejected', resolved_at = ? WHERE status = 'open' AND similarity < ?`;
      if (entityType) {
        sql += ` AND entity_type = ?`;
        params.push(entityType);
      }
      const result = this.db.prepare(sql).run(...params);
      return result.changes;
    } catch (error) {
      console.error('[ERROR] entityStore.bulkRejectBelowSimilarity:', error.message);
      return 0;
    }
  }

  // Persistiert jeden echten Merge-Versuch (erfolgreich oder fehlgeschlagen) unabhaengig vom
  // Queue-Status - der Queue-Eintrag allein sagt nicht, wie viele Chunks liefen oder woran ein
  // fehlgeschlagener Merge scheiterte (AUDIT-013).
  _insertMergeLogRaw({ queueEntryId = null, entityType, fromId = null, toId, affectedCount, chunksCompleted = 0, chunksTotal = 0, status, errorMessage = null }) {
    this.db.prepare(`
      INSERT INTO entity_merge_log
        (queue_entry_id, entity_type, from_id, to_id, affected_count, chunks_completed, chunks_total, status, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(queueEntryId, entityType, fromId, toId, affectedCount, chunksCompleted, chunksTotal, status, errorMessage, new Date().toISOString());
  }

  insertMergeLog(args) {
    try {
      this._insertMergeLogRaw(args);
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertMergeLog:', error.message);
      return false;
    }
  }

  // Merge-Abschluss schreibt Alias + Queue-Status + Merge-Log gemeinsam in einer Transaktion -
  // schlaegt einer der drei Schritte fehl, darf keiner der anderen bestehen bleiben. Ohne das
  // koennte z.B. der Alias geschrieben werden, aber der Queue-Eintrag auf 'open' stehen bleiben:
  // der naechste Resolver-Lauf wuerde denselben Vorschlag dann erneut zur Pruefung vorlegen,
  // obwohl laut Alias-Tabelle schon entschieden ist (AUDIT-015).
  completeMerge({ alias, queueEntryId, mergeLog }) {
    try {
      const runInTransaction = this.db.transaction(() => {
        this._insertAliasRaw(alias);
        const changed = this._updateQueueStatusRaw(queueEntryId, 'merged');
        if (!changed) {
          throw new Error(`kein Queue-Eintrag mit id=${queueEntryId} gefunden`);
        }
        this._insertMergeLogRaw(mergeLog);
      });
      runInTransaction();
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.completeMerge:', error.message);
      return false;
    }
  }

  listMergeLogForQueueEntry(queueEntryId) {
    try {
      return this.db.prepare(`
        SELECT * FROM entity_merge_log WHERE queue_entry_id = ? ORDER BY created_at ASC
      `).all(queueEntryId);
    } catch (error) {
      console.error('[ERROR] entityStore.listMergeLogForQueueEntry:', error.message);
      return [];
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
