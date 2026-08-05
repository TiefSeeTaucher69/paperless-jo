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
  // Der Judge-Grund muss bis zum Aufrufer durchgereicht werden, sonst hat die Review-UI keine
  // Entscheidungsgrundlage ausser dem nackten Namenspaar (Ursache mehrerer inhaltlich falscher
  // Nutzer-Merges in der Praxis, z.B. "Austrittsdatum"->"Eintrittsdatum").
  assert.strictEqual(result.reason, 'nicht eindeutig');
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

test('recordCreatedAndQueued schreibt den Judge-Grund in llm_reason, wenn einer uebergeben wird', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  resolver.recordCreatedAndQueued({
    type: 'tag', proposedName: 'Austrittsdatum', proposedId: 60,
    candidate: { id: 6, name: 'Eintrittsdatum' }, similarity: 0.71, verdict: 'unsure',
    reason: 'Beide betreffen ein Datum im Beschaeftigungsverhaeltnis, aber Austritt und Eintritt sind gegensaetzliche Zeitpunkte',
    documentId: 124
  });

  const found = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ? AND candidate_name = ?`
  ).get('Austrittsdatum', 'Eintrittsdatum');
  assert.strictEqual(found.llm_reason, 'Beide betreffen ein Datum im Beschaeftigungsverhaeltnis, aber Austritt und Eintritt sind gegensaetzliche Zeitpunkte');
});

test('recordCreatedAndQueued schreibt llm_reason=null, wenn kein Grund uebergeben wird (Rueckwaertskompatibel)', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  resolver.recordCreatedAndQueued({
    type: 'tag', proposedName: 'Ohne Grund', proposedId: 61,
    candidate: { id: 7, name: 'Kandidat' }, similarity: 0.71, verdict: 'unsure',
    documentId: 125
  });

  const found = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ? AND candidate_name = ?`
  ).get('Ohne Grund', 'Kandidat');
  assert.strictEqual(found.llm_reason, null);
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

test('Embedding-Kanal ausgeschlossen fuer diesen Typ -> kein Embedding-Call trotz embeddingEnabled, faellt auf Trigram-only zurueck', async () => {
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
    config: {
      autoThreshold: 0.90, judgeMin: 0.65,
      embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65,
      embeddingExcludedTypes: ['tag']
    }
  });

  // Reines Trigram fuer dieses Paar liegt weit unter judgeMin - waere der Typ nicht
  // ausgeschlossen, wuerde der Fake-Embedding-Service (Cosine 1) einen Auto-Merge ausloesen.
  const result = await resolver.resolve('tag', 'Voellig Anderer Name', [{ id: 1, name: 'Ausbildung' }]);

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

test('Kombiniertes Scoring verdraengt einen sicheren Trigram-Match nicht: Trigram-Auto gewinnt trotz hoeherem kombinierten Score eines anderen Kandidaten', async () => {
  const store = new EntityStore(':memory:');
  // Paar wie in "Stufe 4a": Trigram-Dice ~0.91, also ueber AUTO_THRESHOLD (0.90).
  const embeddingService = fakeEmbeddingService({
    'Verdienstbescheinigungen': [1, 0],
    'Verdienstbescheinigung': [0, 1], // trigram-nahe (fast identisch), aber Embedding-fern (orthogonal)
    'Voellig Anderes Ding': [1, 0] // trigram-fern, aber Embedding-identisch ("false friend")
  });
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigungen', [
    { id: 1, name: 'Verdienstbescheinigung' },
    { id: 2, name: 'Voellig Anderes Ding' }
  ]);

  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'similarity');
  assert.strictEqual(result.id, 1);
});

test('Fehlerverhalten: NaN-Aehnlichkeit vom Embedding-Kanal wird ignoriert statt Kandidatenauswahl zu vergiften', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = {
    embed: async () => [1, 0],
    getOrComputeEmbedding: async (_store, _type, entity) => entity.name === 'Kaputter Kandidat' ? [0, 0] : [1, 0],
    cosineSimilarity: (a, b) => {
      const na = Math.sqrt(a[0] ** 2 + a[1] ** 2);
      const nb = Math.sqrt(b[0] ** 2 + b[1] ** 2);
      if (na === 0 || nb === 0) return NaN; // absichtlich kaputte Fake-Implementierung fuer diesen Test
      return (a[0] * b[0] + a[1] * b[1]) / (na * nb);
    }
  };
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [
    { id: 1, name: 'Kaputter Kandidat' },
    { id: 2, name: 'Entgeltabrechnungen' }
  ]);

  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.id, 2);
});

test('Negativ-Cache blockiert auch Embedding-Auto-Merge, nicht nur Trigram-Auto', async () => {
  const store = new EntityStore(':memory:');
  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Entgeltabrechnung', proposedId: 9,
    candidateName: 'Verdienstbescheinigung', candidateId: 4,
    similarity: 0.95, trigramSimilarity: 0.10, embeddingSimilarity: 0.95,
    llmVerdict: 'different', llmReason: 'Nutzerentscheidung', status: 'rejected'
  });

  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Verdienstbescheinigung': [1, 0] // identisch -> Cosine = 1, waere ohne Negativ-Cache ein Auto-Merge
  });
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);
  assert.strictEqual(result.action, 'create');
});

