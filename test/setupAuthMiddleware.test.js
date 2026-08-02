const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

let server;
let baseUrl;

before(() => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  const setupRoutes = require('../routes/setup.js');
  app.use('/', setupRoutes);

  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  return new Promise((resolve) => server.close(resolve));
});

function request(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const PROTECTED_ROUTES = [
  ['GET', '/settings'],
  ['POST', '/settings'],
  ['POST', '/manual/updateDocument'],
  ['POST', '/api/reset-all-documents'],
  ['POST', '/api/reset-documents'],
  ['POST', '/api/scan/now'],
  ['POST', '/api/webhook/document'],
  ['GET', '/dashboard'],
  ['GET', '/playground'],
  ['GET', '/history'],
  ['GET', '/manual'],
  ['GET', '/debug'],
];

for (const [method, routePath] of PROTECTED_ROUTES) {
  test(`${method} ${routePath} redirects to /login without a token (AUDIT-001 regression)`, async () => {
    const res = await request(method, routePath, { 'content-type': 'application/json' });
    assert.strictEqual(res.status, 302, `expected 302 redirect for ${method} ${routePath}, got ${res.status}`);
    assert.strictEqual(res.location, '/login');
  });
}

test('GET /health stays public (no auth required)', async () => {
  const res = await request('GET', '/health');
  assert.strictEqual(res.status, 200);
});

test('GET /login stays public (no auth redirect loop to itself)', async () => {
  // GET /login redirects to /setup when no users exist yet (first-run UX,
  // see routes/setup.js:244-253) and renders 200 once a user exists. Either
  // is fine here — what this test actually guards is that /login is never
  // redirected back to /login itself (which would indicate PUBLIC_ROUTES
  // stopped exempting it from the auth check).
  const res = await request('GET', '/login');
  assert.notStrictEqual(res.location, '/login');
  assert.ok([200, 302].includes(res.status), `expected 200 or 302, got ${res.status}`);
});
