const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaReachabilityGuard = require('../services/ollamaReachabilityGuard');

test('check() ueberspringt den Request, wenn weder Resolver noch Embedding aktiv sind', async () => {
  const savedResolver = config.entityResolver.enabled;
  const savedEmbedding = config.embedding.enabled;
  config.entityResolver.enabled = false;
  config.embedding.enabled = false;

  let called = false;
  ollamaReachabilityGuard.client = { get: async () => { called = true; return { data: {} }; } };

  try {
    const result = await ollamaReachabilityGuard.check();
    assert.strictEqual(result, true);
    assert.strictEqual(called, false, 'ohne aktiven Resolver/Embedding-Kanal darf kein Request gestellt werden');
  } finally {
    config.entityResolver.enabled = savedResolver;
    config.embedding.enabled = savedEmbedding;
  }
});

test('check() gibt true zurueck, wenn Resolver aktiv und Ollama erreichbar ist', async () => {
  const savedResolver = config.entityResolver.enabled;
  config.entityResolver.enabled = true;
  ollamaReachabilityGuard.client = { get: async () => ({ data: { models: [] } }) };

  try {
    const result = await ollamaReachabilityGuard.check();
    assert.strictEqual(result, true);
  } finally {
    config.entityResolver.enabled = savedResolver;
  }
});

test('check() gibt genau eine Warnung aus und liefert false, wenn Embedding aktiv und Ollama nicht erreichbar ist (AUDIT-007)', async () => {
  const savedResolver = config.entityResolver.enabled;
  const savedEmbedding = config.embedding.enabled;
  config.entityResolver.enabled = false;
  config.embedding.enabled = true;
  ollamaReachabilityGuard.client = { get: async () => { throw new Error('ECONNREFUSED'); } };

  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    const result = await ollamaReachabilityGuard.check();
    assert.strictEqual(result, false);
    assert.strictEqual(warnMessages.length, 1, 'darf genau eine Warnung ausgeben, nicht eine pro Entitaet');
    assert.ok(warnMessages[0].includes('AUDIT-007'));
    assert.ok(warnMessages[0].includes(config.ollama.apiUrl));
  } finally {
    console.warn = savedWarn;
    config.entityResolver.enabled = savedResolver;
    config.embedding.enabled = savedEmbedding;
  }
});
