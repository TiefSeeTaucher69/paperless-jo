const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const openaiService = require('../services/openaiService');

function captureRequest(responseContent) {
  const captured = {};
  openaiService.client = {
    chat: {
      completions: {
        create: async (body) => {
          captured.body = body;
          return {
            choices: [{ message: { content: JSON.stringify(responseContent) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          };
        }
      }
    }
  };
  return captured;
}

test('analyzePlayground sendet die providerneutrale Sampling-Policy statt hartkodierter 0.3 (AUDIT-008)', async () => {
  config.sampling.temperature = 0;
  config.sampling.seed = 42;
  process.env.OPENAI_MODEL = 'gpt-4o-mini';

  const captured = captureRequest({ tags: [], correspondent: 'X' });
  await openaiService.analyzePlayground('DOKUMENT', 'SYSTEM');

  assert.strictEqual(captured.body.temperature, 0);
  assert.strictEqual(captured.body.seed, 42);
});

test('analyzePlayground uebernimmt konfigurierte Sampling-Werte', async () => {
  config.sampling.temperature = 0.25;
  config.sampling.seed = 7;
  process.env.OPENAI_MODEL = 'gpt-4o-mini';

  const captured = captureRequest({ tags: [], correspondent: 'X' });
  await openaiService.analyzePlayground('DOKUMENT', 'SYSTEM');

  assert.strictEqual(captured.body.temperature, 0.25);
  assert.strictEqual(captured.body.seed, 7);
});

test('analyzePlayground setzt weder temperature noch seed fuer o3-mini', async () => {
  config.sampling.temperature = 0;
  config.sampling.seed = 42;
  process.env.OPENAI_MODEL = 'o3-mini';

  const captured = captureRequest({ tags: [], correspondent: 'X' });
  await openaiService.analyzePlayground('DOKUMENT', 'SYSTEM');

  assert.ok(!('temperature' in captured.body), 'temperature darf fuer o3-mini nicht gesetzt sein');
  assert.ok(!('seed' in captured.body), 'seed darf fuer o3-mini nicht gesetzt sein');
});
