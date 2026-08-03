const { test } = require('node:test');
const assert = require('node:assert');
const EntityStore = require('../models/entityStore');
const { normalizeForType } = require('../services/entityNormalizer');

function freshStore() {
  return new EntityStore(':memory:');
}

test('findAlias liefert null, wenn nichts gespeichert ist', () => {
  const store = freshStore();
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('insertAlias und findAlias roundtrip', () => {
  const store = freshStore();
  const ok = store.insertAlias({
    entityType: 'correspondent', aliasNormalized: 'stadtwerke musterstadt',
    canonicalName: 'Stadtwerke Musterstadt GmbH', canonicalId: 42, source: 'auto'
  });
  assert.strictEqual(ok, true);

  const found = store.findAlias('correspondent', 'stadtwerke musterstadt');
  assert.strictEqual(found.canonical_id, 42);
  assert.strictEqual(found.canonical_name, 'Stadtwerke Musterstadt GmbH');
  assert.strictEqual(found.source, 'auto');
});

test('UNIQUE(entity_type, alias_normalized): erneutes Insert ueberschreibt statt zu duplizieren', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'auto' });
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'user' });

  const found = store.findAlias('tag', 'rechnung');
  assert.strictEqual(found.source, 'user');
});

test('deleteAlias entfernt den Eintrag', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'auto' });
  store.deleteAlias('tag', 'rechnung');
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('findRejectedPair liefert null ohne Eintrag, gefunden nach insertQueueEntry mit status rejected', () => {
  const store = freshStore();
  const proposedNormalized = normalizeForType('Verdienstbescheinigung', 'document_type');
  const candidateNormalized = normalizeForType('Entgeltabrechnung', 'document_type');
  assert.strictEqual(store.findRejectedPair('document_type', proposedNormalized, candidateNormalized), null);

  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 9,
    candidateName: 'Entgeltabrechnung', candidateId: 3, similarity: 0.4,
    llmVerdict: 'different', llmReason: 'unterschiedliche Dokumentarten', status: 'rejected'
  });

  const found = store.findRejectedPair('document_type', proposedNormalized, candidateNormalized);
  assert.ok(found);
  assert.strictEqual(found.status, 'rejected');
});

test('findRejectedPair matcht ueber Normalisierung: Gross-/Kleinschreibung und Whitespace-Varianten der Rohnamen finden denselben Eintrag', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'meldebescheid', proposedId: 1,
    candidateName: 'Meldebescheinigung', candidateId: 2, similarity: 0.5,
    llmVerdict: 'different', llmReason: 'test', status: 'rejected'
  });

  // Andere Schreibweise/Whitespace als beim Insert, aber gleiche normalisierte Form
  const found = store.findRejectedPair(
    'tag',
    normalizeForType('  MELDEBESCHEID  ', 'tag'),
    normalizeForType('meldebescheinigung', 'tag')
  );
  assert.ok(found, 'Negativ-Cache sollte trotz Roh-Varianten treffen');
  assert.strictEqual(found.candidate_name, 'Meldebescheinigung');
});

