const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

function withMockClient(mockClient, fn) {
  const original = paperlessService.client;
  paperlessService.client = mockClient;
  return fn().finally(() => { paperlessService.client = original; });
}

test('mergeEntity mit dryRun=true fragt nur ab, schreibt und loescht nichts', async () => {
  const calls = [];
  const mockClient = {
    get: async (url, config) => {
      calls.push({ method: 'get', url, config });
      return { data: { results: [{ id: 10 }, { id: 11 }], next: null } };
    },
    post: async () => { throw new Error('post haette nicht aufgerufen werden duerfen'); },
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.mergeEntity('tag', 5, 6, { dryRun: true })
  );

  assert.deepStrictEqual(result, { affectedCount: 2, documentIds: [10, 11], deleted: false });
  assert.strictEqual(calls.filter(c => c.method === 'get').length, 1);
});

test('mergeEntity mit dryRun=false hängt um, verifiziert und loescht', async () => {
  let getCallCount = 0;
  const bulkEditCalls = [];
  const mockClient = {
    get: async () => {
      getCallCount++;
      // Erster Aufruf (vor dem Umhaengen) findet Dokumente, zweiter (danach) findet keine mehr.
      return getCallCount === 1
        ? { data: { results: [{ id: 20 }], next: null } }
        : { data: { results: [], next: null } };
    },
    post: async (url, body) => {
      bulkEditCalls.push({ url, body });
      return { data: {} };
    },
    delete: async (url) => ({ data: {}, url })
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.mergeEntity('correspondent', 7, 8, { dryRun: false })
  );

  assert.deepStrictEqual(result, { affectedCount: 1, documentIds: [20], deleted: true });
  assert.strictEqual(bulkEditCalls.length, 1);
  assert.strictEqual(bulkEditCalls[0].url, '/documents/bulk_edit/');
  assert.deepStrictEqual(bulkEditCalls[0].body, {
    documents: [20],
    method: 'set_correspondent',
    parameters: { correspondent: 8 }
  });
});

test('mergeEntity mit dryRun=false wirft und loescht nicht, wenn Dokumente uebrig bleiben', async () => {
  const mockClient = {
    get: async () => ({ data: { results: [{ id: 30 }], next: null } }), // bleibt bei jedem Aufruf gleich
    post: async () => ({ data: {} }),
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.mergeEntity('document_type', 1, 2, { dryRun: false })),
    /Merge unvollstaendig/
  );
});

test('mergeEntity fuer type=tag nutzt modify_tags mit add_tags/remove_tags', async () => {
  let getCallCount = 0;
  const bulkEditCalls = [];
  const mockClient = {
    get: async () => {
      getCallCount++;
      return getCallCount === 1
        ? { data: { results: [{ id: 40 }], next: null } }
        : { data: { results: [], next: null } };
    },
    post: async (url, body) => { bulkEditCalls.push(body); return { data: {} }; },
    delete: async () => ({ data: {} })
  };

  await withMockClient(mockClient, () => paperlessService.mergeEntity('tag', 100, 200, { dryRun: false }));

  assert.deepStrictEqual(bulkEditCalls[0], {
    documents: [40],
    method: 'modify_tags',
    parameters: { add_tags: [200], remove_tags: [100] }
  });
});
