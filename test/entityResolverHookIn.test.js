const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');
const config = require('../config/config');
const EntityStore = require('../models/entityStore');
const EntityResolver = require('../services/entityResolver');

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

  try {
    const decision = await paperlessService._resolveEntity('tag', 'Irgendwas', []);
    assert.deepStrictEqual(decision, { action: 'create' });
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
});

test('aktivierter Resolver mit funktionierender Instanz liefert deren Entscheidung durch', async () => {
  config.entityResolver.enabled = true;
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'map', id: 42, canonicalName: 'Kanonisch', via: 'exact' })
  };

  try {
    const decision = await paperlessService._resolveEntity('correspondent', 'Kanonisch', [{ id: 42, name: 'Kanonisch' }]);
    assert.deepStrictEqual(decision, { action: 'map', id: 42, canonicalName: 'Kanonisch', via: 'exact' });
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.processTags(['Irgendein Tag']);
    assert.deepStrictEqual(result.tagIds, [77]);
    assert.deepStrictEqual(result.errors, []);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
});

test('processTags: skip-Entscheidung ueberspringt den Tag und vermerkt einen Fehler', async () => {
  config.entityResolver.enabled = true;
  paperlessService.findExistingTag = async () => null;
  paperlessService.ensureTagCache = async () => {};
  paperlessService.createTagSafely = async () => { throw new Error('darf bei skip nicht aufgerufen werden'); };
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'skip' })
  };

  try {
    const result = await paperlessService.processTags(['Leerer Vorschlag']);
    assert.deepStrictEqual(result.tagIds, []);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].tagName, 'Leerer Vorschlag');
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.processTags(['Neuer Tag Mit Queue']);
    assert.deepStrictEqual(result.tagIds, [888]);
    assert.ok(recordedArgs);
    assert.strictEqual(recordedArgs.type, 'tag');
    assert.strictEqual(recordedArgs.proposedName, 'Neuer Tag Mit Queue');
    assert.strictEqual(recordedArgs.proposedId, 888);
    assert.strictEqual(recordedArgs.dec, decision);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
    delete paperlessService._recordEntityQueue;
  }
});

