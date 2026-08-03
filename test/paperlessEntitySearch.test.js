const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

function withMockClient(mockClient, fn) {
  const original = paperlessService.client;
  paperlessService.client = mockClient;
  return fn().finally(() => { paperlessService.client = original; });
}

test('searchForExistingCorrespondent fragt mit name__iexact statt name__icontains ab (AUDIT-017)', async () => {
  const calls = [];
  const mockClient = {
    get: async (url, requestConfig) => {
      calls.push({ url, params: requestConfig.params });
      return { data: { results: [{ id: 7, name: 'Stadtwerke Musterstadt' }] } };
    }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.searchForExistingCorrespondent('Stadtwerke Musterstadt')
  );

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/correspondents/');
  assert.deepStrictEqual(calls[0].params, { name__iexact: 'Stadtwerke Musterstadt' });
  assert.deepStrictEqual(result, { id: 7, name: 'Stadtwerke Musterstadt' });
});

test('searchForExistingCorrespondent liefert null, wenn keine Ergebnisse zurueckkommen', async () => {
  const mockClient = { get: async () => ({ data: { results: [] } }) };
  const result = await withMockClient(mockClient, () =>
    paperlessService.searchForExistingCorrespondent('Unbekannt')
  );
  assert.strictEqual(result, null);
});

test('searchForExistingDocumentType fragt mit name__iexact statt name__icontains ab (AUDIT-017)', async () => {
  const calls = [];
  const mockClient = {
    get: async (url, requestConfig) => {
      calls.push({ url, params: requestConfig.params });
      return { data: { results: [{ id: 3, name: 'Rechnung' }] } };
    }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.searchForExistingDocumentType('Rechnung')
  );

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/document_types/');
  assert.deepStrictEqual(calls[0].params, { name__iexact: 'Rechnung' });
  assert.deepStrictEqual(result, { id: 3, name: 'Rechnung' });
});

test('searchForExistingDocumentType liefert null, wenn keine Ergebnisse zurueckkommen', async () => {
  const mockClient = { get: async () => ({ data: { results: [] } }) };
  const result = await withMockClient(mockClient, () =>
    paperlessService.searchForExistingDocumentType('Unbekannt')
  );
  assert.strictEqual(result, null);
});
