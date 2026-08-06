# Nachaudit Paket 4 — Fingerprint-Aktivierungsvoraussetzungen schließen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Abweichung von einem reinen Code-Plan:** Wie schon
> [Paket 3](../plans/2026-08-05-nachaudit-paket3-review-queue-produktivlauf.md) ist auch dieses
> Paket kein reiner Code-Task. Task 7 (Beobachtungsmodus-Testlauf, ≥200 Dokumente) und Task 8
> (Schwellwertmessung, ≥60 gelabelte Dokumentpaare) verlangen Zugriff auf die laufende
> **Produktivinstanz** mit echten Paperless-ngx-Daten und sind aus diesem Checkout heraus nicht
> ausführbar. Tasks 1–6 und 9 sind reiner Code/Doku und aus diesem Checkout heraus vollständig
> umsetz- und committbar.

**Goal:** Die drei noch offenen Bedingungen aus dem Erstaudit, Abschnitt 18.6 (Punkt 1
Schwellwertmessung, Punkt 5 Beobachtungsmodus, Punkt 6 Rückabwicklungspfad) sowie den im
Nachaudit gefundenen Nebenbefund NACHAUDIT-13 schließen — **ohne** das Feature selbst zu
aktivieren. `DOCUMENT_FINGERPRINT_ENABLED` bleibt in `data/.env` auf `no`, bis eine bewusste,
separate Aktivierungsentscheidung getroffen wird (siehe
[docs/audit/2026-08-04-nachaudit-offene-punkte.md](../../audit/2026-08-04-nachaudit-offene-punkte.md),
Paket 4: „unkritisch für den laufenden Betrieb, da Feature aus").

**Architektur:** Baut auf der bestehenden Fingerprint-Infrastruktur auf
(`models/documentFingerprintStore.js`, `services/documentFingerprintService.js`,
`services/documentProcessingPipeline.js`). Drei unabhängige Erweiterungen:
1. Ein neuer `DOCUMENT_FINGERPRINT_MODE=observe|apply`-Schalter, der einen Fingerprint-Treffer im
   `observe`-Modus protokolliert statt ihn auf `updateData` anzuwenden — dieselbe
   `document_fingerprints`-Datenbank (`data/entities.db`) bekommt dafür eine neue, additive
   Beobachtungstabelle.
2. Eine `restoreOriginalData`-Funktion, die die in `original_documents` bereits gespeicherten
   Vorzustände (Tags, Korrespondent, Titel) per direktem, Replace-semantischem PATCH nach
   Paperless zurückschreibt — ergänzt um eine neue, authentifizierte Route.
3. Ein Korrektur-Fix an der bestehenden `usedFingerprint`-Ermittlung in
   `server.js`/`routes/setup.js#buildUpdateData`.

Die Schwellwertmessung selbst (Punkt 1) braucht keinen neuen Code — das Werkzeug
(`scripts/tune-thresholds.js --fingerprint`) existiert bereits seit AUDIT-025 — sondern reale
gelabelte Dokumentpaare und einen Messlauf (Task 8, Runbook).

**Tech Stack:** Node.js (CommonJS), `better-sqlite3` (`data/entities.db`), Express-Routen
(`routes/setup.js`), `node:test`. Keine neue Dependency.

## Global Constraints

- `data/.env` und alle darin enthaltenen Zugangsdaten (Paperless-Token, Ollama-URL) dürfen nie
  in Commits, Logs, Doku-Beispielen oder Zusammenfassungen im Klartext auftauchen — nur
  Platzhalter.
- **`DOCUMENT_FINGERPRINT_ENABLED` bleibt `no` in der echten `data/.env`.** Dieses Paket schließt
  Aktivierungsvoraussetzungen, aktiviert das Feature aber nicht — das ist eine separate,
  spätere Entscheidung (siehe Zielsatz oben).
- Additiv: mit `DOCUMENT_FINGERPRINT_ENABLED=no` (unverändert) muss sich die Anwendung exakt wie
  vor diesem Paket verhalten. Kein neuer Codepfad in `server.js`/`routes/setup.js` wird ohne
  aktiviertes Feature erreicht (bestehende Eigenschaft, siehe
  `services/documentProcessingPipeline.js#findFingerprintMatch`, erste Zeile).
- **`DOCUMENT_FINGERPRINT_MODE` ist standardmäßig `observe`, nicht `apply`.** Das ist eine
  bewusste Abweichung von „vorher hätte ein `DOCUMENT_FINGERPRINT_ENABLED=yes` ohne weitere
  Konfiguration sofort angewendet" — genau die Sicherheitseigenschaft, die Bedingung 5 aus
  Abschnitt 18.6 verlangt. Hat keine Auswirkung auf die echte `data/.env`, solange
  `DOCUMENT_FINGERPRINT_ENABLED=no` bleibt (siehe Constraint oben).
- Kein LLM-Judge, keine dauerhafte Review-Queue für Fingerprint-Treffer — bewusste
  Design-Entscheidung aus
  [2026-08-02-phase5-fingerprint-design.md](../specs/2026-08-02-phase5-fingerprint-design.md)
  („Bewusst ausgeschlossen"), durch dieses Paket **nicht** aufgehoben. Der Beobachtungsmodus ist
  ein befristetes Validierungsinstrument vor einer Aktivierungsentscheidung, keine dauerhafte
  Korrekturmöglichkeit im laufenden Betrieb.
- Ein Fingerprint-Fehler darf den Dokumentenverarbeitungslauf nie abbrechen — bestehendes Muster
  (`try`/`catch` mit `console.warn('[WARNING] ...')`) in jeder neuen Fingerprint-Methode
  fortsetzen.
- Sprachkonvention: dieser Plan und `docs/audit/`-Updates sind Deutsch. Code-Kommentare folgen
  der bestehenden Sprache der jeweiligen Datei — `server.js`/`routes/setup.js`s
  Fingerprint-Block ist englisch kommentiert (AUDIT-010), `models/documentFingerprintStore.js`,
  `services/documentFingerprintService.js` und `services/documentProcessingPipeline.js` sind
  deutsch kommentiert.
- `server.js` und `routes/setup.js` enthalten (bekannte, in AUDIT-014 dokumentierte)
  Komplett-Duplikate von `buildUpdateData`. Task 1 vergrößert diese Duplikation nicht um eine
  weitere neu duplizierte Entscheidung — die NACHAUDIT-13-Anwendungslogik wandert in zwei
  gemeinsam genutzte, isoliert getestete Funktionen in
  `services/documentProcessingPipeline.js` (`applyFingerprintTags`/`applyFingerprintDocumentType`).
  Der verbleibende, unveränderte Rest von `buildUpdateData` bleibt dupliziert (out of scope für
  dieses Paket) — jede Änderung an einer der beiden Kopien muss trotzdem identisch an der
  anderen nachvollzogen werden, Task 1 macht das explizit für beide Dateien.

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `services/documentProcessingPipeline.js` | neue `applyFingerprintTags`/`applyFingerprintDocumentType`-Funktionen; neue `restoreOriginalData`-Methode; Modus-Gating in `findFingerprintMatch` | Modify (Task 1, Task 3, Task 4) |
| `test/fingerprintApplication.test.js` | Tests für `applyFingerprintTags`/`applyFingerprintDocumentType` | Add (Task 1) |
| `server.js` | `buildUpdateData`: nutzt die neuen Fingerprint-Funktionen | Modify (Task 1) |
| `routes/setup.js` | `buildUpdateData`-Duplikat: nutzt dieselben Funktionen; neue Route | Modify (Task 1, Task 3) |
| `services/paperlessService.js` | neue `overwriteDocumentFields`-Methode (Replace-PATCH) | Modify (Task 2) |
| `test/paperlessOverwriteDocumentFields.test.js` | Tests für `overwriteDocumentFields` | Add (Task 2) |
| `models/document.js` | `getOriginalData`: deterministische Sortierung | Modify (Task 3) |
| `test/documentProcessingPipeline.test.js` | Tests für `restoreOriginalData` und Beobachtungsmodus | Modify (Task 3, Task 4) |
| `test/setupAuthMiddleware.test.js` | neue Route in `PROTECTED_ROUTES` | Modify (Task 3) |
| `config/config.js` | `documentFingerprint.mode` | Modify (Task 4) |
| `test/configDocumentFingerprint.test.js` | Tests für `documentFingerprint.mode` | Modify (Task 4) |
| `services/documentFingerprintService.js` | `findMatch` liefert zusätzlich `similarity`/`matchedDocumentId` | Modify (Task 4) |
| `test/documentFingerprintService.test.js` | angepasste Assertions | Modify (Task 4) |
| `models/documentFingerprintStore.js` | neue Tabelle `document_fingerprint_observations`, `recordObservation`/`listObservations` | Modify (Task 4) |
| `test/documentFingerprintStore.test.js` | Tests für die neuen Store-Methoden | Modify (Task 4) |
| `scripts/fingerprint-observation-report.js` | Read-only Verteilungsreport der Beobachtungen (`buildReport`/`printReport` exportiert, testbar) | Add (Task 5) |
| `test/fingerprintObservationReport.test.js` | Tests für `buildReport` | Add (Task 5) |
| `.env.example`, `README.md` | Dokumentation `DOCUMENT_FINGERPRINT_MODE` | Modify (Task 6) |
| `data/.env` (nur auf Produktivinstanz) | `DOCUMENT_FINGERPRINT_ENABLED=yes`, `DOCUMENT_FINGERPRINT_MODE=observe`, später `FINGERPRINT_SIMILARITY_THRESHOLD` | Modify über Runbook (Task 7, Task 8), nie in diesem Checkout |
| `data/eval/fingerprint-pairs.json` (nur auf Produktivinstanz) | gelabelte Dokumentpaare für die Schwellwertmessung | Add über Runbook (Task 8) |
| `docs/audit/2026-08-04-nachaudit-offene-punkte.md` | Arbeitsplan-Checkbox, Ergebnis-Vermerk | Modify (Task 9) |

---

### Task 1: NACHAUDIT-13 — `usedFingerprint` nur setzen, wenn der Treffer tatsächlich übernommen wurde

**Files:**
- Modify: `services/documentProcessingPipeline.js` (zwei neue, exportierte Funktionen)
- Create: `test/fingerprintApplication.test.js`
- Modify: `server.js:248-350` (`buildUpdateData`) — nutzt die neuen Funktionen
- Modify: `routes/setup.js:1645-1747` (`buildUpdateData`-Duplikat) — nutzt dieselben Funktionen

**Interfaces:**
- Produziert: `applyFingerprintTags(fingerprintMatch, updateData) -> boolean` und
  `applyFingerprintDocumentType(fingerprintMatch, updateData) -> boolean`, beide exportiert aus
  `services/documentProcessingPipeline.js` neben `DocumentProcessingPipeline`/`getInstance`.
  Jede Funktion setzt das jeweilige Feld auf `updateData`, falls ein verwertbarer Treffer
  vorliegt, und gibt zurück, ob sie das getan hat. `buildUpdateData(...)` liefert weiterhin
  `{ updateData, usedFingerprint }`, aber `usedFingerprint` ist jetzt `true` nur, wenn eine der
  beiden Funktionen tatsächlich etwas gesetzt hat — nicht mehr allein daraus, dass ein Treffer
  existierte. `services/documentProcessingPipeline.js#processAndSave` konsumiert dieses Feld
  bereits unverändert (`usedFingerprint ? 'inherited' : 'llm'`).

**Warum eine gemeinsame Funktion statt zweimal duplizierter Logik:** `server.js` und
`routes/setup.js` haben bereits eine bekannte, in AUDIT-014 dokumentierte Komplett-Duplikation
von `buildUpdateData` — dieses Paket vergrößert sie nicht um eine weitere neu duplizierte
Entscheidung. Die Anwendungslogik (gibt es einen Treffer, ist er nicht leer, setze das Feld)
wandert in `services/documentProcessingPipeline.js`, wo bereits die gesamte übrige
Fingerprint-Logik lebt (`findFingerprintMatch`, `recordDocumentFingerprint`) — beide Aufrufer
binden nur noch dieselbe Funktion ein. Das macht die neue Logik zusätzlich erstmals isoliert
testbar (anders als der Rest von `buildUpdateData`, der reine, nicht test-isolierte Verdrahtung
bleibt — siehe [2026-08-02-phase5-fingerprint.md](../plans/2026-08-02-phase5-fingerprint.md),
Task 4).

- [ ] **Step 1: Write the failing tests**

Create `test/fingerprintApplication.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { applyFingerprintTags, applyFingerprintDocumentType } = require('../services/documentProcessingPipeline');

test('applyFingerprintTags setzt updateData.tags und liefert true, wenn der Treffer Tags hat', () => {
  const updateData = {};
  const result = applyFingerprintTags({ tagIds: [1, 2], documentTypeId: 3 }, updateData);

  assert.strictEqual(result, true);
  assert.deepStrictEqual(updateData.tags, [1, 2]);
});

test('applyFingerprintTags setzt nichts und liefert false, wenn kein Treffer vorliegt', () => {
  const updateData = {};
  const result = applyFingerprintTags(null, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.tags, undefined);
});

test('applyFingerprintTags setzt nichts und liefert false, wenn der Treffer keine Tags hat (NACHAUDIT-13)', () => {
  const updateData = {};
  const result = applyFingerprintTags({ tagIds: [], documentTypeId: 3 }, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.tags, undefined);
});

test('applyFingerprintDocumentType setzt updateData.document_type und liefert true, wenn der Treffer eine Dokumentart hat', () => {
  const updateData = {};
  const result = applyFingerprintDocumentType({ tagIds: [1], documentTypeId: 3 }, updateData);

  assert.strictEqual(result, true);
  assert.strictEqual(updateData.document_type, 3);
});

test('applyFingerprintDocumentType setzt nichts und liefert false, wenn kein Treffer vorliegt', () => {
  const updateData = {};
  const result = applyFingerprintDocumentType(null, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.document_type, undefined);
});

test('applyFingerprintDocumentType setzt nichts und liefert false, wenn der Treffer keine Dokumentart hat (NACHAUDIT-13)', () => {
  const updateData = {};
  const result = applyFingerprintDocumentType({ tagIds: [1], documentTypeId: null }, updateData);

  assert.strictEqual(result, false);
  assert.strictEqual(updateData.document_type, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/fingerprintApplication.test.js`
Expected: FAIL — `applyFingerprintTags is not a function` (noch nicht aus
`services/documentProcessingPipeline.js` exportiert)

- [ ] **Step 3: `services/documentProcessingPipeline.js` implementieren**

Vor `let instance = null;` (aktuell die Zeile direkt nach dem Ende der Klasse
`DocumentProcessingPipeline`) einfügen:

```js
// NACHAUDIT-13: gemeinsame Anwendungslogik fuer server.js/routes/setup.js#buildUpdateData -
// beide Dateien duplizieren buildUpdateData bereits vollstaendig (AUDIT-014); diese zwei
// Funktionen verhindern, dass die Entscheidung "wurde der Fingerprint-Treffer tatsaechlich
// uebernommen" ein zweites Mal dupliziert wird, und machen sie isoliert testbar. Ein Treffer,
// der wegen activateTagging='no'/activateDocumentType='no' NIE hier ankommt, oder dessen
// tagIds/documentTypeId leer sind, darf nicht als angewendet gelten - sonst wird er trotzdem
// als 'inherited' gespeichert und faellt faelschlich als Kandidat fuer ein drittes Dokument
// weg (source='inherited' wird von findCandidates() ausgeschlossen, siehe
// models/documentFingerprintStore.js), obwohl er in Paperless nie etwas bewirkt hat.
function applyFingerprintTags(fingerprintMatch, updateData) {
  if (fingerprintMatch && fingerprintMatch.tagIds.length > 0) {
    updateData.tags = fingerprintMatch.tagIds;
    return true;
  }
  return false;
}

function applyFingerprintDocumentType(fingerprintMatch, updateData) {
  if (fingerprintMatch && fingerprintMatch.documentTypeId) {
    updateData.document_type = fingerprintMatch.documentTypeId;
    return true;
  }
  return false;
}

```

Am Ende der Datei, ersetze:

```js
module.exports = { DocumentProcessingPipeline, getInstance };
```

durch:

```js
module.exports = { DocumentProcessingPipeline, getInstance, applyFingerprintTags, applyFingerprintDocumentType };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/fingerprintApplication.test.js`
Expected: PASS, 6/6 tests green

- [ ] **Step 5: `server.js` auf die neuen Funktionen umstellen**

In `server.js`, der Require-Block für `documentProcessingPipeline` (die Zeile, die aktuell
`getDocumentProcessingPipeline` importiert — analog zu `routes/setup.js:25`) wird erweitert, um
zusätzlich `applyFingerprintTags`/`applyFingerprintDocumentType` zu destrukturieren.

Ersetze (aktuell Zeilen 248-350):

```js
  const correspondentId = existingCorrespondentId || updateData.correspondent;
  const fingerprintMatch = await getDocumentProcessingPipeline().findFingerprintMatch(correspondentId, content);

  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    if (fingerprintMatch && fingerprintMatch.tagIds.length > 0) {
      // AUDIT-010: a fingerprint hit reuses the matched document's tags outright - running
      // processTags here would create new tag entities in Paperless that are immediately
      // discarded, leaving them orphaned and never attached to any document.
      updateData.tags = fingerprintMatch.tagIds;
    } else {
```

durch:

```js
  const correspondentId = existingCorrespondentId || updateData.correspondent;
  const fingerprintMatch = await getDocumentProcessingPipeline().findFingerprintMatch(correspondentId, content);
  let fingerprintApplied = false;

  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    if (applyFingerprintTags(fingerprintMatch, updateData)) {
      // AUDIT-010: a fingerprint hit reuses the matched document's tags outright - running
      // processTags here would create new tag entities in Paperless that are immediately
      // discarded, leaving them orphaned and never attached to any document.
      fingerprintApplied = true;
    } else {
```

Weiter unten, ersetze:

```js
  if (config.limitFunctions?.activateDocumentType !== 'no') {
    if (fingerprintMatch && fingerprintMatch.documentTypeId) {
      updateData.document_type = fingerprintMatch.documentTypeId;
    } else if (analysis.document.document_type) {
```

durch:

```js
  if (config.limitFunctions?.activateDocumentType !== 'no') {
    if (applyFingerprintDocumentType(fingerprintMatch, updateData)) {
      fingerprintApplied = true;
    } else if (analysis.document.document_type) {
```

Und am Ende der Funktion, ersetze:

```js
  return { updateData, usedFingerprint: !!fingerprintMatch };
```

durch:

```js
  return { updateData, usedFingerprint: fingerprintApplied };
```

Am Kopf von `server.js`, wo `getDocumentProcessingPipeline` importiert wird (Suche nach
`require('./services/documentProcessingPipeline')` bzw. `require('../services/documentProcessingPipeline')`
— exakter Pfad hängt davon ab, ob relativ zu `server.js` oder einem Unterordner importiert wird),
die Destrukturierung um die beiden neuen Funktionen erweitern, z. B. von

```js
const { getInstance: getDocumentProcessingPipeline } = require('./services/documentProcessingPipeline');
```

zu:

```js
const { getInstance: getDocumentProcessingPipeline, applyFingerprintTags, applyFingerprintDocumentType } = require('./services/documentProcessingPipeline');
```

- [ ] **Step 6: identische Umstellung in `routes/setup.js`**

Vor der Änderung: `git diff` zwischen den beiden `buildUpdateData`-Funktionen prüfen (z. B.
`diff <(sed -n '224,351p' server.js) <(sed -n '1620,1748p' routes/setup.js)`), um zu bestätigen,
dass die Struktur an den betroffenen Stellen identisch ist, bevor blind gespiegelt wird.

In `routes/setup.js`, Zeile 25 (`const { getInstance: getDocumentProcessingPipeline } = require('../services/documentProcessingPipeline');`)
erweitern zu:

```js
const { getInstance: getDocumentProcessingPipeline, applyFingerprintTags, applyFingerprintDocumentType } = require('../services/documentProcessingPipeline');
```

Dieselbe Transformation wie Step 5 an der strukturell identischen Stelle (aktuell Zeilen
1645-1747):

```js
  const correspondentId = existingCorrespondentId || updateData.correspondent;
  const fingerprintMatch = await getDocumentProcessingPipeline().findFingerprintMatch(correspondentId, content);
  let fingerprintApplied = false;

  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    if (applyFingerprintTags(fingerprintMatch, updateData)) {
      // AUDIT-010: a fingerprint hit reuses the matched document's tags outright - running
      // processTags here would create new tag entities in Paperless that are immediately
      // discarded, leaving them orphaned and never attached to any document.
      fingerprintApplied = true;
    } else {
```

```js
  if (config.limitFunctions?.activateDocumentType !== 'no') {
    if (applyFingerprintDocumentType(fingerprintMatch, updateData)) {
      fingerprintApplied = true;
    } else if (analysis.document.document_type) {
```

```js
  return { updateData, usedFingerprint: fingerprintApplied };
```

- [ ] **Step 7: manuelle Sichtprüfung**

`git diff server.js routes/setup.js` ansehen: beide Dateien müssen an den betroffenen Stellen
(Require-Zeile, Deklaration, Tag-Zweig, Dokumenttyp-Zweig, Return) identisch geändert sein. Kein
anderer Teil der beiden `buildUpdateData`-Funktionen darf sich geändert haben.

- [ ] **Step 8: vollständigen Regressionslauf ausführen**

Run: `npm test`
Expected: alle Tests grün, inklusive der 6 neuen aus Step 1 (`test/documentProcessingPipeline.test.js`
deckt bereits ab, dass `usedFingerprint: true` zu `source: 'inherited'` führt — diese
Verdrahtung bleibt durch diese Änderung unberührt).

- [ ] **Step 9: Commit**

```bash
git add services/documentProcessingPipeline.js test/fingerprintApplication.test.js server.js routes/setup.js
git commit -m "$(cat <<'EOF'
fix: usedFingerprint nur bei tatsaechlich angewendetem Fingerprint-Treffer setzen

NACHAUDIT-13: bei activateTagging='no'/activateDocumentType='no' wurde ein
gefundener, aber nie in updateData uebernommener Fingerprint-Treffer trotzdem
als 'inherited' gespeichert und schied dadurch faelschlich als Kandidat fuer
ein drittes Dokument aus. Die Anwendungsentscheidung steckt jetzt in den neuen,
isoliert getesteten Funktionen applyFingerprintTags/applyFingerprintDocumentType
(services/documentProcessingPipeline.js), die server.js und routes/setup.js
gemeinsam nutzen, statt die Logik ein weiteres Mal zu duplizieren (AUDIT-014).
usedFingerprint spiegelt jetzt, ob eine der beiden Funktionen tatsaechlich
Tags/Dokumentart gesetzt hat.

Nachaudit 2026-08-04, Paket 4 (NACHAUDIT-13).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `paperlessService.overwriteDocumentFields` — Replace-semantischer PATCH

**Files:**
- Modify: `services/paperlessService.js` (neue Methode, nach `removeUnusedTagsFromDocument`,
  aktuell endend bei Zeile 1373)
- Create: `test/paperlessOverwriteDocumentFields.test.js`

**Interfaces:**
- Konsumiert: `this.client` (axios-Instanz, wie im gesamten Modul), `this.initialize()`,
  `this.getDocument(documentId)` (existierend).
- Produziert: `async overwriteDocumentFields(documentId, { title, tags, correspondent }) ->
  Promise<object|undefined>`. Task 3 konsumiert exakt diese Signatur.

**Warum eine neue Methode statt der bestehenden `updateDocument`:** `updateDocument` (Zeile
1613) vereinigt `updates.tags` mit den aktuell vorhandenen Tags (`combinedTags = [...new
Set([...currentDoc.tags, ...updates.tags])]`) und verwirft `updates.correspondent`, wenn das
Dokument bereits einen Korrespondenten hat. Beides ist für die normale KI-Klassifikation
richtig (nie etwas wegnehmen, was schon da ist), aber für eine Rückabwicklung falsch — ein
Restore muss auf den exakten historischen Zustand zurücksetzen können, auch wenn das bedeutet,
seither hinzugefügte Tags/einen seither gesetzten Korrespondenten zu entfernen.
`removeUnusedTagsFromDocument` (Zeile 1341) zeigt bereits das richtige Muster: direkter
`this.client.patch(...)` mit exakten Werten, keine Union-Logik.

- [ ] **Step 1: Write the failing tests**

Create `test/paperlessOverwriteDocumentFields.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

function withMockClient(mockClient, fn) {
  const original = paperlessService.client;
  paperlessService.client = mockClient;
  return fn().finally(() => { paperlessService.client = original; });
}

test('overwriteDocumentFields schickt title/tags/correspondent unveraendert als PATCH-Body, ohne mit dem aktuellen Dokument zu vereinigen', async () => {
  const patchCalls = [];
  const mockClient = {
    patch: async (url, body) => { patchCalls.push({ url, body }); return { data: {} }; },
    get: async () => ({ data: { id: 42, title: 'Original', tags: [1], correspondent: 5 } })
  };

  await withMockClient(mockClient, () =>
    paperlessService.overwriteDocumentFields(42, { title: 'Original', tags: [1], correspondent: 5 })
  );

  assert.strictEqual(patchCalls.length, 1);
  assert.strictEqual(patchCalls[0].url, '/documents/42/');
  assert.deepStrictEqual(patchCalls[0].body, { title: 'Original', tags: [1], correspondent: 5 });
});

test('overwriteDocumentFields kann Tags/Korrespondent gegenueber dem aktuellen Stand entfernen (Replace- statt Union-Semantik)', async () => {
  const patchCalls = [];
  const mockClient = {
    patch: async (url, body) => { patchCalls.push({ url, body }); return { data: {} }; },
    // Aktuelles Dokument hat mehr Tags und einen Korrespondenten als der Zielzustand -
    // eine Union-Logik (wie updateDocument()) wuerde das Tag 99/den Korrespondenten 7 behalten.
    get: async () => ({ data: { id: 42, title: 'Geaendert', tags: [1, 99], correspondent: 7 } })
  };

  await withMockClient(mockClient, () =>
    paperlessService.overwriteDocumentFields(42, { title: 'Original', tags: [1], correspondent: null })
  );

  assert.deepStrictEqual(patchCalls[0].body, { title: 'Original', tags: [1], correspondent: null });
});

test('overwriteDocumentFields gibt das aktualisierte Dokument zurueck', async () => {
  const mockClient = {
    patch: async () => ({ data: {} }),
    get: async () => ({ data: { id: 42, title: 'Original', tags: [1], correspondent: 5 } })
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.overwriteDocumentFields(42, { title: 'Original', tags: [1], correspondent: 5 })
  );

  assert.deepStrictEqual(result, { id: 42, title: 'Original', tags: [1], correspondent: 5 });
});

test('overwriteDocumentFields wirft weiter, wenn der PATCH fehlschlaegt (kein stilles Verschlucken)', async () => {
  const mockClient = {
    patch: async () => { throw new Error('Network error'); },
    get: async () => ({ data: {} })
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.overwriteDocumentFields(42, { title: 'T', tags: [], correspondent: null })),
    /Network error/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/paperlessOverwriteDocumentFields.test.js`
Expected: FAIL — `TypeError: paperlessService.overwriteDocumentFields is not a function`

- [ ] **Step 3: Write the implementation**

In `services/paperlessService.js`, direkt nach dem Ende von `removeUnusedTagsFromDocument`
(nach der schließenden `}` in Zeile 1373, vor `async _entityExists(type, id) {`), einfügen:

```js
  // NACHAUDIT-12: replace- statt union-semantischer PATCH. updateDocument() vereinigt
  // updates.tags mit den bereits vorhandenen Tags und verwirft updates.correspondent, wenn das
  // Dokument schon einen hat (richtig fuer die normale KI-Klassifikation, die nichts wegnehmen
  // soll). Eine Rueckabwicklung auf einen frueheren Zustand muss dagegen auch Tags/einen
  // Korrespondenten entfernen koennen, die seit der gespeicherten Momentaufnahme hinzukamen -
  // sonst waere "restore" nur ein Teil-Merge, kein echtes Zuruecksetzen.
  async overwriteDocumentFields(documentId, { title, tags, correspondent }) {
    this.initialize();
    if (!this.client) return;
    try {
      const updateData = { title, tags, correspondent };
      await this.client.patch(`/documents/${documentId}/`, updateData);
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(`[ERROR] paperlessService.overwriteDocumentFields: Wiederherstellung fuer Dokument ${documentId} fehlgeschlagen:`, error.message);
      throw error;
    }
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/paperlessOverwriteDocumentFields.test.js`
Expected: PASS, 4/4 tests green

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: alle Tests grün, keine Regression (die neue Methode wird von keinem bestehenden
Codepfad aufgerufen).

- [ ] **Step 6: Commit**

```bash
git add services/paperlessService.js test/paperlessOverwriteDocumentFields.test.js
git commit -m "$(cat <<'EOF'
feat: add paperlessService.overwriteDocumentFields fuer Replace-semantische Updates

Baustein fuer NACHAUDIT-12 (Rueckabwicklungspfad): anders als updateDocument()
(Union-Semantik bei Tags, verwirft correspondent bei bereits gesetztem Wert)
schreibt diese Methode title/tags/correspondent exakt wie uebergeben - noetig,
um ein Dokument auf einen frueheren, in original_documents gespeicherten
Zustand zurueckzusetzen.

Nachaudit 2026-08-04, Paket 4 (NACHAUDIT-12, Baustein 1/2).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `restoreOriginalData` — Rückabwicklungspfad (NACHAUDIT-12)

**Files:**
- Modify: `models/document.js:279-297` (`getOriginalData`)
- Modify: `services/documentProcessingPipeline.js` (neue Methode)
- Modify: `test/documentProcessingPipeline.test.js` (neue Tests)
- Modify: `routes/setup.js` (neue Route, nach `/api/history` in Zeile 1272)
- Modify: `test/setupAuthMiddleware.test.js` (`PROTECTED_ROUTES`)

**Interfaces:**
- Konsumiert: `documentModel.getOriginalData(id)` (bestehend, wird in diesem Task deterministisch
  gemacht), `paperlessService.overwriteDocumentFields` (Task 2).
- Produziert: `documentProcessingPipeline.restoreOriginalData(documentId) ->
  Promise<{restored: boolean, reason?: string, original?: {title, tags, correspondent}}>`.
  Route `POST /api/documents/:id/restore-original` konsumiert exakt diese Rückgabe.

**Hintergrund `getOriginalData`:** `original_documents` hat **keine** Unique-Constraint auf
`document_id` — jede Verarbeitung desselben Dokuments fügt eine neue Zeile ein (siehe
`saveOriginalData`, Zeile 223). `getOriginalData(id)` hat aktuell kein `ORDER BY` und verlässt
sich auf das implizite (in SQLite bei einem einfachen Tabellen-Scan typischerweise mit der
Einfügereihenfolge übereinstimmende, aber nicht dokumentgarantierte) Scan-Verhalten. Für eine
Wiederherstellung, die das **allererste** bekannte Original (vor jeder KI-Verarbeitung, nicht
nur vor dem letzten Lauf) zurückschreiben soll, wird das hier explizit gemacht.
`getOriginalData` hat aktuell **keinen einzigen Aufrufer** im Code (geprüft per
`grep -rn "getOriginalData("` — nur die Definition selbst) — die Änderung hat daher kein
Regressionsrisiko für bestehendes Verhalten.

- [ ] **Step 1: `getOriginalData` deterministisch machen**

In `models/document.js`, Zeile 284, ersetze:

```js
        return db.prepare('SELECT * FROM original_documents WHERE document_id = ?').get(id);
```

durch:

```js
        // NACHAUDIT-12: explizite Sortierung statt impliziter Scan-Reihenfolge - original_documents
        // hat keine UNIQUE-Constraint auf document_id (jede erneute Verarbeitung fuegt eine neue
        // Zeile ein), und eine Wiederherstellung muss deterministisch den AELTESTEN bekannten
        // Zustand treffen (vor jeder KI-Verarbeitung), nicht irgendeinen.
        return db.prepare('SELECT * FROM original_documents WHERE document_id = ? ORDER BY id ASC LIMIT 1').get(id);
```

- [ ] **Step 2: Write the failing tests für `restoreOriginalData`**

In `test/documentProcessingPipeline.test.js`, am Ende der Datei (nach dem letzten bestehenden
Test) einfügen:

```js
test('restoreOriginalData liefert restored:false, wenn kein Original gespeichert ist', async () => {
  const pipeline = makePipeline({
    documentModel: { getOriginalData: async () => undefined }
  });

  const result = await pipeline.restoreOriginalData(42);

  assert.deepStrictEqual(result, { restored: false, reason: 'no_original_data' });
});

test('restoreOriginalData schreibt den gespeicherten Originalzustand ueber overwriteDocumentFields zurueck', async () => {
  const overwriteCalls = [];
  const pipeline = makePipeline({
    documentModel: {
      getOriginalData: async () => ({ document_id: 42, title: 'Alter Titel', tags: '[1,2]', correspondent: '5' })
    },
    paperlessService: {
      overwriteDocumentFields: async (documentId, fields) => { overwriteCalls.push({ documentId, fields }); return {}; }
    }
  });

  const result = await pipeline.restoreOriginalData(42);

  assert.strictEqual(overwriteCalls.length, 1);
  assert.strictEqual(overwriteCalls[0].documentId, 42);
  assert.deepStrictEqual(overwriteCalls[0].fields, { title: 'Alter Titel', tags: [1, 2], correspondent: 5 });
  assert.deepStrictEqual(result, { restored: true, original: { title: 'Alter Titel', tags: [1, 2], correspondent: 5 } });
});

test('restoreOriginalData behandelt einen null-Korrespondenten korrekt (nicht als 0 oder NaN)', async () => {
  const overwriteCalls = [];
  const pipeline = makePipeline({
    documentModel: {
      getOriginalData: async () => ({ document_id: 42, title: 'Titel', tags: '[]', correspondent: null })
    },
    paperlessService: {
      overwriteDocumentFields: async (documentId, fields) => { overwriteCalls.push({ documentId, fields }); return {}; }
    }
  });

  await pipeline.restoreOriginalData(42);

  assert.strictEqual(overwriteCalls[0].fields.correspondent, null);
  assert.deepStrictEqual(overwriteCalls[0].fields.tags, []);
});

test('restoreOriginalData wirft weiter, wenn overwriteDocumentFields fehlschlaegt', async () => {
  const pipeline = makePipeline({
    documentModel: {
      getOriginalData: async () => ({ document_id: 42, title: 'Titel', tags: '[1]', correspondent: '5' })
    },
    paperlessService: {
      overwriteDocumentFields: async () => { throw new Error('PATCH fehlgeschlagen'); }
    }
  });

  await assert.rejects(() => pipeline.restoreOriginalData(42), /PATCH fehlgeschlagen/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx node --test test/documentProcessingPipeline.test.js`
Expected: FAIL — `TypeError: pipeline.restoreOriginalData is not a function`

- [ ] **Step 4: Write the implementation**

In `services/documentProcessingPipeline.js`, in der Klasse `DocumentProcessingPipeline`, nach
`pruneOrphanedFingerprints` und vor `saveDocumentChanges` einfügen:

```js
  // NACHAUDIT-12 (Audit Abschnitt 18.6, Bedingung 6): original_documents speichert bereits den
  // Vorzustand (Tags, Korrespondent, Titel) vor jeder KI-Aenderung, aber es gab bisher keine
  // Funktion, die daraus wiederherstellt. Nutzt overwriteDocumentFields (Replace-Semantik) statt
  // saveDocumentChanges/updateDocument - eine Wiederherstellung muss auch seither hinzugekommene
  // Tags/einen seither gesetzten Korrespondenten entfernen koennen, nicht nur ergaenzen.
  async restoreOriginalData(documentId) {
    const original = await this.documentModel.getOriginalData(documentId);
    if (!original) {
      return { restored: false, reason: 'no_original_data' };
    }

    const restoredFields = {
      title: original.title,
      tags: JSON.parse(original.tags || '[]'),
      correspondent: original.correspondent ? Number(original.correspondent) : null
    };

    await this.paperlessService.overwriteDocumentFields(documentId, restoredFields);

    return { restored: true, original: restoredFields };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx node --test test/documentProcessingPipeline.test.js`
Expected: PASS, alle Tests inklusive der 4 neuen grün

- [ ] **Step 6: Route hinzufügen**

In `routes/setup.js`, direkt nach dem Ende des `/api/history`-Handlers (nach der schließenden
`});` in Zeile 1272, vor dem `/api/reset-all-documents`-Swagger-Block), einfügen:

```js
router.post('/api/documents/:id/restore-original', async (req, res) => {
  const documentId = parseInt(req.params.id, 10);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return res.status(400).json({ error: 'Invalid document id' });
  }
  try {
    const result = await getDocumentProcessingPipeline().restoreOriginalData(documentId);
    if (!result.restored) {
      return res.status(404).json({ error: 'No original data recorded for this document' });
    }
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] restoring original data for document ${documentId}:`, error);
    res.status(500).json({ error: 'Restore failed' });
  }
});

```

Kein zusätzliches Auth-Wiring nötig — der globale Gate in `routes/setup.js:160`
(`router.use(...)`, siehe NACHAUDIT-01) schützt jede nicht in `PUBLIC_ROUTES` gelistete Route
automatisch, `/api/documents/:id/restore-original` steht dort nicht.

- [ ] **Step 7: Regressionstest für den Auth-Gate ergänzen**

In `test/setupAuthMiddleware.test.js`, `PROTECTED_ROUTES` (Zeile 69-82) erweitern:

```js
const PROTECTED_ROUTES = [
  ['GET', '/settings'],
  ['POST', '/settings'],
  ['POST', '/manual/updateDocument'],
  ['POST', '/api/reset-all-documents'],
  ['POST', '/api/reset-documents'],
  ['POST', '/api/scan/now'],
  ['POST', '/api/webhook/document'],
  ['POST', '/api/documents/42/restore-original'],
  ['GET', '/dashboard'],
  ['GET', '/playground'],
  ['GET', '/history'],
  ['GET', '/manual'],
  ['GET', '/debug'],
];
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx node --test test/setupAuthMiddleware.test.js`
Expected: PASS, inklusive des neuen `POST /api/documents/42/restore-original`-Falls (302 Redirect
zu `/login` ohne Token)

- [ ] **Step 9: Run the full suite to check for regressions**

Run: `npm test`
Expected: alle Tests grün.

- [ ] **Step 10: Commit**

```bash
git add models/document.js services/documentProcessingPipeline.js test/documentProcessingPipeline.test.js routes/setup.js test/setupAuthMiddleware.test.js
git commit -m "$(cat <<'EOF'
feat: restoreOriginalData - Rueckabwicklungspfad fuer geschriebene Dokumente

NACHAUDIT-12 (Audit Abschnitt 18.6, Bedingung 6): original_documents
speicherte bereits den Vorzustand vor jeder KI-Aenderung, aber es gab keine
Funktion, die daraus wiederherstellt. Neue Route
POST /api/documents/:id/restore-original (authentifiziert ueber den
bestehenden globalen Gate in routes/setup.js) schreibt Titel/Tags/
Korrespondent per Replace-semantischem PATCH (overwriteDocumentFields)
zurueck. getOriginalData() sortiert jetzt explizit nach der aeltesten
gespeicherten Zeile statt sich auf implizite Scan-Reihenfolge zu verlassen.

Nachaudit 2026-08-04, Paket 4 (NACHAUDIT-12, Baustein 2/2).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Beobachtungsmodus-Infrastruktur (NACHAUDIT-11, Bedingung 5)

**Files:**
- Modify: `config/config.js` (`documentFingerprint.mode`)
- Modify: `test/configDocumentFingerprint.test.js`
- Modify: `services/documentFingerprintService.js` (`findMatch` liefert `similarity`/`matchedDocumentId`)
- Modify: `test/documentFingerprintService.test.js`
- Modify: `models/documentFingerprintStore.js` (neue Tabelle, `recordObservation`/`listObservations`)
- Modify: `test/documentFingerprintStore.test.js`
- Modify: `services/documentProcessingPipeline.js` (`findFingerprintMatch` gated auf `mode`)
- Modify: `test/documentProcessingPipeline.test.js`

**Interfaces:**
- Produziert: `config.documentFingerprint.mode` (`'observe'` | `'apply'`, Default `'observe'`).
  `documentFingerprintService.findMatch(correspondentId, content) ->
  Promise<{tagIds, documentTypeId, similarity, matchedDocumentId} | null>` (erweitert um zwei
  Felder). `documentFingerprintStore.recordObservation({correspondentId, matchedDocumentId,
  similarity, tagIds, documentTypeId}) -> boolean`, `listObservations({limit}) -> Array<row>`.
  Task 5 konsumiert `listObservations`.

- [ ] **Step 1: Write the failing config tests**

In `test/configDocumentFingerprint.test.js`, nach dem letzten bestehenden Test einfügen:

```js
test('documentFingerprint.mode ist standardmaessig "observe" (NACHAUDIT-11: sicherer Default)', () => {
  const saved = process.env.DOCUMENT_FINGERPRINT_MODE;
  try {
    delete process.env.DOCUMENT_FINGERPRINT_MODE;
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.documentFingerprint.mode, 'observe');
  } finally {
    if (saved === undefined) delete process.env.DOCUMENT_FINGERPRINT_MODE;
    else process.env.DOCUMENT_FINGERPRINT_MODE = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('DOCUMENT_FINGERPRINT_MODE=apply wird uebernommen', () => {
  const saved = process.env.DOCUMENT_FINGERPRINT_MODE;
  try {
    process.env.DOCUMENT_FINGERPRINT_MODE = 'apply';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.documentFingerprint.mode, 'apply');
  } finally {
    if (saved === undefined) delete process.env.DOCUMENT_FINGERPRINT_MODE;
    else process.env.DOCUMENT_FINGERPRINT_MODE = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('ein unbekannter DOCUMENT_FINGERPRINT_MODE-Wert faellt auf "observe" zurueck', () => {
  const saved = process.env.DOCUMENT_FINGERPRINT_MODE;
  try {
    process.env.DOCUMENT_FINGERPRINT_MODE = 'apply_all_the_things';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.documentFingerprint.mode, 'observe');
  } finally {
    if (saved === undefined) delete process.env.DOCUMENT_FINGERPRINT_MODE;
    else process.env.DOCUMENT_FINGERPRINT_MODE = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/configDocumentFingerprint.test.js`
Expected: FAIL — `AssertionError` (`config.documentFingerprint.mode` ist `undefined`)

- [ ] **Step 3: `config/config.js` implementieren**

In `config/config.js`, im `documentFingerprint`-Block (Zeile 207-210), ersetze:

```js
  documentFingerprint: {
    enabled: parseEnvBoolean(process.env.DOCUMENT_FINGERPRINT_ENABLED, 'no') === 'yes',
    similarityThreshold: documentFingerprintSimilarityThreshold
  },
```

durch:

```js
  documentFingerprint: {
    enabled: parseEnvBoolean(process.env.DOCUMENT_FINGERPRINT_ENABLED, 'no') === 'yes',
    // NACHAUDIT-11 (Audit Abschnitt 18.6, Bedingung 5): 'observe' ist bewusst der Default, nicht
    // 'apply' - ein DOCUMENT_FINGERPRINT_ENABLED=yes ohne weitere Konfiguration protokolliert
    // Treffer nur, statt sie live auf Tags/Dokumentart anzuwenden. Ein unbekannter Wert (Tippfehler)
    // faellt auf den sicheren Default zurueck statt den Rest der Konfiguration zu verwerfen.
    mode: ['observe', 'apply'].includes(process.env.DOCUMENT_FINGERPRINT_MODE) ? process.env.DOCUMENT_FINGERPRINT_MODE : 'observe',
    similarityThreshold: documentFingerprintSimilarityThreshold
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/configDocumentFingerprint.test.js`
Expected: PASS, 6/6 tests green (3 bestehende + 3 neue)

- [ ] **Step 5: Write the failing tests für `documentFingerprintService.findMatch`**

In `test/documentFingerprintService.test.js`, ersetze die fünf bestehenden `assert.deepStrictEqual`-Zeilen,
die einen Treffer erwarten, wie folgt (Werte anhand der jeweiligen Testdaten der Datei
berechnet):

Zeile 46 (`'findMatch: Kandidat ueber Schwelle...'`):
```js
  assert.deepStrictEqual(result, { tagIds: [1, 2], documentTypeId: 3, similarity: 1, matchedDocumentId: 101 });
```

Zeile 69 (`'findMatch: mehrere Kandidaten, aehnlichster gewinnt'`):
```js
  assert.deepStrictEqual(result, { tagIds: [2], documentTypeId: 2, similarity: 1, matchedDocumentId: 2 });
```

Zeile 96 (`'findMatch: Text wird vor dem Embedding-Call auf 3000 Zeichen gekuerzt'`):
```js
  assert.deepStrictEqual(result, { tagIds: [1], documentTypeId: 3, similarity: 1, matchedDocumentId: 101 });
```

Zeile 172 (`'findMatch gefolgt von recordFingerprint...'`):
```js
  assert.deepStrictEqual(match, { tagIds: [1, 2], documentTypeId: 3, similarity: 1, matchedDocumentId: 101 });
```

Zeile 200 (`'Memo-Cache ist an den Inhalt gebunden...'`):
```js
  assert.deepStrictEqual(matchA, { tagIds: [1, 2], documentTypeId: 3, similarity: 1, matchedDocumentId: 101 });
```

(Alle fünf Fälle haben identische Vektoren zwischen Content und gewinnendem Kandidaten,
Cosine-Similarity ist also exakt `1`.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx node --test test/documentFingerprintService.test.js`
Expected: FAIL — die fünf angepassten `deepStrictEqual`-Assertions schlagen fehl, weil
`similarity`/`matchedDocumentId` im tatsächlichen Rückgabewert noch fehlen.

- [ ] **Step 7: `documentFingerprintService.js` implementieren**

In `services/documentFingerprintService.js`, in `findMatch`, ersetze:

```js
    if (!best || best.similarity < this.similarityThreshold) {
      return null;
    }

    console.log(`[INFO] documentFingerprintService: Treffer fuer correspondent=${correspondentId}, similarity=${best.similarity.toFixed(3)}, document_id=${best.candidate.documentId}`);
    return { tagIds: best.candidate.tagIds, documentTypeId: best.candidate.documentTypeId };
```

durch:

```js
    if (!best || best.similarity < this.similarityThreshold) {
      return null;
    }

    console.log(`[INFO] documentFingerprintService: Treffer fuer correspondent=${correspondentId}, similarity=${best.similarity.toFixed(3)}, document_id=${best.candidate.documentId}`);
    // NACHAUDIT-11: similarity/matchedDocumentId werden durchgereicht, damit der Aufrufer
    // (documentProcessingPipeline.findFingerprintMatch) im Beobachtungsmodus protokollieren kann,
    // WAS angewendet worden waere, nicht nur DASS ein Treffer existierte.
    return {
      tagIds: best.candidate.tagIds,
      documentTypeId: best.candidate.documentTypeId,
      similarity: best.similarity,
      matchedDocumentId: best.candidate.documentId
    };
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx node --test test/documentFingerprintService.test.js`
Expected: PASS, alle Tests grün

- [ ] **Step 9: Write the failing tests für die Beobachtungstabelle**

In `test/documentFingerprintStore.test.js`, am Ende der Datei einfügen:

```js
test('recordObservation speichert eine Beobachtung, listObservations liefert sie zurueck', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    const ok = store.recordObservation({
      correspondentId: 5, matchedDocumentId: 101, similarity: 0.93,
      tagIds: [1, 2], documentTypeId: 3
    });
    assert.strictEqual(ok, true);

    const observations = store.listObservations();
    assert.strictEqual(observations.length, 1);
    assert.strictEqual(observations[0].correspondent_id, 5);
    assert.strictEqual(observations[0].matched_document_id, 101);
    assert.strictEqual(observations[0].similarity, 0.93);
    assert.deepStrictEqual(JSON.parse(observations[0].tag_ids), [1, 2]);
    assert.strictEqual(observations[0].document_type_id, 3);
  } finally {
    store.close();
  }
});

