const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const DocumentFingerprintStore = require('../models/documentFingerprintStore');
const { buildReport, tableExists } = require('../scripts/fingerprint-observation-report');

test('buildReport liefert total=0 und leere Listen ohne gespeicherte Beobachtungen', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    const report = buildReport(store.db);
    assert.strictEqual(report.total, 0);
    assert.deepStrictEqual(report.byCorrespondent, []);
    assert.deepStrictEqual(report.bySimilarityBand, []);
    assert.deepStrictEqual(report.recent, []);
  } finally {
    store.close();
  }
});

test('buildReport gruppiert nach Korrespondent und Aehnlichkeits-Band', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.recordObservation({ correspondentId: 5, matchedDocumentId: 1, similarity: 0.93, tagIds: [1], documentTypeId: null });
    store.recordObservation({ correspondentId: 5, matchedDocumentId: 2, similarity: 0.82, tagIds: [2], documentTypeId: 3 });
    store.recordObservation({ correspondentId: 9, matchedDocumentId: 3, similarity: 0.99, tagIds: [1], documentTypeId: null });

    const report = buildReport(store.db);

    assert.strictEqual(report.total, 3);
    const byCorrespondent = Object.fromEntries(report.byCorrespondent.map(r => [r.correspondent_id, r.n]));
    assert.deepStrictEqual(byCorrespondent, { 5: 2, 9: 1 });

    const bands = Object.fromEntries(report.bySimilarityBand.map(r => [r.band, r.n]));
    assert.strictEqual(bands['0.80-0.85'], 1);
    assert.strictEqual(bands['0.90-0.95'], 1);
    assert.strictEqual(bands['0.95-1.00'], 1);
  } finally {
    store.close();
  }
});

test('buildReport liefert die juengsten Beobachtungen zuerst, begrenzt auf 20', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    for (let i = 1; i <= 25; i++) {
      store.recordObservation({ correspondentId: 5, matchedDocumentId: i, similarity: 0.9, tagIds: [1], documentTypeId: null });
    }
    const report = buildReport(store.db);
    assert.strictEqual(report.recent.length, 20);
    assert.strictEqual(report.recent[0].matched_document_id, 25);
  } finally {
    store.close();
  }
});

test('buildReport enthaelt document_id in den juengsten Beobachtungen (Finding 1)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.recordObservation({ documentId: 77, correspondentId: 5, matchedDocumentId: 101, similarity: 0.93, tagIds: [1], documentTypeId: null });
    const report = buildReport(store.db);
    assert.strictEqual(report.recent[0].document_id, 77);
  } finally {
    store.close();
  }
});

test('tableExists liefert true fuer eine vorhandene Tabelle (Finding 2)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    assert.strictEqual(tableExists(store.db, 'document_fingerprint_observations'), true);
  } finally {
    store.close();
  }
});

test('tableExists liefert false fuer eine Datenbank ohne die Beobachtungstabelle (Finding 2)', () => {
  // Simuliert eine Instanz, auf der DOCUMENT_FINGERPRINT_ENABLED nie aktiviert war: die Tabelle
  // wurde nie angelegt, weil DocumentFingerprintStore nie instanziiert wurde.
  const db = new Database(':memory:');
  try {
    assert.strictEqual(tableExists(db, 'document_fingerprint_observations'), false);
  } finally {
    db.close();
  }
});
