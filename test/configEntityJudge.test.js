const { test } = require('node:test');
const assert = require('node:assert');

test('config.entityJudge.timeoutMs hat den Default 60000', () => {
  const saved = process.env.ENTITY_JUDGE_TIMEOUT_MS;
  try {
    process.env.ENTITY_JUDGE_TIMEOUT_MS = '';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.entityJudge.timeoutMs, 60000);
  } finally {
    if (saved === undefined) delete process.env.ENTITY_JUDGE_TIMEOUT_MS;
    else process.env.ENTITY_JUDGE_TIMEOUT_MS = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('ENTITY_JUDGE_TIMEOUT_MS wird aus process.env gelesen', () => {
  const saved = process.env.ENTITY_JUDGE_TIMEOUT_MS;
  try {
    process.env.ENTITY_JUDGE_TIMEOUT_MS = '30000';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.entityJudge.timeoutMs, 30000);
  } finally {
    if (saved === undefined) delete process.env.ENTITY_JUDGE_TIMEOUT_MS;
    else process.env.ENTITY_JUDGE_TIMEOUT_MS = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});
