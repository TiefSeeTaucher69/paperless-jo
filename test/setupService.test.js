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

test('loadConfig splits only on the first = (values containing = are not truncated)', async () => {
  const envPath = await tmpEnvPath();
  await fs.writeFile(envPath, 'AZURE_API_KEY=abc123==\nOTHER=plain\n');
  const service = new SetupService(envPath);
  const config = await service.loadConfig();
  assert.strictEqual(config.AZURE_API_KEY, 'abc123==');
  assert.strictEqual(config.OTHER, 'plain');
});

test('SYSTEM_PROMPT survives multiple saveConfig/loadConfig round-trips without accumulating backticks', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  service.validateConfig = async () => true;

  await service.saveConfig({
    PAPERLESS_API_URL: 'http://example.test/api',
    SYSTEM_PROMPT: 'You are a helpful assistant.\\nBe concise.'
  });

  let config = await service.loadConfig();
  assert.strictEqual(config.SYSTEM_PROMPT, 'You are a helpful assistant.\\nBe concise.');

  // Second round-trip: save again using the value just read back, exactly
  // like a real settings save would (form pre-filled from current config).
  await service.saveConfig({ SYSTEM_PROMPT: config.SYSTEM_PROMPT });
  config = await service.loadConfig();
  assert.strictEqual(config.SYSTEM_PROMPT, 'You are a helpful assistant.\\nBe concise.');

  // Third round-trip, to be sure it's actually stable and not just "off by one".
  await service.saveConfig({ SYSTEM_PROMPT: config.SYSTEM_PROMPT });
  config = await service.loadConfig();
  assert.strictEqual(config.SYSTEM_PROMPT, 'You are a helpful assistant.\\nBe concise.');
});

test('saveConfig(updates, { validate: false }) skips validation and still writes the file', async () => {
  const envPath = await tmpEnvPath();
  // A fake PAPERLESS_API_URL that would fail real validateConfig() (no live
  // Paperless to validate against) -- if validate:false didn't actually skip
  // validation, this save would throw.
  await fs.writeFile(envPath, 'PAPERLESS_API_URL=http://not-a-real-host.invalid/api\nPAPERLESS_API_TOKEN=tok\n');
  const service = new SetupService(envPath);

  await service.saveConfig({ SOME_KEY: 'x' }, { validate: false });

  const after = await service.loadConfig();
  assert.strictEqual(after.SOME_KEY, 'x');
  assert.strictEqual(after.PAPERLESS_API_URL, 'http://not-a-real-host.invalid/api');
});

test('saveConfig without an options argument still validates by default', async () => {
  const envPath = await tmpEnvPath();
  await fs.writeFile(envPath, 'PAPERLESS_API_URL=http://example.test/api\n');
  const service = new SetupService(envPath);
  service.validateConfig = async () => {
    throw new Error('validateConfig was called, as expected by default');
  };

  await assert.rejects(
    () => service.saveConfig({ SOME_KEY: 'x' }),
    /validateConfig was called, as expected by default/
  );
});