test('insertQueueEntry speichert proposed_normalized/candidate_normalized neben den rohen Namen', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'correspondent', proposedName: 'Müller GmbH', proposedId: 1,
    candidateName: 'Mueller', candidateId: 2, similarity: 0.6,
    llmVerdict: 'different', llmReason: 'test', status: 'rejected'
  });

  const row = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ?`
  ).get('Müller GmbH');

  assert.strictEqual(row.proposed_name, 'Müller GmbH', 'roher Name bleibt fuer Anzeige erhalten');
  assert.strictEqual(row.proposed_normalized, normalizeForType('Müller GmbH', 'correspondent'));
  assert.strictEqual(row.candidate_normalized, normalizeForType('Mueller', 'correspondent'));
});

test('offene Queue-Eintraege werden von findRejectedPair NICHT gefunden', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'A', proposedId: 1,
    candidateName: 'B', candidateId: 2, similarity: 0.7,
    llmVerdict: 'unsure', llmReason: null, status: 'open'
  });
  assert.strictEqual(
    store.findRejectedPair('tag', normalizeForType('A', 'tag'), normalizeForType('B', 'tag')),
    null
  );
});

test('findRejectedPair findet eine Ablehnung auch in umgekehrter Richtung (Backfill- vs. Live-Reihenfolge)', () => {
  const store = freshStore();
  const normalizedA = normalizeForType('Stadtwerke Musterstadt', 'correspondent');
  const normalizedB = normalizeForType('Stadtwerke Beispielstadt', 'correspondent');

  // Backfill legt die Richtung nach ID fest (kleinere ID = candidate): hier proposed=B, candidate=A.
  store.insertQueueEntry({
    entityType: 'correspondent', proposedName: 'Stadtwerke Beispielstadt', proposedId: 2,
    candidateName: 'Stadtwerke Musterstadt', candidateId: 1, similarity: 0.9,
    llmVerdict: 'different', llmReason: 'test', status: 'rejected'
  });

  // Der Live-Resolver fragt spaeter in der Gegenrichtung: proposed=A, candidate=B.
  const found = store.findRejectedPair('correspondent', normalizedA, normalizedB);
  assert.ok(found, 'Negativ-Cache sollte auch die umgekehrte Richtung treffen');
  assert.strictEqual(found.status, 'rejected');
});

test('findRejectedPair liefert weiterhin null, wenn weder Richtung abgelehnt wurde', () => {
  const store = freshStore();
  const normalizedA = normalizeForType('Amazon', 'correspondent');
  const normalizedB = normalizeForType('Ebay', 'correspondent');

  assert.strictEqual(store.findRejectedPair('correspondent', normalizedA, normalizedB), null);
});

test('Fehlerfall: geschlossene DB liefert Fallback statt zu werfen', () => {
  const store = freshStore();
  store.close();
  assert.doesNotThrow(() => store.findAlias('tag', 'rechnung'));
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('listOpenQueueEntries liefert nur offene Eintraege, sortiert nach created_at', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: null });
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Mahnung', proposedId: 3, candidateName: 'Mahnungen', candidateId: 4, similarity: 0.75, llmVerdict: null, llmReason: null, status: 'rejected', documentId: null });

  const open = store.listOpenQueueEntries();

  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].proposed_name, 'Rechnung');
});

test('getQueueEntryById liefert den Eintrag inklusive document_id, oder null', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: 42 });
  const entry = store.listOpenQueueEntries()[0];

  const fetched = store.getQueueEntryById(entry.id);
  assert.strictEqual(fetched.document_id, 42);
  assert.strictEqual(store.getQueueEntryById(999999), null);
});

test('updateQueueStatus setzt status und resolved_at, liefert true bei Treffer', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: null });
  const entry = store.listOpenQueueEntries()[0];

  const updated = store.updateQueueStatus(entry.id, 'merged');

  assert.strictEqual(updated, true);
  const fetched = store.getQueueEntryById(entry.id);
  assert.strictEqual(fetched.status, 'merged');
  assert.ok(fetched.resolved_at);
});

test('updateQueueStatus liefert false, wenn die id nicht existiert', () => {
  const store = freshStore();
  assert.strictEqual(store.updateQueueStatus(999999, 'merged'), false);
});

test('findQueueEntryPair findet Eintraege unabhaengig vom status, null wenn keiner existiert', () => {
  const store = freshStore();
  const proposedNormalized = normalizeForType('Mahnung', 'tag');
  const candidateNormalized = normalizeForType('Mahnungen', 'tag');

  assert.strictEqual(store.findQueueEntryPair('tag', proposedNormalized, candidateNormalized), null);

  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Mahnung', proposedId: 1, candidateName: 'Mahnungen', candidateId: 2, similarity: 0.8, llmVerdict: 'unsure', llmReason: null, status: 'open', documentId: null });
  const openFound = store.findQueueEntryPair('tag', proposedNormalized, candidateNormalized);
  assert.ok(openFound);
  assert.strictEqual(openFound.status, 'open');

  store.updateQueueStatus(openFound.id, 'merged');
  const mergedFound = store.findQueueEntryPair('tag', proposedNormalized, candidateNormalized);
  assert.ok(mergedFound);
  assert.strictEqual(mergedFound.status, 'merged');

  store.updateQueueStatus(openFound.id, 'rejected');
  const rejectedFound = store.findQueueEntryPair('tag', proposedNormalized, candidateNormalized);
  assert.ok(rejectedFound);
  assert.strictEqual(rejectedFound.status, 'rejected');
});

test('findQueueEntryPair findet einen Eintrag auch in umgekehrter Richtung (Backfill- vs. Live-Reihenfolge)', () => {
  const store = freshStore();
  const normalizedA = normalizeForType('Stadtwerke Musterstadt', 'correspondent');
  const normalizedB = normalizeForType('Stadtwerke Beispielstadt', 'correspondent');

  // Live-Resolver legt die Richtung nach Rolle fest: hier proposed=B, candidate=A.
  store.insertQueueEntry({
    entityType: 'correspondent', proposedName: 'Stadtwerke Beispielstadt', proposedId: 2,
    candidateName: 'Stadtwerke Musterstadt', candidateId: 1, similarity: 0.9,
    llmVerdict: 'unsure', llmReason: null, status: 'open'
  });

  // Der Backfill fragt spaeter in der Gegenrichtung (ID-basiert): proposed=A, candidate=B.
  const found = store.findQueueEntryPair('correspondent', normalizedA, normalizedB);
  assert.ok(found, 'sollte auch die umgekehrte Richtung treffen');
  assert.strictEqual(found.status, 'open');
});

test('countOpenQueueEntries zaehlt nur offene Eintraege', () => {
  const store = freshStore();
  assert.strictEqual(store.countOpenQueueEntries(), 0);
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: null });
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Mahnung', proposedId: 3, candidateName: 'Mahnungen', candidateId: 4, similarity: 0.75, llmVerdict: null, llmReason: null, status: 'rejected', documentId: null });
  assert.strictEqual(store.countOpenQueueEntries(), 1);
});

test('getEmbedding liefert null, wenn nichts gespeichert ist', () => {
  const store = freshStore();
  assert.strictEqual(store.getEmbedding('tag', 1), null);
});

test('upsertEmbedding und getEmbedding roundtrip mit Float32-Praezision', () => {
  const store = freshStore();
  const ok = store.upsertEmbedding({ entityType: 'document_type', id: 4, name: 'Meldebescheinigung', model: 'bge-m3', vector: [0.1, 0.2, 0.3] });
  assert.strictEqual(ok, true);

  const found = store.getEmbedding('document_type', 4);
  assert.strictEqual(found.entity_name, 'Meldebescheinigung');
  assert.strictEqual(found.model, 'bge-m3');
  assert.strictEqual(found.vector.length, 3);
  [0.1, 0.2, 0.3].forEach((v, i) => assert.ok(Math.abs(found.vector[i] - v) < 1e-6));
});

test('UNIQUE(entity_type, entity_id): erneutes Upsert ueberschreibt statt zu duplizieren', () => {
  const store = freshStore();
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'bge-m3', vector: [1, 0] });
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnungen', model: 'bge-m3', vector: [0, 1] });

  const found = store.getEmbedding('tag', 1);
  assert.strictEqual(found.entity_name, 'Rechnungen');
  assert.deepStrictEqual(found.vector, [0, 1]);
});

test('deleteEmbedding entfernt den Eintrag', () => {
  const store = freshStore();
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'bge-m3', vector: [1, 0] });
  store.deleteEmbedding('tag', 1);
  assert.strictEqual(store.getEmbedding('tag', 1), null);
});

test('Fehlerfall: geschlossene DB liefert Fallback statt zu werfen (Embeddings)', () => {
  const store = freshStore();
  store.close();
  assert.doesNotThrow(() => store.getEmbedding('tag', 1));
  assert.strictEqual(store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'X', model: 'bge-m3', vector: [1, 0] }), false);
  assert.doesNotThrow(() => store.deleteEmbedding('tag', 1));
});

test('entity_review_queue: trigram_similarity und embedding_similarity werden persistiert', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Entgeltabrechnung', proposedId: 9,
    candidateName: 'Verdienstbescheinigung', candidateId: 3,
    similarity: 0.85, trigramSimilarity: 0.10, embeddingSimilarity: 0.85,
    llmVerdict: 'same', llmReason: 'semantisch gleich', status: 'open'
  });

  const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE proposed_name = 'Entgeltabrechnung'`).get();
  assert.strictEqual(row.trigram_similarity, 0.10);
  assert.strictEqual(row.embedding_similarity, 0.85);
});

