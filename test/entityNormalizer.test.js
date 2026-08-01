const { test } = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../services/entityNormalizer');

test('Kleinschreibung und Whitespace-Kollaps', () => {
  assert.strictEqual(normalize('  Stadt WERKE   Musterstadt '), 'stadt werke musterstadt');
});

test('Umlaute und scharfes S werden gefaltet', () => {
  assert.strictEqual(normalize('Müller Straße'), 'mueller strasse');
  assert.strictEqual(normalize('ÄÖÜ Größe'), 'aeoeue groesse');
});

test('Interpunktion wird zu Leerzeichen', () => {
  assert.strictEqual(normalize('Stadtwerke, GmbH & Co. KG'), 'stadtwerke gmbh co kg');
});

test('fremdsprachige Diakritika werden ueber NFKD entfernt', () => {
  assert.strictEqual(normalize('Café Résumé'), 'cafe resume');
});

test('leerer oder Nicht-String-Input liefert Leerstring', () => {
  assert.strictEqual(normalize(''), '');
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
});

test('keine Plural-/Singular-Stemming', () => {
  assert.notStrictEqual(normalize('Rechnung'), normalize('Rechnungen'));
});
