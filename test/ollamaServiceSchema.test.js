process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [] });
process.env.SYSTEM_PROMPT = 'Du bist ein Dokumentenanalyst.';

const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaService = require('../services/ollamaService');

test('documentAnalysisSchema enthaelt custom_fields nur bei activateCustomFields=yes (1.2.b)', () => {
  const saved = config.limitFunctions.activateCustomFields;
  try {
    config.limitFunctions.activateCustomFields = 'no';
    assert.strictEqual(ollamaService.documentAnalysisSchema.properties.custom_fields, undefined);

    config.limitFunctions.activateCustomFields = 'yes';
    assert.deepStrictEqual(
      ollamaService.documentAnalysisSchema.properties.custom_fields,
      { type: 'object', additionalProperties: true }
    );
  } finally {
    config.limitFunctions.activateCustomFields = saved;
  }
});

test('documentAnalysisSchema.required listet custom_fields nie als Pflichtfeld', () => {
  const saved = config.limitFunctions.activateCustomFields;
  try {
    config.limitFunctions.activateCustomFields = 'yes';
    assert.ok(!ollamaService.documentAnalysisSchema.required.includes('custom_fields'));
  } finally {
    config.limitFunctions.activateCustomFields = saved;
  }
});

test('playgroundSchema hat nie custom_fields, unabhaengig von activateCustomFields', () => {
  const saved = config.limitFunctions.activateCustomFields;
  try {
    config.limitFunctions.activateCustomFields = 'yes';
    assert.strictEqual(ollamaService.playgroundSchema.properties.custom_fields, undefined);
  } finally {
    config.limitFunctions.activateCustomFields = saved;
  }
});
