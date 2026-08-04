const { test } = require('node:test');
const assert = require('node:assert');
const entityJudge = require('../services/entityJudge');
const config = require('../config/config');

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

test('sendet den globalen Ollama-Seed (AUDIT-028: Determinismus wie bei Temperature, siehe AUDIT-008)', async () => {
  const captured = captureRequest({ response: { verdict: 'same', reason: 'x' } });
  await entityJudge.judge('tag', 'A', 'B');
  assert.strictEqual(captured.body.options.seed, config.ollama.seed);
});

test('Kuerzt Namen ueber 300 Zeichen vor dem Prompt (AUDIT-028: num_ctx=1024 bleibt sicher)', async () => {
  const longName = 'A'.repeat(400);
  const captured = captureRequest({ response: { verdict: 'unsure', reason: 'lang' } });
  await entityJudge.judge('correspondent', longName, 'B');
  const nameALine = captured.body.prompt.split('\n').find(line => line.startsWith('Name A:'));
  assert.strictEqual(nameALine, `Name A: ${'A'.repeat(300)}`);
});

test('Retry: erster Versuch schlaegt fehl, zweiter Versuch liefert das Ergebnis (AUDIT-028)', async () => {
  let calls = 0;
  entityJudge.client = {
    post: async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return { data: { response: { verdict: 'same', reason: 'nach Retry gleich' } } };
    }
  };
  const result = await entityJudge.judge('tag', 'A', 'B');
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(result, { verdict: 'same', reason: 'nach Retry gleich' });
});

test('Retry erschoepft: beide Versuche schlagen fehl -> wirft weiterhin, Aufrufer faengt ab (AUDIT-028)', async () => {
  let calls = 0;
  entityJudge.client = { post: async () => { calls++; throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => entityJudge.judge('tag', 'A', 'B'), /ECONNREFUSED/);
  assert.strictEqual(calls, 2);
});

test('Kuerzt NICHT bei genau 300 Zeichen, kuerzt bei 301 Zeichen (AUDIT-028: Grenzwert)', async () => {
  const exactLength = 'A'.repeat(300);
  const captured300 = captureRequest({ response: { verdict: 'unsure', reason: 'grenzwert' } });
  await entityJudge.judge('tag', exactLength, 'B');
  const nameALine300 = captured300.body.prompt.split('\n').find(line => line.startsWith('Name A:'));
  assert.strictEqual(nameALine300, `Name A: ${exactLength}`);

  const overLength = 'A'.repeat(301);
  const captured301 = captureRequest({ response: { verdict: 'unsure', reason: 'grenzwert' } });
  await entityJudge.judge('tag', overLength, 'B');
  const nameALine301 = captured301.body.prompt.split('\n').find(line => line.startsWith('Name A:'));
  assert.strictEqual(nameALine301, `Name A: ${'A'.repeat(300)}`);
});

test('Retry NICHT bei 4xx-Fehlern (AUDIT-028: nur transiente Fehler werden wiederholt)', async () => {
  let calls = 0;
  const clientError = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400 }
  });
  entityJudge.client = { post: async () => { calls++; throw clientError; } };
  await assert.rejects(() => entityJudge.judge('tag', 'A', 'B'), /400/);
  assert.strictEqual(calls, 1);
});
