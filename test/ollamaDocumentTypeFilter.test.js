const { test } = require('node:test');
const assert = require('node:assert');
const ollamaService = require('../services/ollamaService');

test('eine normale Dokumentart ist plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType('Entgeltabrechnung'), true);
});

test('der bekannte Prompt-Platzhalter wird verworfen', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType('Invoice/Contract/...'), false);
});

test('ein Wert mit Schraegstrich wird verworfen', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType('Rechnung/Mahnung'), false);
});

test('ein unplausibel langer Wert wird verworfen', () => {
  const long = 'x'.repeat(61);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(long), false);
});

test('ein Wert an der Laengengrenze von 60 Zeichen bleibt plausibel', () => {
  const atLimit = 'x'.repeat(60);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(atLimit), true);
});

test('ein leerer oder nicht-string Wert ist nicht plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType(''), false);
  assert.strictEqual(ollamaService._isPlausibleDocumentType('   '), false);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(null), false);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(undefined), false);
});

test('_normalizeParsedDocument verwirft eine unplausible Dokumentart und setzt sie auf null', () => {
  const doc = { document_type: 'Invoice/Contract/...', tags: [] };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_type, null);
});

test('_normalizeParsedDocument laesst eine plausible Dokumentart unangetastet', () => {
  const doc = { document_type: 'Entgeltabrechnung', tags: [] };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_type, 'Entgeltabrechnung');
});
