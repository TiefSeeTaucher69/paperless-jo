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

test('processAndSave zeichnet den Fingerprint mit den von updateDocument() zurueckgelieferten (tatsaechlich geschriebenen) Tags auf, nicht mit den vor dem Speichern eingefrorenen (AUDIT-011)', async () => {
  const recordCalls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => ({ tags: [1, 55], document_type: 66 }) },
    documentFingerprintService: { findMatch: async () => null, recordFingerprint: async (args) => { recordCalls.push(args); } },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  // updateData kommt hier bereits fertig vom Aufrufer (buildUpdateData in server.js/
  // routes/setup.js) - processAndSave wendet den Fingerprint selbst nicht mehr an, siehe die
  // findFingerprintMatch-Tests oben.
  const updateData = { tags: [55], document_type: 66 };
  await pipeline.processAndSave({
    doc: { id: 7 }, updateData,
    analysis: { metrics: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, document: {} },
    originalData: { tags: [1], correspondent: null, title: 'Old' },
    content: 'text', correspondentId: 99
  });

  assert.strictEqual(recordCalls.length, 1);
  assert.deepStrictEqual(recordCalls[0].tagIds, [1, 55]);
  assert.strictEqual(recordCalls[0].documentTypeId, 66);
});

test('processAndSave setzt source=llm, wenn kein Fingerprint verwendet wurde', async () => {
  const recordCalls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => ({ tags: [1], document_type: 3 }) },
    documentFingerprintService: { findMatch: async () => null, recordFingerprint: async (args) => { recordCalls.push(args); } },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  await pipeline.processAndSave({
    doc: { id: 7 }, updateData: { tags: [1], document_type: 3 },
    analysis: { metrics: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, document: {} },
    originalData: { tags: [], correspondent: null, title: 'Old' },
    content: 'text', correspondentId: 99, usedFingerprint: false
  });

  assert.strictEqual(recordCalls[0].source, 'llm');
});

test('processAndSave setzt source=inherited, wenn der Aufrufer einen angewendeten Fingerprint-Treffer meldet (AUDIT-003)', async () => {
  const recordCalls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => ({ tags: [55], document_type: 66 }) },
    documentFingerprintService: { findMatch: async () => null, recordFingerprint: async (args) => { recordCalls.push(args); } },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  await pipeline.processAndSave({
    doc: { id: 7 }, updateData: { tags: [55], document_type: 66 },
    analysis: { metrics: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, document: {} },
    originalData: { tags: [], correspondent: null, title: 'Old' },
    content: 'text', correspondentId: 99, usedFingerprint: true
  });

  assert.strictEqual(recordCalls[0].source, 'inherited');
});