test('recordObservation akzeptiert documentTypeId=null', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.recordObservation({
      correspondentId: 5, matchedDocumentId: 101, similarity: 0.93,
      tagIds: [1], documentTypeId: null
    });
    const observations = store.listObservations();
    assert.strictEqual(observations[0].document_type_id, null);
  } finally {
    store.close();
  }
});

test('listObservations liefert die neuesten zuerst, begrenzt auf limit', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    for (let i = 1; i <= 5; i++) {
      store.recordObservation({ correspondentId: 5, matchedDocumentId: i, similarity: 0.9, tagIds: [1], documentTypeId: null });
    }
    const observations = store.listObservations({ limit: 2 });
    assert.strictEqual(observations.length, 2);
    assert.strictEqual(observations[0].matched_document_id, 5);
    assert.strictEqual(observations[1].matched_document_id, 4);
  } finally {
    store.close();
  }
});

test('listObservations liefert leeres Array ohne gespeicherte Beobachtungen', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    assert.deepStrictEqual(store.listObservations(), []);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `npx node --test test/documentFingerprintStore.test.js`
Expected: FAIL — `TypeError: store.recordObservation is not a function`

- [ ] **Step 11: `documentFingerprintStore.js` implementieren**

In `models/documentFingerprintStore.js`, in `_createTables()`, nach dem bestehenden
`document_fingerprints`-Index (nach Zeile 45, vor den `_ensureColumn`-Aufrufen) einfügen:

```js

    // NACHAUDIT-11 (Audit Abschnitt 18.6, Bedingung 5): Beobachtungsmodus - protokolliert einen
    // Treffer, der im Modus 'observe' NICHT auf updateData angewendet wurde, damit die
    // Trefferqualitaet vor einer Aktivierungsentscheidung stichprobenartig geprueft werden kann.
    // Eigene Tabelle statt Wiederverwendung von document_fingerprints: eine Beobachtung ist kein
    // gespeicherter Fingerprint-Kandidat und darf nicht in findCandidates() auftauchen.
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS document_fingerprint_observations (
        id INTEGER PRIMARY KEY,
        correspondent_id INTEGER NOT NULL,
        matched_document_id INTEGER NOT NULL,
        similarity REAL NOT NULL,
        tag_ids TEXT NOT NULL,
        document_type_id INTEGER,
        created_at TEXT NOT NULL
      )
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_document_fingerprint_observations_created_at
      ON document_fingerprint_observations(created_at)
    `).run();
