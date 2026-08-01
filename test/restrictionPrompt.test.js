const { test } = require('node:test');
const assert = require('node:assert');
const RestrictionPromptService = require('../services/restrictionPromptService');

test('%RESTRICTED_TAGS% wird aus einem String-Array befuellt', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    ['Rechnung', 'Versicherung'],
    [],
    [],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: Rechnung, Versicherung');
});

test('%RESTRICTED_TAGS% akzeptiert weiterhin ein Objekt-Array', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    [{ id: 1, name: 'Rechnung' }, { id: 2, name: 'Versicherung' }],
    [],
    [],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: Rechnung, Versicherung');
});

test('%RESTRICTED_TAGS% wird bei leerer Liste zu Leerstring', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    [],
    [],
    [],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: ');
});

test('%RESTRICTED_DOCUMENT_TYPES% wird aus einem String-Array befuellt', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Dokumentarten: %RESTRICTED_DOCUMENT_TYPES%',
    [],
    [],
    ['Rechnung', 'Gehaltsabrechnung'],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Dokumentarten: Rechnung, Gehaltsabrechnung');
});

test('%RESTRICTED_DOCUMENT_TYPES% akzeptiert ein Objekt-Array', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Dokumentarten: %RESTRICTED_DOCUMENT_TYPES%',
    [],
    [],
    [{ id: 7, name: 'Rechnung' }],
    {}
  );

  assert.strictEqual(result, 'Dokumentarten: Rechnung');
});

test('alle drei Platzhalter werden in einem Prompt ersetzt', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'T:%RESTRICTED_TAGS% K:%RESTRICTED_CORRESPONDENTS% D:%RESTRICTED_DOCUMENT_TYPES%',
    ['Steuer'],
    ['Finanzamt'],
    ['Bescheid'],
    {}
  );

  assert.strictEqual(result, 'T:Steuer K:Finanzamt D:Bescheid');
});

test('Korrespondenten koennen als vorformatierter String kommen', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'K: %RESTRICTED_CORRESPONDENTS%',
    [],
    '  Finanzamt, Stadtwerke  ',
    [],
    {}
  );

  assert.strictEqual(result, 'K: Finanzamt, Stadtwerke');
});
