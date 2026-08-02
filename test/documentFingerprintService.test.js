const { test } = require('node:test');
const assert = require('node:assert');
const DocumentFingerprintService = require('../services/documentFingerprintService');

function fakeEmbeddingService(vectorsByText) {
  return {
    embed: async (text) => {
      if (!(text in vectorsByText)) throw new Error(`kein Test-Vektor fuer "${text}" hinterlegt`);
      return vectorsByText[text];
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
  };
}

function fakeStore(candidates = []) {
  const upserts = [];
  return {
    findCandidates: () => candidates,
    upsertFingerprint: (args) => { upserts.push(args); return true; },
    upserts
  };
}

test('findMatch: keine Kandidaten -> null', async () => {
  const store = fakeStore([]);
  const embeddingService = fakeEmbeddingService({});
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const result = await service.findMatch(5, 'Inhalt egal');
  assert.strictEqual(result, null);
});

test('findMatch: Kandidat ueber Schwelle -> tagIds/documentTypeId des Kandidaten', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0], model: 'bge-m3' }
  ]);
  const embeddingService = fakeEmbeddingService({ 'Gehaltsabrechnung Juli': [1, 0] }); // Cosine = 1
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const result = await service.findMatch(5, 'Gehaltsabrechnung Juli');
  assert.deepStrictEqual(result, { tagIds: [1, 2], documentTypeId: 3 });
});

test('findMatch: Kandidat unter Schwelle -> null', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0], model: 'bge-m3' }
  ]);
  const embeddingService = fakeEmbeddingService({ 'Voellig anderer Inhalt': [0, 1] }); // Cosine = 0
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const result = await service.findMatch(5, 'Voellig anderer Inhalt');
  assert.strictEqual(result, null);
});

test('findMatch: mehrere Kandidaten, aehnlichster gewinnt', async () => {
  const store = fakeStore([
    { documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0], model: 'bge-m3' },
    { documentId: 2, correspondentId: 5, documentTypeId: 2, tagIds: [2], embedding: [0.99, 0.14], model: 'bge-m3' }
  ]);
  const embeddingService = fakeEmbeddingService({ 'Text': [0.99, 0.14] });
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const result = await service.findMatch(5, 'Text');
  assert.deepStrictEqual(result, { tagIds: [2], documentTypeId: 2 });
});

test('findMatch: Embedding-Fehler -> null, kein Absturz', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0], model: 'bge-m3' }
  ]);
  const embeddingService = {
    embed: async () => { throw new Error('ECONNREFUSED'); },
    cosineSimilarity: () => { throw new Error('sollte nicht erreicht werden'); }
  };
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const result = await service.findMatch(5, 'Text');
  assert.strictEqual(result, null);
});

test('findMatch: Text wird vor dem Embedding-Call auf 3000 Zeichen gekuerzt', async () => {
  const longContent = 'A'.repeat(5000);
  const truncated = 'A'.repeat(3000);
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1], embedding: [1, 0], model: 'bge-m3' }
  ]);
  const embeddingService = fakeEmbeddingService({ [truncated]: [1, 0] });
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const result = await service.findMatch(5, longContent);
  assert.deepStrictEqual(result, { tagIds: [1], documentTypeId: 3 });
});

test('findMatch ignoriert Kandidaten mit abweichendem Embedding-Modell', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0], model: 'a-different-model' }
  ]);
  const embeddingService = fakeEmbeddingService({ 'Text': [1, 0] }); // waere Cosine 1, wenn verglichen
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const result = await service.findMatch(5, 'Text');
  assert.strictEqual(result, null);
});

test('recordFingerprint: berechnet Embedding und speichert ueber den Store', async () => {
  const store = fakeStore([]);
  const embeddingService = fakeEmbeddingService({ 'Neuer Inhalt': [1, 0] });
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  await service.recordFingerprint({
    documentId: 55, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], content: 'Neuer Inhalt'
  });

  assert.strictEqual(store.upserts.length, 1);
  assert.deepStrictEqual(store.upserts[0], {
    documentId: 55, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0], model: 'bge-m3'
  });
});

test('recordFingerprint: Embedding-Fehler -> kein Absturz, kein Store-Write', async () => {
  const store = fakeStore([]);
  const embeddingService = {
    embed: async () => { throw new Error('ECONNREFUSED'); }
  };
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  await service.recordFingerprint({
    documentId: 55, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], content: 'Text'
  });

  assert.strictEqual(store.upserts.length, 0);
});

test('findMatch gefolgt von recordFingerprint fuer denselben Inhalt embedded nur einmal', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0], model: 'bge-m3' }
  ]);
  let embedCalls = 0;
  const embeddingService = {
    embed: async (text) => {
      embedCalls++;
      if (embedCalls > 1) throw new Error('embed sollte hier nur einmal aufgerufen werden');
      return [1, 0];
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
  };
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const match = await service.findMatch(5, 'Wiederkehrender Inhalt');
  assert.deepStrictEqual(match, { tagIds: [1, 2], documentTypeId: 3 });

  await service.recordFingerprint({ documentId: 202, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], content: 'Wiederkehrender Inhalt' });
  assert.strictEqual(embedCalls, 1);
});

test('Memo-Cache ist an den Inhalt gebunden: zwei verschiedene Dokumente embedden je einmal, mit unterschiedlichen Vektoren', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0], model: 'bge-m3' }
  ]);
  const vectorsByText = { 'Dokument A': [1, 0], 'Dokument B': [0, 1] };
  let embedCalls = 0;
  const embeddingService = {
    embed: async (text) => {
      embedCalls++;
      if (!(text in vectorsByText)) throw new Error(`kein Test-Vektor fuer "${text}" hinterlegt`);
      return vectorsByText[text];
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
  };
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90, model: 'bge-m3' });

  const matchA = await service.findMatch(5, 'Dokument A');
  assert.deepStrictEqual(matchA, { tagIds: [1, 2], documentTypeId: 3 });

  const matchB = await service.findMatch(5, 'Dokument B');
  assert.strictEqual(matchB, null); // Cosine([0,1], [1,0]) = 0, weit unter der Schwelle

  assert.strictEqual(embedCalls, 2); // je ein Call, keine Wiederverwendung des falschen Vektors
});
