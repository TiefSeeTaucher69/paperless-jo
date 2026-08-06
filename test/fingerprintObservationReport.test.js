const { test } = require('node:test');
const assert = require('node:assert');
const DocumentFingerprintStore = require('../models/documentFingerprintStore');
const { buildReport } = require('../scripts/fingerprint-observation-report');

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