test('entity_review_queue: trigram_similarity/embedding_similarity bleiben null ohne Angabe (Rueckwaertskompatibilitaet)', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'A', proposedId: 1,
    candidateName: 'B', candidateId: 2, similarity: 0.7,
    llmVerdict: 'unsure', llmReason: null, status: 'open'
  });

  const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE proposed_name = 'A'`).get();
  assert.strictEqual(row.trigram_similarity, null);
  assert.strictEqual(row.embedding_similarity, null);
});

test('Migration: eine bestehende entity_review_queue ohne die neuen Spalten wird beim Oeffnen ergaenzt, Daten bleiben erhalten', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const Database = require('better-sqlite3');

  const dbPath = path.join(os.tmpdir(), `entity-store-migration-test-${process.pid}-${Math.floor(Math.random() * 1e6)}.db`);
  try {
    const raw = new Database(dbPath);
    raw.prepare(`
      CREATE TABLE entity_review_queue (
        id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, proposed_name TEXT NOT NULL,
        proposed_normalized TEXT NOT NULL, proposed_id INTEGER, candidate_name TEXT NOT NULL,
        candidate_normalized TEXT NOT NULL, candidate_id INTEGER NOT NULL, similarity REAL NOT NULL,
        llm_verdict TEXT, llm_reason TEXT, status TEXT NOT NULL, document_id INTEGER,
        created_at TEXT NOT NULL, resolved_at TEXT,
        UNIQUE(entity_type, proposed_normalized, candidate_normalized)
      )
    `).run();
    raw.prepare(`
      INSERT INTO entity_review_queue
        (entity_type, proposed_name, proposed_normalized, proposed_id, candidate_name, candidate_normalized, candidate_id, similarity, status, created_at)
      VALUES ('tag', 'Alt', 'alt', 1, 'Bestand', 'bestand', 2, 0.8, 'open', '2026-01-01T00:00:00.000Z')
    `).run();
    raw.close();

    const store = new EntityStore(dbPath);
    try {
      const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE proposed_name = 'Alt'`).get();
      assert.strictEqual(row.similarity, 0.8, 'bestehende Daten bleiben erhalten');
      assert.strictEqual(row.trigram_similarity, null);
      assert.strictEqual(row.embedding_similarity, null);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});

