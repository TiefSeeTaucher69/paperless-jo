// services/scanRunGuard.js
//
// Ein einziger prozessweiter Lauf-Guard fuer alle Vollscan-Einstiegspunkte (initialer Scan,
// Cron-Scan und der manuelle "Scan now"-Button). Vorher hatte routes/setup.js gar keinen
// wirksamen Guard: die Zeile `runningTask = false` dort referenzierte eine in diesem Modul nie
// deklarierte Variable und legte im Non-Strict-CommonJS ein wirkungsloses globales Property an
// (ESLint: 'runningTask' is not defined) - ein Klick auf "Scan now" waehrend des Cron-Laufs
// startete faktisch eine zweite volle Verarbeitungsschleife ueber dieselben Dokumente
// (AUDIT-014). Ueber require()-Caching teilen sich server.js und routes/setup.js dieselbe
// Modulinstanz und damit denselben `running`-Zustand.
let running = false;

function tryStart() {
  if (running) {
    return false;
  }
  running = true;
  return true;
}

function finish() {
  running = false;
}

function isRunning() {
  return running;
}

module.exports = { tryStart, finish, isRunning };
