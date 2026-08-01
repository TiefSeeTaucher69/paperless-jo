const { test } = require('node:test');
const assert = require('node:assert');
const entityJudge = require('../services/entityJudge');

function captureRequest(responseData) {
  const captured = {};
  entityJudge.client = {
    post: async (url, body) => {
      captured.url = url;
      captured.body = body;
      return { data: responseData };
    }
  };
  return captured;
}

test('sendet temperature 0 unabhaengig von der globalen Konfiguration', async () => {
  const captured = captureRequest({ response: { verdict: 'same', reason: 'gleiche Sache' } });
  await entityJudge.judge('document_type', 'Meldebescheid', 'Meldebescheinigung');

  assert.strictEqual(captured.body.options.temperature, 0);
  assert.strictEqual(captured.body.stream, false);
  assert.ok(captured.body.prompt.includes('Meldebescheid'));
  assert.ok(captured.body.prompt.includes('Meldebescheinigung'));
});

test('parst ein strukturiertes Objekt direkt', async () => {
  captureRequest({ response: { verdict: 'different', reason: 'unterschiedlich' } });
  const result = await entityJudge.judge('tag', 'A', 'B');
  assert.deepStrictEqual(result, { verdict: 'different', reason: 'unterschiedlich' });
});

test('parst eine JSON-Zeichenkette (Fallback, falls Ollama Text statt Objekt liefert)', async () => {
  captureRequest({ response: JSON.stringify({ verdict: 'unsure', reason: 'unklar' }) });
  const result = await entityJudge.judge('tag', 'A', 'B');
  assert.deepStrictEqual(result, { verdict: 'unsure', reason: 'unklar' });
});

test('wirft bei Netzwerkfehler (Aufrufer in entityResolver faengt das ab)', async () => {
  entityJudge.client = { post: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => entityJudge.judge('tag', 'A', 'B'), /ECONNREFUSED/);
});