test('processAndSave behandelt ein undefined updatedDoc von paperlessService.updateDocument robust (Review-Fix)', async () => {
  const recordCalls = [];
  const pipeline = makePipeline({
    paperlessService: { updateDocument: async () => undefined },
    documentFingerprintService: { findMatch: async () => null, recordFingerprint: async (args) => { recordCalls.push(args); } },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  await assert.doesNotReject(() => pipeline.processAndSave({
    doc: { id: 7 }, updateData: { tags: [1], document_type: 3 },
    analysis: { metrics: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, document: {} },
    originalData: { tags: [], correspondent: null, title: 'Old' },
    content: 'text', correspondentId: 99
  }));

  assert.strictEqual(recordCalls.length, 1);
  assert.deepStrictEqual(recordCalls[0].tagIds, [1]); // faellt auf updateData.tags zurueck
  assert.strictEqual(recordCalls[0].documentTypeId, null);
});

test('findFingerprintMatch liefert null, wenn documentFingerprint.enabled=false, selbst mit korrespondentId', async () => {
  const findMatchCalls = [];
  const pipeline = makePipeline({
    documentFingerprintService: { findMatch: async () => { findMatchCalls.push(1); return null; }, recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: false }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.strictEqual(result, null);
  assert.strictEqual(findMatchCalls.length, 0);
});

test('findFingerprintMatch liefert null ohne korrespondentId, selbst wenn aktiviert', async () => {
  const pipeline = makePipeline({
    documentFingerprintService: { findMatch: async () => ({ tagIds: [1], documentTypeId: 2 }), recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(null, 'text');

  assert.strictEqual(result, null);
});

test('findFingerprintMatch liefert die Treffer-IDs, wenn sie gegen den aktuellen Paperless-Bestand gueltig sind', async () => {
  const pipeline = makePipeline({
    paperlessService: {
      hasTagId: async (id) => [55, 56].includes(id),
      hasDocumentTypeId: async (id) => id === 66
    },
    documentFingerprintService: { findMatch: async () => ({ tagIds: [55, 56], documentTypeId: 66 }), recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.deepStrictEqual(result, { tagIds: [55, 56], documentTypeId: 66 });
});

test('findFingerprintMatch verwirft Tag-IDs, die in Paperless nicht mehr existieren (AUDIT-006)', async () => {
  const pipeline = makePipeline({
    paperlessService: {
      hasTagId: async (id) => id === 55, // 56 existiert nicht mehr - z.B. geloescht oder gemergt
      hasDocumentTypeId: async () => true
    },
    documentFingerprintService: { findMatch: async () => ({ tagIds: [55, 56], documentTypeId: 66 }), recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.deepStrictEqual(result.tagIds, [55]);
});

test('findFingerprintMatch verwirft eine Dokumenttyp-ID, die in Paperless nicht mehr existiert (AUDIT-006)', async () => {
  const pipeline = makePipeline({
    paperlessService: {
      hasTagId: async () => true,
      hasDocumentTypeId: async () => false
    },
    documentFingerprintService: { findMatch: async () => ({ tagIds: [55], documentTypeId: 66 }), recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.strictEqual(result.documentTypeId, null);
});

test('findFingerprintMatch liefert null, wenn nach der ID-Validierung nichts Gueltiges mehr uebrig ist (Review-Fix)', async () => {
  const pipeline = makePipeline({
    paperlessService: { hasTagId: async () => false, hasDocumentTypeId: async () => false },
    documentFingerprintService: { findMatch: async () => ({ tagIds: [55], documentTypeId: 66 }), recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.strictEqual(result, null);
});

test('findFingerprintMatch faengt Fehler ab und liefert null, statt zu werfen', async () => {
  const pipeline = makePipeline({
    paperlessService: { hasTagId: async () => true, hasDocumentTypeId: async () => true },
    documentFingerprintService: { findMatch: async () => { throw new Error('Embedding-Dienst nicht erreichbar'); }, recordFingerprint: async () => {} },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.strictEqual(result, null);
});

test('invalidateFingerprintsForMerge delegiert an den Store, wenn der Fingerprint-Service existiert (AUDIT-006)', () => {
  const calls = [];
  const pipeline = makePipeline({
    documentFingerprintService: { store: { invalidateForMerge: (...args) => calls.push(args) } },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  pipeline.invalidateFingerprintsForMerge('tag', 5, 6);

  assert.deepStrictEqual(calls, [['tag', 5, 6]]);
});

test('invalidateFingerprintsForMerge tut nichts ohne documentFingerprintService', () => {
  const pipeline = makePipeline({
    documentFingerprintService: null,
    config: { documentFingerprint: { enabled: false }, limitFunctions: {} }
  });

  assert.doesNotThrow(() => pipeline.invalidateFingerprintsForMerge('tag', 5, 6));
});

test('pruneOrphanedFingerprints delegiert an den Store, wenn der Fingerprint-Service existiert (AUDIT-020)', () => {
  const calls = [];
  const pipeline = makePipeline({
    documentFingerprintService: { store: { pruneOrphaned: (ids) => { calls.push(ids); return ids.length; } } },
    config: { documentFingerprint: { enabled: true }, limitFunctions: {} }
  });

  pipeline.pruneOrphanedFingerprints([1, 2, 3]);

  assert.deepStrictEqual(calls, [[1, 2, 3]]);
});

test('pruneOrphanedFingerprints tut nichts ohne documentFingerprintService', () => {
  const pipeline = makePipeline({
    documentFingerprintService: null,
    config: { documentFingerprint: { enabled: false }, limitFunctions: {} }
  });

  assert.doesNotThrow(() => pipeline.pruneOrphanedFingerprints([1, 2, 3]));
});

test('restoreOriginalData liefert restored:false, wenn kein Original gespeichert ist', async () => {
  const pipeline = makePipeline({
    documentModel: { getOriginalData: async () => undefined }
  });

  const result = await pipeline.restoreOriginalData(42);

  assert.deepStrictEqual(result, { restored: false, reason: 'no_original_data' });
});

test('restoreOriginalData liefert restored:false, wenn getOriginalData wegen eines internen DB-Fehlers [] statt null liefert (Review-Fix)', async () => {
  const overwriteCalls = [];
  const pipeline = makePipeline({
    documentModel: { getOriginalData: async () => [] },
    paperlessService: {
      overwriteDocumentFields: async (documentId, fields) => { overwriteCalls.push({ documentId, fields }); return {}; }
    }
  });

  const result = await pipeline.restoreOriginalData(42);

  assert.deepStrictEqual(result, { restored: false, reason: 'no_original_data' });
  assert.strictEqual(overwriteCalls.length, 0);
});

test('restoreOriginalData schreibt den gespeicherten Originalzustand ueber overwriteDocumentFields zurueck', async () => {
  const overwriteCalls = [];
  const pipeline = makePipeline({
    documentModel: {
      getOriginalData: async () => ({ document_id: 42, title: 'Alter Titel', tags: '[1,2]', correspondent: '5' })
    },
    paperlessService: {
      overwriteDocumentFields: async (documentId, fields) => { overwriteCalls.push({ documentId, fields }); return {}; }
    }
  });

  const result = await pipeline.restoreOriginalData(42);

  assert.strictEqual(overwriteCalls.length, 1);
  assert.strictEqual(overwriteCalls[0].documentId, 42);
  assert.deepStrictEqual(overwriteCalls[0].fields, { title: 'Alter Titel', tags: [1, 2], correspondent: 5 });
  assert.deepStrictEqual(result, { restored: true, original: { title: 'Alter Titel', tags: [1, 2], correspondent: 5 } });
});

test('restoreOriginalData behandelt einen null-Korrespondenten korrekt (nicht als 0 oder NaN)', async () => {
  const overwriteCalls = [];
  const pipeline = makePipeline({
    documentModel: {
      getOriginalData: async () => ({ document_id: 42, title: 'Titel', tags: '[]', correspondent: null })
    },
    paperlessService: {
      overwriteDocumentFields: async (documentId, fields) => { overwriteCalls.push({ documentId, fields }); return {}; }
    }
  });

  await pipeline.restoreOriginalData(42);

  assert.strictEqual(overwriteCalls[0].fields.correspondent, null);
  assert.deepStrictEqual(overwriteCalls[0].fields.tags, []);
});

test('restoreOriginalData wirft weiter, wenn overwriteDocumentFields fehlschlaegt', async () => {
  const pipeline = makePipeline({
    documentModel: {
      getOriginalData: async () => ({ document_id: 42, title: 'Titel', tags: '[1]', correspondent: '5' })
    },
    paperlessService: {
      overwriteDocumentFields: async () => { throw new Error('PATCH fehlgeschlagen'); }
    }
  });

  await assert.rejects(() => pipeline.restoreOriginalData(42), /PATCH fehlgeschlagen/);
});
