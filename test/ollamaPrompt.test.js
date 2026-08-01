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

test('_buildPrompt liefert getrennte system- und user-Teile', () => {
  config.useExistingData = 'no';
  const { system, user } = ollamaService._buildPrompt(
    'Rechnungstext', ['Rechnung'], ['Finanzamt'], ['Bescheid'], {}
  );

  assert.strictEqual(typeof system, 'string');
  assert.strictEqual(typeof user, 'string');
  assert.strictEqual(user, JSON.stringify('Rechnungstext'));
});

test('der system-Teil enthaelt den SYSTEM_PROMPT und die Formatvorgabe', () => {
  config.useExistingData = 'no';
  const { system } = ollamaService._buildPrompt('Text', [], [], [], {});

  assert.ok(system.includes('Du bist ein Dokumentenanalyst.'));
  assert.ok(system.includes('"document_date"'));
});

test('der user-Teil enthaelt keine Anweisungen', () => {
  config.useExistingData = 'no';
  const { user } = ollamaService._buildPrompt('Text', ['Rechnung'], [], [], {});

  assert.ok(!user.includes('Du bist ein Dokumentenanalyst.'));
  assert.ok(!user.includes('"document_date"'));
  assert.ok(!user.includes('Rechnung'));
});

test('bei useExistingData=yes stehen die Bestandslisten im system-Teil', () => {
  config.useExistingData = 'yes';
  config.restrictToExistingTags = 'no';
  config.restrictToExistingCorrespondents = 'no';

  const { system, user } = ollamaService._buildPrompt(
    'Text', ['Rechnung', 'Steuer'], ['Finanzamt'], ['Bescheid'], {}
  );

  assert.ok(system.includes('Rechnung'));
  assert.ok(system.includes('Finanzamt'));
  assert.ok(system.includes('Bescheid'));
  assert.ok(!user.includes('Finanzamt'));

  config.useExistingData = 'no';
});

test('Bestandslisten funktionieren auch mit Objekt-Arrays', () => {
  config.useExistingData = 'yes';

  const { system } = ollamaService._buildPrompt(
    'Text', ['Rechnung'], [{ id: 1, name: 'Stadtwerke' }], [{ id: 2, name: 'Vertrag' }], {}
  );

  assert.ok(system.includes('Stadtwerke'));
  assert.ok(system.includes('Vertrag'));
  assert.ok(!system.includes('[object Object]'));

  config.useExistingData = 'no';
});

test('leerer SYSTEM_PROMPT faellt auf den Default-Analyzer zurueck', () => {
  config.useExistingData = 'no';
  const original = process.env.SYSTEM_PROMPT;
  process.env.SYSTEM_PROMPT = '   ';

  const { system } = ollamaService._buildPrompt('Text', [], [], [], {});
  assert.ok(system.includes('document analyzer'));
  assert.ok(!system.includes('undefined'));

  process.env.SYSTEM_PROMPT = original;
});

test('externe API-Daten landen als Text im system-Teil, nicht als Promise', () => {
  config.useExistingData = 'no';
  const { system } = ollamaService._buildPrompt(
    'Text', [], [], [], { externalApiData: { kunde: 'Muster' } }
  );

  assert.ok(!system.includes('[object Promise]'));
  assert.ok(system.includes('Muster'));
});
