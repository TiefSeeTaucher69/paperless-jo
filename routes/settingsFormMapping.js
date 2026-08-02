// Pure mapping from POST /settings' req.body (camelCase form fields) to the
// 7 env keys the EntityResolver/Embedding/Fingerprint features read from
// data/.env. Kept separate from routes/setup.js so it's testable without an
// Express app or a live Paperless/Ollama connection.

const CHECKBOX_FIELDS = {
  entityResolverEnabled: 'ENTITY_RESOLVER_ENABLED',
  embeddingSimilarityEnabled: 'EMBEDDING_SIMILARITY_ENABLED',
  documentFingerprintEnabled: 'DOCUMENT_FINGERPRINT_ENABLED'
};

const THRESHOLD_FIELDS = {
  entityResolverAutoThreshold: 'ENTITY_RESOLVER_AUTO_THRESHOLD',
  entityResolverJudgeMin: 'ENTITY_RESOLVER_JUDGE_MIN',
  embedAutoThreshold: 'EMBED_AUTO_THRESHOLD',
  embedJudgeMin: 'EMBED_JUDGE_MIN'
};

function mapEntitySimilarityFields(body) {
  const updates = {};

  for (const [bodyKey, envKey] of Object.entries(CHECKBOX_FIELDS)) {
    // Unchecked HTML checkboxes are absent from FormData entirely -- same
    // convention as ACTIVATE_TAGGING etc. elsewhere in this handler.
    updates[envKey] = body[bodyKey] === 'on' || body[bodyKey] === 'yes' ? 'yes' : 'no';
  }

  for (const [bodyKey, envKey] of Object.entries(THRESHOLD_FIELDS)) {
    const value = body[bodyKey];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      updates[envKey] = String(value);
    }
  }

  return updates;
}

module.exports = { mapEntitySimilarityFields };
