const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaService = require('../services/ollamaService');

function captureRequest() {
  const captured = {};
  ollamaService.client = {
    post: async (url, body) => {
      captured.url = url;
      captured.body = body;
      return { data: { response: { title: 'x' } } };
    }
  };
  return captured;
}

test('_callOllamaAPI sendet greedy-decoding Optionen', async () => {
  config.ollama.temperature = 0;
  config.ollama.seed = 42;
  config.ollama.numPredict = 512;

  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 4096, { type: 'object' });

  assert.strictEqual(captured.body.options.temperature, 0);
  assert.strictEqual(captured.body.options.seed, 42);
  assert.strictEqual(captured.body.options.top_p, 1);
  assert.strictEqual(captured.body.options.num_predict, 512);
  assert.strictEqual(captured.body.options.num_ctx, 4096);
});

test('_callOllamaAPI setzt kein top_k mehr', async () => {
  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 4096, { type: 'object' });

  assert.ok(!('top_k' in captured.body.options), 'top_k darf nicht gesetzt sein');
});

test('_callOllamaAPI uebernimmt konfigurierte Werte', async () => {
  config.ollama.temperature = 0.25;
  config.ollama.seed = 7;
  config.ollama.numPredict = 900;

  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 2048, { type: 'object' });

  assert.strictEqual(captured.body.options.temperature, 0.25);
  assert.strictEqual(captured.body.options.seed, 7);
  assert.strictEqual(captured.body.options.num_predict, 900);
});

test('_callOllamaAPI trennt system und prompt', async () => {
  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 2048, { type: 'object' });

  assert.strictEqual(captured.body.prompt, 'DOKUMENT');
  assert.strictEqual(captured.body.system, 'SYSTEM');
  assert.strictEqual(captured.body.stream, false);
});
