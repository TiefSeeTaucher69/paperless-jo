const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { SetupService } = require('../services/setupService.js');

async function tmpEnvPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setupservice-test-'));
  return path.join(dir, '.env');
}

test('loadConfig returns null when the file does not exist yet', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  const config = await service.loadConfig();
  assert.strictEqual(config, null);
});

test('loadConfig parses KEY=value lines from a real temp file', async () => {
  const envPath = await tmpEnvPath();
  await fs.writeFile(envPath, 'FOO=bar\nBAZ=qux\n');
  const service = new SetupService(envPath);
  const config = await service.loadConfig();
  assert.strictEqual(config.FOO, 'bar');
  assert.strictEqual(config.BAZ, 'qux');
});

test('saveConfig preserves existing keys the caller does not mention (AUDIT-002)', async () => {
  const envPath = await tmpEnvPath();
  await fs.writeFile(
    envPath,
    'PAPERLESS_API_URL=http://example.test/api\nPAPERLESS_API_TOKEN=tok\nJWT_SECRET=super-secret-value\nENTITY_RESOLVER_ENABLED=yes\n'
  );
  const service = new SetupService(envPath);
  // Stub out validateConfig so this test doesn't need a live Paperless/AI provider.
  service.validateConfig = async () => true;

  await service.saveConfig({ SCAN_INTERVAL: '*/15 * * * *' });

  const after = await service.loadConfig();
  assert.strictEqual(after.SCAN_INTERVAL, '*/15 * * * *', 'the intended change was applied');
  assert.strictEqual(after.JWT_SECRET, 'super-secret-value', 'JWT_SECRET must survive an unrelated save');
  assert.strictEqual(after.ENTITY_RESOLVER_ENABLED, 'yes', 'unknown/newer keys must survive an unrelated save');
  assert.strictEqual(after.PAPERLESS_API_URL, 'http://example.test/api', 'untouched keys are unchanged');
});

test('saveConfig still overwrites a key the caller explicitly sets', async () => {
  const envPath = await tmpEnvPath();
  await fs.writeFile(envPath, 'PAPERLESS_API_URL=http://old.test/api\nSCAN_INTERVAL=*/30 * * * *\n');
  const service = new SetupService(envPath);
  service.validateConfig = async () => true;

  await service.saveConfig({ SCAN_INTERVAL: '*/5 * * * *' });

  const after = await service.loadConfig();
  assert.strictEqual(after.SCAN_INTERVAL, '*/5 * * * *');
  assert.strictEqual(after.PAPERLESS_API_URL, 'http://old.test/api');
});
