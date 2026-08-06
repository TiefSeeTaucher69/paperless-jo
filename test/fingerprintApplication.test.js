const { test } = require('node:test');
const assert = require('node:assert');
const { applyFingerprintTags, applyFingerprintDocumentType } = require('../services/documentProcessingPipeline');

test('applyFingerprintTags setzt updateData.tags und liefert true, wenn der Treffer Tags hat', () => {
  const updateData = {};
  const result = applyFingerprintTags({ tagIds: [1, 2], documentTypeId: 3 }, updateData);

  assert.strictEqual(result, true);
  assert.deepStrictEqual(updateData.tags, [1, 2]);
});

test('applyFingerprintTags setzt nichts und liefert false, wenn kein Treffer vorliegt', () => {
  const updateData = {};
  const result = applyFingerprintTags(null, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.tags, undefined);
});

test('applyFingerprintTags setzt nichts und liefert false, wenn der Treffer keine Tags hat (NACHAUDIT-13)', () => {
  const updateData = {};
  const result = applyFingerprintTags({ tagIds: [], documentTypeId: 3 }, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.tags, undefined);
});

test('applyFingerprintDocumentType setzt updateData.document_type und liefert true, wenn der Treffer eine Dokumentart hat', () => {
  const updateData = {};
  const result = applyFingerprintDocumentType({ tagIds: [1], documentTypeId: 3 }, updateData);

  assert.strictEqual(result, true);
  assert.strictEqual(updateData.document_type, 3);
});

test('applyFingerprintDocumentType setzt nichts und liefert false, wenn kein Treffer vorliegt', () => {
  const updateData = {};
  const result = applyFingerprintDocumentType(null, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.document_type, undefined);
});

test('applyFingerprintDocumentType setzt nichts und liefert false, wenn der Treffer keine Dokumentart hat (NACHAUDIT-13)', () => {
  const updateData = {};
  const result = applyFingerprintDocumentType({ tagIds: [1], documentTypeId: null }, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.document_type, undefined);
});
