const { test } = require('node:test');
const assert = require('node:assert');

test('entityResolver-Block hat sichere Defaults', () => {
  // Hermetic test: verify defaults when ENTITY_RESOLVER_* env vars are unset,
  // regardless of what may be in data/.env at test-run time.

  // Step 1: Save current env var values
  const savedEnv = {
    enabled: process.env.ENTITY_RESOLVER_ENABLED,
    autoThreshold: process.env.ENTITY_RESOLVER_AUTO_THRESHOLD,
    judgeMin: process.env.ENTITY_RESOLVER_JUDGE_MIN,
    dbPath: process.env.ENTITY_RESOLVER_DB_PATH
  };

  try {
    // Step 2: Set env vars to empty strings. This prevents dotenv.config() from
    // overriding them (dotenv doesn't override already-set values), and
    // parseEnvNumber/parseEnvBoolean treat empty strings as "use default".
    process.env.ENTITY_RESOLVER_ENABLED = '';
    process.env.ENTITY_RESOLVER_AUTO_THRESHOLD = '';
    process.env.ENTITY_RESOLVER_JUDGE_MIN = '';
    process.env.ENTITY_RESOLVER_DB_PATH = '';

    // Step 3: Clear the require cache for config/config.js so it re-evaluates
    // against the modified process.env (with empty-string values)
    delete require.cache[require.resolve('../config/config')];

    // Step 4: Re-require config fresh. dotenv.config() will run but won't override
    // our empty-string values. parseEnvNumber will see empty strings and use defaults.
    const config = require('../config/config');

    assert.strictEqual(typeof config.entityResolver.enabled, 'boolean');
    assert.strictEqual(config.entityResolver.enabled, false);
    assert.strictEqual(config.entityResolver.autoThreshold, 0.90);
    assert.strictEqual(config.entityResolver.judgeMin, 0.65);
    assert.ok(config.entityResolver.dbPath.endsWith('entities.db'));
  } finally {
    // Step 5: Restore original env var values
    if (savedEnv.enabled === undefined) {
      delete process.env.ENTITY_RESOLVER_ENABLED;
    } else {
      process.env.ENTITY_RESOLVER_ENABLED = savedEnv.enabled;
    }

    if (savedEnv.autoThreshold === undefined) {
      delete process.env.ENTITY_RESOLVER_AUTO_THRESHOLD;
    } else {
      process.env.ENTITY_RESOLVER_AUTO_THRESHOLD = savedEnv.autoThreshold;
    }

    if (savedEnv.judgeMin === undefined) {
      delete process.env.ENTITY_RESOLVER_JUDGE_MIN;
    } else {
      process.env.ENTITY_RESOLVER_JUDGE_MIN = savedEnv.judgeMin;
    }

    if (savedEnv.dbPath === undefined) {
      delete process.env.ENTITY_RESOLVER_DB_PATH;
    } else {
      process.env.ENTITY_RESOLVER_DB_PATH = savedEnv.dbPath;
    }

    // Also restore the require cache for config/config.js so other tests
    // that run afterward get a fresh module in its normal state
    delete require.cache[require.resolve('../config/config')];
  }
});
