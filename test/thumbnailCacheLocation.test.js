const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'thumbnail-cache-location-test-secret';

const config = require('../config/config');
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');

let server;
let baseUrl;
let savedThumbnailCacheDir;
let savedIsConfigured;
let savedGetThumbnailImage;
let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-cache-test-'));
  savedThumbnailCacheDir = config.thumbnailCacheDir;
  config.thumbnailCacheDir = tmpDir;

  savedIsConfigured = setupService.isConfigured;
  setupService.isConfigured = async () => true;

  savedGetThumbnailImage = paperlessService.getThumbnailImage;
  paperlessService.getThumbnailImage = async () => Buffer.from('fake-png-bytes');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  const setupRoutes = require('../routes/setup.js');
  app.use('/', setupRoutes);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  config.thumbnailCacheDir = savedThumbnailCacheDir;
  setupService.isConfigured = savedIsConfigured;
  paperlessService.getThumbnailImage = savedGetThumbnailImage;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const req = http.request(
      { method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /thumb/:documentId caches under config.thumbnailCacheDir, not public/, and serves the image', async () => {
  const token = jwt.sign({ id: 1, username: 'testuser' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const res = await get('/thumb/999', { Cookie: `jwt=${token}` });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.toString(), 'fake-png-bytes');

  const cachedPath = path.join(tmpDir, '999.png');
  const cached = await fs.readFile(cachedPath);
  assert.strictEqual(cached.toString(), 'fake-png-bytes');

  const publicPath = path.join(__dirname, '..', 'public', 'images', '999.png');
  await assert.rejects(() => fs.access(publicPath), /ENOENT/, 'thumbnail must not be cached under public/images/');
});

test('GET /thumb/:documentId rejects a non-numeric id (path-traversal hardening)', async () => {
  const token = jwt.sign({ id: 1, username: 'testuser' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  let getThumbnailImageCalled = false;
  const originalGetThumbnailImage = paperlessService.getThumbnailImage;
  paperlessService.getThumbnailImage = async () => {
    getThumbnailImageCalled = true;
    return Buffer.from('fake-png-bytes');
  };

  try {
    // Encoded slashes ('%2f') survive Express's route-segment split and are
    // decoded into the :documentId param value, so this exercises a real
    // traversal-shaped id ("../../etc/passwd") rather than just "non-digit".
    const res = await get('/thumb/..%2f..%2fetc%2fpasswd', { Cookie: `jwt=${token}` });

    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.strictEqual(getThumbnailImageCalled, false, 'must reject before calling out to Paperless or touching the filesystem');
  } finally {
    paperlessService.getThumbnailImage = originalGetThumbnailImage;
  }
});
