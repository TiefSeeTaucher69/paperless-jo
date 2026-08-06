// Reads the csrfToken cookie set by middleware/csrf.js. Cookie name must match
// CSRF_COOKIE_NAME in middleware/csrf.js exactly.
// eslint-disable-next-line no-unused-vars -- globaler Bezeichner, siehe eslint.config.mjs; wird aus anderen public/js-Dateien per <script>-Reihenfolge aufgerufen, nicht aus dieser Datei.
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|; )csrfToken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}
