const crypto = require('crypto');

const CSRF_COOKIE_NAME = 'csrfToken';
const CSRF_HEADER_NAME = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokensMatch(cookieValue, headerValue) {
  if (!cookieValue || !headerValue) return false;
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(headerValue);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Double-submit cookie CSRF check. Only applies to requests authenticated via
// the JWT cookie: a browser attaches cookies automatically to cross-site
// requests (the CSRF threat model), but never attaches a custom X-API-Key
// header on its own, so API-key-authenticated requests are already immune
// and are skipped here.
function csrfProtection(req, res, next) {
  if (req.user && req.user.apiKey) {
    return next();
  }

  if (SAFE_METHODS.has(req.method)) {
    if (!req.cookies[CSRF_COOKIE_NAME]) {
      res.cookie(CSRF_COOKIE_NAME, generateCsrfToken(), {
        httpOnly: false, // must be readable by frontend JS to echo back in the header
        sameSite: 'strict',
        secure: process.env.COOKIE_SECURE === 'yes',
        path: '/'
      });
    }
    return next();
  }

  const cookieToken = req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];
  if (!tokensMatch(cookieToken, headerToken)) {
    return res.status(403).json({ message: 'Invalid or missing CSRF token' });
  }
  next();
}

module.exports = { csrfProtection, generateCsrfToken, tokensMatch, CSRF_COOKIE_NAME, CSRF_HEADER_NAME };
