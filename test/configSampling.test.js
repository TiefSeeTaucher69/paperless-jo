const { test } = require('node:test');
const assert = require('node:assert');

test('sampling-Block liefert providerneutrale Deterministik-Defaults und spiegelt config.ollama (AUDIT-008)', () => {
  const savedTemp = process.env.OLLAMA_TEMPERATURE;
  const savedSeed = process.env.OLLAMA_SEED;

  try {
    process.env.OLLAMA_TEMPERATURE = '';
    process.env.OLLAMA_SEED = '';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.sampling.temperature, 0);
    assert.strictEqual(config.sampling.seed, 42);
    assert.strictEqual(config.sampling.temperature, config.ollama.temperature);
    assert.strictEqual(config.sampling.seed, config.ollama.seed);
  } finally {
    if (savedTemp === undefined) { delete process.env.OLLAMA_TEMPERATURE; } else { process.env.OLLAMA_TEMPERATURE = savedTemp; }
    if (savedSeed === undefined) { delete process.env.OLLAMA_SEED; } else { process.env.OLLAMA_SEED = savedSeed; }
    delete require.cache[require.resolve('../config/config')];
  }
});

test('sampling-Block uebernimmt konfigurierte Werte', () => {
  const savedTemp = process.env.OLLAMA_TEMPERATURE;
  const savedSeed = process.env.OLLAMA_SEED;

  try {
    process.env.OLLAMA_TEMPERATURE = '0.25';
    process.env.OLLAMA_SEED = '7';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.sampling.temperature, 0.25);
    assert.strictEqual(config.sampling.seed, 7);
  } finally {
    if (savedTemp === undefined) { delete process.env.OLLAMA_TEMPERATURE; } else { process.env.OLLAMA_TEMPERATURE = savedTemp; }
    if (savedSeed === undefined) { delete process.env.OLLAMA_SEED; } else { process.env.OLLAMA_SEED = savedSeed; }
    delete require.cache[require.resolve('../config/config')];
  }
});
