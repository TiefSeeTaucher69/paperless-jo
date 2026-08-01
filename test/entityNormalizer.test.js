const { test } = require('node:test');
const assert = require('node:assert');
const { normalize, normalizeForType } = require('../services/entityNormalizer');

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

test('Rechtsform-Token wird nur bei Korrespondenten entfernt', () => {
  assert.strictEqual(normalizeForType('Stadtwerke Musterstadt GmbH', 'correspondent'), 'stadtwerke musterstadt');
  assert.strictEqual(normalizeForType('Stadtwerke Musterstadt GmbH', 'tag'), 'stadtwerke musterstadt gmbh');
});

test('e V als Bigramm wird entfernt', () => {
  assert.strictEqual(normalizeForType('Sportverein Musterstadt e.V.', 'correspondent'), 'sportverein musterstadt');
});

test('mehrere Rechtsform-Token gemischt', () => {
  assert.strictEqual(normalizeForType('Muster AG & Co. KGaA', 'correspondent'), 'muster');
});

test('reines Rechtsform-Token kollabiert nicht auf Leerstring', () => {
  assert.strictEqual(normalizeForType('GmbH', 'correspondent'), 'gmbh');
});

test('document_type und tag bleiben unveraendert zu normalize', () => {
  assert.strictEqual(normalizeForType('Rechnung AG', 'document_type'), normalizeForType('Rechnung AG', 'tag'));
});
