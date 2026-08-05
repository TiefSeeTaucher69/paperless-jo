const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');

// Vor Task 2 (NACHAUDIT-02-Nebenbefund) sicherte/restaurierte dieser Test
// die *echte* logs/prompt.txt bzw. logs/response.txt. Ein abgebrochener
// Testlauf konnte die Datei in einem Zwischenstand hinterlassen. Jetzt zeigt
// config.promptLogging.logDir waehrend des Tests auf ein Temp-Verzeichnis -
// dasselbe Muster wie config.thumbnailCacheDir weiter unten in dieser Datei.
async function withTempLogDir(fn) {
  const savedLogDir = config.promptLogging.logDir;
  const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-log-test-'));

  try {
    config.promptLogging.logDir = tmpLogDir;
    await fn({
      responseLogPath: path.join(tmpLogDir, 'response.txt'),
      promptLogPath: path.join(tmpLogDir, 'prompt.txt')
    });
  } finally {
    config.promptLogging.logDir = savedLogDir;
    await fs.rm(tmpLogDir, { recursive: true, force: true });
  }
}

const RESPONSE_CONTENT = {
  title: 'Rechnung 2024',
  correspondent: 'Muster GmbH',
  tags: ['Rechnung'],
  document_type: 'Rechnung',
  document_date: '2024-01-01',
  language: 'de'
};

const PROVIDERS = [
  { name: 'openai', modulePath: '../services/openaiService' },
  { name: 'azure', modulePath: '../services/azureService' },
  { name: 'custom', modulePath: '../services/customService' }
];

function makeClientStub() {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(RESPONSE_CONTENT) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      }
    }
  };
}

// The production `fs.appendFile('./logs/response.txt', ...)` call is never
// awaited (it passes a callback to the promises-API appendFile, which is
// silently ignored - see fix-1-brief.md). That means the write is
// fire-and-forget: analyzeDocument() can resolve before the write actually
// lands on disk. To keep these tests deterministic (not racing that I/O)
// rather than accidentally-green/red, we poll for the expected end state
// instead of asserting immediately after the await.
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function withStubbedEnv(service, run) {
  const savedThumbnailCacheDir = config.thumbnailCacheDir;
  const savedClient = service.client;
  const savedGetThumbnailImage = paperlessService.getThumbnailImage;
  const tmpCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-log-test-'));

  try {
    config.thumbnailCacheDir = tmpCacheDir;
    // Use a real Buffer (not null) so the thumbnail-caching branch in
    // analyzeDocument (fs.writeFile(cachePath, thumbnailData)) doesn't throw
    // before execution ever reaches the response.txt write we're testing.
    paperlessService.getThumbnailImage = async () => Buffer.from('FAKE-PNG-DATA');
    service.client = makeClientStub();

    await run();
  } finally {
    config.thumbnailCacheDir = savedThumbnailCacheDir;
    service.client = savedClient;
    paperlessService.getThumbnailImage = savedGetThumbnailImage;
    await fs.rm(tmpCacheDir, { recursive: true, force: true });
  }
}

for (const { name, modulePath } of PROVIDERS) {
  test(`${name}Service: response.txt is not written when promptLogging.enabled is false`, async () => {
    const service = require(modulePath);
    const savedEnabled = config.promptLogging.enabled;

    await withTempLogDir(async ({ responseLogPath, promptLogPath }) => {
      await withStubbedEnv(service, async () => {
        try {
          config.promptLogging.enabled = false;

          await service.analyzeDocument('DOKUMENT INHALT', [], [], [], 'test-doc-id');

          // Give any (incorrectly) fire-and-forget write a generous window to
          // land before asserting absence, so this assertion is a real check
          // of the gate rather than a race won by sheer luck.
          const appeared = await waitUntil(() => fileExists(responseLogPath), { timeoutMs: 500 });
          assert.strictEqual(appeared, false, `expected ${responseLogPath} not to exist when promptLogging.enabled is false`);

          const promptAppeared = await fileExists(promptLogPath);
          assert.strictEqual(promptAppeared, false, `expected ${promptLogPath} not to exist when promptLogging.enabled is false`);
        } finally {
          config.promptLogging.enabled = savedEnabled;
        }
      });
    });
  });

  test(`${name}Service: response.txt is written when promptLogging.enabled is true`, async () => {
    const service = require(modulePath);
    const savedEnabled = config.promptLogging.enabled;

    await withTempLogDir(async ({ responseLogPath }) => {
      await withStubbedEnv(service, async () => {
        try {
          config.promptLogging.enabled = true;

          const result = await service.analyzeDocument('DOKUMENT INHALT', [], [], [], 'test-doc-id');
          assert.strictEqual(result.error, undefined, `analyzeDocument reported an unexpected error: ${result.error}`);

          const appeared = await waitUntil(() => fileExists(responseLogPath), { timeoutMs: 2000 });
          assert.strictEqual(appeared, true, `expected ${responseLogPath} to be written when promptLogging.enabled is true`);

          const written = await fs.readFile(responseLogPath, 'utf8');
          assert.ok(written.includes(RESPONSE_CONTENT.correspondent), 'expected the logged response to include the parsed correspondent');
        } finally {
          config.promptLogging.enabled = savedEnabled;
        }
      });
    });
  });
}