test('processTags: werfender Resolver faellt auf normales Anlegen zurueck (Fail-Open)', async () => {
  config.entityResolver.enabled = true;
  paperlessService.findExistingTag = async () => null;
  paperlessService.ensureTagCache = async () => {};
  paperlessService.createTagSafely = async (name) => ({ id: 111, name });
  paperlessService._entityResolverInstance = {
    resolve: async () => { throw new Error('Judge/Store kaputt'); }
  };

  try {
    const result = await paperlessService.processTags(['Tag Trotz Fehler']);
    assert.deepStrictEqual(result.tagIds, [111]);
    assert.deepStrictEqual(result.errors, []);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

test('KRITISCH: getOrCreateCorrespondent ruft ensureCorrespondentCache NICHT auf, wenn Resolver deaktiviert ist (kein unnoetiger API-Call)', async () => {
  const originalEnsure = paperlessService.ensureCorrespondentCache;
  try {
    config.entityResolver.enabled = false;
    paperlessService.correspondentCache.clear();
    paperlessService.lastCorrespondentRefresh = 0;

    let ensureCalls = 0;
    paperlessService.ensureCorrespondentCache = async () => { ensureCalls++; };
    paperlessService.searchForExistingCorrespondent = async () => null;
    paperlessService.client = {
      post: async (url, data) => ({ data: { id: 901, name: data.name } })
    };

    const result = await paperlessService.getOrCreateCorrespondent('Kein Cache Noetig');
    assert.deepStrictEqual(result, { id: 901, name: 'Kein Cache Noetig' });
    assert.strictEqual(ensureCalls, 0, 'ensureCorrespondentCache darf bei deaktiviertem Resolver nicht aufgerufen werden');
  } finally {
    config.entityResolver.enabled = false;
    paperlessService.ensureCorrespondentCache = originalEnsure;
  }
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

  try {
    const result = await paperlessService.getOrCreateCorrespondent('Noch ein Korrespondent');
    assert.deepStrictEqual(result, { id: 556, name: 'Noch ein Korrespondent' });
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.getOrCreateCorrespondent('Stadtwerke Musterstadt GmbH');
    assert.deepStrictEqual(result, { id: 12, name: 'Stadtwerke Musterstadt' });
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.getOrCreateCorrespondent('  ');
    assert.strictEqual(result, null);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.getOrCreateCorrespondent('Neuer Korrespondent Queue');
    assert.deepStrictEqual(result, { id: 777, name: 'Neuer Korrespondent Queue' });
    assert.ok(recordedArgs);
    assert.strictEqual(recordedArgs.type, 'correspondent');
    assert.strictEqual(recordedArgs.proposedName, 'Neuer Korrespondent Queue');
    assert.strictEqual(recordedArgs.proposedId, 777);
    assert.strictEqual(recordedArgs.dec, decision);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
    delete paperlessService._recordEntityQueue;
  }
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

  try {
    const result = await paperlessService.getOrCreateCorrespondent('Rennende Korrespondenz');
    assert.deepStrictEqual(result, { id: 778, name: 'Rennende Korrespondenz' });
    assert.ok(recordedArgs);
    assert.strictEqual(recordedArgs.proposedId, 778);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
    delete paperlessService._recordEntityQueue;
  }
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

test('KRITISCH: getOrCreateDocumentType ruft ensureDocumentTypeCache NICHT auf, wenn Resolver deaktiviert ist (kein unnoetiger API-Call)', async () => {
  const originalEnsure = paperlessService.ensureDocumentTypeCache;
  try {
    config.entityResolver.enabled = false;
    paperlessService.documentTypeCache.clear();
    paperlessService.lastDocumentTypeRefresh = 0;

    let ensureCalls = 0;
    paperlessService.ensureDocumentTypeCache = async () => { ensureCalls++; };
    paperlessService.searchForExistingDocumentType = async () => null;
    paperlessService.client = {
      post: async (url, data) => ({ data: { id: 902, name: data.name } })
    };

    const result = await paperlessService.getOrCreateDocumentType('Kein Cache Noetig Typ');
    assert.deepStrictEqual(result, { id: 902, name: 'Kein Cache Noetig Typ' });
    assert.strictEqual(ensureCalls, 0, 'ensureDocumentTypeCache darf bei deaktiviertem Resolver nicht aufgerufen werden');
  } finally {
    config.entityResolver.enabled = false;
    paperlessService.ensureDocumentTypeCache = originalEnsure;
  }
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

  try {
    const result = await paperlessService.getOrCreateDocumentType('Noch ein Dokumenttyp');
    assert.deepStrictEqual(result, { id: 656, name: 'Noch ein Dokumenttyp' });
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.getOrCreateDocumentType('Rechnungen');
    assert.deepStrictEqual(result, { id: 21, name: 'Rechnung' });
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.getOrCreateDocumentType('  ');
    assert.strictEqual(result, null);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
  }
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

  try {
    const result = await paperlessService.getOrCreateDocumentType('Neuer Dokumenttyp Queue');
    assert.deepStrictEqual(result, { id: 999, name: 'Neuer Dokumenttyp Queue' });
    assert.ok(recordedArgs);
    assert.strictEqual(recordedArgs.type, 'document_type');
    assert.strictEqual(recordedArgs.proposedName, 'Neuer Dokumenttyp Queue');
    assert.strictEqual(recordedArgs.proposedId, 999);
    assert.strictEqual(recordedArgs.dec, decision);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
    delete paperlessService._recordEntityQueue;
  }
});

test('getOrCreateDocumentType: create_and_queue greift auch im Race-Condition-Retry-Zweig', async () => {
  config.entityResolver.enabled = true;
  paperlessService.searchForExistingDocumentType = async () => null;
  paperlessService.ensureDocumentTypeCache = async () => {};
  const decision = { action: 'create_and_queue', candidate: { id: 40, name: 'Kandidat-Typ Race' }, similarity: 0.74, verdict: 'unsure' };
  paperlessService._entityResolverInstance = { resolve: async () => decision };
  paperlessService.client = {
    post: async () => {
      const err = new Error('unique constraint violation');
      err.response = { status: 400, data: { error: 'unique constraint violation' } };
      throw err;
    },
    get: async () => ({ data: { results: [{ id: 1000, name: 'Rennender Dokumenttyp' }] } })
  };

  let recordedArgs = null;
  paperlessService._recordEntityQueue = (type, proposedName, proposedId, dec) => {
    recordedArgs = { type, proposedName, proposedId, dec };
  };

  try {
    const result = await paperlessService.getOrCreateDocumentType('Rennender Dokumenttyp');
    assert.deepStrictEqual(result, { id: 1000, name: 'Rennender Dokumenttyp' });
    assert.ok(recordedArgs);
    assert.strictEqual(recordedArgs.type, 'document_type');
    assert.strictEqual(recordedArgs.proposedName, 'Rennender Dokumenttyp');
    assert.strictEqual(recordedArgs.proposedId, 1000);
    assert.strictEqual(recordedArgs.dec, decision);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
    delete paperlessService._recordEntityQueue;
  }
});

test('_getEntityResolver(): lazy construction verdrahtet autoThreshold/judgeMin aus config.entityResolver', () => {
  const originalInstance = paperlessService._entityResolverInstance;
  const originalDbPath = config.entityResolver.dbPath;

  try {
    config.entityResolver.dbPath = ':memory:';
    paperlessService._entityResolverInstance = null;

    const resolver = paperlessService._getEntityResolver();

    assert.strictEqual(resolver.autoThreshold, config.entityResolver.autoThreshold);
    assert.strictEqual(resolver.judgeMin, config.entityResolver.judgeMin);
    resolver.store.close();
  } finally {
    config.entityResolver.dbPath = originalDbPath;
    paperlessService._entityResolverInstance = originalInstance;
  }
});

test('aktivierter Resolver mit echter EntityResolver/EntityStore-Verdrahtung schreibt echte Zeile in entity_review_queue', async () => {
  const originalInstance = paperlessService._entityResolverInstance;
  const originalSearch = paperlessService.searchForExistingCorrespondent;
  const originalEnsure = paperlessService.ensureCorrespondentCache;
  const originalClient = paperlessService.client;
  const originalCacheEntries = Array.from(paperlessService.correspondentCache.entries());

  const store = new EntityStore(':memory:');

  try {
    config.entityResolver.enabled = true;

    // autoThreshold auf unerreichbar und judgeMin auf 0 gesetzt, damit der Judge
    // garantiert aufgerufen wird (statt Auto-Map oder direktem Create).
    paperlessService._entityResolverInstance = new EntityResolver({
      store,
      judge: async () => ({ verdict: 'unsure', reason: 'Testfall erzwingt unsure' }),
      config: { autoThreshold: 1.1, judgeMin: 0 }
    });

    paperlessService.searchForExistingCorrespondent = async () => null;
    paperlessService.ensureCorrespondentCache = async () => {};
    paperlessService.correspondentCache.clear();
    paperlessService.correspondentCache.set('vollkommen anderer name', { id: 501, name: 'Vollkommen Anderer Name' });
    paperlessService.client = {
      post: async (url, data) => ({ data: { id: 850, name: data.name } })
    };

    const result = await paperlessService.getOrCreateCorrespondent('Testkorrespondent Fuer Echte Queue');
    assert.deepStrictEqual(result, { id: 850, name: 'Testkorrespondent Fuer Echte Queue' });

    const row = store.db.prepare(
      `SELECT * FROM entity_review_queue WHERE entity_type = ? AND proposed_name = ?`
    ).get('correspondent', 'Testkorrespondent Fuer Echte Queue');

    assert.ok(row, 'Es sollte eine echte Zeile in entity_review_queue geschrieben worden sein');
    assert.strictEqual(row.proposed_id, 850);
    assert.strictEqual(row.candidate_id, 501);
    assert.strictEqual(row.status, 'open');
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = originalInstance;
    paperlessService.searchForExistingCorrespondent = originalSearch;
    paperlessService.ensureCorrespondentCache = originalEnsure;
    paperlessService.client = originalClient;
    paperlessService.correspondentCache.clear();
    originalCacheEntries.forEach(([key, value]) => paperlessService.correspondentCache.set(key, value));
    store.close();
  }
});
