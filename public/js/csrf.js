// Reads the csrfToken cookie set by middleware/csrf.js. Cookie name must match
// CSRF_COOKIE_NAME in middleware/csrf.js exactly.
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|; )csrfToken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}
