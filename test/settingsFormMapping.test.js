const { test } = require('node:test');
const assert = require('node:assert');
const { mapEntitySimilarityFields } = require('../routes/settingsFormMapping');

test('unchecked checkboxes (absent from the body) map to "no"', () => {
  const updates = mapEntitySimilarityFields({});
  assert.strictEqual(updates.ENTITY_RESOLVER_ENABLED, 'no');
  assert.strictEqual(updates.EMBEDDING_SIMILARITY_ENABLED, 'no');
  assert.strictEqual(updates.DOCUMENT_FINGERPRINT_ENABLED, 'no');
});

test('checked checkboxes (FormData sends "on") map to "yes"', () => {
  const updates = mapEntitySimilarityFields({
    entityResolverEnabled: 'on',
    embeddingSimilarityEnabled: 'on',
    documentFingerprintEnabled: 'on'
  });
  assert.strictEqual(updates.ENTITY_RESOLVER_ENABLED, 'yes');
  assert.strictEqual(updates.EMBEDDING_SIMILARITY_ENABLED, 'yes');
  assert.strictEqual(updates.DOCUMENT_FINGERPRINT_ENABLED, 'yes');
});

test('numeric threshold fields pass through as strings when present', () => {
  const updates = mapEntitySimilarityFields({
    entityResolverAutoThreshold: '0.8',
    entityResolverJudgeMin: '0.35',
    embedAutoThreshold: '0.9',
    embedJudgeMin: '0.5'
  });
  assert.strictEqual(updates.ENTITY_RESOLVER_AUTO_THRESHOLD, '0.8');
  assert.strictEqual(updates.ENTITY_RESOLVER_JUDGE_MIN, '0.35');
  assert.strictEqual(updates.EMBED_AUTO_THRESHOLD, '0.9');
  assert.strictEqual(updates.EMBED_JUDGE_MIN, '0.5');
});

test('empty-string threshold fields are omitted, not overwritten with an empty value', () => {
  const updates = mapEntitySimilarityFields({ entityResolverAutoThreshold: '' });
  assert.strictEqual('ENTITY_RESOLVER_AUTO_THRESHOLD' in updates, false);
});

test('missing threshold fields are omitted', () => {
  const updates = mapEntitySimilarityFields({});
  assert.strictEqual('ENTITY_RESOLVER_AUTO_THRESHOLD' in updates, false);
  assert.strictEqual('ENTITY_RESOLVER_JUDGE_MIN' in updates, false);
  assert.strictEqual('EMBED_AUTO_THRESHOLD' in updates, false);
  assert.strictEqual('EMBED_JUDGE_MIN' in updates, false);
});
