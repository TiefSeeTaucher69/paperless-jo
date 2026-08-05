# Nachaudit Paket 2 — Dokumentation und Altdaten bereinigen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die sechs Restposten aus Paket 2 des Nachaudits
(`docs/audit/2026-08-04-nachaudit-offene-punkte.md`, NACHAUDIT-02 bis
NACHAUDIT-07) abarbeiten: eine PII-belastete Logdatei aus dem Erstaudit
bereinigen, zwei veraltete Aussagen in der Roadmap korrigieren, die neuen
Feature-Flags in README/docker-compose dokumentieren, die Fix-Dokumentation
versionieren und eine bewusste Nicht-Entscheidung zum Lint-Warnungsdeckel
festhalten. Reine Doku- und Datenhygiene ohne Änderung an
Produktionsverhalten — die einzige Ausnahme (Task 2, optional) fügt einen
konfigurierbaren Log-Pfad hinzu, ändert aber am Default nichts.

**Kontext:** Diese Punkte sind laut Nachaudit „unabhängig voneinander und von
Paket 1 durchführbar" — Paket 1 (NACHAUDIT-01, Setup-Route) ist bereits
gemergt (Commits `9af7a32`, `28ceec0`, plus Folge-Review-Fixes bis `70b455b`).
Alle Recherche-Ergebnisse unten sind Stand des Planungslaufs
(2026-08-05); vor der Umsetzung erneut prüfen, ob sich der Stand
zwischenzeitlich geändert hat.

**Tech Stack:** Node.js (CommonJS), `node:test`, Markdown/YAML-Doku. Keine
neue Dependency.

**Referenz:** [../../audit/2026-08-04-nachaudit-offene-punkte.md](../../audit/2026-08-04-nachaudit-offene-punkte.md), Abschnitt „Paket 2"

## Global Constraints

- `data/.env` enthält echte Zugangsdaten — niemals in Commits, Logs oder
  Doku-Beispielen echte Werte verwenden, nur Platzhalter wie in
  `.env.example`.
- Sprachkonvention beibehalten: `docs/planning/`, `docs/audit/` und
  Commit-Bodies sind Deutsch (bestehender Stil dieser Dateien);
  `README.md`, `docker-compose.yml` und `.env.example` sind Englisch.
- Task 1 fasst nur eine bereits gitignorete Laufzeit-Datei an
  (`logs/prompt.txt`), keinen Code. Task 2 ist optional und die einzige
  Aufgabe in diesem Paket mit einer Produktivcode-Änderung — dafür gilt
  TDD wie in allen anderen `superpowers`-Plänen dieses Projekts.
- Jede Aufgabe ist unabhängig von den anderen; Reihenfolge unten ist
  Empfehlung, kein Zwang. Task 6 (Doku versionieren) sollte trotzdem
  zuletzt laufen, da es die Ergebnisse der Tasks 1–5 mit committet.
- Vor Task 2, Step 5 (Regressionstest): `npm test` muss lokal lauffähig
  sein (Node ≥ 22, `better-sqlite3` bereits gebaut). Falls nicht
  verfügbar, Task 2 überspringen und nur Task 1 (Datei-Löschung) sowie
  die Doku-Tasks (3–7) durchführen.

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `logs/prompt.txt` | Erstaudit-Altlast (PII) | Delete (falls vorhanden) |
| `config/config.js` | `promptLogging.logDir` (optional) | Modify (Task 2) |
| `services/serviceUtils.js` | `writePromptToFile`-Default-Pfad | Modify (Task 2) |
| `services/openaiService.js` | `response.txt`-Pfad | Modify (Task 2) |
| `services/azureService.js` | `response.txt`-Pfad | Modify (Task 2) |
| `services/customService.js` | `response.txt`-Pfad | Modify (Task 2) |
| `test/promptLoggingResponseFile.test.js` | Temp-Verzeichnis statt echter Logdatei | Modify (Task 2) |
| `docs/planning/klassifikations-konsistenz-roadmap.md` | Testanzahl, Abnahmekriterium Phase 1 | Modify (Task 3, 4) |
| `README.md` | Feature-Flag-Namen in bestehendem Abschnitt | Modify (Task 5) |
| `docker-compose.yml` | Beispiel-Env-Block | Modify (Task 5) |
| `docs/audit/2026-08-04-nachaudit-offene-punkte.md` | Arbeitsplan-Checkbox | Modify (Task 6) |

