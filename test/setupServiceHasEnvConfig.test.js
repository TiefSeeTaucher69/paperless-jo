const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { SetupService } = require('../services/setupService.js');

// Final whole-branch review finding 1: hasEnvConfig() is the cheap, local,
// non-memoized replacement for isConfigured() used by POST /setup's security
// gate (see routes/setup.js and services/setupService.js#hasEnvConfig).
// These tests exercise it directly, against a throwaway .env in a temp
// directory (same tmpdir pattern as test/thumbnailCacheLocation.test.js),
// independent of any real data/.env in this checkout.

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-service-has-env-config-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('hasEnvConfig() returns false when no .env file exists', async () => {
  const envPath = path.join(tmpDir, 'missing.env');
  const service = new SetupService(envPath);

  assert.strictEqual(await service.hasEnvConfig(), false);
});

test('hasEnvConfig() returns false when .env exists but lacks PAPERLESS_API_URL', async () => {
  const envPath = path.join(tmpDir, 'no-url.env');
  await fs.writeFile(envPath, 'SOME_OTHER_KEY=value\n');
  const service = new SetupService(envPath);

  assert.strictEqual(await service.hasEnvConfig(), false);
});

test('hasEnvConfig() returns true when .env exists with PAPERLESS_API_URL set', async () => {
  const envPath = path.join(tmpDir, 'configured.env');
  await fs.writeFile(envPath, 'PAPERLESS_API_URL=http://paperless.example/api\n');
  const service = new SetupService(envPath);

  assert.strictEqual(await service.hasEnvConfig(), true);
});
