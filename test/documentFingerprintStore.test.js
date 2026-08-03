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

test('upsertFingerprint speichert source, findCandidates liefert es zurueck (AUDIT-003)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({
      documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1],
      embedding: [1, 0], model: 'bge-m3', source: 'llm'
    });
    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates[0].source, 'llm');
  } finally {
    store.close();
  }
});

test('upsertFingerprint ohne explizites source speichert den Default "llm"', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'bge-m3' });
    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates[0].source, 'llm');
  } finally {
    store.close();
  }
});

test('findCandidates schliesst inherited-Fingerprints aus - sie duerfen selbst nicht mehr weitervererben (AUDIT-003)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'bge-m3', source: 'llm' });
    store.upsertFingerprint({ documentId: 2, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'bge-m3', source: 'inherited' });

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentId, 1);
  } finally {
    store.close();
  }
});

test('invalidateForMerge aktualisiert correspondent_id bei einem Korrespondenten-Merge (AUDIT-006)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'bge-m3' });
    store.invalidateForMerge('correspondent', 5, 9);

    const candidates = store.findCandidates(9);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentId, 1);
    assert.strictEqual(store.findCandidates(5).length, 0);
  } finally {
    store.close();
  }
});

test('invalidateForMerge aktualisiert document_type_id bei einem Dokumenttyp-Merge (AUDIT-006)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 3, tagIds: [1], embedding: [1, 0], model: 'bge-m3' });
    store.invalidateForMerge('document_type', 3, 4);

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates[0].documentTypeId, 4);
  } finally {
    store.close();
  }
});

test('invalidateForMerge ersetzt eine gemergte Tag-ID innerhalb von tag_ids und dedupliziert (AUDIT-006)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [10, 20], embedding: [1, 0], model: 'bge-m3' });
    store.upsertFingerprint({ documentId: 2, correspondentId: 5, documentTypeId: 1, tagIds: [10, 30], embedding: [1, 0], model: 'bge-m3' });
    store.invalidateForMerge('tag', 10, 30);

    const candidates = store.findCandidates(5).sort((a, b) => a.documentId - b.documentId);
    assert.deepStrictEqual(candidates[0].tagIds, [30, 20]);
    assert.deepStrictEqual(candidates[1].tagIds, [30]); // dedupliziert statt [30, 30]
  } finally {
    store.close();
  }
});

test('invalidateForMerge laesst Zeilen unberuehrt, deren tag_ids die fromId nur als Teilstring enthaelt (z.B. 12 bei fromId=1)', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [12], embedding: [1, 0], model: 'bge-m3' });
    store.invalidateForMerge('tag', 1, 99);

    assert.deepStrictEqual(store.findCandidates(5)[0].tagIds, [12]);
  } finally {
    store.close();
  }
});