test('Judge different: entity_review_queue erhaelt trigram_similarity und embedding_similarity', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Verdienstbescheinigung': [0.7, 0.714142842854285]
  });
  const judge = async () => ({ verdict: 'different', reason: 'tatsaechlich verschieden' });
  const resolver = new EntityResolver({
    store, judge, embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE proposed_name = 'Entgeltabrechnung'`).get();
  assert.ok(row.trigram_similarity < 0.3);
  assert.ok(row.embedding_similarity > 0.6 && row.embedding_similarity < 0.8);
  // AUDIT-029: similarity darf nicht den hoeheren Embedding-Wert tragen (Skalen-Mischung) -
  // muss dem Trigram-Wert entsprechen, der in diesem Fixture klar niedriger ist.
  assert.strictEqual(row.similarity, row.trigram_similarity);
  assert.ok(row.similarity < 0.3);
  assert.strictEqual(row.status, 'rejected');
});

test('AUDIT-029: bei "unsure" traegt result.similarity den Trigram-Wert, nicht den hoeheren Embedding-Wert', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Verdienstbescheinigung': [0.7, 0.714142842854285] // Cosine ~0.7, weit ueber dem Trigram-Wert
  });
  const judge = async () => ({ verdict: 'unsure', reason: 'unklar' });
  const resolver = new EntityResolver({
    store, judge, embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  assert.strictEqual(result.action, 'create_and_queue');
  assert.ok(result.embeddingSimilarity > 0.6);
  assert.ok(result.similarity < 0.3, `similarity sollte der niedrigere Trigram-Wert sein, nicht der Embedding-Wert (${result.similarity})`);
  assert.strictEqual(result.similarity, result.trigramSimilarity);
});

test('Judge-Zone verdraengt einen judge-wuerdigen Trigram-Kandidaten nicht: bevorzugt bestTrigram vor dem kombinierten Sieger', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Entgeltabrechnungen': [0, 1], // Trigram ~0.889 (Judge-Zone), Embedding fern (0)
    'Voellig Anderes Ding': [0.895, 0.446] // Trigram fern, Embedding ~0.895 -> kombiniert schlaegt bestTrigram, aber unter EMBED_AUTO_THRESHOLD
  });
  let askedAboutName = null;
  const judge = async (type, nameA, nameB) => { askedAboutName = nameB; return { verdict: 'same', reason: 'ok' }; };
  const resolver = new EntityResolver({
    store, judge, embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [
    { id: 1, name: 'Entgeltabrechnungen' },
    { id: 2, name: 'Voellig Anderes Ding' }
  ]);

  assert.strictEqual(askedAboutName, 'Entgeltabrechnungen');
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.id, 1);
});

test('AUDIT-015: schlaegt insertAlias in Stufe 3 (normalisierter Treffer) fehl, wird das geloggt, die Zuordnung bleibt aber bestehen', async () => {
  const store = new EntityStore(':memory:');
  store.insertAlias = () => false;
  const resolver = makeResolver({ store });

  const errorCalls = [];
  const originalError = console.error;
  console.error = (...args) => errorCalls.push(args.join(' '));
  let result;
  try {
    result = await resolver.resolve('correspondent', 'Müller Straße GmbH', [{ id: 3, name: 'Mueller Strasse' }]);
  } finally {
    console.error = originalError;
  }

  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.id, 3);
  assert.ok(errorCalls.some(msg => msg.includes('entityResolver') && msg.includes('mueller strasse')));
});

test('AUDIT-015: schlaegt insertQueueEntry bei Judge-Verdict "different" fehl, wird das geloggt (Negativ-Cache fehlt dann)', async () => {
  const store = new EntityStore(':memory:');
  store.insertQueueEntry = () => false;
  const judge = async () => ({ verdict: 'different', reason: 'unterschiedliche Dokumentarten' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const errorCalls = [];
  const originalError = console.error;
  console.error = (...args) => errorCalls.push(args.join(' '));
  let result;
  try {
    result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  } finally {
    console.error = originalError;
  }

  assert.strictEqual(result.action, 'create');
  assert.ok(errorCalls.some(msg => msg.includes('entityResolver') && msg.includes('Negativ-Cache')));
});

test('AUDIT-015: schlaegt insertQueueEntry in recordCreatedAndQueued fehl, wird das geloggt', () => {
  const store = new EntityStore(':memory:');
  store.insertQueueEntry = () => false;
  const resolver = makeResolver({ store });

  const errorCalls = [];
  const originalError = console.error;
  console.error = (...args) => errorCalls.push(args.join(' '));
  try {
    resolver.recordCreatedAndQueued({
      type: 'tag', proposedName: 'Neuer Tag', proposedId: 55,
      candidate: { id: 1, name: 'Aehnlicher Tag' }, similarity: 0.7, verdict: 'unsure', documentId: 123
    });
  } finally {
    console.error = originalError;
  }

  assert.ok(errorCalls.some(msg => msg.includes('entityResolver') && msg.includes('Neuer Tag')));
});
