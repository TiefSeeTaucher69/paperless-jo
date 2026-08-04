const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');

const RESPONSE_LOG_PATH = path.join(process.cwd(), 'logs', 'response.txt');
const PROMPT_LOG_PATH = path.join(process.cwd(), 'logs', 'prompt.txt');
const LOG_PATHS = [RESPONSE_LOG_PATH, PROMPT_LOG_PATH];

// Saves and restores both logs/response.txt and logs/prompt.txt around a
// test body. analyzeDocument() writes to *both* files (via appendResponseLog
// and writePromptToFile with no filePath override, i.e. the real default
// path) when promptLogging.enabled is true, so both must be protected or a
// real developer's logs/prompt.txt gets corrupted by the "enabled" tests.
//
// Also deletes each file *before* running the test body (after saving its
// original content), not just after: otherwise a leftover file from a prior
// PROMPT_LOGGING_ENABLED=yes run would make fileExists() already true before
// analyzeDocument() ever runs, causing false failures in the "disabled"
// tests regardless of whether the gate works.
async function withSavedLogFiles(fn) {
  const originalContents = new Map();

  for (const logPath of LOG_PATHS) {
    try {
      originalContents.set(logPath, await fs.readFile(logPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      originalContents.set(logPath, null);
    }
    await fs.rm(logPath, { force: true });
  }

  try {
    await fn();
  } finally {
    for (const logPath of LOG_PATHS) {
      const originalContent = originalContents.get(logPath);
      if (originalContent === null) {
        await fs.rm(logPath, { force: true });
      } else {
        await fs.writeFile(logPath, originalContent);
      }
    }
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
  test(`${name}Service: logs/response.txt is not written when promptLogging.enabled is false`, async () => {
    const service = require(modulePath);
    const savedEnabled = config.promptLogging.enabled;

    await withSavedLogFiles(async () => {
      await withStubbedEnv(service, async () => {
        try {
          config.promptLogging.enabled = false;

          await service.analyzeDocument('DOKUMENT INHALT', [], [], [], 'test-doc-id');

          // Give any (incorrectly) fire-and-forget write a generous window to
          // land before asserting absence, so this assertion is a real check
          // of the gate rather than a race won by sheer luck.
          const appeared = await waitUntil(() => fileExists(RESPONSE_LOG_PATH), { timeoutMs: 500 });
          assert.strictEqual(appeared, false, `expected ${RESPONSE_LOG_PATH} not to exist when promptLogging.enabled is false`);

          const promptAppeared = await fileExists(PROMPT_LOG_PATH);
          assert.strictEqual(promptAppeared, false, `expected ${PROMPT_LOG_PATH} not to exist when promptLogging.enabled is false`);
        } finally {
          config.promptLogging.enabled = savedEnabled;
        }
      });
    });
  });

  test(`${name}Service: logs/response.txt is written when promptLogging.enabled is true`, async () => {
    const service = require(modulePath);
    const savedEnabled = config.promptLogging.enabled;

    await withSavedLogFiles(async () => {
      await withStubbedEnv(service, async () => {
        try {
          config.promptLogging.enabled = true;

          const result = await service.analyzeDocument('DOKUMENT INHALT', [], [], [], 'test-doc-id');
          assert.strictEqual(result.error, undefined, `analyzeDocument reported an unexpected error: ${result.error}`);

          const appeared = await waitUntil(() => fileExists(RESPONSE_LOG_PATH), { timeoutMs: 2000 });
          assert.strictEqual(appeared, true, `expected ${RESPONSE_LOG_PATH} to be written when promptLogging.enabled is true`);

          const written = await fs.readFile(RESPONSE_LOG_PATH, 'utf8');
          assert.ok(written.includes(RESPONSE_CONTENT.correspondent), 'expected the logged response to include the parsed correspondent');
        } finally {
          config.promptLogging.enabled = savedEnabled;
        }
      });
    });
  });
}
