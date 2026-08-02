const { test } = require('node:test');
const assert = require('node:assert');
const EntityResolver = require('../services/entityResolver');
const EntityStore = require('../models/entityStore');
const { normalizeForType } = require('../services/entityNormalizer');

function makeResolver(overrides = {}) {
  const store = overrides.store || new EntityStore(':memory:');
  const judge = overrides.judge || (async () => { throw new Error('Judge sollte in diesem Test nicht aufgerufen werden'); });
  return new EntityResolver({ store, judge, config: { autoThreshold: 0.90, judgeMin: 0.65 } });
}

test('Stufe 0: leer oder nur Whitespace -> skip', async () => {
  const resolver = makeResolver();
  assert.deepStrictEqual(await resolver.resolve('tag', '   ', []), { action: 'skip' });
  assert.deepStrictEqual(await resolver.resolve('tag', '', []), { action: 'skip' });
});

test('Stufe 1: Alias-Tabelle kennt normalize(N) -> map ohne API/LLM', async () => {
  const store = new EntityStore(':memory:');
  store.insertAlias({ entityType: 'correspondent', aliasNormalized: 'stadtwerke musterstadt', canonicalName: 'Stadtwerke Musterstadt', canonicalId: 5, source: 'user' });
  const resolver = makeResolver({ store });

  const result = await resolver.resolve('correspondent', 'Stadtwerke Musterstadt GmbH', [{ id: 5, name: 'Stadtwerke Musterstadt' }]);
  assert.deepStrictEqual(result, { action: 'map', id: 5, canonicalName: 'Stadtwerke Musterstadt', via: 'alias' });
});

test('Stufe 1 Fehlerfall: Alias zeigt auf geloeschte ID -> verworfen, neu entschieden', async () => {
  const store = new EntityStore(':memory:');
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 999, source: 'auto' });
  const resolver = makeResolver({ store });

  // 999 existiert nicht mehr im Bestand -> Alias verwerfen, dann Stufe 4d (keine Aehnlichkeit) -> create
  const result = await resolver.resolve('tag', 'Rechnung', [{ id: 1, name: 'Vertrag' }]);
  assert.strictEqual(result.action, 'create');
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('Stufe 2: exakter Treffer im Bestand -> map', async () => {
  const resolver = makeResolver();
  const result = await resolver.resolve('tag', 'Rechnung', [{ id: 7, name: 'Rechnung' }]);
  assert.deepStrictEqual(result, { action: 'map', id: 7, canonicalName: 'Rechnung', via: 'exact' });
});

test('Stufe 3: normalisierter Treffer -> map, Alias wird geschrieben', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  const result = await resolver.resolve('correspondent', 'Müller Straße GmbH', [{ id: 3, name: 'Mueller Strasse' }]);
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.id, 3);
  assert.strictEqual(result.via, 'normalized');

  const alias = store.findAlias('correspondent', 'mueller strasse');
  assert.ok(alias, 'Alias sollte geschrieben worden sein');
  assert.strictEqual(alias.source, 'auto');
});

test('Stufe 4a: Aehnlichkeit >= AUTO_THRESHOLD -> map, Alias source=auto', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  // "Verdienstbescheinigungen"/"Verdienstbescheinigung" liegen mit der echten
  // Trigram-Dice-Implementierung bei ~0.91, also ueber dem Default-AUTO_THRESHOLD (0.90).
  const result = await resolver.resolve('document_type', 'Verdienstbescheinigungen', [{ id: 1, name: 'Verdienstbescheinigung' }]);
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'similarity');
  assert.strictEqual(store.findAlias('document_type', 'verdienstbescheinigungen').source, 'auto');
});

test('Stufe 4b: als rejected bekanntes Paar -> create, kein LLM-Call trotz hoher Aehnlichkeit', async () => {
  const store = new EntityStore(':memory:');
  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Verdienstbescheinigungen', proposedId: 9,
    candidateName: 'Verdienstbescheinigung', candidateId: 1, similarity: 0.91,
    llmVerdict: 'different', llmReason: 'Nutzerentscheidung', status: 'rejected'
  });
  const resolver = makeResolver({ store }); // judge wirft, falls aufgerufen

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigungen', [{ id: 1, name: 'Verdienstbescheinigung' }]);
  assert.deepStrictEqual(result, { action: 'create' });
});

test('Stufe 4b: rejected Paar wird auch bei Gross-/Kleinschreibungs-/Whitespace-Variante des Rohnamens erkannt (normalisierter Negativ-Cache)', async () => {
  const store = new EntityStore(':memory:');
  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'verdienstbescheinigungen', proposedId: 9,
    candidateName: 'Verdienstbescheinigung', candidateId: 1, similarity: 0.91,
    llmVerdict: 'different', llmReason: 'Nutzerentscheidung', status: 'rejected'
  });
  const resolver = makeResolver({ store }); // judge wirft, falls aufgerufen

  // Andere Schreibweise (Grossbuchstaben + fuehrendes/folgendes Leerzeichen) desselben
  // Namens wie beim Insert -> muss trotzdem als bereits abgelehnt erkannt werden, weil
  // findRejectedPair jetzt normalisiert statt roh vergleicht.
  const result = await resolver.resolve('document_type', '  VERDIENSTBESCHEINIGUNGEN  ', [{ id: 1, name: 'Verdienstbescheinigung' }]);
  assert.deepStrictEqual(result, { action: 'create' });
});

