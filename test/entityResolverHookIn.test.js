const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

test('correspondentCache und documentTypeCache existieren und sind leer vor erstem Refresh', () => {
  assert.ok(paperlessService.correspondentCache instanceof Map);
  assert.ok(paperlessService.documentTypeCache instanceof Map);
});

test('ensureCorrespondentCache befuellt den Cache aus listCorrespondentsNames', async () => {
  paperlessService.listCorrespondentsNames = async () => ([{ id: 1, name: 'Stadtwerke Musterstadt', document_count: 3 }]);
  paperlessService.correspondentCache.clear();
  paperlessService.lastCorrespondentRefresh = 0;

  await paperlessService.ensureCorrespondentCache();

  assert.strictEqual(paperlessService.correspondentCache.get('stadtwerke musterstadt').id, 1);
});

test('ensureDocumentTypeCache befuellt den Cache aus listDocumentTypesNames', async () => {
  paperlessService.listDocumentTypesNames = async () => ([{ id: 2, name: 'Rechnung' }]);
  paperlessService.documentTypeCache.clear();
  paperlessService.lastDocumentTypeRefresh = 0;

  await paperlessService.ensureDocumentTypeCache();

  assert.strictEqual(paperlessService.documentTypeCache.get('rechnung').id, 2);
});
