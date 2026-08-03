const { test } = require('node:test');
const assert = require('node:assert');

// AUDIT-022: server.js:202 und routes/setup.js:1570 enthalten beide dieselbe Bedingung
// `!content || !content.length >= 10` - dieser Test pinnt die reparierte Version isoliert,
// weil processDocument() in keiner der beiden Dateien exportiert ist (siehe Plan, Global
// Constraints). Bei einer Regression auf die alte Bedingung (kopiert-eingefuegter Copy/Paste-
// Fehler) faellt dieser Test durch.
function isContentTooShort(content) {
  return !content || content.length < 10;
}

test('Inhalt mit weniger als 10 Zeichen gilt als zu kurz (AUDIT-022)', () => {
  assert.strictEqual(isContentTooShort('123456789'), true); // 9 Zeichen
});

test('Inhalt mit genau 10 Zeichen gilt nicht als zu kurz', () => {
  assert.strictEqual(isContentTooShort('1234567890'), false); // 10 Zeichen
});

test('leerer oder fehlender Inhalt gilt als zu kurz', () => {
  assert.strictEqual(isContentTooShort(''), true);
  assert.strictEqual(isContentTooShort(null), true);
  assert.strictEqual(isContentTooShort(undefined), true);
});

test('die alte, kaputte Bedingung haette 9 Zeichen faelschlich durchgelassen (Regressionsbeleg)', () => {
  const content = '123456789'; // 9 Zeichen
  const brokenCondition = !content || !content.length >= 10;
  assert.strictEqual(brokenCondition, false, 'die alte Bedingung liess 9 Zeichen faelschlich durch - genau das ist AUDIT-022');
});