test('Stufe 4c: JUDGE_MIN <= Aehnlichkeit < AUTO_THRESHOLD, Judge sagt same -> map, Alias source=llm', async () => {
  const store = new EntityStore(':memory:');
  const judge = async (type, a, b) => ({ verdict: 'same', reason: 'gleiche Sache, andere Schreibweise' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Meldebeschreibung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'llm');
  assert.strictEqual(store.findAlias('document_type', 'meldebeschreibung').source, 'llm');
});

test('Stufe 4c: Judge sagt different -> create, Negativ-Eintrag geschrieben', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => ({ verdict: 'different', reason: 'unterschiedliche Dokumentarten' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create');
  assert.ok(store.findRejectedPair(
    'document_type',
    normalizeForType('Verdienstbescheinigung', 'document_type'),
    normalizeForType('Meldebescheinigung', 'document_type')
  ));
});

test('Stufe 4c: Judge sagt unsure -> create_and_queue, ohne Queue-Eintrag zu schreiben', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => ({ verdict: 'unsure', reason: 'nicht eindeutig' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.deepStrictEqual(result.candidate, { id: 4, name: 'Meldebescheinigung' });
  assert.strictEqual(result.verdict, 'unsure');
  assert.strictEqual(store.findRejectedPair(
    'document_type',
    normalizeForType('Verdienstbescheinigung', 'document_type'),
    normalizeForType('Meldebescheinigung', 'document_type')
  ), null);
});

test('Fehlerverhalten: Judge wirft (nicht erreichbar) -> unsure statt Absturz', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => { throw new Error('ECONNREFUSED'); };
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.strictEqual(result.verdict, 'unsure');
});

test('Fehlerverhalten: Judge liefert unparsbares Urteil -> unsure', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => ({ verdict: 'ja klar', reason: 'kaputte Antwort' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.strictEqual(result.verdict, 'unsure');
});

test('Stufe 4d: Aehnlichkeit unter JUDGE_MIN -> create, kein Judge-Call', async () => {
  const resolver = makeResolver(); // judge wirft, falls aufgerufen
  const result = await resolver.resolve('correspondent', 'Voellig Anderer Name', [{ id: 1, name: 'Stadtwerke Musterstadt' }]);
  assert.deepStrictEqual(result, { action: 'create' });
});

test('recordCreatedAndQueued schreibt den Queue-Eintrag mit der echten proposed_id', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  resolver.recordCreatedAndQueued({
    type: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 55,
    candidate: { id: 4, name: 'Meldebescheinigung' }, similarity: 0.42, verdict: 'unsure',
    documentId: 123
  });

  const found = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ? AND candidate_name = ?`
  ).get('Verdienstbescheinigung', 'Meldebescheinigung');
  assert.strictEqual(found.proposed_id, 55);
  assert.strictEqual(found.status, 'open');
  assert.strictEqual(found.document_id, 123);
});

function fakeEmbeddingService(vectors) {
  return {
    embed: async (text) => {
      if (!(text in vectors)) throw new Error(`kein Test-Vektor fuer "${text}" hinterlegt`);
      return vectors[text];
    },
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

test('Embedding-Auto: Embedding >= EMBED_AUTO_THRESHOLD, Trigram weit darunter -> map via embedding_similarity, Alias source=auto_embedding', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Verdienstbescheinigung': [1, 0] // identisch -> Cosine = 1
  });
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'embedding_similarity');
  const alias = store.findAlias('document_type', normalizeForType('Entgeltabrechnung', 'document_type'));
  assert.strictEqual(alias.source, 'auto_embedding');
});

test('Embedding-Judge-Zone: Trigram unter JUDGE_MIN, Embedding im Judge-Fenster -> Judge wird gefragt', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Verdienstbescheinigung': [0.7, 0.714142842854285] // Cosine ~0.7
  });
  const resolver = new EntityResolver({
    store, judge: async () => ({ verdict: 'same', reason: 'semantisch gleich' }),
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'llm');
});

test('Embedding deaktiviert trotz injiziertem Service -> kein Embedding-Call, Verhalten wie ohne Embeddings', async () => {
  const store = new EntityStore(':memory:');
  let calls = 0;
  const embeddingService = {
    embed: async () => { calls++; return [1, 0]; },
    getOrComputeEmbedding: async () => { calls++; return [1, 0]; },
    cosineSimilarity: () => 1
  };
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: false }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  assert.strictEqual(result.action, 'create');
  assert.strictEqual(calls, 0);
});

test('Fehlerverhalten: Embedding-Call wirft -> faellt auf Trigram-only zurueck, kein Absturz', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = {
    embed: async () => { throw new Error('ECONNREFUSED'); },
    getOrComputeEmbedding: async () => { throw new Error('sollte nicht erreicht werden'); },
    cosineSimilarity: () => { throw new Error('sollte nicht erreicht werden'); }
  };
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  // Trigram-Aehnlichkeit dieser beiden Namen liegt unter judgeMin -> create, trotz kaputtem Embedding-Kanal
  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);
  assert.strictEqual(result.action, 'create');
});

test('recordCreatedAndQueued schreibt trigram_similarity und embedding_similarity mit', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  resolver.recordCreatedAndQueued({
    type: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 55,
    candidate: { id: 4, name: 'Meldebescheinigung' }, similarity: 0.81,
    trigramSimilarity: 0.42, embeddingSimilarity: 0.81,
    verdict: 'unsure', documentId: 123
  });

  const found = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ? AND candidate_name = ?`
  ).get('Verdienstbescheinigung', 'Meldebescheinigung');
  assert.strictEqual(found.trigram_similarity, 0.42);
  assert.strictEqual(found.embedding_similarity, 0.81);
});
