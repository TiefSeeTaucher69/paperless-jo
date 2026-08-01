const { test } = require('node:test');
const assert = require('node:assert');
const EntityStore = require('../models/entityStore');

function freshStore() {
  return new EntityStore(':memory:');
}

test('findAlias liefert null, wenn nichts gespeichert ist', () => {
  const store = freshStore();
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('insertAlias und findAlias roundtrip', () => {
  const store = freshStore();
  const ok = store.insertAlias({
    entityType: 'correspondent', aliasNormalized: 'stadtwerke musterstadt',
    canonicalName: 'Stadtwerke Musterstadt GmbH', canonicalId: 42, source: 'auto'
  });
  assert.strictEqual(ok, true);

  const found = store.findAlias('correspondent', 'stadtwerke musterstadt');
  assert.strictEqual(found.canonical_id, 42);
  assert.strictEqual(found.canonical_name, 'Stadtwerke Musterstadt GmbH');
  assert.strictEqual(found.source, 'auto');
});

test('UNIQUE(entity_type, alias_normalized): erneutes Insert ueberschreibt statt zu duplizieren', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'auto' });
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'user' });

  const found = store.findAlias('tag', 'rechnung');
  assert.strictEqual(found.source, 'user');
});

test('deleteAlias entfernt den Eintrag', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'auto' });
  store.deleteAlias('tag', 'rechnung');
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('findRejectedPair liefert null ohne Eintrag, gefunden nach insertQueueEntry mit status rejected', () => {
  const store = freshStore();
  assert.strictEqual(store.findRejectedPair('document_type', 'Verdienstbescheinigung', 'Entgeltabrechnung'), null);

  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 9,
    candidateName: 'Entgeltabrechnung', candidateId: 3, similarity: 0.4,
    llmVerdict: 'different', llmReason: 'unterschiedliche Dokumentarten', status: 'rejected'
  });

  const found = store.findRejectedPair('document_type', 'Verdienstbescheinigung', 'Entgeltabrechnung');
  assert.ok(found);
  assert.strictEqual(found.status, 'rejected');
});

test('offene Queue-Eintraege werden von findRejectedPair NICHT gefunden', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'A', proposedId: 1,
    candidateName: 'B', candidateId: 2, similarity: 0.7,
    llmVerdict: 'unsure', llmReason: null, status: 'open'
  });
  assert.strictEqual(store.findRejectedPair('tag', 'A', 'B'), null);
});

test('Fehlerfall: geschlossene DB liefert Fallback statt zu werfen', () => {
  const store = freshStore();
  store.close();
  assert.doesNotThrow(() => store.findAlias('tag', 'rechnung'));
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});
