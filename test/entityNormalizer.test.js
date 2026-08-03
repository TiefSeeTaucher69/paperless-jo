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

test('Rechtsform-Token am Namensanfang wird nicht entfernt (AUDIT-016)', () => {
  assert.strictEqual(normalizeForType('AG Nürnberg', 'correspondent'), 'ag nuernberg');
  assert.notStrictEqual(
    normalizeForType('AG Nürnberg', 'correspondent'),
    normalizeForType('Nürnberg', 'correspondent')
  );
});

test('SE als Namensbestandteil am Anfang bleibt erhalten (AUDIT-016)', () => {
  assert.strictEqual(normalizeForType('SE Bank', 'correspondent'), 'se bank');
  assert.notStrictEqual(
    normalizeForType('SE Bank', 'correspondent'),
    normalizeForType('Bank', 'correspondent')
  );
});

test('Co- als Wortbestandteil am Anfang bleibt erhalten (AUDIT-016)', () => {
  assert.strictEqual(normalizeForType('Co-Working Nord', 'correspondent'), 'co working nord');
  assert.notStrictEqual(
    normalizeForType('Co-Working Nord', 'correspondent'),
    normalizeForType('Working Nord', 'correspondent')
  );
});

test('kurzes ambiges Rechtsform-Token am Ende bleibt, wenn der Rest zu kurz ist (AUDIT-016)', () => {
  assert.strictEqual(normalizeForType('X SE', 'correspondent'), 'x se');
});

test('kurzes ambiges Rechtsform-Token am Ende wird entfernt, wenn genug Rest bleibt (AUDIT-016)', () => {
  assert.strictEqual(normalizeForType('ADAC SE', 'correspondent'), 'adac');
});

test('unambiges Rechtsform-Token am Ende wird weiterhin immer entfernt', () => {
  assert.strictEqual(normalizeForType('X GmbH', 'correspondent'), 'x');
});

test('kurzes ambiges Rechtsform-Token wird bei exakt 3 Zeichen Rest entfernt (Grenzfall, AUDIT-016)', () => {
  assert.strictEqual(normalizeForType('IBM SE', 'correspondent'), 'ibm');
});
