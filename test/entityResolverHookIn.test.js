const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');
const config = require('../config/config');

test('correspondentCache und documentTypeCache existieren und sind leer vor erstem Refresh', () => {
  assert.ok(paperlessService.correspondentCache instanceof Map);
  assert.ok(paperlessService.documentTypeCache instanceof Map);
});

test('ensureCorrespondentCache befuellt den Cache aus listCorrespondentsNames', async () => {
  paperlessService.listCorrespondentsNames = async () => ([{ id: 1, name: 'Stadtwerke Musterstadt', document_count: 3 }]);
  paperlessService.correspondentCache.clear();
  paperlessService.lastCorrespondentRefresh = 0;

  await paperlessService.ensureCorrespondentCache();

  assert.strictEqual(paperlessService.correspondentCache.get('stadtwerke musterstadt').id, 1);
});

test('ensureDocumentTypeCache befuellt den Cache aus listDocumentTypesNames', async () => {
  paperlessService.listDocumentTypesNames = async () => ([{ id: 2, name: 'Rechnung' }]);
  paperlessService.documentTypeCache.clear();
  paperlessService.lastDocumentTypeRefresh = 0;

  await paperlessService.ensureDocumentTypeCache();

  assert.strictEqual(paperlessService.documentTypeCache.get('rechnung').id, 2);
});

test('deaktivierter Resolver: _resolveEntity liefert immer create, ohne Store/Judge anzufassen', async () => {
  config.entityResolver.enabled = false;
  const decision = await paperlessService._resolveEntity('tag', 'Irgendwas', [{ id: 1, name: 'Anderes' }]);
  assert.deepStrictEqual(decision, { action: 'create' });
});