---

### Task 1: `logs/prompt.txt`-Altlast bereinigen (NACHAUDIT-02, Hauptpunkt)

**Files:**
- Delete (falls vorhanden): `logs/prompt.txt`

**Rechercheergebnis (2026-08-05):** In diesem Arbeitsverzeichnis existiert
aktuell **kein** `logs/`-Verzeichnis (`Glob logs/**` → keine Treffer). Die im
Nachaudit beschriebene 172-KB-Datei mit Klarnamen/Anschrift ist entweder
bereits entfernt oder existiert nur auf der ursprünglich geprüften Maschine.
`public/images/` ist ebenfalls bestätigt leer/weg — kein Handlungsbedarf dort.
Dieser Task ist deshalb primär eine **Absicherung für den Fall**, dass die
Datei auf der Zielmaschine (Produktivsystem, nicht notwendigerweise diese
Arbeitskopie) noch existiert.

- [ ] **Step 1: Vorhandensein prüfen**

```bash
ls -la logs/ 2>/dev/null || echo "logs/ existiert nicht - Task 1 bereits erledigt"
```

- [ ] **Step 2: Falls `logs/prompt.txt` existiert, löschen**

```bash
rm -f logs/prompt.txt
```

Kein `git rm` nötig — die Datei ist über `.gitignore` (`logs/*`, `prompt.txt`)
ohnehin nie getrackt. Falls das Verzeichnis danach leer ist, kann es bleiben
(wird bei Bedarf von `writePromptToFile`/`fs.mkdir` neu angelegt) oder
ebenfalls entfernt werden — beides ist funktional gleichwertig.

- [ ] **Step 3: Bestätigen**

```bash
ls logs/ 2>/dev/null
```

Erwartet: kein `prompt.txt` mehr (Verzeichnis leer oder nicht vorhanden).

Kein Commit nötig — reine Dateisystem-Bereinigung außerhalb von Git.

---

### Task 2 (optional): Test greift nicht mehr auf die echte Logdatei zu (NACHAUDIT-02, Nebenbefund)

**Warum optional:** Kein Fehlverhalten heute, nur ein Risiko bei einem
abgebrochenen Testlauf (`test/promptLoggingResponseFile.test.js` sichert und
restauriert `logs/prompt.txt`/`logs/response.txt` um die Tests herum). Bei
Zeitdruck überspringen und direkt zu Task 3.

**Files:**
- Modify: `config/config.js:215-217` (`promptLogging`-Block)
- Modify: `services/serviceUtils.js:164` (`writePromptToFile`-Default-Parameter)
- Modify: `services/openaiService.js:220`, `services/azureService.js:211`, `services/customService.js:226` (`fs.appendFile('./logs/response.txt', ...)`)
- Modify: `test/promptLoggingResponseFile.test.js` (Pfade auf Temp-Verzeichnis umstellen)

**Interfaces:**
- Consumes: nichts Neues.
- Produces: `config.promptLogging.logDir` (string, Default `'./logs'`),
  konsumiert von `writePromptToFile`s Default-Parameter und den drei
  `response.txt`-Schreibstellen. Gleiches Muster wie das bereits bestehende
  `config.thumbnailCacheDir`, das `test/promptLoggingResponseFile.test.js` für
  die Thumbnail-Caching-Stelle schon heute per Test-Override nutzt (Zeilen
  106-124 der Testdatei) — dieser Task zieht `promptLogging`/`response.txt`
  auf dasselbe Muster nach.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Ersetze in `test/promptLoggingResponseFile.test.js` die Konstanten und die
`withSavedLogFiles`-Hilfsfunktion (Zeilen 9-49):

```js
const RESPONSE_LOG_PATH = path.join(process.cwd(), 'logs', 'response.txt');
const PROMPT_LOG_PATH = path.join(process.cwd(), 'logs', 'prompt.txt');
const LOG_PATHS = [RESPONSE_LOG_PATH, PROMPT_LOG_PATH];
```

durch:

```js
const RESPONSE_LOG_PATH = path.join(process.cwd(), 'logs', 'response.txt');
const PROMPT_LOG_PATH = path.join(process.cwd(), 'logs', 'prompt.txt');
const LOG_PATHS = [RESPONSE_LOG_PATH, PROMPT_LOG_PATH];

// Vor Task 2 (NACHAUDIT-02-Nebenbefund) sicherte/restaurierte dieser Test
// die *echte* logs/prompt.txt bzw. logs/response.txt. Ein abgebrochener
// Testlauf konnte die Datei in einem Zwischenstand hinterlassen. Jetzt zeigt
// config.promptLogging.logDir waehrend des Tests auf ein Temp-Verzeichnis -
// dasselbe Muster wie config.thumbnailCacheDir weiter unten in dieser Datei.
```

