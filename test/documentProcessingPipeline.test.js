const { test } = require('node:test');
const assert = require('node:assert');
const { DocumentProcessingPipeline } = require('../services/documentProcessingPipeline');

function makePipeline(overrides = {}) {
  const paperlessService = overrides.paperlessService || { updateDocument: async () => ({}) };
  const documentModel = overrides.documentModel || {
    saveOriginalData: async () => {},
    addProcessedDocument: async () => {},
    addOpenAIMetrics: async () => {},
    addToHistory: async () => {}
  };
  const documentFingerprintService = Object.prototype.hasOwnProperty.call(overrides, 'documentFingerprintService')
    ? overrides.documentFingerprintService
    : null;
  const config = overrides.config || { documentFingerprint: { enabled: false }, limitFunctions: {} };
  return new DocumentProcessingPipeline({ paperlessService, documentModel, documentFingerprintService, config });
}

test('saveDocumentChanges wirft weiter, wenn paperlessService.updateDocument wirft, und ruft addProcessedDocument/addToHistory nicht auf (AUDIT-004)', async () => {
  const calls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => { throw new Error('PATCH fehlgeschlagen'); } },
    documentModel: {
      saveOriginalData: async () => { calls.push('saveOriginalData'); },
      addProcessedDocument: async () => { calls.push('addProcessedDocument'); },
      addOpenAIMetrics: async () => { calls.push('addOpenAIMetrics'); },
      addToHistory: async () => { calls.push('addToHistory'); }
    }
  });

  await assert.rejects(
    () => pipeline.saveDocumentChanges(42, { title: 'T', tags: [1] }, { metrics: {}, document: {} }, { tags: [], correspondent: null, title: 'Old' }),
    /PATCH fehlgeschlagen/
  );

  assert.deepStrictEqual(calls, ['saveOriginalData']);
});

test('saveDocumentChanges ruft nach erfolgreichem updateDocument alle Folgeschritte auf, PATCH zuerst', async () => {
  const calls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => { calls.push('updateDocument'); return {}; } },
    documentModel: {
      saveOriginalData: async () => { calls.push('saveOriginalData'); },
      addProcessedDocument: async () => { calls.push('addProcessedDocument'); },
      addOpenAIMetrics: async () => { calls.push('addOpenAIMetrics'); },
      addToHistory: async () => { calls.push('addToHistory'); }
    }
  });

  await pipeline.saveDocumentChanges(
    42, { title: 'T', tags: [1] },
    { metrics: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, document: { correspondent: 'X' } },
    { tags: [], correspondent: null, title: 'Old' }
  );

  assert.deepStrictEqual(new Set(calls), new Set(['saveOriginalData', 'updateDocument', 'addProcessedDocument', 'addOpenAIMetrics', 'addToHistory']));
  assert.ok(calls.indexOf('updateDocument') < calls.indexOf('addProcessedDocument'), 'updateDocument muss vor addProcessedDocument laufen');
});

test('processAndSave ruft recordDocumentFingerprint NICHT auf, wenn der PATCH fehlschlaegt (AUDIT-004 + AUDIT-014)', async () => {
  const recordCalls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => { throw new Error('Netzwerkfehler'); } },
    documentFingerprintService: {
      findMatch: async () => null,
      recordFingerprint: async (args) => { recordCalls.push(args); }
    },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  await assert.rejects(
    () => pipeline.processAndSave({
      doc: { id: 7 }, updateData: { tags: [1], document_type: 3 },
      analysis: { metrics: {}, document: {} }, originalData: {}, content: 'text', correspondentId: 99
    }),
    /Netzwerkfehler/
  );

  assert.strictEqual(recordCalls.length, 0);
});

test('processAndSave wendet den Fingerprint an, speichert dann und zeichnet ihn mit den NACH Fingerprint-Anwendung aktuellen Tags auf', async () => {
  const recordCalls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => ({}) },
    documentFingerprintService: {
      findMatch: async () => ({ tagIds: [55], documentTypeId: 66 }),
      recordFingerprint: async (args) => { recordCalls.push(args); }
    },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  const updateData = { tags: [1], document_type: 3 };
  await pipeline.processAndSave({
    doc: { id: 7 }, updateData,
    analysis: { metrics: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, document: {} },
    originalData: { tags: [], correspondent: null, title: 'Old' },
    content: 'text', correspondentId: 99
  });

  assert.deepStrictEqual(updateData.tags, [55]);
  assert.strictEqual(updateData.document_type, 66);
  assert.strictEqual(recordCalls.length, 1);
  assert.deepStrictEqual(recordCalls[0].tagIds, [55]);
  assert.strictEqual(recordCalls[0].documentTypeId, 66);
});

test('applyDocumentFingerprint tut nichts, wenn documentFingerprint.enabled=false, selbst mit korrespondentId', async () => {
  const findMatchCalls = [];
  const pipeline = makePipeline({
    documentFingerprintService: { findMatch: async () => { findMatchCalls.push(1); return null; }, recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: false }, limitFunctions: {} }
  });

  const updateData = { tags: [1] };
  await pipeline.applyDocumentFingerprint({ id: 1 }, updateData, 'text', 42);

  assert.strictEqual(findMatchCalls.length, 0);
  assert.deepStrictEqual(updateData.tags, [1]);
});

test('applyDocumentFingerprint respektiert activateTagging=no und ueberschreibt updateData.tags nicht', async () => {
  const pipeline = makePipeline({
    documentFingerprintService: { findMatch: async () => ({ tagIds: [55], documentTypeId: 66 }), recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: true }, limitFunctions: { activateTagging: 'no' } }
  });

  const updateData = { tags: [1], document_type: 3 };
  await pipeline.applyDocumentFingerprint({ id: 1 }, updateData, 'text', 42);

  assert.deepStrictEqual(updateData.tags, [1]);
  assert.strictEqual(updateData.document_type, 66);
});
