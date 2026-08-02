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
    /Merge incomplete/
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

test('mergeEntity mit dryRun=false behandelt 404 beim Loeschen als bereits erledigt', async () => {
  let getCallCount = 0;
  const mockClient = {
    get: async () => {
      getCallCount++;
      return getCallCount === 1
        ? { data: { results: [{ id: 50 }], next: null } }
        : { data: { results: [], next: null } };
    },
    post: async () => ({ data: {} }),
    delete: async () => {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      throw error;
    }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.mergeEntity('tag', 9, 10, { dryRun: false })
  );

  assert.deepStrictEqual(result, { affectedCount: 1, documentIds: [50], deleted: true });
});

test('mergeEntity mit dryRun=false wirft weiter, wenn das Loeschen nicht mit 404 fehlschlaegt', async () => {
  let getCallCount = 0;
  const mockClient = {
    get: async () => {
      getCallCount++;
      return getCallCount === 1
        ? { data: { results: [{ id: 60 }], next: null } }
        : { data: { results: [], next: null } };
    },
    post: async () => ({ data: {} }),
    delete: async () => {
      const error = new Error('Request failed with status code 500');
      error.response = { status: 500 };
      throw error;
    }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.mergeEntity('tag', 11, 12, { dryRun: false })),
    /500/
  );
});

test('mergeEntity wirft bei fromId=null und stellt keinen HTTP-Request', async () => {
  const mockClient = {
    get: async () => { throw new Error('get haette nicht aufgerufen werden duerfen'); },
    post: async () => { throw new Error('post haette nicht aufgerufen werden duerfen'); },
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.mergeEntity('tag', null, 6, { dryRun: true })),
    /ungueltige IDs/
  );
});

test('mergeEntity wirft bei fromId === toId', async () => {
  const mockClient = {
    get: async () => { throw new Error('get haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.mergeEntity('tag', 5, 5, { dryRun: true })),
    /ungueltige IDs/
  );
});

test('mergeEntity wirft bei nicht-positiven oder nicht-ganzzahligen IDs', async () => {
  const mockClient = {
    get: async () => { throw new Error('get haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(() => withMockClient(mockClient, () => paperlessService.mergeEntity('tag', -1, 6, { dryRun: true })), /ungueltige IDs/);
  await assert.rejects(() => withMockClient(mockClient, () => paperlessService.mergeEntity('tag', 5, 0, { dryRun: true })), /ungueltige IDs/);
  await assert.rejects(() => withMockClient(mockClient, () => paperlessService.mergeEntity('tag', 5.5, 6, { dryRun: true })), /ungueltige IDs/);
  await assert.rejects(() => withMockClient(mockClient, () => paperlessService.mergeEntity('tag', 5, undefined, { dryRun: true })), /ungueltige IDs/);
});

test('getOpenReviewQueueCount liefert die Anzahl offener Queue-Eintraege', () => {
  const original = paperlessService._entityResolverInstance;
  paperlessService._entityResolverInstance = { store: { countOpenQueueEntries: () => 3 } };

  try {
    assert.strictEqual(paperlessService.getOpenReviewQueueCount(), 3);
  } finally {
    paperlessService._entityResolverInstance = original;
  }
});

test('getExampleDocumentsForEntity fragt eine begrenzte Anzahl Dokumente mit Titel ab', async () => {
  const calls = [];
  const mockClient = {
    get: async (url, config) => {
      calls.push({ url, config });
      return { data: { results: [{ id: 1, title: 'Rechnung Januar' }, { id: 2, title: 'Rechnung Februar' }] } };
    }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.getExampleDocumentsForEntity('tag', 42, 3)
  );

  assert.deepStrictEqual(result, [{ id: 1, title: 'Rechnung Januar' }, { id: 2, title: 'Rechnung Februar' }]);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/documents/');
  assert.deepStrictEqual(calls[0].config.params, { tags__id: 42, page: 1, page_size: 3, fields: 'id,title' });
});

test('getExampleDocumentsForEntity nutzt das richtige Filterfeld je Typ', async () => {
  const capturedParams = [];
  const mockClient = {
    get: async (url, config) => { capturedParams.push(config.params); return { data: { results: [] } }; }
  };

  await withMockClient(mockClient, async () => {
    await paperlessService.getExampleDocumentsForEntity('correspondent', 1, 3);
    await paperlessService.getExampleDocumentsForEntity('document_type', 2, 3);
  });

  assert.ok('correspondent__id' in capturedParams[0]);
  assert.ok('document_type__id' in capturedParams[1]);
});

test('getExampleDocumentsForEntity wirft bei unbekanntem Typ', async () => {
  await assert.rejects(
    () => paperlessService.getExampleDocumentsForEntity('unknown', 1, 3),
    /unknown type/
  );
});

test('_bulkReassignDocuments chunkt bei mehr als 100 Dokumenten in mehrere bulk_edit-Aufrufe', async () => {
  const documentIds = Array.from({ length: 250 }, (_, i) => i + 1);
  const bulkEditCalls = [];
  const mockClient = {
    post: async (url, body) => { bulkEditCalls.push(body); return { data: {} }; }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService._bulkReassignDocuments('tag', documentIds, 5, 6)
  );

  assert.strictEqual(bulkEditCalls.length, 3);
  assert.strictEqual(bulkEditCalls[0].documents.length, 100);
  assert.strictEqual(bulkEditCalls[1].documents.length, 100);
  assert.strictEqual(bulkEditCalls[2].documents.length, 50);
  assert.deepStrictEqual(bulkEditCalls[0].parameters, { add_tags: [6], remove_tags: [5] });
  assert.deepStrictEqual(result, { chunksCompleted: 3, chunksTotal: 3 });
});

test('_bulkReassignDocuments schickt bei <=100 Dokumenten genau einen bulk_edit-Aufruf', async () => {
  const bulkEditCalls = [];
  const mockClient = {
    post: async (url, body) => { bulkEditCalls.push(body); return { data: {} }; }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService._bulkReassignDocuments('correspondent', [1, 2, 3], 7, 8)
  );

  assert.strictEqual(bulkEditCalls.length, 1);
  assert.deepStrictEqual(result, { chunksCompleted: 1, chunksTotal: 1 });
});
