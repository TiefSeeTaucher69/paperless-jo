const { test } = require('node:test');
const assert = require('node:assert');

const ollamaService = require('../services/ollamaService.js');
const paperlessService = require('../services/paperlessService.js');

test('_handleThumbnailCaching rejects a non-numeric id before touching the filesystem or Paperless', async () => {
  let getThumbnailImageCalled = false;
  const originalGetThumbnailImage = paperlessService.getThumbnailImage;
  paperlessService.getThumbnailImage = async () => {
    getThumbnailImageCalled = true;
    return Buffer.from('fake-png-bytes');
  };

  try {
    await ollamaService._handleThumbnailCaching('../../etc/passwd');
    assert.strictEqual(getThumbnailImageCalled, false, 'must reject before calling out to Paperless');
  } finally {
    paperlessService.getThumbnailImage = originalGetThumbnailImage;
  }
});

test('_handleThumbnailCaching still proceeds for a valid numeric id', async () => {
  let getThumbnailImageCalled = false;
  const originalGetThumbnailImage = paperlessService.getThumbnailImage;
  paperlessService.getThumbnailImage = async () => {
    getThumbnailImageCalled = true;
    return null; // short-circuits before any fs write; keeps this test filesystem-free
  };

  try {
    await ollamaService._handleThumbnailCaching('999999999'); // won't collide with a real cached file
    assert.strictEqual(getThumbnailImageCalled, true, 'a valid numeric id must still be processed');
  } finally {
    paperlessService.getThumbnailImage = originalGetThumbnailImage;
  }
});
