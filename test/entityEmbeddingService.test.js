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
