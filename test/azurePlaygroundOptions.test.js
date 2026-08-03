const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const azureService = require('../services/azureService');

function captureRequest(responseContent) {
  const captured = {};
  azureService.client = {
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

  const captured = captureRequest({ tags: [], correspondent: 'X' });
  await azureService.analyzePlayground('DOKUMENT', 'SYSTEM');

  assert.strictEqual(captured.body.temperature, 0);
  assert.strictEqual(captured.body.seed, 42);
});

test('analyzePlayground uebernimmt konfigurierte Sampling-Werte', async () => {
  config.sampling.temperature = 0.25;
  config.sampling.seed = 7;

  const captured = captureRequest({ tags: [], correspondent: 'X' });
  await azureService.analyzePlayground('DOKUMENT', 'SYSTEM');

  assert.strictEqual(captured.body.temperature, 0.25);
  assert.strictEqual(captured.body.seed, 7);
});
