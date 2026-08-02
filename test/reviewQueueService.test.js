const { test } = require('node:test');
const assert = require('node:assert');
const ReviewQueueService = require('../services/reviewQueueService');

function fakeStore(overrides = {}) {
  const entries = new Map();
  return {
    entries,
    listOpenQueueEntries: () => Array.from(entries.values()).filter(e => e.status === 'open'),
    getQueueEntryById: (id) => entries.get(id) || null,
    updateQueueStatus: (id, status) => {
      if (!entries.has(id)) return false;
      entries.get(id).status = status;
      return true;
    },
    insertAlias: () => true,
    ...overrides
  };
}

test('listOpen delegiert an store.listOpenQueueEntries', () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'tag' });
  const service = new ReviewQueueService({ store, paperlessService: {} });

  assert.strictEqual(service.listOpen().length, 1);
});

test('previewMerge ruft mergeEntity mit dryRun=true auf und aendert nichts am Eintrag', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'correspondent', proposed_id: 10, candidate_id: 20, proposed_normalized: 'stadtwerke', candidate_name: 'Stadtwerke GmbH' });
  const calls = [];
  const paperlessService = {
    mergeEntity: async (type, fromId, toId, opts) => { calls.push({ type, fromId, toId, opts }); return { affectedCount: 3, documentIds: [1, 2, 3], deleted: false }; }
  };
  const service = new ReviewQueueService({ store, paperlessService });

  const result = await service.previewMerge(1);

  assert.deepStrictEqual(result, { affectedCount: 3, documentIds: [1, 2, 3], deleted: false });
  assert.deepStrictEqual(calls, [{ type: 'correspondent', fromId: 10, toId: 20, opts: { dryRun: true } }]);
  assert.strictEqual(store.entries.get(1).status, 'open');
});

test('merge fuehrt echten Merge aus, schreibt Alias mit source=user und setzt status=merged', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'correspondent', proposed_id: 10, candidate_id: 20, proposed_normalized: 'stadtwerke', candidate_name: 'Stadtwerke GmbH' });
  const aliasCalls = [];
  store.insertAlias = (args) => { aliasCalls.push(args); return true; };
  const paperlessService = { mergeEntity: async () => ({ affectedCount: 3, documentIds: [1, 2, 3], deleted: true }) };
  const service = new ReviewQueueService({ store, paperlessService });

  const result = await service.merge(1);

  assert.strictEqual(result.deleted, true);
  assert.deepStrictEqual(aliasCalls, [{
    entityType: 'correspondent', aliasNormalized: 'stadtwerke', canonicalName: 'Stadtwerke GmbH', canonicalId: 20, source: 'user'
  }]);
  assert.strictEqual(store.entries.get(1).status, 'merged');
});

test('merge wirft, wenn die id nicht existiert, und schreibt keinen Alias', async () => {
  const store = fakeStore();
  const service = new ReviewQueueService({ store, paperlessService: { mergeEntity: async () => { throw new Error('haette nicht aufgerufen werden duerfen'); } } });

  await assert.rejects(() => service.merge(999), /No queue entry/);
});

test('reject setzt status=rejected und ruft mergeEntity nicht auf', () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'tag' });
  const service = new ReviewQueueService({ store, paperlessService: { mergeEntity: async () => { throw new Error('haette nicht aufgerufen werden duerfen'); } } });

  const entry = service.reject(1);

  assert.strictEqual(entry.id, 1);
  assert.strictEqual(store.entries.get(1).status, 'rejected');
});