```

Nach der Methode `pruneOrphaned` (nach ihrer schließenden `}`, vor `_vectorToBuffer`) einfügen:

```js

  recordObservation({ correspondentId, matchedDocumentId, similarity, tagIds, documentTypeId }) {
    try {
      this.db.prepare(`
        INSERT INTO document_fingerprint_observations
          (correspondent_id, matched_document_id, similarity, tag_ids, document_type_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(correspondentId, matchedDocumentId, similarity, JSON.stringify(tagIds), documentTypeId ?? null, new Date().toISOString());
      return true;
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.recordObservation:', error.message);
      return false;
    }
  }

  listObservations({ limit = 500 } = {}) {
    try {
      return this.db.prepare(`
        SELECT * FROM document_fingerprint_observations ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(limit);
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.listObservations:', error.message);
      return [];
    }
  }
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `npx node --test test/documentFingerprintStore.test.js`
Expected: PASS, alle Tests grün

- [ ] **Step 13: Write the failing tests für das Modus-Gating in der Pipeline**

In `test/documentProcessingPipeline.test.js`, am Ende der Datei einfügen:

```js
test('findFingerprintMatch wendet den Treffer im Modus "apply" an (Default-Verhalten)', async () => {
  const pipeline = makePipeline({
    paperlessService: { hasTagId: async () => true, hasDocumentTypeId: async () => true },
    documentFingerprintService: {
      findMatch: async () => ({ tagIds: [1], documentTypeId: 2, similarity: 0.95, matchedDocumentId: 101 }),
      recordFingerprint: async () => {}
    },
    config: { documentFingerprint: { enabled: true, mode: 'apply' }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.deepStrictEqual(result, { tagIds: [1], documentTypeId: 2 });
});

test('findFingerprintMatch protokolliert im Modus "observe" nur, wendet aber nichts an (NACHAUDIT-11)', async () => {
  const observeCalls = [];
  const pipeline = makePipeline({
    paperlessService: { hasTagId: async () => true, hasDocumentTypeId: async () => true },
    documentFingerprintService: {
      findMatch: async () => ({ tagIds: [1], documentTypeId: 2, similarity: 0.95, matchedDocumentId: 101 }),
      recordFingerprint: async () => {},
      store: { recordObservation: (args) => { observeCalls.push(args); return true; } }
    },
    config: { documentFingerprint: { enabled: true, mode: 'observe' }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.strictEqual(result, null);
  assert.strictEqual(observeCalls.length, 1);
  assert.deepStrictEqual(observeCalls[0], {
    correspondentId: 42, matchedDocumentId: 101, similarity: 0.95, tagIds: [1], documentTypeId: 2
  });
});

test('findFingerprintMatch protokolliert im Modus "observe" die validierten (nicht die rohen) IDs (AUDIT-006 bleibt auch im Beobachtungsmodus gueltig)', async () => {
  const observeCalls = [];
  const pipeline = makePipeline({
    paperlessService: {
      hasTagId: async (id) => id === 1, // Tag 2 existiert nicht mehr
      hasDocumentTypeId: async () => true
    },
    documentFingerprintService: {
      findMatch: async () => ({ tagIds: [1, 2], documentTypeId: 3, similarity: 0.95, matchedDocumentId: 101 }),
      recordFingerprint: async () => {},
      store: { recordObservation: (args) => { observeCalls.push(args); return true; } }
    },
    config: { documentFingerprint: { enabled: true, mode: 'observe' }, limitFunctions: {} }
  });

  await pipeline.findFingerprintMatch(42, 'text');

  assert.deepStrictEqual(observeCalls[0].tagIds, [1]);
});

test('findFingerprintMatch protokolliert nichts im Modus "observe", wenn kein Treffer existiert', async () => {
  const observeCalls = [];
  const pipeline = makePipeline({
    documentFingerprintService: {
      findMatch: async () => null,
      recordFingerprint: async () => {},
      store: { recordObservation: (args) => { observeCalls.push(args); return true; } }
    },
    config: { documentFingerprint: { enabled: true, mode: 'observe' }, limitFunctions: {} }
  });

  const result = await pipeline.findFingerprintMatch(42, 'text');

  assert.strictEqual(result, null);
  assert.strictEqual(observeCalls.length, 0);
});
```

- [ ] **Step 14: Run tests to verify they fail**

Run: `npx node --test test/documentProcessingPipeline.test.js`
Expected: FAIL — die drei `mode: 'observe'`-Tests erwarten `result === null` und einen
`recordObservation`-Aufruf, den es im aktuellen Code noch nicht gibt (aktuell würde
`findFingerprintMatch` immer den Treffer zurückgeben).

- [ ] **Step 15: `documentProcessingPipeline.js` implementieren**

In `services/documentProcessingPipeline.js`, in `findFingerprintMatch`, ersetze:

```js
      // Review-Fix: eine Validierung, die ALLES verworfen hat (alle Tag-IDs geloescht/gemergt,
      // keine gueltige Dokumentart), ist kein verwertbarer Treffer - der Aufrufer wuerde ihn
      // sonst trotzdem als Treffer werten und die LLM-Klassifikation verwerfen, ohne etwas
      // Brauchbares an ihrer Stelle zu setzen.
      if (validTagIds.length === 0 && documentTypeId === null) {
        return null;
      }
      return { tagIds: validTagIds, documentTypeId };
```

durch:

```js
      // Review-Fix: eine Validierung, die ALLES verworfen hat (alle Tag-IDs geloescht/gemergt,
      // keine gueltige Dokumentart), ist kein verwertbarer Treffer - der Aufrufer wuerde ihn
      // sonst trotzdem als Treffer werten und die LLM-Klassifikation verwerfen, ohne etwas
      // Brauchbares an ihrer Stelle zu setzen.
      if (validTagIds.length === 0 && documentTypeId === null) {
        return null;
      }

      // NACHAUDIT-11 (Audit Abschnitt 18.6, Bedingung 5): im Beobachtungsmodus wird der
      // (bereits AUDIT-006-validierte) Treffer protokolliert, aber NICHT zurueckgegeben -
      // buildUpdateData() faehrt dann exakt wie bei keinem Treffer fort. So laesst sich die
      // Trefferqualitaet unter echter Last beobachten, ohne dass ein Fehltreffer bereits live
      // Tags/Dokumentart ueberschreibt.
      if (this.config.documentFingerprint.mode === 'observe') {
        this.documentFingerprintService.store.recordObservation({
          correspondentId,
          matchedDocumentId: match.matchedDocumentId,
          similarity: match.similarity,
          tagIds: validTagIds,
          documentTypeId
        });
        return null;
      }

      return { tagIds: validTagIds, documentTypeId };
```

- [ ] **Step 16: Run tests to verify they pass**

Run: `npx node --test test/documentProcessingPipeline.test.js`
Expected: PASS, alle Tests grün (bestehende Tests ohne explizites `mode` im `config`-Objekt
bleiben unverändert grün, weil `undefined === 'observe'` `false` ist — Default-Verhalten bleibt
„anwenden", genau wie vor diesem Task)

- [ ] **Step 17: Run the full suite to check for regressions**

Run: `npm test`
Expected: alle Tests grün.

- [ ] **Step 18: Commit**

```bash
git add config/config.js test/configDocumentFingerprint.test.js services/documentFingerprintService.js test/documentFingerprintService.test.js models/documentFingerprintStore.js test/documentFingerprintStore.test.js services/documentProcessingPipeline.js test/documentProcessingPipeline.test.js
git commit -m "$(cat <<'EOF'
feat: Beobachtungsmodus fuer Fingerprint-Treffer (DOCUMENT_FINGERPRINT_MODE)

NACHAUDIT-11 (Audit Abschnitt 18.6, Bedingung 5): ein Fingerprint-Treffer
wird im neuen Modus 'observe' (Default bei aktiviertem Feature) protokolliert
statt auf Tags/Dokumentart angewendet zu werden - die neue Tabelle
document_fingerprint_observations haelt correspondent_id, matched_document_id,
similarity und die (AUDIT-006-validierten) Tag-/Dokumenttyp-IDs fest. Modus
'apply' verhaelt sich wie bisher. documentFingerprintService.findMatch gibt
dafuer zusaetzlich similarity/matchedDocumentId zurueck.

Aktiviert noch keinen produktiven Beobachtungslauf - DOCUMENT_FINGERPRINT_ENABLED
bleibt in data/.env auf 'no' (siehe Paket-4-Plan, Task 7 fuer den Runbook-Teil).

Nachaudit 2026-08-04, Paket 4 (NACHAUDIT-11, Infrastruktur).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Sichtbarkeit — Beobachtungs-Report-Skript (NACHAUDIT-11)

**Files:**
- Create: `scripts/fingerprint-observation-report.js`
- Create: `test/fingerprintObservationReport.test.js`

**Interfaces:**
- Konsumiert: eine `better-sqlite3`-`Database`-Instanz mit dem Schema aus
  `document_fingerprint_observations` (Task 4) — im Skript selbst über
  `config.entityResolver.dbPath` geöffnet, in Tests über `DocumentFingerprintStore(':memory:').db`
  (Task 4, gleiches Muster wie `test/documentFingerprintStore.test.js`).
- Produziert: `buildReport(db) -> {total, byCorrespondent, bySimilarityBand, recent}`, exportiert
  aus `scripts/fingerprint-observation-report.js` für den Test. `printReport(report, {dbPath,
  mode, similarityThreshold})` formatiert die Konsolenausgabe getrennt von der Datenermittlung.
  Kein anderer Task konsumiert diese Funktionen.

**Warum `buildReport` von der Konsolenausgabe getrennt ist:** anders als
`scripts/review-queue-report.js` (Paket 3), das als reines Top-Level-Skript ohne exportierte
Funktion committet wurde, trennt dieses Skript die vier SQL-Abfragen (`buildReport`, reine
Funktion von `db` zu einer Datenstruktur) von `printReport`/`main` (Konsolenausgabe, Prozess).
`buildReport` ist dadurch mit einer In-Memory-`DocumentFingerprintStore` testbar, ohne
`data/entities.db` zu benötigen — die Trennung kostet keine zusätzliche Komplexität (vier
`db.prepare(...).all()`/`.get()`-Aufrufe, ein Objekt zurückgeben statt sofort zu drucken).

- [ ] **Step 1: Write the failing tests**

Create `test/fingerprintObservationReport.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const DocumentFingerprintStore = require('../models/documentFingerprintStore');
const { buildReport } = require('../scripts/fingerprint-observation-report');

test('buildReport liefert total=0 und leere Listen ohne gespeicherte Beobachtungen', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    const report = buildReport(store.db);
    assert.strictEqual(report.total, 0);
    assert.deepStrictEqual(report.byCorrespondent, []);
    assert.deepStrictEqual(report.bySimilarityBand, []);
    assert.deepStrictEqual(report.recent, []);
  } finally {
    store.close();
  }
});

