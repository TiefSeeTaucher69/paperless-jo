const { test } = require('node:test');
const assert = require('node:assert');

test('embedding-Block hat sichere Defaults', () => {
  const savedEnv = {
    enabled: process.env.EMBEDDING_SIMILARITY_ENABLED,
    model: process.env.EMBEDDING_MODEL,
    autoThreshold: process.env.EMBED_AUTO_THRESHOLD,
    judgeMin: process.env.EMBED_JUDGE_MIN
  };

  try {
    process.env.EMBEDDING_SIMILARITY_ENABLED = '';
    process.env.EMBEDDING_MODEL = '';
    process.env.EMBED_AUTO_THRESHOLD = '';
    process.env.EMBED_JUDGE_MIN = '';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.embedding.enabled, false);
    assert.strictEqual(config.embedding.model, 'bge-m3');
    assert.strictEqual(config.embedding.autoThreshold, 0.90);
    assert.strictEqual(config.embedding.judgeMin, 0.65);
    assert.ok(config.embedding.apiUrl);
    assert.deepStrictEqual(config.embedding.excludedTypes, []);
  } finally {
    for (const [key, value] of Object.entries({
      EMBEDDING_SIMILARITY_ENABLED: savedEnv.enabled,
      EMBEDDING_MODEL: savedEnv.model,
      EMBED_AUTO_THRESHOLD: savedEnv.autoThreshold,
      EMBED_JUDGE_MIN: savedEnv.judgeMin
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../config/config')];
  }
});

test('EMBEDDING_EXCLUDED_TYPES parst eine kommagetrennte Liste, trimmt Whitespace', () => {
  const saved = process.env.EMBEDDING_EXCLUDED_TYPES;
  try {
    process.env.EMBEDDING_EXCLUDED_TYPES = ' tag , document_type ';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.deepStrictEqual(config.embedding.excludedTypes, ['tag', 'document_type']);
  } finally {
    if (saved === undefined) delete process.env.EMBEDDING_EXCLUDED_TYPES;
    else process.env.EMBEDDING_EXCLUDED_TYPES = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('EMBEDDING_SIMILARITY_ENABLED=yes aktiviert den Kanal', () => {
  const saved = process.env.EMBEDDING_SIMILARITY_ENABLED;
  try {
    process.env.EMBEDDING_SIMILARITY_ENABLED = 'yes';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.embedding.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.EMBEDDING_SIMILARITY_ENABLED;
    else process.env.EMBEDDING_SIMILARITY_ENABLED = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('EMBED_AUTO_THRESHOLD ausserhalb [0,1] wird geklemmt und warnt', () => {
  const saved = process.env.EMBED_AUTO_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.EMBED_AUTO_THRESHOLD = '1.4';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.embedding.autoThreshold, 1);
    assert.ok(warnMessages.some(msg => msg.includes('EMBED_AUTO_THRESHOLD')));
  } finally {
    console.warn = savedWarn;
    if (saved === undefined) delete process.env.EMBED_AUTO_THRESHOLD;
    else process.env.EMBED_AUTO_THRESHOLD = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('EMBED_JUDGE_MIN > EMBED_AUTO_THRESHOLD warnt, wird nicht automatisch korrigiert', () => {
  const savedJudgeMin = process.env.EMBED_JUDGE_MIN;
  const savedAutoThreshold = process.env.EMBED_AUTO_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.EMBED_JUDGE_MIN = '0.95';
    process.env.EMBED_AUTO_THRESHOLD = '0.90';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.embedding.judgeMin, 0.95);
    assert.strictEqual(config.embedding.autoThreshold, 0.90);
    assert.ok(warnMessages.some(msg => msg.includes('unerreichbar')));
  } finally {
    console.warn = savedWarn;
    if (savedJudgeMin === undefined) delete process.env.EMBED_JUDGE_MIN;
    else process.env.EMBED_JUDGE_MIN = savedJudgeMin;
    if (savedAutoThreshold === undefined) delete process.env.EMBED_AUTO_THRESHOLD;
    else process.env.EMBED_AUTO_THRESHOLD = savedAutoThreshold;
    delete require.cache[require.resolve('../config/config')];
  }
});
