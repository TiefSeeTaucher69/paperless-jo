const { test } = require('node:test');
const assert = require('node:assert');
const RestrictionPromptService = require('../services/restrictionPromptService');

test('%RESTRICTED_TAGS% wird aus einem String-Array befuellt', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    ['Rechnung', 'Versicherung'],
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
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: Rechnung, Versicherung');
});

test('%RESTRICTED_TAGS% wird bei leerer Liste zu Leerstring', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    [],
    [],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: ');
});
