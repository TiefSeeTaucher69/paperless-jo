const { test } = require('node:test');
const assert = require('node:assert');

test('tryStart liefert true beim ersten Aufruf, false solange running, true wieder nach finish (AUDIT-014)', () => {
  delete require.cache[require.resolve('../services/scanRunGuard')];
  const guard = require('../services/scanRunGuard');

  assert.strictEqual(guard.isRunning(), false);
  assert.strictEqual(guard.tryStart(), true);
  assert.strictEqual(guard.isRunning(), true);
  assert.strictEqual(guard.tryStart(), false, 'ein zweiter tryStart waehrend des Laufs muss abgelehnt werden');

  guard.finish();
  assert.strictEqual(guard.isRunning(), false);
  assert.strictEqual(guard.tryStart(), true, 'nach finish() muss ein neuer Lauf wieder moeglich sein');

  guard.finish();
});

test('finish ist ohne vorheriges tryStart sicher (kein Fehler, running bleibt false)', () => {
  delete require.cache[require.resolve('../services/scanRunGuard')];
  const guard = require('../services/scanRunGuard');

  guard.finish();
  assert.strictEqual(guard.isRunning(), false);
});
