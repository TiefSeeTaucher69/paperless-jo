const { test } = require('node:test');
const assert = require('node:assert');

test('documentFingerprint-Block hat sichere Defaults', () => {
  const saved = {
    enabled: process.env.DOCUMENT_FINGERPRINT_ENABLED,
    threshold: process.env.FINGERPRINT_SIMILARITY_THRESHOLD
  };
  try {
    process.env.DOCUMENT_FINGERPRINT_ENABLED = '';
    process.env.FINGERPRINT_SIMILARITY_THRESHOLD = '';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.documentFingerprint.enabled, false);
    assert.strictEqual(config.documentFingerprint.similarityThreshold, 0.90);
  } finally {
    for (const [key, value] of Object.entries({
      DOCUMENT_FINGERPRINT_ENABLED: saved.enabled,
      FINGERPRINT_SIMILARITY_THRESHOLD: saved.threshold
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../config/config')];
  }
});

test('DOCUMENT_FINGERPRINT_ENABLED=yes aktiviert das Feature', () => {
  const saved = process.env.DOCUMENT_FINGERPRINT_ENABLED;
  try {
    process.env.DOCUMENT_FINGERPRINT_ENABLED = 'yes';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.documentFingerprint.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.DOCUMENT_FINGERPRINT_ENABLED;
    else process.env.DOCUMENT_FINGERPRINT_ENABLED = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('FINGERPRINT_SIMILARITY_THRESHOLD ausserhalb [0,1] wird geklemmt und warnt', () => {
  const saved = process.env.FINGERPRINT_SIMILARITY_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.FINGERPRINT_SIMILARITY_THRESHOLD = '1.4';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.documentFingerprint.similarityThreshold, 1);
    assert.ok(warnMessages.some(msg => msg.includes('FINGERPRINT_SIMILARITY_THRESHOLD')));
  } finally {
    console.warn = savedWarn;
    if (saved === undefined) delete process.env.FINGERPRINT_SIMILARITY_THRESHOLD;
    else process.env.FINGERPRINT_SIMILARITY_THRESHOLD = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});
