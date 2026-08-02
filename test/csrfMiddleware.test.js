const { test } = require('node:test');
const assert = require('node:assert');
const { csrfProtection, generateCsrfToken, tokensMatch, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } = require('../middleware/csrf.js');

function fakeReqRes({ method = 'POST', cookies = {}, headers = {}, user = { id: 1 } } = {}) {
  const req = { method, cookies, headers, user };
  const res = {
    statusCode: 200,
    cookieCalls: [],
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
    cookie(name, value, opts) { this.cookieCalls.push({ name, value, opts }); }
  };
  return { req, res };
}

test('generateCsrfToken returns distinct 64-char hex strings', () => {
  const a = generateCsrfToken();
  const b = generateCsrfToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, b);
});

test('tokensMatch is false when either value is missing', () => {
  assert.strictEqual(tokensMatch(undefined, 'x'), false);
  assert.strictEqual(tokensMatch('x', undefined), false);
});

test('tokensMatch is true only for equal-length, equal-content strings', () => {
  assert.strictEqual(tokensMatch('abc', 'abc'), true);
  assert.strictEqual(tokensMatch('abc', 'abd'), false);
  assert.strictEqual(tokensMatch('abc', 'ab'), false);
});

test('csrfProtection skips API-key-authenticated requests entirely', () => {
  const { req, res } = fakeReqRes({ method: 'POST', user: { apiKey: true } });
  let nextCalled = false;
  csrfProtection(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.cookieCalls.length, 0);
});

test('csrfProtection sets a cookie on a safe GET request when none exists yet', () => {
  const { req, res } = fakeReqRes({ method: 'GET', cookies: {} });
  let nextCalled = false;
  csrfProtection(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.cookieCalls.length, 1);
  assert.strictEqual(res.cookieCalls[0].name, CSRF_COOKIE_NAME);
});

test('csrfProtection does not overwrite an existing cookie on GET', () => {
  const { req, res } = fakeReqRes({ method: 'GET', cookies: { [CSRF_COOKIE_NAME]: 'existing-token' } });
  csrfProtection(req, res, () => {});
  assert.strictEqual(res.cookieCalls.length, 0);
});

test('csrfProtection rejects a POST with no CSRF header', () => {
  const { req, res } = fakeReqRes({ method: 'POST', cookies: { [CSRF_COOKIE_NAME]: 'token-value' }, headers: {} });
  let nextCalled = false;
  csrfProtection(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('csrfProtection rejects a POST with a mismatched CSRF header', () => {
  const { req, res } = fakeReqRes({
    method: 'POST',
    cookies: { [CSRF_COOKIE_NAME]: 'token-value' },
    headers: { [CSRF_HEADER_NAME]: 'wrong-value' }
  });
  csrfProtection(req, res, () => {});
  assert.strictEqual(res.statusCode, 403);
});

test('csrfProtection allows a POST when the header matches the cookie', () => {
  const { req, res } = fakeReqRes({
    method: 'POST',
    cookies: { [CSRF_COOKIE_NAME]: 'token-value' },
    headers: { [CSRF_HEADER_NAME]: 'token-value' }
  });
  let nextCalled = false;
  csrfProtection(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});
