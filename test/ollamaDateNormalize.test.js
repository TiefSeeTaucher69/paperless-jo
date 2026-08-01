const { test } = require('node:test');
const assert = require('node:assert');
const ollamaService = require('../services/ollamaService');

test('ein ISO-Datum bleibt unveraendert', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate('2026-07-22'), '2026-07-22');
});

test('ein deutsches Datum wird zu ISO konvertiert', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate('22.07.2026'), '2026-07-22');
});

test('ein einstelliger Tag/Monat im deutschen Format wird nicht erkannt', () => {
  // Bewusst konservativ: nur das zweistellige Format wird konvertiert,
  // alles andere lieber verwerfen als falsch raten.
  assert.strictEqual(ollamaService._normalizeDocumentDate('2.7.2026'), null);
});

test('ein unbekanntes Format wird verworfen, nicht geraten', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate('22. Juli 2026'), null);
});

test('null und undefined werden verworfen', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate(null), null);
  assert.strictEqual(ollamaService._normalizeDocumentDate(undefined), null);
});

test('_normalizeParsedDocument normiert document_date im Dokument', () => {
  const doc = { tags: [], document_date: '22.07.2026' };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_date, '2026-07-22');
});

test('_normalizeParsedDocument verwirft ein unparsebares document_date', () => {
  const doc = { tags: [], document_date: '22. Juli 2026' };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_date, null);
});

test('_normalizeParsedDocument laesst ein fehlendes document_date unangetastet', () => {
  const doc = { tags: [] };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_date, undefined);
});
