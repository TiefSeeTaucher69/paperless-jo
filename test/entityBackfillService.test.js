const { test } = require('node:test');
const assert = require('node:assert');
const EntityBackfillService = require('../services/entityBackfillService');
const EntityStore = require('../models/entityStore');

function fakeEmbeddingService(vectors) {
  return {
    getOrComputeEmbedding: async (_store, _type, entity) => {
      if (!(entity.name in vectors)) throw new Error(`kein Test-Vektor fuer "${entity.name}" hinterlegt`);
      return vectors[entity.name];
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
  };
}

test('run findet ein aehnliches Paar oberhalb judgeMin und schreibt einen Queue-Eintrag, aeltere id wird kanonisch', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = await service.run('document_type', [
      { id: 5, name: 'Meldebescheinigung' },
      { id: 12, name: 'Meldebeschreibung' }
    ]);

    assert.strictEqual(result.inserted, 1);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'document_type'`).get();
    assert.strictEqual(row.candidate_id, 5);
    assert.strictEqual(row.proposed_id, 12);
    assert.strictEqual(row.llm_verdict, null);
    assert.strictEqual(row.status, 'open');
  } finally {
    store.close();
  }
});

test('run ueberspringt Paare unterhalb judgeMin', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run ueberspringt bereits als rejected bekannte Paare', async () => {
  const store = new EntityStore(':memory:');
  try {
    store.insertQueueEntry({
      entityType: 'tag',
      proposedName: 'Mahnung', proposedId: 2,
      candidateName: 'Mahnungen', candidateId: 1,
      similarity: 0.9, llmVerdict: 'different', llmReason: 'Test', status: 'rejected', documentId: null
    });

    const service = new EntityBackfillService({ store, judgeMin: 0.5 });
    const result = await service.run('tag', [
      { id: 1, name: 'Mahnungen' },
      { id: 2, name: 'Mahnung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run ueberschreibt den llm_verdict eines bereits offenen Queue-Eintrags nicht', async () => {
  const store = new EntityStore(':memory:');
  try {
    store.insertQueueEntry({
      entityType: 'tag',
      proposedName: 'Mahnung', proposedId: 2,
      candidateName: 'Mahnungen', candidateId: 1,
      similarity: 0.9, llmVerdict: 'unsure', llmReason: 'Vom Live-Pfad gesetzt', status: 'open', documentId: null
    });

    const service = new EntityBackfillService({ store, judgeMin: 0.5 });
    const result = await service.run('tag', [
      { id: 1, name: 'Mahnungen' },
      { id: 2, name: 'Mahnung' }
    ]);

    assert.strictEqual(result.inserted, 0);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'tag'`).get();
    assert.strictEqual(row.llm_verdict, 'unsure');
    assert.strictEqual(row.status, 'open');
  } finally {
    store.close();
  }
});

test('run vergleicht jedes Paar nur einmal bei mehr als zwei Eintraegen', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.99 }); // nur exakte Duplikate treffen

    const result = await service.run('tag', [
      { id: 1, name: 'Rechnung' },
      { id: 2, name: 'Rechnung' },
      { id: 3, name: 'Voellig Anders' }
    ]);

    assert.strictEqual(result.inserted, 1);
  } finally {
    store.close();
  }
});

test('run findet mit aktiviertem Embedding-Kanal ein Paar, das Trigram allein verpassen wuerde', async () => {
  const store = new EntityStore(':memory:');
  try {
    const embeddingService = fakeEmbeddingService({
      'Entgeltabrechnung': [1, 0],
      'Verdienstbescheinigung': [1, 0] // identisch -> Cosine = 1
    });
    const service = new EntityBackfillService({
      store, judgeMin: 0.99, embeddingService, embeddingEnabled: true, embedJudgeMin: 0.90
    });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 1);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'document_type'`).get();
    assert.ok(row.embedding_similarity > 0.9);
    assert.ok(row.trigram_similarity < 0.3);
  } finally {
    store.close();
  }
});

test('run bleibt bei deaktiviertem Embedding-Kanal trigram-only, kein Embedding-Call', async () => {
  const store = new EntityStore(':memory:');
  let calls = 0;
  try {
    const embeddingService = {
      getOrComputeEmbedding: async () => { calls++; return [1, 0]; },
      cosineSimilarity: () => 1
    };
    const service = new EntityBackfillService({ store, judgeMin: 0.99, embeddingService, embeddingEnabled: false });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 0);
    assert.strictEqual(calls, 0);
  } finally {
    store.close();
  }
});

test('run ignoriert einen einzelnen fehlgeschlagenen Embedding-Call, statt abzubrechen', async () => {
  const store = new EntityStore(':memory:');
  try {
    const embeddingService = {
      getOrComputeEmbedding: async (_store, _type, entity) => {
        if (entity.name === 'Verdienstbescheinigung') throw new Error('ECONNREFUSED');
        return [1, 0];
      },
      cosineSimilarity: () => 1
    };
    const service = new EntityBackfillService({
      store, judgeMin: 0.99, embeddingService, embeddingEnabled: true, embedJudgeMin: 0.90
    });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    // Ein Vektor fehlt (Fehler beim Prefetch) -> embeddingSim fuer dieses Paar bleibt null,
    // trigram allein (weit unter judgeMin 0.99) entscheidet -> kein Absturz, kein Insert.
    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run ueberspringt den Embedding-Kanal fuer einen ausgeschlossenen Typ, kein Embedding-Call', async () => {
  const store = new EntityStore(':memory:');
  let calls = 0;
  try {
    const embeddingService = {
      getOrComputeEmbedding: async () => { calls++; return [1, 0]; },
      cosineSimilarity: () => 1
    };
    const service = new EntityBackfillService({
      store, judgeMin: 0.99, embeddingService, embeddingEnabled: true, embedJudgeMin: 0.90,
      excludedTypes: ['tag']
    });

    // Faker-Embedding-Service liefert ueberall Cosine 1 - waere 'tag' nicht ausgeschlossen,
    // wuerde das trotz weit auseinanderliegender Trigram-Aehnlichkeit einen Eintrag erzeugen.
    const result = await service.run('tag', [
      { id: 1, name: 'Ausbildung' },
      { id: 2, name: 'Bewerbung' }
    ]);

    assert.strictEqual(result.inserted, 0);
    assert.strictEqual(calls, 0);
  } finally {
    store.close();
  }
});

test('run schreibt keine NaN-Aehnlichkeit, wenn cosineSimilarity einen ungueltigen Wert liefert', async () => {
  const store = new EntityStore(':memory:');
  try {
    const embeddingService = {
      getOrComputeEmbedding: async () => [1, 0],
      cosineSimilarity: () => NaN // fehlerhafter Embedding-Service
    };
    const service = new EntityBackfillService({
      store, judgeMin: 0.6, embeddingService, embeddingEnabled: true, embedJudgeMin: 0.90
    });

    // Trigram allein reicht -> es wird eingefuegt; NaN darf weder similarity (NOT NULL)
    // vergiften noch als embedding_similarity landen.
    const result = await service.run('document_type', [
      { id: 5, name: 'Meldebescheinigung' },
      { id: 12, name: 'Meldebeschreibung' }
    ]);

    assert.strictEqual(result.inserted, 1);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'document_type'`).get();
    assert.strictEqual(row.embedding_similarity, null);
    assert.ok(Number.isFinite(row.similarity) && row.similarity >= 0.6);
  } finally {
    store.close();
  }
});