Ersetze die Funktion `withSavedLogFiles` (Zeilen 24-49) durch eine Version,
die `config.promptLogging.logDir` statt echter Dateien umbiegt:

```js
async function withTempLogDir(fn) {
  const savedLogDir = config.promptLogging.logDir;
  const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-log-test-'));

  try {
    config.promptLogging.logDir = tmpLogDir;
    await fn({
      responseLogPath: path.join(tmpLogDir, 'response.txt'),
      promptLogPath: path.join(tmpLogDir, 'prompt.txt')
    });
  } finally {
    config.promptLogging.logDir = savedLogDir;
    await fs.rm(tmpLogDir, { recursive: true, force: true });
  }
}
```

Passe die beiden Testschleifen (Zeilen 128-178) entsprechend an — ersetze
den gesamten Block ab `for (const { name, modulePath } of PROVIDERS) {` bis
zum schließenden `}` durch:

```js
for (const { name, modulePath } of PROVIDERS) {
  test(`${name}Service: response.txt is not written when promptLogging.enabled is false`, async () => {
    const service = require(modulePath);
    const savedEnabled = config.promptLogging.enabled;

    await withTempLogDir(async ({ responseLogPath, promptLogPath }) => {
      await withStubbedEnv(service, async () => {
        try {
          config.promptLogging.enabled = false;

          await service.analyzeDocument('DOKUMENT INHALT', [], [], [], 'test-doc-id');

          const appeared = await waitUntil(() => fileExists(responseLogPath), { timeoutMs: 500 });
          assert.strictEqual(appeared, false, `expected ${responseLogPath} not to exist when promptLogging.enabled is false`);

          const promptAppeared = await fileExists(promptLogPath);
          assert.strictEqual(promptAppeared, false, `expected ${promptLogPath} not to exist when promptLogging.enabled is false`);
        } finally {
          config.promptLogging.enabled = savedEnabled;
        }
      });
    });
  });

  test(`${name}Service: response.txt is written when promptLogging.enabled is true`, async () => {
    const service = require(modulePath);
    const savedEnabled = config.promptLogging.enabled;

    await withTempLogDir(async ({ responseLogPath }) => {
      await withStubbedEnv(service, async () => {
        try {
          config.promptLogging.enabled = true;

          const result = await service.analyzeDocument('DOKUMENT INHALT', [], [], [], 'test-doc-id');
          assert.strictEqual(result.error, undefined, `analyzeDocument reported an unexpected error: ${result.error}`);

          const appeared = await waitUntil(() => fileExists(responseLogPath), { timeoutMs: 2000 });
          assert.strictEqual(appeared, true, `expected ${responseLogPath} to be written when promptLogging.enabled is true`);

          const written = await fs.readFile(responseLogPath, 'utf8');
          assert.ok(written.includes(RESPONSE_CONTENT.correspondent), 'expected the logged response to include the parsed correspondent');
        } finally {
          config.promptLogging.enabled = savedEnabled;
        }
      });
    });
  });
}
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test test/promptLoggingResponseFile.test.js`
Expected: FAIL — `config.promptLogging.logDir` ist `undefined`, die Dateien
landen weiterhin unter dem echten `./logs/`.

- [ ] **Step 3: `config.promptLogging.logDir` ergänzen**

Ersetze in `config/config.js` den `promptLogging`-Block (Zeilen 215-217):

```js
  promptLogging: {
    enabled: parseEnvBoolean(process.env.PROMPT_LOGGING_ENABLED, 'no') === 'yes'
  },
```

durch:

```js
  promptLogging: {
    enabled: parseEnvBoolean(process.env.PROMPT_LOGGING_ENABLED, 'no') === 'yes',
    // Ueberschreibbar in Tests (siehe test/promptLoggingResponseFile.test.js),
    // damit kein Testlauf die echte logs/-Datei anfasst. Im Betrieb immer './logs'.
    logDir: './logs'
  },
```

- [ ] **Step 4: Schreibstellen auf `config.promptLogging.logDir` umstellen**

