const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const config = require('../config/config');

test('thumbnailCacheDir points outside public/ (AUDIT-018)', () => {
  assert.ok(path.isAbsolute(config.thumbnailCacheDir), 'expected an absolute path');
  assert.strictEqual(
    config.thumbnailCacheDir,
    path.join(process.cwd(), 'data', 'cache', 'thumbnails')
  );

  const relative = path.relative(path.join(process.cwd(), 'public'), config.thumbnailCacheDir);
  assert.ok(
    relative.startsWith('..'),
    `expected thumbnailCacheDir to live outside public/, got a relative path of "${relative}"`
  );
});
