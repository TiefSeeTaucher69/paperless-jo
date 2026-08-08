const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Regression guard for a whole-branch-review finding (Paket-3 final review,
// Finding 1): views/review-aliases.ejs was copied from views/review.ejs's
// boilerplate, including relative asset paths (href="css/dashboard.css",
// src="js/csrf.js", src="js/review-aliases.js"). views/review.ejs is served
// at /review (one path segment), where a relative URL resolves against '/'
// correctly. views/review-aliases.ejs is served at /review/aliases (two path
// segments), where the SAME relative path resolves against '/review/'
// instead -- producing requests to /review/css/dashboard.css,
// /review/js/csrf.js, /review/js/review-aliases.js, all 404 (static files
// are only mounted at root). Result: the page rendered unstyled,
// getCsrfToken was undefined, and the alias-delete button silently did
// nothing.
//
// Like test/csrfFrontendCoverage.test.js, this is a pragmatic regex/string
// scan over the actual view source -- no DOM, no browser, no jsdom needed,
// consistent with this repo's "no frontend test harness" constraint. It
// scans every .ejs file in views/ for href="..."/src="..." attributes that
// reference a local static asset with a relative path (no leading '/', and
// not an external http(s)/protocol-relative URL) and fails, listing the
// offending file(s) and attribute(s), if any are found. Any current or
// future view served at a route with more than one path segment (like
// /review/aliases) needs absolute asset paths to render correctly, and any
// view served at a one-segment route works fine with absolute paths too --
// so requiring absolute paths everywhere is a strictly safe rule for this
// app, not just a workaround for one page.

const ROOT = path.join(__dirname, '..');

// Pre-existing views that already used relative asset paths before Paket 3
// and are exempt from this check: they've each only ever been served at a
// single-path-segment route (e.g. /chat, /dashboard, /settings), so the
// relative path resolves correctly today. That's the same latent risk
// review-aliases.ejs had -- it's still a footgun for anyone who later serves
// one of these at a nested route -- but fixing a dozen unrelated views is
// out of scope for this fix wave (see the "Not in scope" list in the
// Paket-3 final-review fixplan). Do NOT add new files to this list: any
// newly added or newly touched view should use absolute paths from the
// start, and this list existing is what keeps that enforceable -- it can
// only shrink as the legacy views get cleaned up, never grow.
const LEGACY_EXEMPT_FILES = new Set([
  'chat.ejs',
  'dashboard.ejs',
  'history.ejs',
  'login.ejs',
  'manual.ejs',
  'playground.ejs',
  'rag.ejs',
  'review.ejs',
  'settings.ejs',
  'setup.ejs',
  'template.ejs'
]);

function listViewFiles() {
  const viewsDir = path.join(ROOT, 'views');

  return fs.readdirSync(viewsDir)
    .filter(f => f.endsWith('.ejs') && !f.endsWith('.bak'))
    .filter(f => !LEGACY_EXEMPT_FILES.has(f))
    .map(f => path.join(viewsDir, f));
}

// Matches href="..." / src="..." attributes (single or double quoted).
// Deliberately simple -- this repo doesn't use EJS interpolation inside
// these attribute values for static assets (only for query-string-style
// dynamic hrefs like `<%= documentLink %>`, which never start with a
// relative-looking bare path and are exempt below since they don't match
// this pattern in the first place, e.g. href="<%= entry.documentLink %>").
const ASSET_ATTR_RE = /\b(?:href|src)\s*=\s*"([^"]*)"/g;

function isExemptAssetValue(value) {
  if (value === '') return true; // empty href, e.g. anchor placeholders
  if (value.startsWith('<%')) return true; // fully dynamic EJS expression
  if (value.startsWith('/')) return true; // absolute path -- safe from any route depth
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('//')) return true; // external / protocol-relative
  if (value.startsWith('#')) return true; // in-page anchor
  if (value.startsWith('mailto:') || value.startsWith('tel:') || value.startsWith('javascript:')) return true;
  return false;
}

test('every local static asset href/src in views/*.ejs uses an absolute path', () => {
  const violations = [];

  for (const file of listViewFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(ROOT, file).replace(/\\/g, '/');

    let match;
    ASSET_ATTR_RE.lastIndex = 0;
    while ((match = ASSET_ATTR_RE.exec(content)) !== null) {
      const value = match[1];
      if (isExemptAssetValue(value)) continue;

      const upToMatch = content.slice(0, match.index);
      const line = upToMatch.split('\n').length;
      violations.push(`${relPath}:${line} -- relative asset path "${value}" (must start with "/")`);
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `Found relative local asset path(s) in views/*.ejs that will 404 when the page is served at a route with more than one path segment:\n${violations.join('\n')}`
  );
});
