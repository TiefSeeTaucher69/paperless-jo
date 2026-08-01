const { test } = require('node:test');
const assert = require('node:assert');
const { diceCoefficient } = require('../services/entitySimilarity');

test('identische Strings ergeben 1', () => {
  assert.strictEqual(diceCoefficient('meldebescheid', 'meldebescheid'), 1);
});

test('komplett verschiedene Strings ergeben niedrigen Wert', () => {
  assert.ok(diceCoefficient('rechnung', 'stadtwerke') < 0.3);
});

test('orthografisch nahe Varianten ergeben einen hohen Wert', () => {
  const sim = diceCoefficient('meldebescheid', 'meldebescheinigung');
  assert.ok(sim > 0.5, `war ${sim}`);
});

test('leerer String gegen nicht-leeren ergibt 0', () => {
  assert.strictEqual(diceCoefficient('', 'rechnung'), 0);
  assert.strictEqual(diceCoefficient('rechnung', ''), 0);
});

test('Symmetrie: a gegen b ist gleich b gegen a', () => {
  assert.strictEqual(
    diceCoefficient('entgeltabrechnung', 'verdienstbescheinigung'),
    diceCoefficient('verdienstbescheinigung', 'entgeltabrechnung')
  );
});

test('orthografisch ferne Synonyme werden von reiner Trigram-Aehnlichkeit NICHT als hoch erkannt', () => {
  // Dokumentiert bewusst den blinden Fleck aus der Roadmap ("Befunde aus dem
  // Umgebungscheck"): trigram-Aehnlichkeit reicht fuer dieses Paar nicht aus,
  // dafuer existiert die Judge-Stufe.
  const sim = diceCoefficient('entgeltabrechnung', 'verdienstbescheinigung');
  assert.ok(sim < 0.5, `war ${sim} - falls das je hoch wird, muss JUDGE_MIN neu bewertet werden`);
});
