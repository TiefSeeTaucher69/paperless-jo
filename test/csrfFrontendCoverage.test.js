const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Regression guard for a whole-branch-review finding (AUDIT-027, final review
// Finding 1): routes/setup.js's router.use() applies isAuthenticated ->
// csrfProtection to effectively every non-public browser route in the app
// (it's mounted at '/' before reviewRoutes/ragRoutes, so its blanket
// middleware gates them too -- see routes/setup.js and server.js). A POST
// fetch() call from the frontend that targets a protected route but doesn't
// send the X-CSRF-Token header will get a 403 the moment a user's browser
// actually has a csrfToken cookie. Task 9 wired the header into 5 call-sites;
// a later whole-branch review found ~8 more that were missed. This test
// scans the actual frontend source (not a hardcoded snapshot of "the files we
// remembered to check") so a *future* POST call added without the header
// fails here too, instead of silently shipping a 403 in production.
//
// This is a pragmatic line/regex scan, not a real JS/HTML parser -- see the
// plan doc and final-review-fix-report.md for why that tradeoff was made.

const ROOT = path.join(__dirname, '..');

// Routes exempt from the JWT-cookie auth + CSRF gate (see routes/setup.js's
// PUBLIC_ROUTES). A POST to one of these never needs X-CSRF-Token.
const PUBLIC_ROUTE_PREFIXES = ['/login', '/setup', '/logout', '/health'];

function listSourceFiles() {
  const jsDir = path.join(ROOT, 'public', 'js');
  const viewsDir = path.join(ROOT, 'views');

  const jsFiles = fs.readdirSync(jsDir)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(jsDir, f));

  const viewFiles = fs.readdirSync(viewsDir)
    .filter(f => f.endsWith('.ejs') && !f.endsWith('.bak'))
    .map(f => path.join(viewsDir, f));

  return [...jsFiles, ...viewFiles];
}

// Finds the fetch(...) target nearest (at or before) the `method: 'POST'`
// line. Handles string literals, template literals, and bare identifiers
// (e.g. `fetch(endpoint, ...)` or `fetch(this.action, ...)`).
function extractUrlToken(lines, matchIndex) {
  const start = Math.max(0, matchIndex - 6);
  const windowText = lines.slice(start, matchIndex + 1).join('\n');
  const m = windowText.match(/fetch\(\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w$.]*)/);
  return m ? m[1] : null;
}

function isPublicUrlToken(urlToken) {
  if (!urlToken) return false;
  const stripped = urlToken.replace(/^[`'"]|[`'"]$/g, '');
  return PUBLIC_ROUTE_PREFIXES.some(prefix => stripped.startsWith(prefix));
}

function hasNearbyCsrfHeader(lines, matchIndex) {
  const start = Math.max(0, matchIndex - 2);
  const end = Math.min(lines.length, matchIndex + 10);
  return /X-CSRF-Token/i.test(lines.slice(start, end).join('\n'));
}

test('every protected POST fetch() call in public/js and views sends X-CSRF-Token', () => {
  const violations = [];

  for (const file of listSourceFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const relPath = path.relative(ROOT, file).replace(/\\/g, '/');

    lines.forEach((line, i) => {
      if (!/method\s*:\s*['"]POST['"]/.test(line)) return;

      const urlToken = extractUrlToken(lines, i);

      // views/manual.ejs's `document.querySelector('form')` submit handler
      // (which does `fetch(this.action, { method: 'POST', ... })`) is
      // confirmed dead code: this page has no <form> element anywhere, so
      // querySelector('form') always returns null, the `if (form)` guard is
      // always false, and the fetch call inside it never runs. This check is
      // self-healing: if a <form> is ever added to manual.ejs, the /<form\b/
      // test below stops matching and this exception stops applying, so the
      // call correctly starts failing the assertion until it gets a header.
      if (
        urlToken === 'this.action' &&
        path.basename(file) === 'manual.ejs' &&
        !/<form\b/.test(content)
      ) {
        return;
      }

      if (isPublicUrlToken(urlToken)) return;

      if (!hasNearbyCsrfHeader(lines, i)) {
        violations.push(
          `${relPath}:${i + 1} -- POST fetch (target: ${urlToken || '<unresolved>'}) has no X-CSRF-Token header nearby`
        );
      }
    });
  }

  assert.deepStrictEqual(
    violations,
    [],
    `Found POST fetch call(s) that appear to target a protected route without sending X-CSRF-Token:\n${violations.join('\n')}`
  );
});