test('buildReport gruppiert nach Korrespondent und Aehnlichkeits-Band', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.recordObservation({ correspondentId: 5, matchedDocumentId: 1, similarity: 0.93, tagIds: [1], documentTypeId: null });
    store.recordObservation({ correspondentId: 5, matchedDocumentId: 2, similarity: 0.82, tagIds: [2], documentTypeId: 3 });
    store.recordObservation({ correspondentId: 9, matchedDocumentId: 3, similarity: 0.99, tagIds: [1], documentTypeId: null });

    const report = buildReport(store.db);

    assert.strictEqual(report.total, 3);
    const byCorrespondent = Object.fromEntries(report.byCorrespondent.map(r => [r.correspondent_id, r.n]));
    assert.deepStrictEqual(byCorrespondent, { 5: 2, 9: 1 });

    const bands = Object.fromEntries(report.bySimilarityBand.map(r => [r.band, r.n]));
    assert.strictEqual(bands['0.80-0.85'], 1);
    assert.strictEqual(bands['0.90-0.95'], 1);
    assert.strictEqual(bands['0.95-1.00'], 1);
  } finally {
    store.close();
  }
});

test('buildReport liefert die juengsten Beobachtungen zuerst, begrenzt auf 20', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    for (let i = 1; i <= 25; i++) {
      store.recordObservation({ correspondentId: 5, matchedDocumentId: i, similarity: 0.9, tagIds: [1], documentTypeId: null });
    }
    const report = buildReport(store.db);
    assert.strictEqual(report.recent.length, 20);
    assert.strictEqual(report.recent[0].matched_document_id, 25);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/fingerprintObservationReport.test.js`
Expected: FAIL — `Cannot find module '../scripts/fingerprint-observation-report'`

- [ ] **Step 3: Write the implementation**

Create `scripts/fingerprint-observation-report.js`:

```js
#!/usr/bin/env node
// Read-only Verteilungsreport fuer Fingerprint-Beobachtungen (DOCUMENT_FINGERPRINT_MODE=observe,
// NACHAUDIT-11, Audit Abschnitt 18.6 Bedingung 5). Zeigt, wie viele Treffer im Beobachtungsmodus
// protokolliert wurden und mit welcher Aehnlichkeit - Grundlage fuer die Stichprobenpruefung vor
// einer Umschaltung auf DOCUMENT_FINGERPRINT_MODE=apply. Aendert keine Daten.
// buildReport/printReport sind getrennt, damit buildReport ohne data/entities.db testbar ist
// (siehe test/fingerprintObservationReport.test.js) - main() bleibt der einzige Ort, der eine
// echte Datenbankverbindung oeffnet.
const Database = require('better-sqlite3');

function buildReport(db) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM document_fingerprint_observations`).get();
  const byCorrespondent = db.prepare(`
    SELECT correspondent_id, COUNT(*) AS n
    FROM document_fingerprint_observations
    GROUP BY correspondent_id ORDER BY n DESC LIMIT 20
  `).all();
  const bySimilarityBand = db.prepare(`
    SELECT
      CASE
        WHEN similarity < 0.85 THEN '0.80-0.85'
        WHEN similarity < 0.90 THEN '0.85-0.90'
        WHEN similarity < 0.95 THEN '0.90-0.95'
        ELSE '0.95-1.00'
      END AS band,
      COUNT(*) AS n
    FROM document_fingerprint_observations
    GROUP BY band ORDER BY band
  `).all();
  const recent = db.prepare(`
    SELECT id, correspondent_id, matched_document_id, similarity, tag_ids, document_type_id, created_at
    FROM document_fingerprint_observations
    ORDER BY created_at DESC, id DESC LIMIT 20
  `).all();

  return { total: total.n, byCorrespondent, bySimilarityBand, recent };
}

function printReport(report, { dbPath, mode, similarityThreshold }) {
  console.log(`Datenbank: ${dbPath}`);
  console.log(`Modus: ${mode}, Schwellwert: ${similarityThreshold}`);
  console.log(`\nProtokollierte Beobachtungen gesamt: ${report.total}`);

  if (report.total === 0) {
    console.log('\nKeine Beobachtungen vorhanden. Voraussetzung: DOCUMENT_FINGERPRINT_ENABLED=yes und DOCUMENT_FINGERPRINT_MODE=observe in data/.env, danach mindestens ein Scan-Zyklus.');
    return;
  }

  console.log('\nNach Korrespondent (Top 20):');
  for (const row of report.byCorrespondent) {
    console.log(`  Korrespondent ${row.correspondent_id}: ${row.n}`);
  }

  console.log('\nAehnlichkeits-Baender:');
  for (const row of report.bySimilarityBand) {
    console.log(`  ${row.band}: ${row.n}`);
  }

  console.log('\nJuengste 20 Beobachtungen (Ausgangspunkt fuer die Stichprobenpruefung):');
  for (const row of report.recent) {
    console.log(`  [${row.created_at}] correspondent=${row.correspondent_id} matched_document=${row.matched_document_id} similarity=${row.similarity.toFixed(3)} tags=${row.tag_ids} document_type=${row.document_type_id ?? '(keine)'}`);
  }
}

function main() {
  const config = require('../config/config');
  const db = new Database(config.entityResolver.dbPath, { readonly: true });
  try {
    const report = buildReport(db);
    printReport(report, {
      dbPath: config.entityResolver.dbPath,
      mode: config.documentFingerprint.mode,
      similarityThreshold: config.documentFingerprint.similarityThreshold
    });
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildReport, printReport };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/fingerprintObservationReport.test.js`
Expected: PASS, 3/3 tests green

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: alle Tests grün.

- [ ] **Step 6: Syntax/Smoke-Check des CLI-Pfads**

Run: `node --check scripts/fingerprint-observation-report.js`
Expected: kein Fehler. `main()` selbst kann in diesem Checkout nicht sinnvoll ausgeführt werden,
da `data/entities.db` hier nicht existiert — die reale Ausführung ist Teil von Task 7; die
Datenermittlung (`buildReport`) ist bereits durch Step 1-4 abgedeckt.

- [ ] **Step 7: Commit**

```bash
git add scripts/fingerprint-observation-report.js test/fingerprintObservationReport.test.js
git commit -m "$(cat <<'EOF'
feat: Read-only Verteilungsreport fuer Fingerprint-Beobachtungen (NACHAUDIT-11)

Zeigt protokollierte Beobachtungen aus DOCUMENT_FINGERPRINT_MODE=observe nach
Korrespondent und Aehnlichkeits-Band, plus die juengsten 20 Eintraege fuer
eine manuelle Stichprobenpruefung - Grundlage fuer die Aktivierungsentscheidung
nach Audit Abschnitt 18.6, Bedingung 5. Aendert keine Daten. Die Datenermittlung
(buildReport) ist von der Konsolenausgabe getrennt und dadurch isoliert getestet.

Nachaudit 2026-08-04, Paket 4 (NACHAUDIT-11, Sichtbarkeit).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Dokumentation — `DOCUMENT_FINGERPRINT_MODE`

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: `.env.example` ergänzen**

In `.env.example`, direkt nach der bestehenden `DOCUMENT_FINGERPRINT_ENABLED=no`-Zeile (Zeile 91)
und vor dem `FINGERPRINT_SIMILARITY_THRESHOLD`-Kommentarblock, einfügen:

```
# Steuert, ob ein Fingerprint-Treffer angewendet oder nur protokolliert wird.
# 'observe' (Default): der Treffer wird in document_fingerprint_observations
# protokolliert (siehe scripts/fingerprint-observation-report.js), aber NICHT auf
# Tags/Dokumentart angewendet - die normale LLM-Klassifikation laeuft unveraendert
# weiter. 'apply': der Treffer wird wie in der urspruenglichen Design-Spec still
# angewendet. Vor einer Umschaltung auf 'apply' sollten mindestens 200 Dokumente im
# Beobachtungsmodus gelaufen und stichprobenartig geprueft sein (Audit Abschnitt 18.6,
# Bedingung 5).
DOCUMENT_FINGERPRINT_MODE=observe
```

- [ ] **Step 2: `README.md` ergänzen**

In `README.md`, im Abschnitt „Document Fingerprint" (Zeile 81-85), ersetze:

```
- **Document Fingerprint** (`DOCUMENT_FINGERPRINT_ENABLED`, default `no`) —
  reuses a recurring document's tags/document type based on content
  similarity (`FINGERPRINT_SIMILARITY_THRESHOLD`). **Not production-ready**
  (see the project's audit report, AUDIT-003) — leave disabled outside of
  testing.
```

durch:

```
- **Document Fingerprint** (`DOCUMENT_FINGERPRINT_ENABLED`, default `no`) —
  reuses a recurring document's tags/document type based on content
  similarity (`FINGERPRINT_SIMILARITY_THRESHOLD`). `DOCUMENT_FINGERPRINT_MODE`
  (`observe`, default, or `apply`) controls whether a hit is only logged
  (`document_fingerprint_observations`, see `scripts/fingerprint-observation-report.js`)
  or actually applied. **Not production-ready** (see the project's audit
  report, section 18.6, for the remaining activation conditions) — leave
  disabled outside of testing.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "$(cat <<'EOF'
docs: DOCUMENT_FINGERPRINT_MODE in .env.example und README dokumentieren

Nachaudit 2026-08-04, Paket 4 (NACHAUDIT-11, Doku).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7 (Runbook, nur auf der Produktivinstanz): Beobachtungsmodus-Testlauf

**Files:** keine Code-Änderung — Betrieb auf der Produktivinstanz.

**Nicht aus diesem Checkout ausführbar** (wie Paket 3, Task 1/6): braucht `data/.env`-Zugriff auf
der Zielmaschine, eine laufende Paperless-ngx-Anbindung und einen erreichbaren Ollama-Endpunkt
mit dem konfigurierten Embedding-Modell (`config.embedding.model`, Default `bge-m3`).
**Voraussetzung:** Tasks 1-6 sind auf der Zielmaschine deployt (Commit-Hash prüfen, gleiches
Vorgehen wie Paket 3 Task 1).

- [ ] **Step 1: Beobachtungsmodus aktivieren**

In `data/.env` der Zielmaschine (niemals hier im Checkout, niemals im Klartext in einer
Zusammenfassung wiederholen):

```
DOCUMENT_FINGERPRINT_ENABLED=yes
DOCUMENT_FINGERPRINT_MODE=observe
EMBEDDING_SIMILARITY_ENABLED=yes
```

(`EMBEDDING_SIMILARITY_ENABLED=yes` nötig, falls noch nicht gesetzt — der Fingerprint-Kanal nutzt
denselben Embedding-Service wie Phase 4.) Anwendung neu starten.

- [ ] **Step 2: Scan-Zyklen über mindestens 200 Dokumente laufen lassen**

`POST /api/scan/now` auslösen (authentifiziert, siehe Paket 3 Task 6 für das Vorgehen bei
`409 { "message": "A scan is already running" }`) — falls der reale Dokumentbestand kleiner als
200 ist, über mehrere Zyklen/neu hinzukommende Dokumente strecken, bis die Zielgröße erreicht
ist (Audit Abschnitt 18.6, Bedingung 5: „mindestens 200 Dokumente in diesem Modus").

- [ ] **Step 3: Report laufen lassen**

```bash
node scripts/fingerprint-observation-report.js
```

Ergebnis (Gesamtzahl Beobachtungen, Ähnlichkeits-Bänder) notieren.

- [ ] **Step 4: Stichprobe der Beobachtungen inhaltlich prüfen**

Für mindestens 10 Einträge aus den „Jüngste 20 Beobachtungen" (Step 3): `matched_document_id`
und das aktuell verarbeitete Dokument in Paperless-ngx öffnen, inhaltlich vergleichen — wäre der
protokollierte Treffer (gleiche Tags/Dokumentart wie `matched_document_id`) tatsächlich korrekt
gewesen? Besonderes Augenmerk auf die in Audit Abschnitt 18.2 benannten Risikoklassen:
gleiches Template mit unterschiedlichem Inhalt (z. B. unterschiedliche Beträge), Serienbrief vs.
individuelle Mitteilung, Formularbriefe mit hohem Standardtext-Anteil. Ergebnis je Fall
festhalten (korrekt/falsch, mit kurzer Begründung).

- [ ] **Step 5: Ergebnis dokumentieren**

In `docs/audit/2026-08-04-nachaudit-offene-punkte.md`, Abschnitt „Paket 4", einen neuen
Ergebnis-Absatz unter NACHAUDIT-11 ergänzen (Muster: Paket 3, NACHAUDIT-08-Ergebnis) — Anzahl
beobachteter Dokumente, Anzahl protokollierter Treffer, Trefferquote, Stichprobenergebnis aus
Step 4 (wie viele der geprüften Treffer wären korrekt gewesen). Diese Dokumentation ist die
Grundlage für eine spätere, separate Entscheidung über `DOCUMENT_FINGERPRINT_MODE=apply` — diese
Entscheidung selbst ist **nicht** Teil dieses Plans.

---

### Task 8 (Runbook, nur auf der Produktivinstanz): Schwellwertmessung (NACHAUDIT-10)

**Files:** `data/eval/fingerprint-pairs.json` (nur auf der Produktivinstanz, nicht in git — wie
alle Dateien unter `data/eval/`, siehe `scripts/tune-thresholds.js`-Ausgabe „nicht in git").

**Nicht aus diesem Checkout ausführbar:** braucht Zugriff auf echte, gelabelte Dokumentpaare aus
der Produktiv-Paperless-Instanz. **Empfehlung:** nach Task 7 durchführen — die dort protokollierten
Beobachtungen (insbesondere Treffer mit Similarity nahe am aktuellen `FINGERPRINT_SIMILARITY_THRESHOLD=0.90`
und die in Task 7/Step 4 als inhaltlich fragwürdig erkannten Fälle) sind wertvolle Kandidaten für
die `different`-Paare dieser Messung — nicht zwingend blockierend, aber sinnvoll sequenziert.

- [ ] **Step 1: Gelabelte Paare zusammenstellen**

Mindestens 60 Dokumentpaare desselben Korrespondenten nach der Verteilung aus Audit Abschnitt
18.4 zusammenstellen:

| Klasse | Label | Mindestanzahl |
|---|---|---|
| Dieselbe Serie, aufeinanderfolgende Perioden (z. B. Gehalt Juli/August) | `same` | 15 |
| Dieselbe Serie, weit auseinanderliegende Perioden | `same` | 10 |
| Gleicher Absender, gleiches Template, **andere** Dokumentart | `different` | 15 |
| Gleicher Absender, Formularbrief vs. individuelle Mitteilung | `different` | 10 |
| Sehr kurze/OCR-arme Dokumente, beide Label | gemischt | 10 |

Ohne ausreichend `different`-Paare mit gleichem Template ist die Messung laut Audit Abschnitt
18.4 wertlos — sie bestimmen die obere Schwellwertgrenze.

- [ ] **Step 2: `data/eval/fingerprint-pairs.json` auf der Zielmaschine anlegen**

Format (laut Fehlermeldung in `scripts/tune-thresholds.js`, Zeile 101-105):

```json
[
  { "documentIdA": 123, "documentIdB": 456, "label": "same" },
  { "documentIdA": 123, "documentIdB": 789, "label": "different" }
]
```

- [ ] **Step 3: Messung ausführen**

```bash
node scripts/tune-thresholds.js --fingerprint
```

Ausgabe: Precision/Recall je Schwellwert 0.80-0.99, empfohlener Schwellwert (kleinster Wert mit
Precision=1.00, plus Sicherheitsaufschlag +0.02, siehe Audit Abschnitt 18.5 Punkt 3), die fünf
am schwersten trennbaren `different`-Paare. Detailergebnis wird nach
`data/eval/fingerprint-threshold-tuning-<datum>.json` geschrieben (nicht in git).

- [ ] **Step 4: Bei Bedarf nach Korrespondententyp getrennt auswerten**

Falls die Streuung der schwierigsten `different`-Paare groß erscheint (Audit Abschnitt 18.5
Punkt 5: Arbeitgeber/Versicherung/Behörde/Versorger verhalten sich unterschiedlich): Teilmengen
von `data/eval/fingerprint-pairs.json` nach Korrespondententyp filtern und Step 3 je Teilmenge
wiederholen. Bei großer Streuung ist ein globaler Schwellwert nicht tragfähig — das wäre ein
eigener Befund, der vor einer Aktivierung gelöst werden müsste (out of scope für dieses Paket).

- [ ] **Step 5: Ergebnis übernehmen und dokumentieren**

Falls Step 3 einen Schwellwert mit Precision=1.00 liefert: `FINGERPRINT_SIMILARITY_THRESHOLD=<gemessener Wert>`
in `data/.env` der Zielmaschine setzen (ersetzt den bisherigen Platzhalter `0.90`). Falls kein
Schwellwert in [0.80, 0.99] Precision=1.00 erreicht: **nicht** aktivieren, Ergebnis trotzdem
dokumentieren — das wäre der Befund „mit den vorliegenden Paaren ist der Fingerprint-Kanal
nicht sicher aktivierbar" (Ausgabetext von `scripts/tune-thresholds.js`).

In `docs/audit/2026-08-04-nachaudit-offene-punkte.md`, Abschnitt „Paket 4", einen
Ergebnis-Absatz unter NACHAUDIT-10 ergänzen: Anzahl/Verteilung der gelabelten Paare, gemessener
Schwellwert (oder „nicht erreicht"), die fünf schwierigsten `different`-Paare (nur als
Dokument-IDs, keine Inhalte). Keine Paperless-Zugangsdaten oder Dokumentinhalte im Klartext in
dieser Dokumentation.

---

### Task 9: Ergebnis dokumentieren, Nachaudit-Arbeitsplan aktualisieren

**Files:**
- Modify: `docs/audit/2026-08-04-nachaudit-offene-punkte.md`

- [ ] **Step 1: Checkbox-Zeile aktualisieren**

In `docs/audit/2026-08-04-nachaudit-offene-punkte.md`, Zeile 54-57, ersetze:

```
4. [ ] **Fingerprint-Aktivierungsvoraussetzungen schließen** (Abschnitt 18.6,
   Punkt 1/5/6 aus dem Erstaudit)
   → Größtes Paket, aber unkritisch für den laufenden Betrieb, da Feature aus.
   Zeitlich nach hinten stellen, außer das Feature soll bald aktiviert werden.
```

durch (Status hängt davon ab, ob zum Zeitpunkt dieses Commits bereits ein Runbook-Ergebnis aus
Task 7/8 vorliegt — **kein `[x]` ohne Beleg**, gleiche Regel wie in Paket 3):

- Falls nur Tasks 1-6 (Code) umgesetzt sind, Tasks 7/8 (Runbook) noch offen:

```
4. [~] **Fingerprint-Aktivierungsvoraussetzungen schließen** (Abschnitt 18.6,
   Punkt 1/5/6 aus dem Erstaudit)
   → Code-Teil (NACHAUDIT-11 Infrastruktur, NACHAUDIT-12, NACHAUDIT-13) umgesetzt laut
   [2026-08-06-nachaudit-paket4-fingerprint-aktivierungsvoraussetzungen.md](../superpowers/plans/2026-08-06-nachaudit-paket4-fingerprint-aktivierungsvoraussetzungen.md).
   Offen: Beobachtungsmodus-Testlauf (NACHAUDIT-11) und Schwellwertmessung (NACHAUDIT-10) —
   beide brauchen Zugriff auf die Produktivinstanz, siehe Plan Task 7/8. Feature bleibt aus.
```

- Falls auch Task 7 und 8 mit dokumentiertem Ergebnis abgeschlossen sind:

```
4. [x] **Fingerprint-Aktivierungsvoraussetzungen schließen** (Abschnitt 18.6,
   Punkt 1/5/6 aus dem Erstaudit)
   → Umgesetzt laut
   [2026-08-06-nachaudit-paket4-fingerprint-aktivierungsvoraussetzungen.md](../superpowers/plans/2026-08-06-nachaudit-paket4-fingerprint-aktivierungsvoraussetzungen.md).
   Alle sechs Bedingungen aus Abschnitt 18.6 erfüllt. Aktivierung
   (DOCUMENT_FINGERPRINT_ENABLED=yes, DOCUMENT_FINGERPRINT_MODE=apply) ist eine separate,
   bewusste Folgeentscheidung, nicht Teil dieses Pakets.
```

- [ ] **Step 2: Commit**

```bash
git add docs/audit/2026-08-04-nachaudit-offene-punkte.md
git commit -m "$(cat <<'EOF'
docs: Paket 4 des Nachaudits — Stand dokumentiert (NACHAUDIT-10, -11, -12, -13)

Nachaudit 2026-08-04, Paket 4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance Criteria

- `npm test` läuft nach jedem Code-Task (1-6) vollständig grün durch, keine Regression.
- Mit `DOCUMENT_FINGERPRINT_ENABLED=no` (unverändert in der echten `data/.env`) verhält sich die
  Anwendung exakt wie vor diesem Paket — kein neuer Codepfad wird erreicht.
- NACHAUDIT-13: ein Fingerprint-Treffer, der wegen `activateTagging='no'`/`activateDocumentType='no'`
  nie auf `updateData` angewendet wurde, wird nicht mehr als `source='inherited'` gespeichert.
- NACHAUDIT-12: `POST /api/documents/:id/restore-original` (authentifiziert) schreibt den
  ältesten gespeicherten `original_documents`-Zustand eines Dokuments per Replace-semantischem
  PATCH nach Paperless zurück; ohne gespeicherten Zustand liefert die Route 404.
- NACHAUDIT-11: `DOCUMENT_FINGERPRINT_MODE=observe` (Default bei aktiviertem Feature) protokolliert
  einen Treffer in `document_fingerprint_observations`, ohne ihn anzuwenden; `apply` verhält sich
  wie das bisherige Verhalten. `scripts/fingerprint-observation-report.js` macht die Beobachtungen
  sichtbar. Ein realer Testlauf über ≥200 Dokumente mit dokumentierter Stichprobenprüfung liegt
  vor (Task 7, Runbook).
- NACHAUDIT-10: eine Schwellwertmessung mit ≥60 gelabelten Dokumentpaaren nach der Verteilung aus
  Audit Abschnitt 18.4 liegt vor, Ergebnis dokumentiert — entweder ein gemessener
  `FINGERPRINT_SIMILARITY_THRESHOLD` oder der explizite Befund „nicht sicher aktivierbar" (Task 8,
  Runbook).
- `docs/audit/2026-08-04-nachaudit-offene-punkte.md` spiegelt den tatsächlichen
  Umsetzungsstand wider (kein `[x]` ohne Beleg).
- `data/.env`-Zugangsdaten tauchen an keiner Stelle dieses Plans, seiner Ausführung oder der
  Ergebnisdokumentation im Klartext auf.
- `DOCUMENT_FINGERPRINT_ENABLED` bleibt am Ende dieses Plans `no` in der echten `data/.env` —
  Aktivierung ist explizit keine Zielgröße dieses Pakets.
