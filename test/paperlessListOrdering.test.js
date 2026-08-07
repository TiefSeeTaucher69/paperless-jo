const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

function withMockClient(mockClient, fn) {
  const original = paperlessService.client;
  paperlessService.client = mockClient;
  return fn().finally(() => { paperlessService.client = original; });
}

test('listCorrespondentsNames fragt mit ordering=name ab (AUDIT-019)', async () => {
  const calls = [];
  const mockClient = {
    get: async (url, requestConfig) => {
      calls.push({ url, params: requestConfig.params });
      return { data: { results: [{ id: 1, name: 'B', document_count: 2 }], next: null } };
    }
  };

  const result = await withMockClient(mockClient, () => paperlessService.listCorrespondentsNames());

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/correspondents/');
  assert.strictEqual(calls[0].params.ordering, 'name');
  assert.deepStrictEqual(result, [{ name: 'B', id: 1, document_count: 2 }]);
});

test('listDocumentTypesNames fragt mit ordering=name ab (AUDIT-019)', async () => {
  const calls = [];
  const mockClient = {
    get: async (url, requestConfig) => {
      calls.push({ url, params: requestConfig.params });
      return { data: { results: [{ id: 5, name: 'Rechnung' }], next: null } };
    }
  };

  const result = await withMockClient(mockClient, () => paperlessService.listDocumentTypesNames());

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/document_types/');
  assert.strictEqual(calls[0].params.ordering, 'name');
  assert.deepStrictEqual(result, [{ name: 'Rechnung', id: 5 }]);
});

test('listDocumentTypesWithCounts liefert id, name und document_count je Dokumentart', async () => {
  const mockClient = {
    get: async (url, requestConfig) => {
      assert.strictEqual(url, '/document_types/');
      assert.strictEqual(requestConfig.params.ordering, 'name');
      return {
        data: {
          results: [
            { id: 5, name: 'Meldebescheinigung', document_count: 0 },
            { id: 6, name: 'Entgeltabrechnung', document_count: 24 }
          ],
          next: null
        }
      };
    }
  };

  const result = await withMockClient(mockClient, () => paperlessService.listDocumentTypesWithCounts());
  assert.deepStrictEqual(result, [
    { id: 5, name: 'Meldebescheinigung', document_count: 0 },
    { id: 6, name: 'Entgeltabrechnung', document_count: 24 }
  ]);
});

test('listDocumentTypesWithCounts paginiert ueber mehrere Seiten', async () => {
  let call = 0;
  const mockClient = {
    get: async () => {
      call++;
      return call === 1
        ? { data: { results: [{ id: 1, name: 'A', document_count: 1 }], next: '/document_types/?page=2' } }
        : { data: { results: [{ id: 2, name: 'B', document_count: 0 }], next: null } };
    }
  };

  const result = await withMockClient(mockClient, () => paperlessService.listDocumentTypesWithCounts());
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[1].document_count, 0);
});
