const { test } = require('node:test');
const assert = require('node:assert');
const EntityResolver = require('../services/entityResolver');
const EntityStore = require('../models/entityStore');

function makeResolver(overrides = {}) {
  const store = overrides.store || new EntityStore(':memory:');
  const judge = overrides.judge || (async () => { throw new Error('Judge sollte in diesem Test nicht aufgerufen werden'); });
  return new EntityResolver({ store, judge, config: { autoThreshold: 0.90, judgeMin: 0.65 } });
}

test('Stufe 0: leer oder nur Whitespace -> skip', async () => {
  const resolver = makeResolver();
  assert.deepStrictEqual(await resolver.resolve('tag', '   ', []), { action: 'skip' });
  assert.deepStrictEqual(await resolver.resolve('tag', '', []), { action: 'skip' });
});

test('Stufe 1: Alias-Tabelle kennt normalize(N) -> map ohne API/LLM', async () => {
  const store = new EntityStore(':memory:');
  store.insertAlias({ entityType: 'correspondent', aliasNormalized: 'stadtwerke musterstadt', canonicalName: 'Stadtwerke Musterstadt', canonicalId: 5, source: 'user' });
  const resolver = makeResolver({ store });

  const result = await resolver.resolve('correspondent', 'Stadtwerke Musterstadt GmbH', [{ id: 5, name: 'Stadtwerke Musterstadt' }]);
  assert.deepStrictEqual(result, { action: 'map', id: 5, canonicalName: 'Stadtwerke Musterstadt', via: 'alias' });
});

test('Stufe 1 Fehlerfall: Alias zeigt auf geloeschte ID -> verworfen, neu entschieden', async () => {
  const store = new EntityStore(':memory:');
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 999, source: 'auto' });
  const resolver = makeResolver({ store });

  // 999 existiert nicht mehr im Bestand -> Alias verwerfen, dann Stufe 4d (keine Aehnlichkeit) -> create
  const result = await resolver.resolve('tag', 'Rechnung', [{ id: 1, name: 'Vertrag' }]);
  assert.strictEqual(result.action, 'create');
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('Stufe 2: exakter Treffer im Bestand -> map', async () => {
  const resolver = makeResolver();
  const result = await resolver.resolve('tag', 'Rechnung', [{ id: 7, name: 'Rechnung' }]);
  assert.deepStrictEqual(result, { action: 'map', id: 7, canonicalName: 'Rechnung', via: 'exact' });
});

test('Stufe 3: normalisierter Treffer -> map, Alias wird geschrieben', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  const result = await resolver.resolve('correspondent', 'Müller Straße GmbH', [{ id: 3, name: 'Mueller Strasse' }]);
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.id, 3);
  assert.strictEqual(result.via, 'normalized');

  const alias = store.findAlias('correspondent', 'mueller strasse');
  assert.ok(alias, 'Alias sollte geschrieben worden sein');
  assert.strictEqual(alias.source, 'auto');
});
