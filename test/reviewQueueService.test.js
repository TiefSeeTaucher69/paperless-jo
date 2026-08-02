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
    insertMergeLog: () => true,
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

test('merge persistiert einen erfolgreichen Merge-Log-Eintrag', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'correspondent', proposed_id: 10, candidate_id: 20, proposed_normalized: 'stadtwerke', candidate_name: 'Stadtwerke GmbH' });
  const mergeLogCalls = [];
  store.insertMergeLog = (args) => { mergeLogCalls.push(args); return true; };
  const paperlessService = { mergeEntity: async () => ({ affectedCount: 3, documentIds: [1, 2, 3], deleted: true, chunksCompleted: 1, chunksTotal: 1 }) };
  const service = new ReviewQueueService({ store, paperlessService });

  await service.merge(1);

  assert.strictEqual(mergeLogCalls.length, 1);
  assert.strictEqual(mergeLogCalls[0].status, 'completed');
  assert.strictEqual(mergeLogCalls[0].affectedCount, 3);
  assert.strictEqual(mergeLogCalls[0].queueEntryId, 1);
});

test('merge persistiert einen fehlgeschlagenen Merge-Log-Eintrag, wirft weiter und aendert weder Alias noch Status', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'correspondent', proposed_id: 10, candidate_id: 20, proposed_normalized: 'stadtwerke', candidate_name: 'Stadtwerke GmbH' });
  const mergeLogCalls = [];
  store.insertMergeLog = (args) => { mergeLogCalls.push(args); return true; };
  store.insertAlias = () => { throw new Error('insertAlias haette nicht aufgerufen werden duerfen'); };
  const mergeError = new Error('Merge incomplete: 2 document(s) still reference fromId=10');
  mergeError.mergeProgress = { affectedCount: 2, chunksCompleted: 0, chunksTotal: 1 };
  const paperlessService = { mergeEntity: async () => { throw mergeError; } };
  const service = new ReviewQueueService({ store, paperlessService });

  await assert.rejects(() => service.merge(1), /Merge incomplete/);

  assert.strictEqual(mergeLogCalls.length, 1);
  assert.strictEqual(mergeLogCalls[0].status, 'failed');
  assert.strictEqual(mergeLogCalls[0].affectedCount, 2);
  assert.strictEqual(mergeLogCalls[0].errorMessage, 'Merge incomplete: 2 document(s) still reference fromId=10');
  assert.strictEqual(store.entries.get(1).status, 'open');
});

test('merge reicht expectedDocumentIds an mergeEntity durch', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'tag', proposed_id: 10, candidate_id: 20, proposed_normalized: 'rechnung', candidate_name: 'Rechnung' });
  const calls = [];
  const paperlessService = {
    mergeEntity: async (type, fromId, toId, opts) => { calls.push(opts); return { affectedCount: 0, documentIds: [], deleted: true, chunksCompleted: 0, chunksTotal: 0 }; }
  };
  const service = new ReviewQueueService({ store, paperlessService });

  await service.merge(1, { expectedDocumentIds: [1, 2, 3] });

  assert.deepStrictEqual(calls[0], { dryRun: false, expectedDocumentIds: [1, 2, 3] });
});
