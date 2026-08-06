const { test } = require('node:test');
const assert = require('node:assert');

test('_hasPreExistingPromptMismatch: true wenn SYSTEM_PROMPT "Pre-existing" enthaelt und useExistingData != yes', () => {
  const config = require('../config/config');
  assert.strictEqual(config._hasPreExistingPromptMismatch('Check Pre-existing tags first.', 'no'), true);
  assert.strictEqual(config._hasPreExistingPromptMismatch('Check Pre-existing tags first.', undefined), true);
});

test('_hasPreExistingPromptMismatch: false wenn useExistingData=yes', () => {
  const config = require('../config/config');
  assert.strictEqual(config._hasPreExistingPromptMismatch('Check Pre-existing tags first.', 'yes'), false);
});

test('_hasPreExistingPromptMismatch: false wenn SYSTEM_PROMPT die Zeichenkette nicht enthaelt', () => {
  const config = require('../config/config');
  assert.strictEqual(config._hasPreExistingPromptMismatch('Ein normaler Prompt ohne Bezug.', 'no'), false);
  assert.strictEqual(config._hasPreExistingPromptMismatch(undefined, 'no'), false);
});

test('_hasPreExistingPromptMismatch: true bei natuersprachlicher, kleingeschriebener Formulierung (wie in .env.example)', () => {
  // Diese Phrase steht woertlich im Default-SYSTEM_PROMPT von .env.example - die alte,
  // rein auf "Pre-existing" (case-sensitive) geankerte Pruefung hat sie nie erkannt.
  const config = require('../config/config');
  assert.strictEqual(
    config._hasPreExistingPromptMismatch('FIRST check the existing tags before suggesting new ones', 'no'),
    true
  );
});

test('Startup warnt tatsaechlich, wenn SYSTEM_PROMPT+USE_EXISTING_DATA widersprechen', () => {
  const savedPrompt = process.env.SYSTEM_PROMPT;
  const savedUseExisting = process.env.USE_EXISTING_DATA;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.SYSTEM_PROMPT = 'Check Pre-existing tags / correspondents / document types first.';
    process.env.USE_EXISTING_DATA = 'no';
    delete require.cache[require.resolve('../config/config')];
    require('../config/config');

    assert.ok(warnMessages.some(m => m.includes('Pre-existing')), 'sollte beim Laden warnen');
  } finally {
    console.warn = savedWarn;
    if (savedPrompt === undefined) delete process.env.SYSTEM_PROMPT;
    else process.env.SYSTEM_PROMPT = savedPrompt;
    if (savedUseExisting === undefined) delete process.env.USE_EXISTING_DATA;
    else process.env.USE_EXISTING_DATA = savedUseExisting;
    delete require.cache[require.resolve('../config/config')];
  }
});
