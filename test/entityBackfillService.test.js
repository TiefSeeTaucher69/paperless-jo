const { test } = require('node:test');
const assert = require('node:assert');
const EntityBackfillService = require('../services/entityBackfillService');
const EntityStore = require('../models/entityStore');

test('run findet ein aehnliches Paar oberhalb judgeMin und schreibt einen Queue-Eintrag, aeltere id wird kanonisch', () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = service.run('document_type', [
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

test('run ueberspringt Paare unterhalb judgeMin', () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run ueberspringt bereits als rejected bekannte Paare', () => {
  const store = new EntityStore(':memory:');
  try {
    const { normalizeForType } = require('../services/entityNormalizer');
    store.insertQueueEntry({
      entityType: 'tag',
      proposedName: 'Mahnung', proposedId: 2,
      candidateName: 'Mahnungen', candidateId: 1,
      similarity: 0.9, llmVerdict: 'different', llmReason: 'Test', status: 'rejected', documentId: null
    });

    const service = new EntityBackfillService({ store, judgeMin: 0.5 });
    const result = service.run('tag', [
      { id: 1, name: 'Mahnungen' },
      { id: 2, name: 'Mahnung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run vergleicht jedes Paar nur einmal bei mehr als zwei Eintraegen', () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.99 }); // nur exakte Duplikate treffen

    const result = service.run('tag', [
      { id: 1, name: 'Rechnung' },
      { id: 2, name: 'Rechnung' },
      { id: 3, name: 'Voellig Anders' }
    ]);

    assert.strictEqual(result.inserted, 1);
  } finally {
    store.close();
  }
});
