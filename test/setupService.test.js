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

test('loadConfig handles CRLF line endings without swallowing keys after SYSTEM_PROMPT', async () => {
  const envPath = await tmpEnvPath();
  const content = [
    'PAPERLESS_API_URL=http://example.test/api',
    'SYSTEM_PROMPT=`You are a helpful assistant.',
    'Be concise.',
    'Always answer.',
    '`',
    'JWT_SECRET=super-secret-value',
    'ENTITY_RESOLVER_ENABLED=yes'
  ].join('\r\n');
  await fs.writeFile(envPath, content);

  const service = new SetupService(envPath);
  const config = await service.loadConfig();

  assert.strictEqual(config.SYSTEM_PROMPT, 'You are a helpful assistant.\nBe concise.\nAlways answer.');
  assert.strictEqual(config.JWT_SECRET, 'super-secret-value');
  assert.strictEqual(config.ENTITY_RESOLVER_ENABLED, 'yes');
});

test('loadConfig does not swallow subsequent keys when a SYSTEM_PROMPT is missing its closing backtick', async () => {
  const envPath = await tmpEnvPath();
  const content = [
    'PAPERLESS_API_URL=http://example.test/api',
    'SYSTEM_PROMPT=`some prompt with no closing backtick',
    'JWT_SECRET=super-secret-value',
    'ENTITY_RESOLVER_ENABLED=yes'
  ].join('\n');
  await fs.writeFile(envPath, content);

  const service = new SetupService(envPath);
  const config = await service.loadConfig();

  // The exact recovered SYSTEM_PROMPT value in this malformed-input case is
  // less important than the guarantee that later keys are NOT lost.
  assert.strictEqual(config.JWT_SECRET, 'super-secret-value');
  assert.strictEqual(config.ENTITY_RESOLVER_ENABLED, 'yes');
});

test('loadConfig reconstructs a real multi-physical-line SYSTEM_PROMPT (LF) across 3 save/load cycles', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  service.validateConfig = async () => true;

  const multilinePrompt = 'You are a helpful assistant.\nBe concise.\nAlways answer.';

  await service.saveConfig({
    PAPERLESS_API_URL: 'http://example.test/api',
    SYSTEM_PROMPT: multilinePrompt
  });

  let config = await service.loadConfig();
  assert.strictEqual(config.SYSTEM_PROMPT, multilinePrompt);

  await service.saveConfig({ SYSTEM_PROMPT: config.SYSTEM_PROMPT });
  config = await service.loadConfig();
  assert.strictEqual(config.SYSTEM_PROMPT, multilinePrompt);

  await service.saveConfig({ SYSTEM_PROMPT: config.SYSTEM_PROMPT });
  config = await service.loadConfig();
  assert.strictEqual(config.SYSTEM_PROMPT, multilinePrompt);
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

test('validateConfig rejects an out-of-range ENTITY_RESOLVER_AUTO_THRESHOLD', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  await assert.rejects(
    () => service.validateConfig({ ENTITY_RESOLVER_AUTO_THRESHOLD: '1.5' }),
    /ENTITY_RESOLVER_AUTO_THRESHOLD/
  );
});

test('validateConfig rejects a non-numeric threshold', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  await assert.rejects(
    () => service.validateConfig({ EMBED_JUDGE_MIN: 'not-a-number' }),
    /EMBED_JUDGE_MIN/
  );
});

test('validateConfig rejects ENTITY_RESOLVER_JUDGE_MIN greater than ENTITY_RESOLVER_AUTO_THRESHOLD', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  await assert.rejects(
    () => service.validateConfig({
      ENTITY_RESOLVER_AUTO_THRESHOLD: '0.5',
      ENTITY_RESOLVER_JUDGE_MIN: '0.7'
    }),
    /ENTITY_RESOLVER_JUDGE_MIN.*ENTITY_RESOLVER_AUTO_THRESHOLD/
  );
});

test('validateConfig rejects EMBED_JUDGE_MIN greater than EMBED_AUTO_THRESHOLD', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  await assert.rejects(
    () => service.validateConfig({
      EMBED_AUTO_THRESHOLD: '0.4',
      EMBED_JUDGE_MIN: '0.6'
    }),
    /EMBED_JUDGE_MIN.*EMBED_AUTO_THRESHOLD/
  );
});

test('validateConfig leaves unset/empty thresholds alone and does not throw on their account', async () => {
  const envPath = await tmpEnvPath();
  const service = new SetupService(envPath);
  // No PAPERLESS_API_URL either -- this call is expected to still reach the
  // Paperless-connectivity check and reject for THAT reason, not for thresholds.
  await assert.rejects(
    () => service.validateConfig({ ENTITY_RESOLVER_AUTO_THRESHOLD: '', EMBED_JUDGE_MIN: undefined }),
    (err) => !/THRESHOLD|JUDGE_MIN/.test(err.message)
  );
});
