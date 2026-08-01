const { test } = require('node:test');
const assert = require('node:assert');
const ollamaService = require('../services/ollamaService');

test('ein normaler Kategorie-Tag ist plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Sozialversicherung'), true);
});

test('ein mehrwortiger Kategorie-Tag ist plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Vertrag Änderung'), true);
});

test('ein Tag mit Doppelpunkt ist ein Datenfeld, kein Kategorie-Tag', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Personal-Nr.: XXXXXX 000'), false);
});

test('ein Tag mit Zeitraumsangabe und Doppelpunkt wird verworfen', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Abrechnungszeitraum: 01.06.2026-30.06.2026'), false);
});

test('ein unplausibel langer Tag wird verworfen', () => {
  const long = 'x'.repeat(61);
  assert.strictEqual(ollamaService._isPlausibleTag(long), false);
});

test('ein Tag an der Laengengrenze von 60 Zeichen bleibt plausibel', () => {
  const atLimit = 'x'.repeat(60);
  assert.strictEqual(ollamaService._isPlausibleTag(atLimit), true);
});

test('ein leerer oder nicht-string Tag ist nicht plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleTag(''), false);
  assert.strictEqual(ollamaService._isPlausibleTag('   '), false);
  assert.strictEqual(ollamaService._isPlausibleTag(null), false);
  assert.strictEqual(ollamaService._isPlausibleTag(undefined), false);
});

test('_normalizeParsedDocument filtert unplausible Tags aus dem Dokument', () => {
  const doc = {
    tags: ['Rechnung', 'Personal-Nr.: XXXXXX 000', 'Versicherung'],
    document_date: null
  };

  ollamaService._normalizeParsedDocument(doc);

  assert.deepStrictEqual(doc.tags, ['Rechnung', 'Versicherung']);
});

test('_normalizeParsedDocument laesst ein Dokument ohne tags-Array unangetastet', () => {
  const doc = { correspondent: 'Finanzamt' };
  const result = ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(result, doc);
  assert.strictEqual(doc.tags, undefined);
});
