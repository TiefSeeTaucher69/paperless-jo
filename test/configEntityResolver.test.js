const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');

test('entityResolver-Block hat sichere Defaults', () => {
  assert.strictEqual(typeof config.entityResolver.enabled, 'boolean');
  assert.strictEqual(config.entityResolver.enabled, false);
  assert.strictEqual(config.entityResolver.autoThreshold, 0.90);
  assert.strictEqual(config.entityResolver.judgeMin, 0.65);
  assert.ok(config.entityResolver.dbPath.endsWith('entities.db'));
});
