const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const config = require('../config/config');
const { writePromptToFile } = require('../services/serviceUtils');

async function tmpLogPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-log-test-'));
  return path.join(dir, 'prompt.txt');
}

test('writePromptToFile is a no-op when promptLogging.enabled is false', async () => {
  const savedEnabled = config.promptLogging.enabled;
  const filePath = await tmpLogPath();
  try {
    config.promptLogging.enabled = false;

    await writePromptToFile('SYSTEM', 'CONTENT', filePath);

    await assert.rejects(
      () => fs.access(filePath),
      /ENOENT/,
      'expected no file to be created when the flag is off'
    );
  } finally {
    config.promptLogging.enabled = savedEnabled;
  }
});

test('writePromptToFile writes systemPrompt and content when promptLogging.enabled is true', async () => {
  const savedEnabled = config.promptLogging.enabled;
  const filePath = await tmpLogPath();
  try {
    config.promptLogging.enabled = true;

    await writePromptToFile('MY SYSTEM PROMPT', 'MY DOCUMENT CONTENT', filePath);

    const written = await fs.readFile(filePath, 'utf8');
    assert.ok(written.includes('MY SYSTEM PROMPT'));
    assert.ok(written.includes('MY DOCUMENT CONTENT'));
    assert.ok(written.includes('SYSTEM PROMPT:'));
    assert.ok(written.includes('USER CONTENT:'));
  } finally {
    config.promptLogging.enabled = savedEnabled;
  }
});

test('writePromptToFile still clears the file past maxSize when enabled', async () => {
  const savedEnabled = config.promptLogging.enabled;
  const filePath = await tmpLogPath();
  try {
    config.promptLogging.enabled = true;

    await writePromptToFile('FIRST', 'FIRST CONTENT', filePath, 10);
    const firstWrite = await fs.readFile(filePath, 'utf8');
    assert.ok(firstWrite.length > 10, 'sanity check: first write already exceeds the tiny maxSize');

    await writePromptToFile('SECOND', 'SECOND CONTENT', filePath, 10);
    const secondWrite = await fs.readFile(filePath, 'utf8');

    assert.ok(!secondWrite.includes('FIRST CONTENT'), 'old content should have been cleared once the size limit was exceeded');
    assert.ok(secondWrite.includes('SECOND CONTENT'));
  } finally {
    config.promptLogging.enabled = savedEnabled;
  }
});
