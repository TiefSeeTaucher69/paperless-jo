process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [{ value: 'Betrag' }] });
process.env.SYSTEM_PROMPT = 'Du bist ein Dokumentenanalyst.';
process.env.USE_PROMPT_TAGS = 'no';

const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaService = require('../services/ollamaService');

test('config.mustHavePrompt wird durch _buildPrompt nicht mutiert', () => {
  config.useExistingData = 'no';
  const before = config.mustHavePrompt;
  assert.ok(before.includes('%CUSTOMFIELDS%'), 'Vorbedingung: Platzhalter vorhanden');

  ollamaService._buildPrompt('Inhalt A', ['Rechnung'], ['Finanzamt'], ['Bescheid'], {});
  ollamaService._buildPrompt('Inhalt B', ['Rechnung'], ['Finanzamt'], ['Bescheid'], {});

  assert.strictEqual(config.mustHavePrompt, before);
  assert.ok(config.mustHavePrompt.includes('%CUSTOMFIELDS%'));
});
