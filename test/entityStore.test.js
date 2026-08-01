const { test } = require('node:test');
const assert = require('node:assert');
const EntityStore = require('../models/entityStore');
const { normalizeForType } = require('../services/entityNormalizer');

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
  const proposedNormalized = normalizeForType('Verdienstbescheinigung', 'document_type');
  const candidateNormalized = normalizeForType('Entgeltabrechnung', 'document_type');
  assert.strictEqual(store.findRejectedPair('document_type', proposedNormalized, candidateNormalized), null);

  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 9,
    candidateName: 'Entgeltabrechnung', candidateId: 3, similarity: 0.4,
    llmVerdict: 'different', llmReason: 'unterschiedliche Dokumentarten', status: 'rejected'
  });

  const found = store.findRejectedPair('document_type', proposedNormalized, candidateNormalized);
  assert.ok(found);
  assert.strictEqual(found.status, 'rejected');
});

test('findRejectedPair matcht ueber Normalisierung: Gross-/Kleinschreibung und Whitespace-Varianten der Rohnamen finden denselben Eintrag', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'meldebescheid', proposedId: 1,
    candidateName: 'Meldebescheinigung', candidateId: 2, similarity: 0.5,
    llmVerdict: 'different', llmReason: 'test', status: 'rejected'
  });

  // Andere Schreibweise/Whitespace als beim Insert, aber gleiche normalisierte Form
  const found = store.findRejectedPair(
    'tag',
    normalizeForType('  MELDEBESCHEID  ', 'tag'),
    normalizeForType('meldebescheinigung', 'tag')
  );
  assert.ok(found, 'Negativ-Cache sollte trotz Roh-Varianten treffen');
  assert.strictEqual(found.candidate_name, 'Meldebescheinigung');
});

test('insertQueueEntry speichert proposed_normalized/candidate_normalized neben den rohen Namen', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'correspondent', proposedName: 'Müller GmbH', proposedId: 1,
    candidateName: 'Mueller', candidateId: 2, similarity: 0.6,
    llmVerdict: 'different', llmReason: 'test', status: 'rejected'
  });

  const row = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ?`
  ).get('Müller GmbH');

  assert.strictEqual(row.proposed_name, 'Müller GmbH', 'roher Name bleibt fuer Anzeige erhalten');
  assert.strictEqual(row.proposed_normalized, normalizeForType('Müller GmbH', 'correspondent'));
  assert.strictEqual(row.candidate_normalized, normalizeForType('Mueller', 'correspondent'));
});

test('offene Queue-Eintraege werden von findRejectedPair NICHT gefunden', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'A', proposedId: 1,
    candidateName: 'B', candidateId: 2, similarity: 0.7,
    llmVerdict: 'unsure', llmReason: null, status: 'open'
  });
  assert.strictEqual(
    store.findRejectedPair('tag', normalizeForType('A', 'tag'), normalizeForType('B', 'tag')),
    null
  );
});

test('Fehlerfall: geschlossene DB liefert Fallback statt zu werfen', () => {
  const store = freshStore();
  store.close();
  assert.doesNotThrow(() => store.findAlias('tag', 'rechnung'));
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});
