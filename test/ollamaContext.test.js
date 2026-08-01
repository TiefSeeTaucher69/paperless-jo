const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaService = require('../services/ollamaService');

// _calculatePromptTokenCount schaetzt mit ceil(length / 4).
// 4 Zeichen entsprechen also einem Token.
const tokens = n => 'x'.repeat(n * 4);

test('kurzer Prompt bekommt die Untergrenze von 2048', () => {
  config.ollama.numCtxMax = 8192;
  config.ollama.numPredict = 512;

  const result = ollamaService._fitPromptToContext(tokens(100), tokens(100));

  assert.strictEqual(result.numCtx, 2048);
  assert.strictEqual(result.truncated, false);
});

test('numCtx waechst mit dem tatsaechlichen Bedarf', () => {
  config.ollama.numCtxMax = 8192;
  config.ollama.numPredict = 512;

  const result = ollamaService._fitPromptToContext(tokens(1000), tokens(2000));

  assert.strictEqual(result.numCtx, 1000 + 2000 + 512);
  assert.strictEqual(result.truncated, false);
});

test('numCtx ueberschreitet die Obergrenze nicht', () => {
  config.ollama.numCtxMax = 4096;
  config.ollama.numPredict = 512;

  const result = ollamaService._fitPromptToContext(tokens(500), tokens(99999));

  assert.ok(result.numCtx <= 4096, `numCtx war ${result.numCtx}`);
  assert.strictEqual(result.truncated, true);
});

test('bei Ueberlauf wird nur der Dokumententext gekuerzt', () => {
  config.ollama.numCtxMax = 4096;
  config.ollama.numPredict = 512;

  const system = tokens(500);
  const result = ollamaService._fitPromptToContext(system, tokens(99999));

  // Der Dokumententext passt in das verbleibende Budget
  const budget = 4096 - 500 - 512;
  assert.strictEqual(result.user.length, budget * 4);
});

test('der system-Teil wird nie gekuerzt', () => {
  config.ollama.numCtxMax = 4096;
  config.ollama.numPredict = 512;

  const system = 'ANWEISUNGEN-' + tokens(500);
  const result = ollamaService._fitPromptToContext(system, tokens(99999));

  // _fitPromptToContext gibt den system-Teil nicht zurueck, weil es ihn nicht
  // veraendert. Der Vertrag wird ueber numCtx geprueft: es muss Platz fuer den
  // vollstaendigen system-Teil bleiben.
  const systemTokens = Math.ceil(system.length / 4);
  const userTokens = Math.ceil(result.user.length / 4);
  assert.ok(result.numCtx >= systemTokens + userTokens);

  // Zusaetzlich: der tatsaechliche user-Anteil darf das Budget nicht
  // sprengen, das nach Abzug von system-Teil und numPredict von
  // numCtxMax uebrig bleibt. Das belegt, dass der system-Teil beim
  // Kuerzen wirklich vollstaendig beruecksichtigt wurde.
  const maxCtx = config.ollama.numCtxMax;
  const numPredict = config.ollama.numPredict;
  assert.ok(result.user.length <= (maxCtx - systemTokens - numPredict) * 4);
});

test('ein uebergrosser system-Teil erzwingt ein Mindestbudget und meldet das', () => {
  config.ollama.numCtxMax = 2000;
  config.ollama.numPredict = 512;

  const result = ollamaService._fitPromptToContext(tokens(1800), tokens(5000));

  // 2000 - 1800 - 512 ist negativ, also greift das Mindestbudget von 512
  assert.strictEqual(result.user.length, 512 * 4);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.numCtx > 2000, 'Obergrenze wird bewusst ueberschritten');
});

test('numPredict laesst sich pro Aufruf ueberschreiben', () => {
  config.ollama.numCtxMax = 8192;
  config.ollama.numPredict = 512;

  const result = ollamaService._fitPromptToContext(tokens(1000), tokens(2000), 1024);

  assert.strictEqual(result.numCtx, 1000 + 2000 + 1024);
});