Ersetze in `services/serviceUtils.js` die Signaturzeile von `writePromptToFile`
(Zeile 164):

```js
async function writePromptToFile(systemPrompt, truncatedContent, filePath = './logs/prompt.txt', maxSize = 10 * 1024 * 1024) {
```

durch:

```js
async function writePromptToFile(systemPrompt, truncatedContent, filePath = path.join(config.promptLogging.logDir, 'prompt.txt'), maxSize = 10 * 1024 * 1024) {
```

In `services/openaiService.js` (Zeile 220), `services/azureService.js`
(Zeile 211) und `services/customService.js` (Zeile 226) jeweils identisch:

```js
          fs.appendFile('./logs/response.txt', jsonContent, (err) => {
```

durch:

```js
          fs.appendFile(path.join(config.promptLogging.logDir, 'response.txt'), jsonContent, (err) => {
```

(`fs`, `path` und `config` sind in allen drei Dateien bereits oben importiert
— keine neuen Requires nötig.)

- [ ] **Step 5: Tests ausführen, Erfolg bestätigen**

Run: `node --test test/promptLoggingResponseFile.test.js`
Expected: PASS — alle Tests grün, kein Zugriff mehr auf `process.cwd()/logs/`.

Run: `npm test`
Expected: vollständige Suite weiterhin grün (keine Regression durch die
Default-Pfad-Änderung, da `logDir` im Betrieb `'./logs'` bleibt — identisch
zum bisherigen hartkodierten Pfad).

- [ ] **Step 6: Commit**

```bash
git add config/config.js services/serviceUtils.js services/openaiService.js services/azureService.js services/customService.js test/promptLoggingResponseFile.test.js
git commit -m "$(cat <<'EOF'
test: prompt/response-Logging-Tests greifen nicht mehr auf echte Logdateien zu

test/promptLoggingResponseFile.test.js sicherte und restaurierte bisher die
echte logs/prompt.txt bzw. logs/response.txt um jeden Testlauf herum. Ein
abgebrochener Lauf konnte die Datei in einem Zwischenstand hinterlassen.

config.promptLogging.logDir (Default './logs', wie bisher hartkodiert) macht
den Log-Ordner ueberschreibbar - der Test zeigt waehrend der Laufzeit auf ein
Temp-Verzeichnis, genau wie schon config.thumbnailCacheDir fuer die
Thumbnail-Caching-Tests in derselben Datei.

Nachaudit 2026-08-04, NACHAUDIT-02 (Nebenbefund, optional).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Testanzahl in der Roadmap aktualisieren (NACHAUDIT-03)

**Files:**
- Modify: `docs/planning/klassifikations-konsistenz-roadmap.md:283-285`

**Rechercheergebnis (2026-08-05):** Seit dem im Nachaudit gemessenen Stand
„403/403" sind fünf neue Testdateien aus der Paket-1-Fix-Welle dazugekommen
(`test/aiServiceThumbnailCaching.test.js`,
`test/ollamaServiceThumbnailCaching.test.js`,
`test/setupAuthMiddleware.test.js`,
`test/setupServiceHasEnvConfig.test.js`,
`test/thumbnailCacheLocation.test.js` — `git diff --stat ca5230c..HEAD --
test/`). Die tatsächliche Zahl zum Ausführungszeitpunkt dieses Tasks ist
höher als 403 und muss frisch gemessen werden, nicht aus diesem Plan
übernommen werden — genau das Muster, das NACHAUDIT-03 selbst beschreibt.

- [ ] **Step 1: Aktuelle Testanzahl messen**

```bash
npm test 2>&1 | tail -20
```

Notiere die finale Zeile (`# pass N`, `# fail 0` o. ä. je nach
`node:test`-Reporter).

- [ ] **Step 2: Roadmap-Zeile aktualisieren**

Ersetze in `docs/planning/klassifikations-konsistenz-roadmap.md`
(Zeilen 283-285):

```
156/156 Tests grün bei Phase-3-Abschluss. **Nachtrag 2026-08-02 (Vollaudit):**
nach Phase 4 und 5 sind es 217/217 — die 156 war zum Zeitpunkt des Auftrags
bereits veraltet (AUDIT-031).
```

durch (Platzhalter `<N>` durch den in Step 1 gemessenen Wert ersetzen):