test('fehlerhafter Resolver faellt auf create zurueck statt zu werfen', async () => {
  config.entityResolver.enabled = true;
  paperlessService._entityResolverInstance = {
    resolve: async () => { throw new Error('DB kaputt'); }
  };

  const decision = await paperlessService._resolveEntity('tag', 'Irgendwas', []);
  assert.deepStrictEqual(decision, { action: 'create' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('aktivierter Resolver mit funktionierender Instanz liefert deren Entscheidung durch', async () => {
  config.entityResolver.enabled = true;
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'map', id: 42, canonicalName: 'Kanonisch', via: 'exact' })
  };

  const decision = await paperlessService._resolveEntity('correspondent', 'Kanonisch', [{ id: 42, name: 'Kanonisch' }]);
  assert.deepStrictEqual(decision, { action: 'map', id: 42, canonicalName: 'Kanonisch', via: 'exact' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('processTags: bei deaktiviertem Resolver unveraendertes Verhalten', async () => {
  config.entityResolver.enabled = false;
  paperlessService.findExistingTag = async () => null;
  paperlessService.createTagSafely = async (name) => ({ id: 99, name });
  paperlessService.ensureTagCache = async () => {};

  const result = await paperlessService.processTags(['Neuer Tag']);
  assert.deepStrictEqual(result.tagIds, [99]);
});

test('processTags: map-Entscheidung verwendet existierende Entity statt neu anzulegen', async () => {
  config.entityResolver.enabled = true;
  paperlessService.findExistingTag = async () => null;
  paperlessService.ensureTagCache = async () => {};
  paperlessService.createTagSafely = async () => { throw new Error('darf bei map nicht aufgerufen werden'); };
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'map', id: 77, canonicalName: 'Kanonischer Tag' })
  };

  const result = await paperlessService.processTags(['Irgendein Tag']);
  assert.deepStrictEqual(result.tagIds, [77]);
  assert.deepStrictEqual(result.errors, []);

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('processTags: skip-Entscheidung ueberspringt den Tag und vermerkt einen Fehler', async () => {
  config.entityResolver.enabled = true;
  paperlessService.findExistingTag = async () => null;
  paperlessService.ensureTagCache = async () => {};
  paperlessService.createTagSafely = async () => { throw new Error('darf bei skip nicht aufgerufen werden'); };
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'skip' })
  };

  const result = await paperlessService.processTags(['   '].length ? ['Leerer Vorschlag'] : []);
  assert.deepStrictEqual(result.tagIds, []);
  assert.strictEqual(result.errors.length, 1);
  assert.strictEqual(result.errors[0].tagName, 'Leerer Vorschlag');

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('processTags: create_and_queue ruft _recordEntityQueue mit der echten neuen ID auf', async () => {
  config.entityResolver.enabled = true;
  paperlessService.findExistingTag = async () => null;
  paperlessService.ensureTagCache = async () => {};
  paperlessService.createTagSafely = async (name) => ({ id: 888, name });

  const decision = { action: 'create_and_queue', candidate: { id: 5, name: 'Kandidat' }, similarity: 0.7, verdict: 'unsure' };
  paperlessService._entityResolverInstance = { resolve: async () => decision };

  let recordedArgs = null;
  paperlessService._recordEntityQueue = (type, proposedName, proposedId, dec) => {
    recordedArgs = { type, proposedName, proposedId, dec };
  };

  const result = await paperlessService.processTags(['Neuer Tag Mit Queue']);
  assert.deepStrictEqual(result.tagIds, [888]);
  assert.ok(recordedArgs);
  assert.strictEqual(recordedArgs.type, 'tag');
  assert.strictEqual(recordedArgs.proposedName, 'Neuer Tag Mit Queue');
  assert.strictEqual(recordedArgs.proposedId, 888);
  assert.strictEqual(recordedArgs.dec, decision);

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
  delete paperlessService._recordEntityQueue;
});

test('getOrCreateCorrespondent: bei deaktiviertem Resolver unveraendertes Verhalten (create)', async () => {
  config.entityResolver.enabled = false;
  paperlessService.searchForExistingCorrespondent = async () => null;
  paperlessService.client = {
    post: async (url, data) => ({ data: { id: 555, name: data.name } })
  };

  const result = await paperlessService.getOrCreateCorrespondent('Neuer Korrespondent');
  assert.deepStrictEqual(result, { id: 555, name: 'Neuer Korrespondent' });
});

test('getOrCreateCorrespondent: fehlerhafter Resolver faellt auf normales Anlegen zurueck', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingCorrespondent = async () => null;
  paperlessService.ensureCorrespondentCache = async () => {};
  paperlessService._entityResolverInstance = {
    resolve: async () => { throw new Error('DB kaputt'); }
  };
  paperlessService.client = {
    post: async (url, data) => ({ data: { id: 556, name: data.name } })
  };

  const result = await paperlessService.getOrCreateCorrespondent('Noch ein Korrespondent');
  assert.deepStrictEqual(result, { id: 556, name: 'Noch ein Korrespondent' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('getOrCreateCorrespondent: map-Entscheidung verwendet existierende Entity statt neu anzulegen', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingCorrespondent = async () => null;
  paperlessService.ensureCorrespondentCache = async () => {};
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'map', id: 12, canonicalName: 'Stadtwerke Musterstadt' })
  };
  paperlessService.client = {
    post: async () => { throw new Error('darf bei map nicht aufgerufen werden'); }
  };

  const result = await paperlessService.getOrCreateCorrespondent('Stadtwerke Musterstadt GmbH');
  assert.deepStrictEqual(result, { id: 12, name: 'Stadtwerke Musterstadt' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('getOrCreateCorrespondent: skip-Entscheidung liefert null ohne anzulegen', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingCorrespondent = async () => null;
  paperlessService.ensureCorrespondentCache = async () => {};
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'skip' })
  };
  paperlessService.client = {
    post: async () => { throw new Error('darf bei skip nicht aufgerufen werden'); }
  };

  const result = await paperlessService.getOrCreateCorrespondent('  ');
  assert.strictEqual(result, null);

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('getOrCreateCorrespondent: create_and_queue ruft _recordEntityQueue mit der echten neuen ID auf', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingCorrespondent = async () => null;
  paperlessService.ensureCorrespondentCache = async () => {};
  const decision = { action: 'create_and_queue', candidate: { id: 9, name: 'Kandidat AG' }, similarity: 0.72, verdict: 'unsure' };
  paperlessService._entityResolverInstance = { resolve: async () => decision };
  paperlessService.client = {
    post: async (url, data) => ({ data: { id: 777, name: data.name } })
  };

  let recordedArgs = null;
  paperlessService._recordEntityQueue = (type, proposedName, proposedId, dec) => {
    recordedArgs = { type, proposedName, proposedId, dec };
  };

  const result = await paperlessService.getOrCreateCorrespondent('Neuer Korrespondent Queue');
  assert.deepStrictEqual(result, { id: 777, name: 'Neuer Korrespondent Queue' });
  assert.ok(recordedArgs);
  assert.strictEqual(recordedArgs.type, 'correspondent');
  assert.strictEqual(recordedArgs.proposedName, 'Neuer Korrespondent Queue');
  assert.strictEqual(recordedArgs.proposedId, 777);
  assert.strictEqual(recordedArgs.dec, decision);

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
  delete paperlessService._recordEntityQueue;
});

test('getOrCreateCorrespondent: create_and_queue greift auch im Race-Condition-Retry-Zweig', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingCorrespondent = async () => null;
  paperlessService.ensureCorrespondentCache = async () => {};
  const decision = { action: 'create_and_queue', candidate: { id: 10, name: 'Kandidat KG' }, similarity: 0.71, verdict: 'unsure' };
  paperlessService._entityResolverInstance = { resolve: async () => decision };
  paperlessService.client = {
    post: async () => {
      const err = new Error('unique constraint violation');
      err.response = { status: 400, data: { error: 'unique constraint violation' } };
      throw err;
    },
    get: async () => ({ data: { results: [{ id: 778, name: 'Rennende Korrespondenz' }] } })
  };

  let recordedArgs = null;
  paperlessService._recordEntityQueue = (type, proposedName, proposedId, dec) => {
    recordedArgs = { type, proposedName, proposedId, dec };
  };

  const result = await paperlessService.getOrCreateCorrespondent('Rennende Korrespondenz');
  assert.deepStrictEqual(result, { id: 778, name: 'Rennende Korrespondenz' });
  assert.ok(recordedArgs);
  assert.strictEqual(recordedArgs.proposedId, 778);

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
  delete paperlessService._recordEntityQueue;
});

test('getOrCreateDocumentType: bei deaktiviertem Resolver unveraendertes Verhalten (create)', async () => {
  config.entityResolver.enabled = false;
  paperlessService.searchForExistingDocumentType = async () => null;
  paperlessService.client = {
    post: async (url, data) => ({ data: { id: 655, name: data.name } })
  };

  const result = await paperlessService.getOrCreateDocumentType('Neuer Dokumenttyp');
  assert.deepStrictEqual(result, { id: 655, name: 'Neuer Dokumenttyp' });
});

test('getOrCreateDocumentType: fehlerhafter Resolver faellt auf normales Anlegen zurueck', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingDocumentType = async () => null;
  paperlessService.ensureDocumentTypeCache = async () => {};
  paperlessService._entityResolverInstance = {
    resolve: async () => { throw new Error('DB kaputt'); }
  };
  paperlessService.client = {
    post: async (url, data) => ({ data: { id: 656, name: data.name } })
  };

  const result = await paperlessService.getOrCreateDocumentType('Noch ein Dokumenttyp');
  assert.deepStrictEqual(result, { id: 656, name: 'Noch ein Dokumenttyp' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('getOrCreateDocumentType: map-Entscheidung verwendet existierende Entity statt neu anzulegen', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingDocumentType = async () => null;
  paperlessService.ensureDocumentTypeCache = async () => {};
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'map', id: 21, canonicalName: 'Rechnung' })
  };
  paperlessService.client = {
    post: async () => { throw new Error('darf bei map nicht aufgerufen werden'); }
  };

  const result = await paperlessService.getOrCreateDocumentType('Rechnungen');
  assert.deepStrictEqual(result, { id: 21, name: 'Rechnung' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('getOrCreateDocumentType: skip-Entscheidung liefert null ohne anzulegen', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingDocumentType = async () => null;
  paperlessService.ensureDocumentTypeCache = async () => {};
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'skip' })
  };
  paperlessService.client = {
    post: async () => { throw new Error('darf bei skip nicht aufgerufen werden'); }
  };

  const result = await paperlessService.getOrCreateDocumentType('  ');
  assert.strictEqual(result, null);

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('getOrCreateDocumentType: create_and_queue ruft _recordEntityQueue mit der echten neuen ID auf', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingDocumentType = async () => null;
  paperlessService.ensureDocumentTypeCache = async () => {};
  const decision = { action: 'create_and_queue', candidate: { id: 30, name: 'Kandidat-Typ' }, similarity: 0.73, verdict: 'unsure' };
  paperlessService._entityResolverInstance = { resolve: async () => decision };
  paperlessService.client = {
    post: async (url, data) => ({ data: { id: 999, name: data.name } })
  };

  let recordedArgs = null;
  paperlessService._recordEntityQueue = (type, proposedName, proposedId, dec) => {
    recordedArgs = { type, proposedName, proposedId, dec };
  };

  const result = await paperlessService.getOrCreateDocumentType('Neuer Dokumenttyp Queue');
  assert.deepStrictEqual(result, { id: 999, name: 'Neuer Dokumenttyp Queue' });
  assert.ok(recordedArgs);
  assert.strictEqual(recordedArgs.type, 'document_type');
  assert.strictEqual(recordedArgs.proposedName, 'Neuer Dokumenttyp Queue');
  assert.strictEqual(recordedArgs.proposedId, 999);
  assert.strictEqual(recordedArgs.dec, decision);

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
  delete paperlessService._recordEntityQueue;
});
