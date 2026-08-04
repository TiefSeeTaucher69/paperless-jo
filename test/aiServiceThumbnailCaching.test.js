const { test } = require('node:test');
const assert = require('node:assert');

const openaiService = require('../services/openaiService.js');
const azureService = require('../services/azureService.js');
const customService = require('../services/customService.js');
const paperlessService = require('../services/paperlessService.js');

// Final whole-branch review finding 2: Task 3's numeric-id hardening for
// thumbnail caching only covered services/ollamaService.js and
// routes/setup.js's GET /thumb/:documentId. The identical unguarded
// path.join(config.thumbnailCacheDir, `${id}.png`) + fs.access/fs.writeFile
// pattern also existed, uninherited, in each of these three provider
// services' analyzeDocument(). These tests prove the same guard
// (`id && /^\d+$/.test(String(id))`) now applies there too: a non-numeric
// id (e.g. a path-traversal payload) must never reach
// paperlessService.getThumbnailImage.

test('analyzeDocument (OpenAI) skips thumbnail caching for a non-numeric id', async () => {
  let getThumbnailImageCalled = false;
  const originalGetThumbnailImage = paperlessService.getThumbnailImage;
  paperlessService.getThumbnailImage = async () => {
    getThumbnailImageCalled = true;
    return Buffer.from('fake-png-bytes');
  };
  const originalClient = openaiService.client;
  openaiService.client = {}; // truthy stub, just enough to pass the init check

  try {
    await openaiService.analyzeDocument('content', [], [], [], '../../etc/passwd').catch(() => {});
    assert.strictEqual(getThumbnailImageCalled, false, 'must skip thumbnail caching for a non-numeric id');
  } finally {
    paperlessService.getThumbnailImage = originalGetThumbnailImage;
    openaiService.client = originalClient;
  }
});

test('analyzeDocument (Azure) skips thumbnail caching for a non-numeric id', async () => {
  let getThumbnailImageCalled = false;
  const originalGetThumbnailImage = paperlessService.getThumbnailImage;
  paperlessService.getThumbnailImage = async () => {
    getThumbnailImageCalled = true;
    return Buffer.from('fake-png-bytes');
  };
  const originalClient = azureService.client;
  azureService.client = {}; // truthy stub, just enough to pass the init check

  try {
    await azureService.analyzeDocument('content', [], [], [], '../../etc/passwd').catch(() => {});
    assert.strictEqual(getThumbnailImageCalled, false, 'must skip thumbnail caching for a non-numeric id');
  } finally {
    paperlessService.getThumbnailImage = originalGetThumbnailImage;
    azureService.client = originalClient;
  }
});

test('analyzeDocument (Custom OpenAI) skips thumbnail caching for a non-numeric id', async () => {
  let getThumbnailImageCalled = false;
  const originalGetThumbnailImage = paperlessService.getThumbnailImage;
  paperlessService.getThumbnailImage = async () => {
    getThumbnailImageCalled = true;
    return Buffer.from('fake-png-bytes');
  };
  const originalClient = customService.client;
  customService.client = {}; // truthy stub, just enough to pass the init check

  try {
    await customService.analyzeDocument('content', [], [], [], '../../etc/passwd').catch(() => {});
    assert.strictEqual(getThumbnailImageCalled, false, 'must skip thumbnail caching for a non-numeric id');
  } finally {
    paperlessService.getThumbnailImage = originalGetThumbnailImage;
    customService.client = originalClient;
  }
});
