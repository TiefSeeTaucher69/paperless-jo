const { test } = require('node:test');
const assert = require('node:assert');

test('promptLogging.enabled defaults to false when PROMPT_LOGGING_ENABLED is unset', () => {
  const saved = process.env.PROMPT_LOGGING_ENABLED;
  try {
    delete process.env.PROMPT_LOGGING_ENABLED;
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.promptLogging.enabled, false);
  } finally {
    if (saved === undefined) delete process.env.PROMPT_LOGGING_ENABLED;
    else process.env.PROMPT_LOGGING_ENABLED = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('PROMPT_LOGGING_ENABLED=yes turns the flag on', () => {
  const saved = process.env.PROMPT_LOGGING_ENABLED;
  try {
    process.env.PROMPT_LOGGING_ENABLED = 'yes';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.promptLogging.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.PROMPT_LOGGING_ENABLED;
    else process.env.PROMPT_LOGGING_ENABLED = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('PROMPT_LOGGING_ENABLED=no keeps the flag off', () => {
  const saved = process.env.PROMPT_LOGGING_ENABLED;
  try {
    process.env.PROMPT_LOGGING_ENABLED = 'no';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.promptLogging.enabled, false);
  } finally {
    if (saved === undefined) delete process.env.PROMPT_LOGGING_ENABLED;
    else process.env.PROMPT_LOGGING_ENABLED = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});
