const crypto = require('crypto');
const setupService = require('./setupService');

function isJwtSecretPlaceholder(value) {
  return !value || value === 'your-secret-key';
}

// Guarantees JWT_SECRET is a real random value before the app serves a single
// request. Without this, a missing JWT_SECRET (fresh install, or a Settings-Save
// that dropped it — see AUDIT-002) would fall back to the literal string
// 'your-secret-key' in routes/auth.js, which is public (it's in this repo) and
// lets anyone forge a valid session cookie.
async function ensureJwtSecret() {
  if (!isJwtSecretPlaceholder(process.env.JWT_SECRET)) {
    return;
  }

  const newSecret = crypto.randomBytes(64).toString('hex');
  process.env.JWT_SECRET = newSecret;

  try {
    const existing = await setupService.loadConfig();
    if (existing && existing.PAPERLESS_API_URL) {
      // Only persist if the app is already configured (data/.env exists with
      // real settings) — a brand-new install writes JWT_SECRET itself during
      // POST /setup and shouldn't get a data/.env file before that happens.
      await setupService.saveConfig({ JWT_SECRET: newSecret });
      console.warn('[SECURITY] JWT_SECRET was missing or set to the default placeholder; generated and persisted a new random secret. All existing sessions are now invalid.');
    }
  } catch (error) {
    console.error('[SECURITY] Generated a new in-memory JWT_SECRET but failed to persist it to data/.env:', error.message);
  }
}

module.exports = { isJwtSecretPlaceholder, ensureJwtSecret };
