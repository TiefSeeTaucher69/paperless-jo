const { test } = require('node:test');
const assert = require('node:assert');

test('ALLOWED_ORIGINS unset defaults to an empty allowlist (same-origin only)', () => {
  const saved = process.env.ALLOWED_ORIGINS;
  try {
    delete process.env.ALLOWED_ORIGINS;
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.deepStrictEqual(config.security.allowedOrigins, []);
  } finally {
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('ALLOWED_ORIGINS parses a comma-separated list and trims whitespace', () => {
  const saved = process.env.ALLOWED_ORIGINS;
  try {
    process.env.ALLOWED_ORIGINS = ' https://a.example , https://b.example ';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.deepStrictEqual(config.security.allowedOrigins, ['https://a.example', 'https://b.example']);
  } finally {
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});
