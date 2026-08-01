const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');

const parse = config._parseEnvNumber;

test('parseEnvNumber liefert den Default bei undefined', () => {
  assert.strictEqual(parse(undefined, 8192), 8192);
});

test('parseEnvNumber liefert den Default bei Leerstring', () => {
  assert.strictEqual(parse('   ', 512), 512);
});

test('parseEnvNumber liefert den Default bei unparsbarem Wert', () => {
  assert.strictEqual(parse('viel', 42), 42);
});

test('parseEnvNumber parst Ganzzahlen', () => {
  assert.strictEqual(parse('4096', 8192), 4096);
});

test('parseEnvNumber parst Kommazahlen', () => {
  assert.strictEqual(parse('0.3', 0), 0.3);
});

test('parseEnvNumber akzeptiert die Null', () => {
  assert.strictEqual(parse('0', 0.7), 0);
});

test('Ollama-Sampling-Werte sind Zahlen', () => {
  assert.strictEqual(typeof config.ollama.temperature, 'number');
  assert.strictEqual(typeof config.ollama.seed, 'number');
  assert.strictEqual(typeof config.ollama.numPredict, 'number');
  assert.strictEqual(typeof config.ollama.numCtxMax, 'number');
});
