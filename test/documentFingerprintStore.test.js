const { test } = require('node:test');
const assert = require('node:assert');
const DocumentFingerprintStore = require('../models/documentFingerprintStore');

test('upsertFingerprint speichert, findCandidates liefert ihn fuer denselben Korrespondenten zurueck', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({
      documentId: 101, correspondentId: 5, documentTypeId: 3,
      tagIds: [1, 2], embedding: [1, 0, 0], model: 'bge-m3'
    });

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentId, 101);
    assert.strictEqual(candidates[0].correspondentId, 5);
    assert.strictEqual(candidates[0].documentTypeId, 3);
    assert.deepStrictEqual(candidates[0].tagIds, [1, 2]);
    assert.deepStrictEqual(candidates[0].embedding, [1, 0, 0]);
    assert.strictEqual(candidates[0].model, 'bge-m3');
  } finally {
    store.close();
  }
});

test('findCandidates liefert leeres Array fuer Korrespondenten ohne gespeicherten Fingerprint', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    assert.deepStrictEqual(store.findCandidates(999), []);
  } finally {
    store.close();
  }
});

test('findCandidates filtert nach correspondent_id, liefert nicht die Fingerprints anderer Korrespondenten', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'bge-m3' });
    store.upsertFingerprint({ documentId: 2, correspondentId: 6, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'bge-m3' });

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentId, 1);
  } finally {
    store.close();
  }
});

test('upsertFingerprint bei gleicher document_id ersetzt statt zu duplizieren', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'old-model' });
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 2, tagIds: [9], embedding: [0, 1], model: 'bge-m3' });

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentTypeId, 2);
    assert.deepStrictEqual(candidates[0].tagIds, [9]);
    assert.deepStrictEqual(candidates[0].embedding, [0, 1]);
    assert.strictEqual(candidates[0].model, 'bge-m3'); // ON CONFLICT ersetzt auch model, nicht nur die uebrigen Spalten
  } finally {
    store.close();
  }
});

test('findCandidates liefert model mit zurueck, upsertFingerprint speichert es', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({
      documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1],
      embedding: [1, 0], model: 'bge-m3'
    });
    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates[0].model, 'bge-m3');
  } finally {
    store.close();
  }
});
