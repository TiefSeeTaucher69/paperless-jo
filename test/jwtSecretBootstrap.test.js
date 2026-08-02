const { test } = require('node:test');
const assert = require('node:assert');
const { isJwtSecretPlaceholder } = require('../services/jwtSecretGuard');

test('isJwtSecretPlaceholder treats missing and the literal default as unsafe', () => {
  assert.strictEqual(isJwtSecretPlaceholder(undefined), true);
  assert.strictEqual(isJwtSecretPlaceholder(''), true);
  assert.strictEqual(isJwtSecretPlaceholder('your-secret-key'), true);
  assert.strictEqual(isJwtSecretPlaceholder('a-real-64-byte-hex-secret'), false);
});
