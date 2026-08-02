const { test } = require('node:test');
const assert = require('node:assert');
const entityEmbeddingService = require('../services/entityEmbeddingService');

function captureRequest(responseData) {
  const captured = {};
  entityEmbeddingService.client = {
    post: async (url, body) => {
      captured.url = url;
      captured.body = body;
      return { data: responseData };
    }
  };
  return captured;
}

test('embed sendet model und input an /api/embed und liefert den ersten Vektor', async () => {
  const captured = captureRequest({ embeddings: [[0.1, 0.2, 0.3]] });
  const vector = await entityEmbeddingService.embed('Entgeltabrechnung');

  assert.ok(captured.url.endsWith('/api/embed'));
  assert.strictEqual(captured.body.input, 'Entgeltabrechnung');
  assert.ok(captured.body.model);
  assert.deepStrictEqual(vector, [0.1, 0.2, 0.3]);
});

test('embed wirft, wenn die Antwort keinen gueltigen Vektor enthaelt', async () => {
  captureRequest({ embeddings: [] });
  await assert.rejects(() => entityEmbeddingService.embed('X'), /keinen gueltigen Vektor/);
});

test('embed wirft bei Netzwerkfehler (Aufrufer faengt das ab)', async () => {
  entityEmbeddingService.client = { post: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => entityEmbeddingService.embed('X'), /ECONNREFUSED/);
});

test('cosineSimilarity: identische Vektoren ergeben 1', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [1, 0]), 1);
});

test('cosineSimilarity: orthogonale Vektoren ergeben 0', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: entgegengesetzte Vektoren ergeben -1', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [-1, 0]), -1);
});

test('cosineSimilarity: Nullvektor ergibt 0 statt NaN', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([0, 0], [1, 1]), 0);
});

test('cosineSimilarity: unterschiedliche Vektorlaenge ergibt 0', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [1, 0, 0]), 0);
});

const EntityStore = require('../models/entityStore');

test('getOrComputeEmbedding: Cache-Treffer liest ohne Ollama-Call', async () => {
  const store = new EntityStore(':memory:');
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'bge-m3', vector: [0.5, 0.5] });
  entityEmbeddingService.client = { post: async () => { throw new Error('sollte nicht aufgerufen werden'); } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 1, name: 'Rechnung' });
  assert.ok(Math.abs(vector[0] - 0.5) < 1e-6 && Math.abs(vector[1] - 0.5) < 1e-6);
});

test('getOrComputeEmbedding: fehlender Cache-Eintrag wird berechnet und gecached', async () => {
  const store = new EntityStore(':memory:');
  let calls = 0;
  entityEmbeddingService.client = { post: async () => { calls++; return { data: { embeddings: [[0.1, 0.2]] } }; } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 5, name: 'Mahnung' });
  assert.deepStrictEqual(vector, [0.1, 0.2]);
  assert.strictEqual(calls, 1);

  const cached = store.getEmbedding('tag', 5);
  assert.ok(cached);
});

test('getOrComputeEmbedding: Umbenennung macht den Cache-Eintrag stale, wird neu berechnet', async () => {
  const store = new EntityStore(':memory:');
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Alter Name', model: 'bge-m3', vector: [1, 0] });
  let calls = 0;
  entityEmbeddingService.client = { post: async () => { calls++; return { data: { embeddings: [[0, 1]] } }; } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 1, name: 'Neuer Name' });
  assert.deepStrictEqual(vector, [0, 1]);
  assert.strictEqual(calls, 1);
});

test('getOrComputeEmbedding: Modellwechsel macht den Cache-Eintrag stale, wird neu berechnet', async () => {
  const store = new EntityStore(':memory:');
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'ein-anderes-modell', vector: [1, 0] });
  let calls = 0;
  entityEmbeddingService.client = { post: async () => { calls++; return { data: { embeddings: [[0, 1]] } }; } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 1, name: 'Rechnung' });
  assert.deepStrictEqual(vector, [0, 1]);
  assert.strictEqual(calls, 1);
});
