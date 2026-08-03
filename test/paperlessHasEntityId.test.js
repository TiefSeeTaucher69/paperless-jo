const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

// Seeded direkt statt ueber einen gemockten Client: ensureTagCache()/ensureDocumentTypeCache()
// ueberspringen den Refresh, wenn die Cache-Map nicht leer und juenger als CACHE_LIFETIME
// (3s) ist - so bleibt der Test unabhaengig vom HTTP-Pfad.
function withSeededCache(cacheKey, refreshKey, entries, fn) {
  const cache = paperlessService[cacheKey];
  const savedEntries = new Map(cache);
  const savedRefresh = paperlessService[refreshKey];

  cache.clear();
  entries.forEach(e => cache.set(e.name.toLowerCase(), e));
  paperlessService[refreshKey] = Date.now();

  return Promise.resolve(fn()).finally(() => {
    cache.clear();
    savedEntries.forEach((v, k) => cache.set(k, v));
    paperlessService[refreshKey] = savedRefresh;
  });
}

test('hasTagId liefert true fuer eine im Cache vorhandene Tag-ID (AUDIT-006)', async () => {
  const result = await withSeededCache('tagCache', 'lastTagRefresh', [{ id: 7, name: 'Rechnung' }], () =>
    paperlessService.hasTagId(7)
  );
  assert.strictEqual(result, true);
});

test('hasTagId liefert false fuer eine nicht (mehr) existierende Tag-ID (AUDIT-006)', async () => {
  const result = await withSeededCache('tagCache', 'lastTagRefresh', [{ id: 7, name: 'Rechnung' }], () =>
    paperlessService.hasTagId(999)
  );
  assert.strictEqual(result, false);
});

test('hasDocumentTypeId liefert true fuer eine im Cache vorhandene Dokumenttyp-ID (AUDIT-006)', async () => {
  const result = await withSeededCache('documentTypeCache', 'lastDocumentTypeRefresh', [{ id: 3, name: 'Rechnung' }], () =>
    paperlessService.hasDocumentTypeId(3)
  );
  assert.strictEqual(result, true);
});

test('hasDocumentTypeId liefert false fuer eine nicht (mehr) existierende Dokumenttyp-ID (AUDIT-006)', async () => {
  const result = await withSeededCache('documentTypeCache', 'lastDocumentTypeRefresh', [{ id: 3, name: 'Rechnung' }], () =>
    paperlessService.hasDocumentTypeId(999)
  );
  assert.strictEqual(result, false);
});
