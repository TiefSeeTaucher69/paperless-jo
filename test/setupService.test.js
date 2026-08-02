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