```
156/156 Tests grün bei Phase-3-Abschluss. **Nachtrag 2026-08-02 (Vollaudit):**
nach Phase 4 und 5 waren es 217/217 — die 156 war zum Zeitpunkt des Auftrags
bereits veraltet (AUDIT-031). **Nachtrag 2026-08-05 (Nachaudit, NACHAUDIT-03):**
<N>/<N>. Diese Zahl veraltet mit jeder neuen Testdatei erneut — als
Fortschrittsindikator lesen, nicht als exakten Sollwert; für den aktuellen
Stand `npm test` ausführen statt dieser Zeile zu vertrauen.
```

- [ ] **Step 3: Commit**

```bash
git add docs/planning/klassifikations-konsistenz-roadmap.md
git commit -m "$(cat <<'EOF'
docs: Testanzahl in der Roadmap aktualisiert (NACHAUDIT-03)

217/217 war bei Phase-3-Abschluss bereits wieder veraltet (aktuell <N>/<N>,
fuenf neue Testdateien aus der Setup-Route-Fix-Welle). Ergaenzt einen
Hinweis, dass die Zahl generell driftet, statt sie erneut einzeln
nachzuziehen - derselbe Mechanismus wie beim urspruenglichen AUDIT-031.

Nachaudit 2026-08-04, NACHAUDIT-03.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Phase-1-Abnahmekriterium präzisieren (NACHAUDIT-04)

**Files:**
- Modify: `docs/planning/klassifikations-konsistenz-roadmap.md:135-142`

**Hintergrund:** AUDIT-019 (Erstaudit,
`docs/audit/paperless-jo-full-project-audit-2026-08-02.md:892-915`) begründet
mit drei unabhängigen Ursachen (wachsende Bestandslisten zwischen Läufen,
fehlendes `ordering` in zwei von drei Listenabfragen — inzwischen behoben —,
promptlängenabhängiges `num_ctx`), warum vollständiger Determinismus über
Läufe hinweg mit diesem Design strukturell nicht erreichbar ist, und
empfiehlt wörtlich: „die Abnahmedefinition von Phase 1 auf ‚identische
Ergebnisse bei identischem Bestand' präzisieren."

- [ ] **Step 1: Abnahmekriterium umformulieren**

Ersetze in `docs/planning/klassifikations-konsistenz-roadmap.md`
(Zeilen 135-142):

```
**Abnahmekriterium:** dasselbe Dokument zweimal über
`scripts/dry-run-eval.js --repeat 2` verarbeitet liefert ein identisches
Ergebnis (gemessene Baseline vor Phase 1: 10 von 10 Dokumenten instabil), und
die Bestandslisten sind im tatsächlich gesendeten Prompt nachweisbar enthalten
(Prüfung über das bestehende Prompt-Log). Nicht über einen normalen
Serverstart prüfen — `PROCESS_PREDEFINED_DOCUMENTS=yes` und
`DISABLE_AUTOMATIC_PROCESSING` ungesetzt bedeuten: ein Start verarbeitet sofort
Dokumente und schreibt nach Paperless.
```

durch:

```
**Abnahmekriterium (präzisiert 2026-08-05, NACHAUDIT-04):** dasselbe
Dokument zweimal über `scripts/dry-run-eval.js --repeat 2` verarbeitet
liefert identische Ergebnisse **bei identischem Bestand** (Tags,
Korrespondenten, Dokumentarten unverändert zwischen den beiden Läufen), und
die Bestandslisten sind im tatsächlich gesendeten Prompt nachweisbar enthalten
(Prüfung über das bestehende Prompt-Log). Vollständiger Determinismus über
Läufe hinweg *unabhängig* vom Bestand ist mit diesem Design laut AUDIT-019
strukturell nicht erreichbar (wachsende Bestandslisten zwischen Läufen sind
eine legitime Rückkopplung, kein Bug) und ist **kein** Ziel dieses Kriteriums
— der Ausgang über den EntityResolver (Phase 2) ist der Hebel gegen
Inkonsistenz, nicht bitweise Prompt-Determinismus. Gemessene Baseline vor
Phase 1: 10 von 10 Dokumenten instabil; nach Phase 1–5 weiterhin 4 von 10
(Ursache: s. o., nicht durch Sampling behebbar).
Nicht über einen normalen Serverstart prüfen — `PROCESS_PREDEFINED_DOCUMENTS=yes`
und `DISABLE_AUTOMATIC_PROCESSING` ungesetzt bedeuten: ein Start verarbeitet
sofort Dokumente und schreibt nach Paperless.
```

- [ ] **Step 2: Commit**

```bash
git add docs/planning/klassifikations-konsistenz-roadmap.md
git commit -m "$(cat <<'EOF'
docs: Phase-1-Abnahmekriterium auf identischen Bestand praezisiert (NACHAUDIT-04)

