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

test('ENTITY_RESOLVER_AUTO_THRESHOLD ausserhalb [0,1] wird auf 1 geklemmt und warnt', () => {
  const savedValue = process.env.ENTITY_RESOLVER_AUTO_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.ENTITY_RESOLVER_AUTO_THRESHOLD = '1.5';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.entityResolver.autoThreshold, 1);
    assert.ok(
      warnMessages.some(msg => msg.includes('ENTITY_RESOLVER_AUTO_THRESHOLD')),
      'sollte eine Klemm-Warnung fuer ENTITY_RESOLVER_AUTO_THRESHOLD ausgeben'
    );
  } finally {
    console.warn = savedWarn;
    if (savedValue === undefined) {
      delete process.env.ENTITY_RESOLVER_AUTO_THRESHOLD;
    } else {
      process.env.ENTITY_RESOLVER_AUTO_THRESHOLD = savedValue;
    }
    delete require.cache[require.resolve('../config/config')];
  }
});

test('ENTITY_RESOLVER_JUDGE_MIN unterhalb 0 wird auf 0 geklemmt', () => {
  const savedValue = process.env.ENTITY_RESOLVER_JUDGE_MIN;
  const savedWarn = console.warn;
  console.warn = () => {};

  try {
    process.env.ENTITY_RESOLVER_JUDGE_MIN = '-0.3';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.entityResolver.judgeMin, 0);
  } finally {
    console.warn = savedWarn;
    if (savedValue === undefined) {
      delete process.env.ENTITY_RESOLVER_JUDGE_MIN;
    } else {
      process.env.ENTITY_RESOLVER_JUDGE_MIN = savedValue;
    }
    delete require.cache[require.resolve('../config/config')];
  }
});

test('ENTITY_RESOLVER_JUDGE_MIN > ENTITY_RESOLVER_AUTO_THRESHOLD warnt, aber wird nicht automatisch korrigiert', () => {
  const savedJudgeMin = process.env.ENTITY_RESOLVER_JUDGE_MIN;
  const savedAutoThreshold = process.env.ENTITY_RESOLVER_AUTO_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.ENTITY_RESOLVER_JUDGE_MIN = '0.95';
    process.env.ENTITY_RESOLVER_AUTO_THRESHOLD = '0.90';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.entityResolver.judgeMin, 0.95);
    assert.strictEqual(config.entityResolver.autoThreshold, 0.90);
    assert.ok(
      warnMessages.some(msg => msg.includes('unerreichbar')),
      'sollte vor unerreichbarer Stufe 4c warnen'
    );
  } finally {
    console.warn = savedWarn;
    if (savedJudgeMin === undefined) {
      delete process.env.ENTITY_RESOLVER_JUDGE_MIN;
    } else {
      process.env.ENTITY_RESOLVER_JUDGE_MIN = savedJudgeMin;
    }
    if (savedAutoThreshold === undefined) {
      delete process.env.ENTITY_RESOLVER_AUTO_THRESHOLD;
    } else {
      process.env.ENTITY_RESOLVER_AUTO_THRESHOLD = savedAutoThreshold;
    }
    delete require.cache[require.resolve('../config/config')];
  }
});
