const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

function withMockClient(mockClient, fn) {
  const original = paperlessService.client;
  paperlessService.client = mockClient;
  return fn().finally(() => { paperlessService.client = original; });
}

test('overwriteDocumentFields schickt title/tags/correspondent unveraendert als PATCH-Body, ohne mit dem aktuellen Dokument zu vereinigen', async () => {
  const patchCalls = [];
  const mockClient = {
    patch: async (url, body) => { patchCalls.push({ url, body }); return { data: {} }; },
    get: async () => ({ data: { id: 42, title: 'Original', tags: [1], correspondent: 5 } })
  };

  await withMockClient(mockClient, () =>
    paperlessService.overwriteDocumentFields(42, { title: 'Original', tags: [1], correspondent: 5 })
  );

  assert.strictEqual(patchCalls.length, 1);
  assert.strictEqual(patchCalls[0].url, '/documents/42/');
  assert.deepStrictEqual(patchCalls[0].body, { title: 'Original', tags: [1], correspondent: 5 });
});

test('overwriteDocumentFields kann Tags/Korrespondent gegenueber dem aktuellen Stand entfernen (Replace- statt Union-Semantik)', async () => {
  const patchCalls = [];
  const mockClient = {
    patch: async (url, body) => { patchCalls.push({ url, body }); return { data: {} }; },
    // Aktuelles Dokument hat mehr Tags und einen Korrespondenten als der Zielzustand -
    // eine Union-Logik (wie updateDocument()) wuerde das Tag 99/den Korrespondenten 7 behalten.
    get: async () => ({ data: { id: 42, title: 'Geaendert', tags: [1, 99], correspondent: 7 } })
  };

  await withMockClient(mockClient, () =>
    paperlessService.overwriteDocumentFields(42, { title: 'Original', tags: [1], correspondent: null })
  );

  assert.deepStrictEqual(patchCalls[0].body, { title: 'Original', tags: [1], correspondent: null });
});

test('overwriteDocumentFields gibt das aktualisierte Dokument zurueck', async () => {
  const mockClient = {
    patch: async () => ({ data: {} }),
    get: async () => ({ data: { id: 42, title: 'Original', tags: [1], correspondent: 5 } })
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.overwriteDocumentFields(42, { title: 'Original', tags: [1], correspondent: 5 })
  );

  assert.deepStrictEqual(result, { id: 42, title: 'Original', tags: [1], correspondent: 5 });
});

test('overwriteDocumentFields wirft weiter, wenn der PATCH fehlschlaegt (kein stilles Verschlucken)', async () => {
  const mockClient = {
    patch: async () => { throw new Error('Network error'); },
    get: async () => ({ data: {} })
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.overwriteDocumentFields(42, { title: 'T', tags: [], correspondent: null })),
    /Network error/
  );
});