test('insertMergeLog schreibt einen Eintrag, listMergeLogForQueueEntry liefert ihn zurueck', () => {
  const store = freshStore();
  const ok = store.insertMergeLog({
    queueEntryId: 1, entityType: 'correspondent', fromId: 10, toId: 20,
    affectedCount: 5, chunksCompleted: 1, chunksTotal: 1, status: 'completed', errorMessage: null
  });
  assert.strictEqual(ok, true);

  const rows = store.listMergeLogForQueueEntry(1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'completed');
  assert.strictEqual(rows[0].affected_count, 5);
  assert.strictEqual(rows[0].from_id, 10);
  assert.strictEqual(rows[0].to_id, 20);
});

test('insertMergeLog speichert fehlgeschlagene Merges mit Fehlermeldung und Teilfortschritt', () => {
  const store = freshStore();
  store.insertMergeLog({
    queueEntryId: 2, entityType: 'tag', fromId: 30, toId: 40,
    affectedCount: 120, chunksCompleted: 1, chunksTotal: 2, status: 'failed', errorMessage: 'Netzwerkfehler'
  });

  const rows = store.listMergeLogForQueueEntry(2);
  assert.strictEqual(rows[0].status, 'failed');
  assert.strictEqual(rows[0].chunks_completed, 1);
  assert.strictEqual(rows[0].chunks_total, 2);
  assert.strictEqual(rows[0].error_message, 'Netzwerkfehler');
});

test('listMergeLogForQueueEntry liefert leeres Array ohne Eintraege', () => {
  const store = freshStore();
  assert.deepStrictEqual(store.listMergeLogForQueueEntry(999), []);
});

test('completeMerge schreibt Alias, Queue-Status und Merge-Log atomar (AUDIT-015)', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'correspondent', proposedName: 'Stadtwerke Beispielstadt', proposedId: 2,
    candidateName: 'Stadtwerke Musterstadt', candidateId: 1, similarity: 0.95,
    llmVerdict: null, llmReason: null, status: 'open'
  });
  const entry = store.listOpenQueueEntries()[0];

  const ok = store.completeMerge({
    alias: { entityType: 'correspondent', aliasNormalized: 'stadtwerke beispielstadt', canonicalName: 'Stadtwerke Musterstadt', canonicalId: 1, source: 'user' },
    queueEntryId: entry.id,
    mergeLog: { queueEntryId: entry.id, entityType: 'correspondent', fromId: 2, toId: 1, affectedCount: 3, chunksCompleted: 1, chunksTotal: 1, status: 'completed', errorMessage: null }
  });

  assert.strictEqual(ok, true);
  assert.strictEqual(store.getQueueEntryById(entry.id).status, 'merged');
  assert.ok(store.findAlias('correspondent', 'stadtwerke beispielstadt'));
  assert.strictEqual(store.listMergeLogForQueueEntry(entry.id).length, 1);
});

test('completeMerge rollt Alias und Merge-Log zurueck, wenn der Queue-Eintrag nicht existiert (AUDIT-015)', () => {
  const store = freshStore();

  const ok = store.completeMerge({
    alias: { entityType: 'correspondent', aliasNormalized: 'nichtvorhanden', canonicalName: 'X', canonicalId: 1, source: 'user' },
    queueEntryId: 999999,
    mergeLog: { queueEntryId: 999999, entityType: 'correspondent', fromId: 2, toId: 1, affectedCount: 0, chunksCompleted: 0, chunksTotal: 0, status: 'completed', errorMessage: null }
  });

  assert.strictEqual(ok, false);
  assert.strictEqual(store.findAlias('correspondent', 'nichtvorhanden'), null, 'Alias-Insert muss zurueckgerollt sein');
  assert.deepStrictEqual(store.listMergeLogForQueueEntry(999999), [], 'Merge-Log-Insert muss zurueckgerollt sein');
});
