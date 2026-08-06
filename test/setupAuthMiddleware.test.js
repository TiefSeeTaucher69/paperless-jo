const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const jwt = require('jsonwebtoken');

// Known secret so this test file can mint tokens that routes/setup.js's
// isAuthenticated (via ./auth.js#getJwtSecret, which reads process.env.JWT_SECRET
// at call time, not at require time) will accept.
process.env.JWT_SECRET = 'setup-auth-middleware-test-secret';

const setupService = require('../services/setupService.js');
const documentModel = require('../models/document.js');
const paperlessService = require('../services/paperlessService.js');

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

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const reqHeaders = { ...headers };
    if (payload !== undefined) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: reqHeaders },
      (res) => {
        res.resume();
        res.on('end', () => resolve({
          status: res.statusCode,
          location: res.headers.location,
          setCookie: res.headers['set-cookie'] || []
        }));
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
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
  ['POST', '/api/documents/42/restore-original'],
  ['GET', '/dashboard'],
  ['GET', '/playground'],
  ['GET', '/history'],
  ['GET', '/manual'],
  ['GET', '/debug'],
];

for (const [method, routePath] of PROTECTED_ROUTES) {
  test(`${method} ${routePath} redirects to /login without a token (AUDIT-001 regression)`, async () => {
    const res = await request(method, routePath, { headers: { 'content-type': 'application/json' } });
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

// Exercises the real isAuthenticated -> csrfProtection composition wired up in
// routes/setup.js's router.use(), as opposed to test/csrfMiddleware.test.js
// (which unit-tests csrfProtection alone against fake req/res objects) or the
// now-removed test this replaces (which only ever hit the public /health
// route and so never reached csrfProtection at all -- it proved nothing about
// CSRF). If csrfProtection were ever removed from that middleware chain, the
// 403 assertions below would fail (nextCalled would let the request through).
test('isAuthenticated -> csrfProtection composition: cookie is set, POST without header is rejected, POST with matching header is not', async () => {
  const originalIsConfigured = setupService.isConfigured;
  setupService.isConfigured = async () => true;

  try {
    const token = jwt.sign({ id: 1, username: 'testuser' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // GET with a valid JWT cookie and no existing CSRF cookie: isAuthenticated
    // passes, csrfProtection (a safe method) sets a new csrfToken cookie, and
    // the request reaches the real route handler. /debug is used because it
    // has no live-backend dependency (unlike /dashboard), so this test isn't
    // flaky against an unconfigured Paperless/AI provider.
    const getRes = await request('GET', '/debug', { headers: { Cookie: `jwt=${token}` } });
    const csrfSetCookie = getRes.setCookie.find(c => c.startsWith('csrfToken='));
    assert.ok(csrfSetCookie, `expected a csrfToken cookie to be set, got Set-Cookie: ${JSON.stringify(getRes.setCookie)}`);
    const csrfToken = csrfSetCookie.split(';')[0].split('=')[1];
    assert.ok(csrfToken.length > 0);

    // POST with the same JWT cookie but WITHOUT the CSRF header: rejected by
    // csrfProtection specifically, before the route handler ever runs.
    const postNoHeaderRes = await request('POST', '/api/reset-documents', {
      headers: { Cookie: `jwt=${token}` },
      body: {}
    });
    assert.strictEqual(postNoHeaderRes.status, 403);

    // POST with the JWT cookie AND a matching X-CSRF-Token header: not
    // rejected by CSRF. (It legitimately gets a 400 from the route handler
    // itself, since body {} has no `ids` array -- that's proof the request
    // made it past csrfProtection into real route logic, not a CSRF failure.)
    const postWithHeaderRes = await request('POST', '/api/reset-documents', {
      headers: { Cookie: `jwt=${token}; csrfToken=${csrfToken}`, 'X-CSRF-Token': csrfToken },
      body: {}
    });
    assert.notStrictEqual(postWithHeaderRes.status, 403);
  } finally {
    setupService.isConfigured = originalIsConfigured;
  }
});

// NACHAUDIT-01: POST /setup had no first-run guard at all. PUBLIC_ROUTES
// exempts it from isAuthenticated/csrfProtection (see the PUBLIC_ROUTES test
// below), and the handler itself never checked isConfigured()/user count
// before touching paperlessService.initializeWithCredentials and eventually
// documentModel.addUser (which does DELETE FROM users before inserting).
// Result: unauthenticated full account takeover in one request. This test
// asserts the same isFullyConfigured gate that GET /setup already applies
// (routes/setup.js:1936) also applies to POST /setup, before any write path
// is touched.
test('POST /setup on an already-configured instance is blocked with 403 and never touches write paths (NACHAUDIT-01)', async () => {
  const originalHasEnvConfig = setupService.hasEnvConfig;
  const originalGetUsers = documentModel.getUsers;
  const originalInitWithCreds = paperlessService.initializeWithCredentials;

  setupService.hasEnvConfig = async () => true;
  documentModel.getUsers = async () => [{ id: 1, username: 'existing-admin' }];
  let initCalled = false;
  paperlessService.initializeWithCredentials = async () => {
    initCalled = true;
    return true;
  };

  try {
    const res = await request('POST', '/setup', {
      body: { paperlessUrl: 'http://attacker.example', paperlessToken: 'x' }
    });
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
    assert.strictEqual(initCalled, false, 'handler must return before touching paperlessService');
  } finally {
    setupService.hasEnvConfig = originalHasEnvConfig;
    documentModel.getUsers = originalGetUsers;
    paperlessService.initializeWithCredentials = originalInitWithCreds;
  }
});

// Finding from final whole-branch review: the POST /setup guard must not
// depend on setupService.isConfigured() (network-dependent, memoized for
// the process lifetime -- see services/setupService.js:336-414). This test
// simulates the failure mode directly: isConfigured() stuck at false (as it
// would be after a dependency outage during its one evaluation), while the
// cheap local hasEnvConfig() check correctly reports the instance is
// already set up. The guard must still block.
test('POST /setup blocks on hasEnvConfig() alone, independent of a stale/failed isConfigured() (final-review fix)', async () => {
  const originalIsConfigured = setupService.isConfigured;
  const originalHasEnvConfig = setupService.hasEnvConfig;
  const originalGetUsers = documentModel.getUsers;
  const originalInitWithCreds = paperlessService.initializeWithCredentials;

  setupService.isConfigured = async () => false; // simulates a permanently-stuck-false memo from a past outage
  setupService.hasEnvConfig = async () => true;  // but the instance genuinely has .env + PAPERLESS_API_URL on disk
  documentModel.getUsers = async () => [{ id: 1, username: 'existing-admin' }];
  let initCalled = false;
  paperlessService.initializeWithCredentials = async () => {
    initCalled = true;
    return true;
  };

  try {
    const res = await request('POST', '/setup', {
      body: { paperlessUrl: 'http://attacker.example', paperlessToken: 'x' }
    });
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
    assert.strictEqual(initCalled, false, 'handler must return before touching paperlessService');
  } finally {
    setupService.isConfigured = originalIsConfigured;
    setupService.hasEnvConfig = originalHasEnvConfig;
    documentModel.getUsers = originalGetUsers;
    paperlessService.initializeWithCredentials = originalInitWithCreds;
  }
});

// Regression guard in the other direction: the real first-run window (no
// .env config yet, no users) must stay reachable. A gate that's too strict
// would lock operators out of ever completing initial setup.
test('POST /setup in the true first-run window (unconfigured, no users) still reaches the handler (NACHAUDIT-01 regression guard)', async () => {
  const originalHasEnvConfig = setupService.hasEnvConfig;
  const originalGetUsers = documentModel.getUsers;
  const originalInitWithCreds = paperlessService.initializeWithCredentials;

  setupService.hasEnvConfig = async () => false;
  documentModel.getUsers = async () => [];
  let initCalled = false;
  paperlessService.initializeWithCredentials = async () => {
    initCalled = true;
    return false; // simulate an unreachable Paperless URL; avoids a real network call
  };

  try {
    const res = await request('POST', '/setup', {
      body: { paperlessUrl: 'http://example.invalid', paperlessToken: 'x' }
    });
    assert.strictEqual(initCalled, true, 'handler must proceed past the first-run gate');
    assert.strictEqual(res.status, 400, `expected 400 from the stubbed init failure, got ${res.status}`);
  } finally {
    setupService.hasEnvConfig = originalHasEnvConfig;
    documentModel.getUsers = originalGetUsers;
    paperlessService.initializeWithCredentials = originalInitWithCreds;
  }
});

// NACHAUDIT-01, recommendation 2: PUBLIC_ROUTES used `req.path.startsWith(route)`,
// so any future route sharing a prefix with a public route (e.g. a
// hypothetical /setup-wizard) would silently inherit the auth bypass too.
// Exact-path matching removes that whole class of bug. This test doesn't
// need a real colliding route to exist -- the bypass check runs in
// router.use(), before Express even looks for a matching route handler, so
// a nonexistent path still proves whether the bypass fired.
test('a path that merely starts with a public prefix is NOT treated as public (PUBLIC_ROUTES exact-match, NACHAUDIT-01 hardening)', async () => {
  const res = await request('GET', '/setup-wizard');
  assert.strictEqual(res.status, 302, `expected 302 redirect for GET /setup-wizard, got ${res.status}`);
  assert.strictEqual(res.location, '/login');
});