Die Roadmap versprach "identisches Ergebnis bei --repeat 2" ohne
Einschraenkung - AUDIT-019 zeigt, dass vollstaendiger Determinismus ueber
Laeufe hinweg mit diesem Design strukturell nicht erreichbar ist (wachsende
Bestandslisten zwischen Laeufen sind eine legitime Rueckkopplung). Setzt
AUDIT-019s eigene Empfehlung um: Kriterium auf "identische Ergebnisse bei
identischem Bestand" praezisiert, damit es nichts mehr verspricht, das laut
eigener Analyse unerreichbar ist.

Nachaudit 2026-08-04, NACHAUDIT-04.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Feature-Flags in README und docker-compose dokumentieren (NACHAUDIT-05)

**Files:**
- Modify: `README.md:65-79` (bestehender Abschnitt „Entity Resolution & Similarity Matching")
- Modify: `docker-compose.yml`

**Rechercheergebnis (2026-08-05):** README.md hat bereits einen Abschnitt
„🔍 Entity Resolution & Similarity Matching (Experimental)", der die drei
Features konzeptionell erklärt und auf die Settings-UI verweist — aber
keinen der zugrunde liegenden Env-Var-Namen nennt. Das ist eine Lücke für
Betreiber, die `data/.env` direkt pflegen (z. B. Docker-Compose-Deployments
ohne Setup-Wizard-Durchlauf) statt über die Settings-UI zu konfigurieren.
`docker-compose.yml` enthält aktuell nur `PUID`/`PGID`/`PAPERLESS_AI_PORT`/
`RAG_SERVICE_*` — keinerlei Klassifikations-Konfiguration, auch nicht die
älteren Variablen. Dieser Task bleibt bewusst auf die drei in NACHAUDIT-05
genannten Flags beschränkt (nicht das gesamte `.env.example` in
`docker-compose.yml` nachziehen — das wäre ein größerer, hier nicht
beauftragter Scope).

- [ ] **Step 1: Env-Var-Namen in README ergänzen**

Ersetze in `README.md` den Abschnitt (Zeilen 65-79):

```markdown
### 🔍 Entity Resolution & Similarity Matching (Experimental)

Configurable from **Settings → Entity Resolution & Similarity Matching**:

- **EntityResolver** — fuzzy-matches AI-suggested tags/correspondents/document
  types against what already exists in Paperless-ngx (trigram similarity)
  instead of always creating a new entity. Tune the auto-merge and judge
  thresholds to your data before relying on it.
- **Embedding Similarity** — adds a second, semantic matching channel via an
  Ollama embedding model (`bge-m3` by default). Requires `ollama pull bge-m3`
  on the Ollama instance used by this app.
- **Document Fingerprint** — reuses a recurring document's tags/document type
  based on content similarity. **Not production-ready** (see the project's
  audit report, AUDIT-003) — leave disabled outside of testing.

Matches below the auto-merge threshold go to the in-app Review Queue
(`/review`) for manual confirmation instead of being applied automatically.
```

durch:

```markdown
### 🔍 Entity Resolution & Similarity Matching (Experimental)

Configurable from **Settings → Entity Resolution & Similarity Matching**, or
directly via `data/.env` (see `.env.example` for the full list with
descriptions — useful for Docker Compose deployments that skip the setup
wizard):

- **EntityResolver** (`ENTITY_RESOLVER_ENABLED`, default `no`) — fuzzy-matches
  AI-suggested tags/correspondents/document types against what already exists
  in Paperless-ngx (trigram similarity) instead of always creating a new
  entity. Tune `ENTITY_RESOLVER_AUTO_THRESHOLD` / `ENTITY_RESOLVER_JUDGE_MIN`
  to your data before relying on it.
- **Embedding Similarity** (`EMBEDDING_SIMILARITY_ENABLED`, default `no`) —
  adds a second, semantic matching channel via an Ollama embedding model
  (`bge-m3` by default). Requires `ollama pull bge-m3` on the Ollama instance
  used by this app. Thresholds: `EMBED_AUTO_THRESHOLD` / `EMBED_JUDGE_MIN`.
- **Document Fingerprint** (`DOCUMENT_FINGERPRINT_ENABLED`, default `no`) —
  reuses a recurring document's tags/document type based on content
  similarity (`FINGERPRINT_SIMILARITY_THRESHOLD`). **Not production-ready**
  (see the project's audit report, AUDIT-003) — leave disabled outside of
  testing.

Matches below the auto-merge threshold go to the in-app Review Queue
(`/review`) for manual confirmation instead of being applied automatically.
```

- [ ] **Step 2: Beispieleinträge in `docker-compose.yml` ergänzen**

Ersetze in `docker-compose.yml` den `environment:`-Block:

```yaml
    environment:
      - PUID=1000
      - PGID=1000
      - PAPERLESS_AI_PORT=${PAPERLESS_AI_PORT:-3000}
      - RAG_SERVICE_URL=http://localhost:8000
      - RAG_SERVICE_ENABLED=true
```

durch:

```yaml
    environment:
      - PUID=1000
      - PGID=1000
      - PAPERLESS_AI_PORT=${PAPERLESS_AI_PORT:-3000}
      - RAG_SERVICE_URL=http://localhost:8000
      - RAG_SERVICE_ENABLED=true
      # Optional, disabled by default - see .env.example for the full list
      # and README.md "Entity Resolution & Similarity Matching" for context.
      # - ENTITY_RESOLVER_ENABLED=no
      # - EMBEDDING_SIMILARITY_ENABLED=no
      # - DOCUMENT_FINGERPRINT_ENABLED=no
```

- [ ] **Step 3: Konsistenz mit `.env.example` prüfen**

```bash
grep -n "ENTITY_RESOLVER_ENABLED\|EMBEDDING_SIMILARITY_ENABLED\|DOCUMENT_FINGERPRINT_ENABLED" .env.example README.md docker-compose.yml
```

Erwartet: alle drei Variablennamen tauchen identisch in allen drei Dateien
auf (keine Tippfehler/Abweichung).

- [ ] **Step 4: Commit**

```bash
git add README.md docker-compose.yml
git commit -m "$(cat <<'EOF'
docs: Feature-Flag-Namen in README und docker-compose ergaenzt (NACHAUDIT-05)

AUDIT-021 hatte die drei neuen Feature-Flags (EntityResolver, Embedding
Similarity, Document Fingerprint) bereits in .env.example und der
Settings-UI dokumentiert. README.md und docker-compose.yml erwaehnten sie
weiterhin nicht - relevant fuer Betreiber, die data/.env direkt pflegen statt
ueber die Settings-UI zu konfigurieren.

Nachaudit 2026-08-04, NACHAUDIT-05.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Fix-Dokumentation versionieren (NACHAUDIT-06)

**Files:** keine Code-Änderung — Verifikation plus Sammel-Commit für Tasks 1–5
und diesen Plan selbst.

**Rechercheergebnis (2026-08-05):** `git ls-files docs/superpowers/` zeigt,
dass alle fünf Implementierungspläne und alle drei Design-Specs unter
`docs/superpowers/` bereits getrackt sind, und `docs/audit/` wurde bereits im
Commit `f25be67` („Added Audits") versioniert. Die im Nachaudit-Text
beschriebenen „neun Implementierungspläne der Fix-Welle
(`docs/superpowers/plans/2026-08-0{2,3,4}-*-audit-*.md`)" existieren unter
diesem Namensmuster **nicht** im aktuellen Arbeitsverzeichnis (`Glob
**/2026-08-0[234]-*audit*.md` → nur die Nachaudit-Datei selbst). NACHAUDIT-06
ist damit für den Hauptteil bereits erledigt oder bezog sich auf einen
Zwischenstand einer anderen Maschine/Session — dieser Task verifiziert den
Ist-Stand statt blind der (veralteten) Beschreibung zu folgen und committet
die in Task 1–5 erzeugten Änderungen sowie diesen Plan.

- [ ] **Step 1: Ist-Stand verifizieren**

```bash
git status --porcelain -uall
git ls-files docs/audit/ docs/superpowers/
```

Erwartet: `docs/audit/` und `docs/superpowers/{plans,specs}/` vollständig
getrackt (kein `??`); die einzigen offenen Änderungen sind die aus Task 1–5
dieses Plans plus dieser Plan-Datei selbst.

- [ ] **Step 2: Falls doch untrackte Doku-Dateien gefunden werden**

Nur falls Step 1 tatsächlich untrackte Dateien unter `docs/` zeigt (z. B. auf
einer anderen Maschine als der, auf der dieser Plan geschrieben wurde):

```bash
git add docs/
git status
```

Vor dem Commit kurz durchsehen, ob wirklich nur Doku-Dateien betroffen sind
(kein `data/`, kein `.env`).

- [ ] **Step 3: Nachaudit-Arbeitsplan als erledigt markieren**

In `docs/audit/2026-08-04-nachaudit-offene-punkte.md`, Zeile 30-32, Checkbox
umstellen:

```
2. [ ] **Dokumentation und Altdaten bereinigen** (AUDIT-018-Altlast, AUDIT-031,
   AUDIT-019-Doku, Doku-Lücken)
   → Risikoarm, unabhängig von Paket 1, guter Lückenfüller.
```

durch:

```
2. [x] **Dokumentation und Altdaten bereinigen** (AUDIT-018-Altlast, AUDIT-031,
   AUDIT-019-Doku, Doku-Lücken)
   → Umgesetzt laut [2026-08-05-nachaudit-paket2-doku-altdaten.md](../superpowers/plans/2026-08-05-nachaudit-paket2-doku-altdaten.md).
```

- [ ] **Step 4: Sammel-Commit**

```bash
git add docs/superpowers/plans/2026-08-05-nachaudit-paket2-doku-altdaten.md docs/audit/2026-08-04-nachaudit-offene-punkte.md
git commit -m "$(cat <<'EOF'
docs: Paket 2 des Nachaudits abgeschlossen (NACHAUDIT-02 bis -07)

Dokumentation und Altdaten bereinigt: PII-Altlast logs/prompt.txt entfernt
(falls vorhanden), Testanzahl und Phase-1-Abnahmekriterium in der Roadmap
korrigiert, Feature-Flags in README/docker-compose dokumentiert. Fix-Doku
war laut Ist-Stand-Pruefung bereits vollstaendig versioniert (NACHAUDIT-06);
Lint-Warnungsdeckel bewusst unveraendert gelassen (NACHAUDIT-07, siehe
Plan-Datei fuer Begruendung).

Nachaudit 2026-08-04, Paket 2.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Lint-Warnungsdeckel — bewusste Nicht-Entscheidung (NACHAUDIT-07)

**Files:** keine Änderung.

**Rechercheergebnis (2026-08-05):** `package.json` trägt weiterhin
`"lint": "eslint . --max-warnings=83"`. Das Nachaudit selbst stuft dies als
optional und niedrige Priorität ein: die Ratsche funktioniert (kein Anstieg
unbemerkt), erzwingt aber eine manuelle Anpassung der Zahl bei jeder neuen
legitimen Warnung.

- [ ] **Step 1: Keine Änderung vornehmen**

Kein Handlungsbedarf — das Nachaudit empfiehlt explizit, dies nur bei
tatsächlichem Alltagsreibungspunkt anzufassen. Diese Entscheidung wird über
Task 6s Sammel-Commit-Nachricht dokumentiert, damit sie nicht erneut als
offener Punkt aufploppt.

---

## Acceptance Criteria

- `logs/prompt.txt` existiert nicht mehr (oder war bereits nicht vorhanden —
  per Task 1 verifiziert).
- `npm test` bleibt vollständig grün, inklusive des optionalen Task 2 falls
  durchgeführt (Default-Verhalten von `promptLogging.logDir` unverändert
  `'./logs'`).
- `docs/planning/klassifikations-konsistenz-roadmap.md` nennt die tatsächlich
  gemessene aktuelle Testanzahl statt „217/217", und das Phase-1-
  Abnahmekriterium verspricht keinen bestandsunabhängigen Determinismus mehr.
- `README.md` und `docker-compose.yml` nennen `ENTITY_RESOLVER_ENABLED`,
  `EMBEDDING_SIMILARITY_ENABLED`, `DOCUMENT_FINGERPRINT_ENABLED` konsistent
  mit `.env.example`.
- `docs/audit/2026-08-04-nachaudit-offene-punkte.md` markiert Paket 2 als
  erledigt mit Verweis auf diesen Plan.
- Kein Task dieses Plans ändert Produktionsverhalten bei unveränderter
  `data/.env` (Task 2 ist rein additiv am Default).
