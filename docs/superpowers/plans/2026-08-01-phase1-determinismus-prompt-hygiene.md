# Phase 1: Determinismus und Prompt-Hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Ollama-Klassifikation liefert bei identischem Dokument ein identisches Ergebnis, erhält die Bestandslisten nachweislich vollständig im Prompt, und liefert plausible Tags sowie ein normiertes Datum statt gelegentlich Freitext-Fragmente oder falscher Datumsformate.

**Architecture:** Sampling wird auf greedy decoding mit festem Seed umgestellt und über Env konfigurierbar. Der Prompt wird korrekt in `system` (Anweisungen, Formatvorgabe, Bestandslisten) und `prompt` (nur Dokumententext) getrennt. Das Kontextfenster wird aus beiden Teilen berechnet; bei Überlauf kürzen wir bewusst nur den Dokumententext. Drei Bugs, die den Kontext stillschweigend beschädigen, werden behoben. Zwei defensive Nachbearbeitungsfilter fangen ab, was Prompt-Anweisungen allein nicht zuverlässig verhindern: Tags, die eigentlich extrahierte Datenwerte sind, und Datumsangaben in einem anderen Format als `YYYY-MM-DD`.

**Baseline (2026-08-01, 10 Dokumente, repeat 2, vor dieser Phase):** 10 von 10 wiederholten Dokumenten lieferten unterschiedliche Ergebnisse — bis hin zu unterschiedlichen erfundenen Werten in `custom_fields` zwischen zwei Läufen desselben Dokuments. Diese Zahl ist der Maßstab, an dem Task 3 (Determinismus) gemessen wird. Details: `data/eval/dryrun-baseline-*.json` (nicht in git, personenbezogene Daten).

**Tech Stack:** Node.js 22 (CommonJS), Express, axios, `node:test` als Test-Runner (keine neue Dependency).

**Spec:** [../specs/2026-08-01-klassifikations-konsistenz-design.md](../specs/2026-08-01-klassifikations-konsistenz-design.md), Abschnitt „Phase 1"

## Global Constraints

- Node.js ≥ 22 (`node:test`, `node --test`). Vorhanden: v22.14.0.
- **Keine neuen Runtime-Dependencies.** Keine neue devDependency.
- CommonJS (`require`/`module.exports`), kein ESM. Bestehender Stil.
- Log-Präfixe wie im Bestand: `[DEBUG]`, `[ERROR]`, `[WARNING]`.
- `data/.env` enthält echte Zugangsdaten. Weder Tests noch Logs noch Commit-Nachrichten dürfen Werte daraus ausgeben. Tests setzen ihre Env-Variablen selbst und verlassen sich nie auf `data/.env`.
- Jede Änderung muss bei **fehlenden** Env-Variablen ein Verhalten liefern, das zum heutigen Stand passt oder es verbessert — nie einen Absturz.
- **Vor Task 1:** `git checkout docs/klassifikations-konsistenz` — dieser Branch trägt Spec, Roadmap, diesen Plan sowie den bereits gebauten Dry-Run-Harness (`scripts/dry-run-eval.js`, `scripts/export-entity-fixture.js`). Der Branch ist rein lokal, hat keinen Remote-Tracking-Branch. Task 1, Step 1 zweigt von dort auf `feat/phase1-determinismus` ab.
- `data/.env` muss vorhanden sein, `PAPERLESS_API_URL` muss auf `/api` enden (sonst liefert Paperless die Login-Seite statt JSON). Mit `node scripts/dry-run-eval.js --limit 1` lässt sich das vorab prüfen, ohne etwas zu verändern.
- Token-Schätzung bleibt bei `Math.ceil(length / 4)`. Genauere Zählung ist ausdrücklich nicht Teil dieser Phase.

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `package.json` | `npm test` → `node --test test/`, bisheriges Verhalten → `npm run dev` | Modify |
| `test/restrictionPrompt.test.js` | Platzhalter-Ersetzung | Create |
| `test/ollamaOptions.test.js` | Sampling-Optionen im API-Body | Create |
| `test/ollamaPrompt.test.js` | Aufteilung system/user, keine Config-Mutation | Create |
| `test/ollamaContext.test.js` | Kontextfenster und kontrollierte Kürzung | Create |
| `test/configParse.test.js` | `parseEnvNumber` | Create |
| `test/ollamaTagFilter.test.js` | Tags, die wie extrahierte Datenwerte statt Kategorien aussehen, werden verworfen | Create |
| `test/ollamaDateNormalize.test.js` | `document_date` wird auf `YYYY-MM-DD` normiert oder verworfen | Create |
| `services/restrictionPromptService.js` | Platzhalter-Ersetzung, ein gemeinsamer Listen-Formatierer | Modify |
| `services/ollamaService.js` | Prompt-Bau, Kontextfenster, API-Optionen, Tag-Filter, Datumsnormierung | Modify |
| `services/openaiService.js` | nur Aufrufstelle anpassen | Modify |
| `services/azureService.js` | nur Aufrufstelle anpassen | Modify |
| `config/config.js` | Ollama-Sampling-Defaults, `parseEnvNumber`, Log-Maskierung | Modify |
| `test-restriction-service.js` | veraltetes Ad-hoc-Skript, ersetzt durch `test/` | Delete |
| `test-updated-service.js` | veraltetes Ad-hoc-Skript, ersetzt durch `test/` | Delete |

**Warum `node --test test/` und nicht `node --test`:** Node erkennt Testdateien unter anderem am Muster `test-*.js`. Die beiden Ad-hoc-Skripte im Wurzelverzeichnis würden sonst als Tests ausgeführt. Sie werden in Task 2 gelöscht, aber die Pfad-Einschränkung bleibt als Absicherung.

---

### Task 1: Test-Infrastruktur und String-Arrays in `%RESTRICTED_TAGS%`

`server.js:369` übergibt Tag-**Namen** (Strings), `_formatTagsList` filtert aber auf `tag.name`. Ergebnis: der Platzhalter löst zu Leerstring auf. Die Testinfrastruktur wird hier mit eingerichtet, weil dieser Fix sie als Erster braucht.

**Files:**
- Modify: `package.json`
- Modify: `services/restrictionPromptService.js:49-58`
- Test: `test/restrictionPrompt.test.js` (create)

**Interfaces:**
- Consumes: nichts
- Produces: `npm test` führt `node --test test/` aus. `RestrictionPromptService._formatTagsList(input: Array<string|{name:string}>) → string`

- [ ] **Step 1: Branch anlegen**

```bash
git checkout -b feat/phase1-determinismus
```

- [ ] **Step 2: Test-Skripte in `package.json` eintragen**

Ersetze in `package.json` den `scripts`-Block:

```json
  "scripts": {
    "test": "node --test test/",
    "dev": "nodemon server.js",
    "start": "node server.js"
  },
```

- [ ] **Step 3: Den fehlschlagenden Test schreiben**

Neue Datei `test/restrictionPrompt.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const RestrictionPromptService = require('../services/restrictionPromptService');

test('%RESTRICTED_TAGS% wird aus einem String-Array befuellt', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    ['Rechnung', 'Versicherung'],
    [],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: Rechnung, Versicherung');
});

test('%RESTRICTED_TAGS% akzeptiert weiterhin ein Objekt-Array', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    [{ id: 1, name: 'Rechnung' }, { id: 2, name: 'Versicherung' }],
    [],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: Rechnung, Versicherung');
});

test('%RESTRICTED_TAGS% wird bei leerer Liste zu Leerstring', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Tags: %RESTRICTED_TAGS%',
    [],
    [],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Tags: ');
});
```

- [ ] **Step 4: Test ausführen, Fehlschlag bestätigen**

Run: `npm test`
Expected: FAIL — der erste Test meldet `Erlaubte Tags: ` statt `Erlaubte Tags: Rechnung, Versicherung`. Die Tests 2 und 3 bestehen bereits.

- [ ] **Step 5: `_formatTagsList` implementieren**

Ersetze in `services/restrictionPromptService.js` die Methode `_formatTagsList` (Zeilen 49-58) vollständig:

```js
  static _formatTagsList(existingTags) {
    if (!Array.isArray(existingTags) || existingTags.length === 0) {
      return '';
    }

    return existingTags
      .filter(Boolean)
      .map(tag => (typeof tag === 'string' ? tag : tag?.name || ''))
      .filter(name => name.length > 0)
      .join(', ');
  }
```

- [ ] **Step 6: Test ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 3 Tests bestehen.

- [ ] **Step 7: Commit**

```bash
git add package.json test/restrictionPrompt.test.js services/restrictionPromptService.js
git commit -m "fix: %RESTRICTED_TAGS% akzeptiert String-Arrays

server.js uebergibt Tag-Namen als Strings, _formatTagsList filterte aber
auf tag.name und lieferte deshalb immer einen Leerstring.

Richtet zugleich node:test als Test-Runner ein.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Platzhalter für Dokumentarten und korrekte Signatur

`processRestrictionsInPrompt` ist mit vier Parametern deklariert, wird aber von `ollamaService` und `customService` mit fünf aufgerufen — die Dokumentarten landen still auf `config`. `openaiService` und `azureService` rufen mit vier auf und müssen mitgezogen werden. Zugleich werden `_formatTagsList` und `_formatCorrespondentsList` zu einem gemeinsamen Formatierer zusammengefasst; sie tun nach Task 1 dasselbe.

**Files:**
- Modify: `services/restrictionPromptService.js` (ganze Datei)
- Modify: `services/openaiService.js:129-134`
- Modify: `services/azureService.js:120-125`
- Delete: `test-restriction-service.js`, `test-updated-service.js`
- Test: `test/restrictionPrompt.test.js` (erweitern)

**Interfaces:**
- Consumes: `RestrictionPromptService._formatTagsList` aus Task 1
- Produces: `processRestrictionsInPrompt(prompt: string, existingTags: Array, existingCorrespondentList: Array|string, existingDocumentTypes: Array, config: object) → string`, neuer Platzhalter `%RESTRICTED_DOCUMENT_TYPES%`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Hänge an `test/restrictionPrompt.test.js` an:

```js
test('%RESTRICTED_DOCUMENT_TYPES% wird aus einem String-Array befuellt', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Erlaubte Dokumentarten: %RESTRICTED_DOCUMENT_TYPES%',
    [],
    [],
    ['Rechnung', 'Gehaltsabrechnung'],
    {}
  );

  assert.strictEqual(result, 'Erlaubte Dokumentarten: Rechnung, Gehaltsabrechnung');
});

test('%RESTRICTED_DOCUMENT_TYPES% akzeptiert ein Objekt-Array', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'Dokumentarten: %RESTRICTED_DOCUMENT_TYPES%',
    [],
    [],
    [{ id: 7, name: 'Rechnung' }],
    {}
  );

  assert.strictEqual(result, 'Dokumentarten: Rechnung');
});

test('alle drei Platzhalter werden in einem Prompt ersetzt', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'T:%RESTRICTED_TAGS% K:%RESTRICTED_CORRESPONDENTS% D:%RESTRICTED_DOCUMENT_TYPES%',
    ['Steuer'],
    ['Finanzamt'],
    ['Bescheid'],
    {}
  );

  assert.strictEqual(result, 'T:Steuer K:Finanzamt D:Bescheid');
});

test('Korrespondenten koennen als vorformatierter String kommen', () => {
  const result = RestrictionPromptService.processRestrictionsInPrompt(
    'K: %RESTRICTED_CORRESPONDENTS%',
    [],
    '  Finanzamt, Stadtwerke  ',
    [],
    {}
  );

  assert.strictEqual(result, 'K: Finanzamt, Stadtwerke');
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `npm test`
Expected: FAIL — `%RESTRICTED_DOCUMENT_TYPES%` bleibt unersetzt im Ergebnis stehen.

- [ ] **Step 3: `restrictionPromptService.js` neu schreiben**

Ersetze den **gesamten** Inhalt von `services/restrictionPromptService.js`:

```js
/**
 * Service for handling placeholder replacement in prompts
 * Used by all LLM services to ensure consistent placeholder handling
 */
class RestrictionPromptService {
  /**
   * Process placeholders in a prompt by replacing them with actual data
   * @param {string} prompt - The original prompt that may contain placeholders
   * @param {Array} existingTags - Existing tags, as strings or {name} objects
   * @param {Array|string} existingCorrespondentList - Existing correspondents
   * @param {Array} existingDocumentTypes - Existing document types
   * @param {Object} config - Configuration object (unused, kept for compatibility)
   * @returns {string} - Prompt with placeholders replaced
   */
  static processRestrictionsInPrompt(
    prompt,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypes,
    config
  ) {
    let processedPrompt = prompt;

    if (processedPrompt.includes('%RESTRICTED_TAGS%')) {
      processedPrompt = processedPrompt.replace(
        /%RESTRICTED_TAGS%/g,
        this._formatNameList(existingTags)
      );
    }

    if (processedPrompt.includes('%RESTRICTED_CORRESPONDENTS%')) {
      processedPrompt = processedPrompt.replace(
        /%RESTRICTED_CORRESPONDENTS%/g,
        this._formatNameList(existingCorrespondentList)
      );
    }

    if (processedPrompt.includes('%RESTRICTED_DOCUMENT_TYPES%')) {
      processedPrompt = processedPrompt.replace(
        /%RESTRICTED_DOCUMENT_TYPES%/g,
        this._formatNameList(existingDocumentTypes)
      );
    }

    return processedPrompt;
  }

  /**
   * Format a list of entities into a comma-separated string.
   * Accepts an array of strings, an array of {name} objects, a mixed array,
   * or an already formatted string.
   * @param {Array|string} list
   * @returns {string} - Comma-separated names, or empty string
   */
  static _formatNameList(list) {
    if (!list) {
      return '';
    }

    if (typeof list === 'string') {
      return list.trim();
    }

    if (!Array.isArray(list)) {
      return '';
    }

    return list
      .filter(Boolean)
      .map(entry => (typeof entry === 'string' ? entry : entry?.name || ''))
      .filter(name => name.length > 0)
      .join(', ');
  }

  /**
   * @deprecated Use _formatNameList. Kept as a named entry point for tags.
   */
  static _formatTagsList(existingTags) {
    return this._formatNameList(existingTags);
  }

  /**
   * @deprecated Use _formatNameList. Kept as a named entry point for correspondents.
   */
  static _formatCorrespondentsList(existingCorrespondentList) {
    return this._formatNameList(existingCorrespondentList);
  }
}

module.exports = RestrictionPromptService;
```

- [ ] **Step 4: Aufrufstelle in `openaiService.js` korrigieren**

Ersetze in `services/openaiService.js` (Zeilen 129-134):

```js
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        config
      );
```

durch:

```js
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList,
        config
      );
```

- [ ] **Step 5: Aufrufstelle in `azureService.js` korrigieren**

Ersetze in `services/azureService.js` (Zeilen 120-125) exakt denselben Block durch:

```js
      systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
        systemPrompt,
        existingTags,
        existingCorrespondentList,
        existingDocumentTypesList,
        config
      );
```

- [ ] **Step 6: Prüfen, dass keine Aufrufstelle übersehen wurde**

Run: `grep -rn "processRestrictionsInPrompt" --include=*.js services/ routes/ server.js`
Expected: vier Aufrufstellen (`ollamaService`, `customService`, `openaiService`, `azureService`) plus die Deklaration; alle vier übergeben fünf Argumente.

- [ ] **Step 7: Veraltete Ad-hoc-Skripte löschen**

```bash
git rm test-restriction-service.js test-updated-service.js
```

- [ ] **Step 8: Tests ausführen**

Run: `npm test`
Expected: PASS — 7 Tests bestehen.

- [ ] **Step 9: Commit**

```bash
git add services/restrictionPromptService.js services/openaiService.js services/azureService.js test/restrictionPrompt.test.js
git commit -m "fix: Dokumentarten-Platzhalter und korrekte Signatur

processRestrictionsInPrompt war mit vier Parametern deklariert, wurde aber
mit fuenf aufgerufen; Dokumentarten fielen still auf den config-Parameter.
Ergaenzt %RESTRICTED_DOCUMENT_TYPES% und zieht openai- und azureService
auf die neue Signatur nach.

Ersetzt die beiden Ad-hoc-Skripte im Wurzelverzeichnis durch echte Tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Deterministisches Sampling, konfigurierbar

`temperature: 0.7` und ein fehlender `seed` sind die größte Einzelursache für unterschiedliche Ergebnisse bei identischem Dokument.

**Files:**
- Modify: `config/config.js:7-11` (Helper), `config/config.js:76-79` (Ollama-Block), `config/config.js:54` (Export)
- Modify: `services/ollamaService.js:542-564` (`_callOllamaAPI`)
- Test: `test/configParse.test.js` (create), `test/ollamaOptions.test.js` (create)

**Interfaces:**
- Consumes: nichts
- Produces: `config.ollama.temperature: number`, `config.ollama.seed: number`, `config.ollama.numPredict: number`, `config.ollama.numCtxMax: number`, `config._parseEnvNumber(value, default) → number`

- [ ] **Step 1: Den fehlschlagenden Test für `parseEnvNumber` schreiben**

Neue Datei `test/configParse.test.js`:

```js
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
```

- [ ] **Step 2: Den fehlschlagenden Test für die API-Optionen schreiben**

Neue Datei `test/ollamaOptions.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaService = require('../services/ollamaService');

function captureRequest() {
  const captured = {};
  ollamaService.client = {
    post: async (url, body) => {
      captured.url = url;
      captured.body = body;
      return { data: { response: { title: 'x' } } };
    }
  };
  return captured;
}

test('_callOllamaAPI sendet greedy-decoding Optionen', async () => {
  config.ollama.temperature = 0;
  config.ollama.seed = 42;
  config.ollama.numPredict = 512;

  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 4096, { type: 'object' });

  assert.strictEqual(captured.body.options.temperature, 0);
  assert.strictEqual(captured.body.options.seed, 42);
  assert.strictEqual(captured.body.options.top_p, 1);
  assert.strictEqual(captured.body.options.num_predict, 512);
  assert.strictEqual(captured.body.options.num_ctx, 4096);
});

test('_callOllamaAPI setzt kein top_k mehr', async () => {
  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 4096, { type: 'object' });

  assert.ok(!('top_k' in captured.body.options), 'top_k darf nicht gesetzt sein');
});

test('_callOllamaAPI uebernimmt konfigurierte Werte', async () => {
  config.ollama.temperature = 0.25;
  config.ollama.seed = 7;
  config.ollama.numPredict = 900;

  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 2048, { type: 'object' });

  assert.strictEqual(captured.body.options.temperature, 0.25);
  assert.strictEqual(captured.body.options.seed, 7);
  assert.strictEqual(captured.body.options.num_predict, 900);
});

test('_callOllamaAPI trennt system und prompt', async () => {
  const captured = captureRequest();
  await ollamaService._callOllamaAPI('DOKUMENT', 'SYSTEM', 2048, { type: 'object' });

  assert.strictEqual(captured.body.prompt, 'DOKUMENT');
  assert.strictEqual(captured.body.system, 'SYSTEM');
  assert.strictEqual(captured.body.stream, false);
});
```

- [ ] **Step 3: Tests ausführen, Fehlschlag bestätigen**

Run: `npm test`
Expected: FAIL — `config._parseEnvNumber is not a function`, und die Options-Tests melden `temperature` 0.7 statt 0 sowie ein gesetztes `top_k`.

- [ ] **Step 4: `parseEnvNumber` in `config/config.js` ergänzen**

Füge unmittelbar nach dem Block `parseEnvBoolean` (nach Zeile 11) ein:

```js
// Helper function to parse numeric env vars with a fallback
const parseEnvNumber = (value, defaultValue) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};
```

- [ ] **Step 5: Ollama-Block in `config/config.js` erweitern**

Ersetze in `config/config.js` den `ollama`-Block im Export:

```js
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2'
  },
```

durch:

```js
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    // Deterministic defaults: classification is a labelling task, not a
    // creative one. Same document must yield the same answer.
    temperature: parseEnvNumber(process.env.OLLAMA_TEMPERATURE, 0),
    seed: parseEnvNumber(process.env.OLLAMA_SEED, 42),
    numPredict: parseEnvNumber(process.env.OLLAMA_NUM_PREDICT, 512),
    numCtxMax: parseEnvNumber(process.env.OLLAMA_NUM_CTX_MAX, 8192)
  },
```

- [ ] **Step 6: Helper exportieren**

Ersetze in `config/config.js` die erste Zeile des Exportobjekts:

```js
  PAPERLESS_AI_VERSION: '3.0.9',
```

durch:

```js
  PAPERLESS_AI_VERSION: '3.0.9',
  // Exported for unit tests
  _parseEnvNumber: parseEnvNumber,
```

- [ ] **Step 7: `_callOllamaAPI` umstellen**

Ersetze in `services/ollamaService.js` den Body von `_callOllamaAPI` (Zeilen 543-557):

```js
        const response = await this.client.post(`${this.apiUrl}/api/generate`, {
            model: this.model,
            prompt: prompt,
            system: systemPrompt,
            stream: false,
            format: schema,
            options: {
                temperature: 0.7,
                top_p: 0.9,
                repeat_penalty: 1.1,
                top_k: 7,
                num_predict: 256,
                num_ctx: numCtx
            }
        });
```

durch:

```js
        const response = await this.client.post(`${this.apiUrl}/api/generate`, {
            model: this.model,
            prompt: prompt,
            system: systemPrompt,
            stream: false,
            format: schema,
            options: {
                temperature: config.ollama.temperature,
                seed: config.ollama.seed,
                top_p: 1,
                repeat_penalty: 1.1,
                num_predict: config.ollama.numPredict,
                num_ctx: numCtx
            }
        });
```

- [ ] **Step 8: Tests ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 18 Tests bestehen.

- [ ] **Step 9: Commit**

```bash
git add config/config.js services/ollamaService.js test/configParse.test.js test/ollamaOptions.test.js
git commit -m "feat: deterministisches Sampling fuer die Klassifikation

temperature 0 und fester seed statt temperature 0.7 ohne seed. top_k
entfaellt, bei greedy decoding wirkungslos. num_predict von 256 auf 512,
damit die Antwort bei vielen Tags und Custom Fields nicht abbricht.
Alle vier Werte ueber Env konfigurierbar.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Mutation von `config.mustHavePrompt` beseitigen

`ollamaService.js:320` schreibt das Ergebnis der Platzhalter-Ersetzung zurück ins geteilte Config-Objekt. Nach dem ersten Dokument ist `%CUSTOMFIELDS%` dauerhaft verbraucht; ändert man die Custom Fields später über die Settings-UI, bekommen alle Folgedokumente die alte Vorlage.

**Files:**
- Modify: `services/ollamaService.js:319-323`
- Test: `test/ollamaPrompt.test.js` (create)

**Interfaces:**
- Consumes: nichts
- Produces: `config.mustHavePrompt` behält den Platzhalter `%CUSTOMFIELDS%` über beliebig viele Aufrufe

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Neue Datei `test/ollamaPrompt.test.js`:

```js
process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [{ value: 'Betrag' }] });
process.env.SYSTEM_PROMPT = 'Du bist ein Dokumentenanalyst.';
process.env.USE_PROMPT_TAGS = 'no';

const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaService = require('../services/ollamaService');

test('config.mustHavePrompt wird durch _buildPrompt nicht mutiert', () => {
  config.useExistingData = 'no';
  const before = config.mustHavePrompt;
  assert.ok(before.includes('%CUSTOMFIELDS%'), 'Vorbedingung: Platzhalter vorhanden');

  ollamaService._buildPrompt('Inhalt A', ['Rechnung'], ['Finanzamt'], ['Bescheid'], {});
  ollamaService._buildPrompt('Inhalt B', ['Rechnung'], ['Finanzamt'], ['Bescheid'], {});

  assert.strictEqual(config.mustHavePrompt, before);
  assert.ok(config.mustHavePrompt.includes('%CUSTOMFIELDS%'));
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test test/ollamaPrompt.test.js`
Expected: FAIL — `config.mustHavePrompt` enthält nach dem ersten Aufruf kein `%CUSTOMFIELDS%` mehr.

- [ ] **Step 3: Mutation entfernen**

Ersetze in `services/ollamaService.js` die Zeilen 319-323:

```js
        } else {
            config.mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
            systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt;
            promptTags = '';
        }
```

durch:

```js
        } else {
            const mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
            systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + mustHavePrompt;
            promptTags = '';
        }
```

- [ ] **Step 4: Test ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 19 Tests bestehen.

- [ ] **Step 5: Commit**

```bash
git add services/ollamaService.js test/ollamaPrompt.test.js
git commit -m "fix: _buildPrompt mutiert das geteilte Config-Objekt nicht mehr

config.mustHavePrompt wurde in-place ersetzt; der %CUSTOMFIELDS%-Platzhalter
war nach dem ersten Dokument dauerhaft verbraucht.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Prompt korrekt in `system` und `prompt` trennen

Heute landet der deutsche `SYSTEM_PROMPT` im `prompt`-Feld, während ein hartkodierter englischer Analyzer-Prompt ins `system`-Feld geht. Das Modell bekommt zwei teils widersprüchliche Anweisungssätze in zwei Sprachen, jeder mit eigener JSON-Vorlage. Nebenbei wird ein weiterer Bug behoben: `_validateAndTruncateExternalApiData` ist `async`, wird in `_buildPrompt` aber ohne `await` aufgerufen und hängt deshalb `[object Promise]` an den Prompt. Die Methode enthält kein `await` und wird synchron gemacht.

**Files:**
- Modify: `services/ollamaService.js` — Methoden `analyzeDocument`, `_buildPrompt`, `_validateAndTruncateExternalApiData`, `_generateSystemPrompt`, `_logPromptAndResponse`
- Test: `test/ollamaPrompt.test.js` (erweitern)

**Interfaces:**
- Consumes: `RestrictionPromptService.processRestrictionsInPrompt` mit fünf Argumenten aus Task 2
- Produces: `_buildPrompt(content, existingTags, existingCorrespondent, existingDocumentTypes, options) → { system: string, user: string }`; `_defaultAnalyzerPrompt() → string`; `_logPromptAndResponse(system, user, response) → Promise<void>`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Hänge an `test/ollamaPrompt.test.js` an:

```js
test('_buildPrompt liefert getrennte system- und user-Teile', () => {
  config.useExistingData = 'no';
  const { system, user } = ollamaService._buildPrompt(
    'Rechnungstext', ['Rechnung'], ['Finanzamt'], ['Bescheid'], {}
  );

  assert.strictEqual(typeof system, 'string');
  assert.strictEqual(typeof user, 'string');
  assert.strictEqual(user, JSON.stringify('Rechnungstext'));
});

test('der system-Teil enthaelt den SYSTEM_PROMPT und die Formatvorgabe', () => {
  config.useExistingData = 'no';
  const { system } = ollamaService._buildPrompt('Text', [], [], [], {});

  assert.ok(system.includes('Du bist ein Dokumentenanalyst.'));
  assert.ok(system.includes('"document_date"'));
});

test('der user-Teil enthaelt keine Anweisungen', () => {
  config.useExistingData = 'no';
  const { user } = ollamaService._buildPrompt('Text', ['Rechnung'], [], [], {});

  assert.ok(!user.includes('Du bist ein Dokumentenanalyst.'));
  assert.ok(!user.includes('"document_date"'));
  assert.ok(!user.includes('Rechnung'));
});

test('bei useExistingData=yes stehen die Bestandslisten im system-Teil', () => {
  config.useExistingData = 'yes';
  config.restrictToExistingTags = 'no';
  config.restrictToExistingCorrespondents = 'no';

  const { system, user } = ollamaService._buildPrompt(
    'Text', ['Rechnung', 'Steuer'], ['Finanzamt'], ['Bescheid'], {}
  );

  assert.ok(system.includes('Rechnung'));
  assert.ok(system.includes('Finanzamt'));
  assert.ok(system.includes('Bescheid'));
  assert.ok(!user.includes('Finanzamt'));

  config.useExistingData = 'no';
});

test('Bestandslisten funktionieren auch mit Objekt-Arrays', () => {
  config.useExistingData = 'yes';

  const { system } = ollamaService._buildPrompt(
    'Text', ['Rechnung'], [{ id: 1, name: 'Stadtwerke' }], [{ id: 2, name: 'Vertrag' }], {}
  );

  assert.ok(system.includes('Stadtwerke'));
  assert.ok(system.includes('Vertrag'));
  assert.ok(!system.includes('[object Object]'));

  config.useExistingData = 'no';
});

test('leerer SYSTEM_PROMPT faellt auf den Default-Analyzer zurueck', () => {
  config.useExistingData = 'no';
  const original = process.env.SYSTEM_PROMPT;
  process.env.SYSTEM_PROMPT = '   ';

  const { system } = ollamaService._buildPrompt('Text', [], [], [], {});
  assert.ok(system.includes('document analyzer'));
  assert.ok(!system.includes('undefined'));

  process.env.SYSTEM_PROMPT = original;
});

test('externe API-Daten landen als Text im system-Teil, nicht als Promise', () => {
  config.useExistingData = 'no';
  const { system } = ollamaService._buildPrompt(
    'Text', [], [], [], { externalApiData: { kunde: 'Muster' } }
  );

  assert.ok(!system.includes('[object Promise]'));
  assert.ok(system.includes('Muster'));
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test test/ollamaPrompt.test.js`
Expected: FAIL — `_buildPrompt` gibt einen String zurück, `system` und `user` sind `undefined`.

> **Ab hier keine Zeilennummern mehr.** Die vorangegangenen Tasks haben
> `services/ollamaService.js` bereits verändert; alle folgenden Schritte
> identifizieren Code über Methodennamen und exakte Textblöcke.

- [ ] **Step 3: `_buildPrompt` ersetzen**

Ersetze in `services/ollamaService.js` die **gesamte** Methode `_buildPrompt` samt JSDoc-Block durch:

```js
    /**
     * Build the system and user halves of the prompt.
     * The system half carries all instructions, the format template and the
     * pre-existing entity lists. The user half carries only the document text,
     * so that truncation can never eat the instructions.
     *
     * @param {string} content - Document content
     * @param {Array} existingTags - Existing tags
     * @param {Array} existingCorrespondent - Existing correspondents
     * @param {Array} existingDocumentTypes - Existing document types
     * @param {Object} options - May carry externalApiData
     * @returns {{system: string, user: string}}
     */
    _buildPrompt(content, existingTags = [], existingCorrespondent = [], existingDocumentTypes = [], options = {}) {
        const correspondentList = Array.isArray(existingCorrespondent) ? existingCorrespondent : [];
        const customFieldsStr = this._generateCustomFieldsTemplate();
        const mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
        const basePrompt = (process.env.SYSTEM_PROMPT || '').trim() || this._defaultAnalyzerPrompt();

        let systemPrompt;

        if (config.useExistingData === 'yes'
            && config.restrictToExistingTags === 'no'
            && config.restrictToExistingCorrespondents === 'no') {
            const tagList = RestrictionPromptService._formatNameList(existingTags);
            const correspondentNames = RestrictionPromptService._formatNameList(correspondentList);
            const documentTypeNames = RestrictionPromptService._formatNameList(existingDocumentTypes);

            systemPrompt = `Pre-existing tags: ${tagList}\n\n`
                + `Pre-existing correspondents: ${correspondentNames}\n\n`
                + `Pre-existing document types: ${documentTypeNames}\n\n`
                + `${basePrompt}\n\n${mustHavePrompt}`;
        } else {
            systemPrompt = `${basePrompt}\n\n${mustHavePrompt}`;
        }

        systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
            systemPrompt,
            existingTags,
            correspondentList,
            existingDocumentTypes,
            config
        );

        if (options.externalApiData) {
            try {
                const validated = this._validateAndTruncateExternalApiData(options.externalApiData);
                if (validated) {
                    systemPrompt += `\n\nAdditional context from external API:\n${validated}`;
                    console.log('[DEBUG] External API data validated and included');
                }
            } catch (error) {
                console.warn('[WARNING] External API data validation failed:', error.message);
            }
        }

        if (process.env.USE_PROMPT_TAGS === 'yes') {
            systemPrompt = `Take these tags and try to match one or more to the document content.\n\n`
                + config.specialPromptPreDefinedTags;
        }

        return { system: systemPrompt, user: JSON.stringify(content) };
    }
```

- [ ] **Step 4: `_validateAndTruncateExternalApiData` synchron machen**

Ersetze in `services/ollamaService.js` die Signaturzeile der Methode
`_validateAndTruncateExternalApiData`:

```js
    async _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
```

durch:

```js
    _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
```

- [ ] **Step 5: `_generateSystemPrompt` in `_defaultAnalyzerPrompt` umwandeln**

Ersetze in `services/ollamaService.js` die **gesamte** Methode `_generateSystemPrompt` samt ihrem JSDoc-Block durch:

```js
    /**
     * Fallback instructions used when SYSTEM_PROMPT is not configured.
     * Deliberately carries no JSON template: config.mustHavePrompt supplies it,
     * and two competing templates confused the model.
     * @returns {string}
     */
    _defaultAnalyzerPrompt() {
        return `You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions.
YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
YOU MUSTNOT: Return a response without the desired JSON format.
The tags, title and document_type MUST be in the language used in the document.
The custom_fields are optional; only fill in values you actually find in the document.`;
    }
```

- [ ] **Step 6: `analyzeDocument` auf die neue Struktur umstellen**

Ersetze in `services/ollamaService.js` in `analyzeDocument` den zusammenhängenden Block, der mit dem Kommentar `// Build prompt` beginnt und mit der Zeile `const parsedResponse = this._processOllamaResponse(response);` endet, durch:

```js
            // Build prompt: instructions go to `system`, document text to `prompt`
            let system;
            let user;
            if (!customPrompt) {
                ({ system, user } = this._buildPrompt(
                    content, existingTags, existingCorrespondentList, existingDocumentTypesList, options
                ));
            } else {
                const customFieldsStr = this._generateCustomFieldsTemplate();
                system = customPrompt + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
                user = JSON.stringify(content);
                console.log('[DEBUG] Ollama Service started with custom prompt');
            }

            console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
            console.log(`[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`);

            // Fit into the context window (Task 6 replaces this line)
            const numCtx = config.ollama.numCtxMax;

            // Call Ollama API
            const response = await this._callOllamaAPI(user, system, numCtx, this.documentAnalysisSchema);

            // Process response
            const parsedResponse = this._processOllamaResponse(response);
```

- [ ] **Step 7: `_logPromptAndResponse` auf beide Hälften umstellen**

Ersetze in `services/ollamaService.js` die **gesamte** Methode `_logPromptAndResponse` samt JSDoc-Block durch:

```js
    /**
     * Log prompt and response to file
     * @param {string} systemPrompt - System half of the prompt
     * @param {string} userPrompt - User half of the prompt
     * @param {Object} response - Response object
     */
    async _logPromptAndResponse(systemPrompt, userPrompt, response) {
        const content = '================================================================================\n'
            + '--- SYSTEM ---\n' + systemPrompt + '\n\n'
            + '--- USER ---\n' + userPrompt + '\n\n'
            + JSON.stringify(response)
            + '\n\n'
            + '================================================================================\n\n';

        await writePromptToFile(content);
    }
```

Und passe den Aufruf in `analyzeDocument` an — ersetze:

```js
            await this._logPromptAndResponse(prompt, parsedResponse);
```

durch:

```js
            await this._logPromptAndResponse(system, user, parsedResponse);
```

- [ ] **Step 8: Tests ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 26 Tests bestehen.

- [ ] **Step 9: Commit**

```bash
git add services/ollamaService.js test/ollamaPrompt.test.js
git commit -m "refactor: Prompt sauber in system und user trennen

Bisher landete der konfigurierte SYSTEM_PROMPT im prompt-Feld, waehrend ein
hartkodierter englischer Analyzer-Prompt ins system-Feld ging - zwei
konkurrierende Anweisungssaetze mit je eigener JSON-Vorlage.

Neu: system traegt Anweisungen, Formatvorgabe und Bestandslisten, prompt nur
den Dokumententext. Der hartkodierte Prompt bleibt als Fallback fuer den Fall,
dass SYSTEM_PROMPT leer ist.

Behebt nebenbei den fehlenden await auf _validateAndTruncateExternalApiData,
der [object Promise] in den Prompt schrieb; die Methode ist jetzt synchron.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Kontextfenster berechnen und kontrolliert kürzen

`_calculateNumCtx` zählt nur den User-Prompt. Der System-Prompt — der die gesamten Bestandslisten trägt — fehlt in der Rechnung. Passt am Ende nicht alles ins Fenster, kürzt Ollama still am Anfang, also genau bei den Bestandslisten. Neu wird der Bedarf aus beiden Hälften berechnet und bei Überlauf ausschließlich der Dokumententext gekürzt.

**Files:**
- Modify: `services/ollamaService.js` — `_calculateNumCtx` ersetzen, `analyzeDocument`, `analyzePlayground`, `generateText`
- Test: `test/ollamaContext.test.js` (create)

**Interfaces:**
- Consumes: `config.ollama.numCtxMax`, `config.ollama.numPredict` aus Task 3; `_buildPrompt → {system, user}` aus Task 5
- Produces: `_fitPromptToContext(systemPrompt: string, userPrompt: string, numPredict?: number) → { user: string, numCtx: number, truncated: boolean }`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Neue Datei `test/ollamaContext.test.js`:

```js
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
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test test/ollamaContext.test.js`
Expected: FAIL — `ollamaService._fitPromptToContext is not a function`

- [ ] **Step 3: `_calculateNumCtx` durch `_fitPromptToContext` ersetzen**

Ersetze in `services/ollamaService.js` die **gesamte** Methode `_calculateNumCtx` samt JSDoc-Block durch:

```js
    /**
     * Fit the prompt into the context window.
     *
     * The system half is never touched: it carries the instructions, the format
     * template and the pre-existing entity lists. Only the document text is
     * trimmed, and only when it does not fit.
     *
     * @param {string} systemPrompt - System half (protected)
     * @param {string} userPrompt - User half (document text, may be trimmed)
     * @param {number} [numPredict] - Tokens reserved for the response
     * @returns {{user: string, numCtx: number, truncated: boolean}}
     */
    _fitPromptToContext(systemPrompt, userPrompt, numPredict = config.ollama.numPredict) {
        const MIN_CTX = 2048;
        const MIN_DOC_TOKENS = 512;
        const maxCtx = config.ollama.numCtxMax;

        const systemTokens = this._calculatePromptTokenCount(systemPrompt);
        let budget = maxCtx - systemTokens - numPredict;
        let user = userPrompt;
        let truncated = false;

        if (budget < MIN_DOC_TOKENS) {
            console.error(
                `[ERROR] System prompt (${systemTokens} tokens) plus reserved response `
                + `(${numPredict} tokens) leaves only ${budget} tokens for the document `
                + `within OLLAMA_NUM_CTX_MAX=${maxCtx}. Forcing ${MIN_DOC_TOKENS} document `
                + `tokens and exceeding the configured maximum. Raise OLLAMA_NUM_CTX_MAX or `
                + `shorten the pre-existing tag/correspondent lists.`
            );
            budget = MIN_DOC_TOKENS;
        }

        if (this._calculatePromptTokenCount(user) > budget) {
            user = user.substring(0, budget * 4);
            truncated = true;
            console.warn(`[WARNING] Document text truncated to ${budget} tokens to protect the system prompt`);
        }

        const userTokens = this._calculatePromptTokenCount(user);
        const numCtx = Math.max(MIN_CTX, systemTokens + userTokens + numPredict);

        console.log(`[DEBUG] num_ctx=${numCtx} (system=${systemTokens}, user=${userTokens}, predict=${numPredict}, truncated=${truncated})`);

        return { user, numCtx, truncated };
    }
```

- [ ] **Step 4: `analyzeDocument` verdrahten**

Ersetze in `services/ollamaService.js` die beiden Zeilen aus Task 5, Step 6:

```js
            // Fit into the context window (Task 6 replaces this line)
            const numCtx = config.ollama.numCtxMax;

            // Call Ollama API
            const response = await this._callOllamaAPI(user, system, numCtx, this.documentAnalysisSchema);
```

durch:

```js
            // Fit into the context window; only the document text may be trimmed
            const fitted = this._fitPromptToContext(system, user);

            // Call Ollama API
            const response = await this._callOllamaAPI(fitted.user, system, fitted.numCtx, this.documentAnalysisSchema);
```

Und passe den Log-Aufruf an — ersetze:

```js
            await this._logPromptAndResponse(system, user, parsedResponse);
```

durch:

```js
            await this._logPromptAndResponse(system, fitted.user, parsedResponse);
```

Ersetze außerdem das `truncated: false` im Rückgabeobjekt von `analyzeDocument`:

```js
                truncated: false
```

durch:

```js
                truncated: fitted.truncated
```

- [ ] **Step 5: `analyzePlayground` verdrahten**

Ersetze in `services/ollamaService.js` in `analyzePlayground` diesen Block:

```js
            // Calculate context window size
            const promptTokenCount = await calculateTokens(prompt);
            const numCtx = this._calculateNumCtx(promptTokenCount, 1024);

            // Generate playground system prompt (simpler than full analysis)
            const systemPrompt = this._generatePlaygroundSystemPrompt();

            // Call Ollama API
            const response = await this._callOllamaAPI(
                prompt + "\n\n" + JSON.stringify(content),
                systemPrompt,
                numCtx,
                this.playgroundSchema
            );
```

durch:

```js
            // Generate playground system prompt (simpler than full analysis)
            const systemPrompt = this._generatePlaygroundSystemPrompt();

            // Fit into the context window
            const fitted = this._fitPromptToContext(
                systemPrompt,
                prompt + "\n\n" + JSON.stringify(content)
            );

            // Call Ollama API
            const response = await this._callOllamaAPI(
                fitted.user,
                systemPrompt,
                fitted.numCtx,
                this.playgroundSchema
            );
```

- [ ] **Step 6: `generateText` verdrahten**

Ersetze in `services/ollamaService.js` in `generateText` diesen Block:

```js
            // Calculate context window size based on prompt length
            const promptTokenCount = this._calculatePromptTokenCount(prompt);
            const numCtx = this._calculateNumCtx(promptTokenCount, 512);

            // Simple system prompt for text generation
            const systemPrompt = `You are a helpful assistant. Generate a clear, concise, and informative response to the user's question or request.`;
```

durch:

```js
            // Simple system prompt for text generation
            const systemPrompt = `You are a helpful assistant. Generate a clear, concise, and informative response to the user's question or request.`;

            // Fit into the context window; free-text generation reserves more tokens
            const fitted = this._fitPromptToContext(systemPrompt, prompt, 1024);
```

Und ersetze im darauffolgenden `this.client.post`-Aufruf:

```js
                prompt: prompt,
                system: systemPrompt,
                stream: false,
                options: {
                    temperature: 0.7,
                    top_p: 0.9,
                    num_predict: 1024,
                    num_ctx: numCtx
                }
```

durch:

```js
                prompt: fitted.user,
                system: systemPrompt,
                stream: false,
                options: {
                    temperature: 0.7,
                    top_p: 0.9,
                    num_predict: 1024,
                    num_ctx: fitted.numCtx
                }
```

`generateText` erzeugt Freitext, keine Klassifikation — `temperature: 0.7` bleibt hier bewusst erhalten.

- [ ] **Step 7: Prüfen, dass `_calculateNumCtx` nirgends mehr aufgerufen wird**

Run: `grep -rn "_calculateNumCtx" --include=*.js .`
Expected: keine Treffer.

- [ ] **Step 8: Tests ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 33 Tests bestehen.

- [ ] **Step 9: Commit**

```bash
git add services/ollamaService.js test/ollamaContext.test.js
git commit -m "fix: Kontextfenster aus beiden Prompt-Haelften berechnen

_calculateNumCtx zaehlte nur den User-Prompt; der System-Prompt mit den
Bestandslisten fehlte in der Rechnung. Bei Ueberlauf kuerzte Ollama still am
Anfang - also genau die Listen, auf die es ankommt.

_fitPromptToContext berechnet den Bedarf aus beiden Haelften, haelt eine
Untergrenze von 2048 und die konfigurierte Obergrenze ein und kuerzt bei
Ueberlauf ausschliesslich den Dokumententext.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Paperless-URL im Startup-Log maskieren

`config/config.js` gibt beim Start die Paperless-URL im Klartext aus. Der Token ist bereits maskiert, die URL nicht. Beides stammt aus `data/.env` und gehört nicht ins Log.

**Files:**
- Modify: `config/config.js` — `console.log('Loaded environment variables:'…)`-Block und Export
- Test: `test/configParse.test.js` (erweitern)

**Interfaces:**
- Consumes: nichts
- Produces: `config._maskUrl(url: string) → string`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Hänge an `test/configParse.test.js` an:

```js
test('_maskUrl behaelt das Schema und maskiert Host und Port', () => {
  assert.strictEqual(config._maskUrl('http://10.0.0.5:8000'), 'http://***');
  assert.strictEqual(config._maskUrl('https://paperless.example.org'), 'https://***');
});

test('_maskUrl meldet fehlende Konfiguration als solche', () => {
  assert.strictEqual(config._maskUrl(undefined), '(not set)');
  assert.strictEqual(config._maskUrl(''), '(not set)');
});

test('_maskUrl gibt bei unparsbarem Wert keinen Klartext preis', () => {
  assert.strictEqual(config._maskUrl('kein-url-wert'), '***');
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test test/configParse.test.js`
Expected: FAIL — `config._maskUrl is not a function`

- [ ] **Step 3: `maskUrl` implementieren und im Log verwenden**

Füge in `config/config.js` unmittelbar vor der Zeile `console.log('Loaded environment variables:', {` ein:

```js
// Never log connection details from data/.env in clear text
const maskUrl = (url) => {
  if (!url) return '(not set)';
  try {
    return `${new URL(url).protocol}//***`;
  } catch {
    return '***';
  }
};
```

Ersetze anschließend innerhalb dieses `console.log`-Blocks:

```js
  PAPERLESS_API_URL: process.env.PAPERLESS_API_URL,
```

durch:

```js
  PAPERLESS_API_URL: maskUrl(process.env.PAPERLESS_API_URL),
```

- [ ] **Step 4: Helper exportieren**

Ersetze in `config/config.js`:

```js
  // Exported for unit tests
  _parseEnvNumber: parseEnvNumber,
```

durch:

```js
  // Exported for unit tests
  _parseEnvNumber: parseEnvNumber,
  _maskUrl: maskUrl,
```

- [ ] **Step 5: Tests ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 36 Tests bestehen.

- [ ] **Step 6: Prüfen, dass der Start keine Klartext-URL mehr ausgibt**

Run: `node -e "require('./config/config')" | grep -i paperless_api_url`
Expected: `PAPERLESS_API_URL: 'http://***'` — kein Hostname, kein Port.

- [ ] **Step 7: Commit**

```bash
git add config/config.js test/configParse.test.js
git commit -m "fix: Paperless-URL im Startup-Log maskieren

Der Token war bereits maskiert, die URL nicht. Beide stammen aus data/.env.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Tags auf Kategorienamen begrenzen

Baseline-Beobachtung, Dokument 178, zweiter Lauf: `"tags": ["Personal-Nr.: XXXXXX 000", "Abrechnungszeitraum: 01.06.2026-30.06.2026"]`. Das sind keine Kategorien, sondern extrahierte Datenwerte, die eigentlich in `custom_fields` gehören. Eine Prompt-Anweisung allein ist bei einem 7B-Modell keine Garantie; deshalb zusätzlich ein defensiver Nachbearbeitungsfilter: jeder Tag, der einen Doppelpunkt enthält oder unplausibel lang ist, wird verworfen statt nach Paperless geschrieben zu werden.

**Files:**
- Modify: `services/ollamaService.js` — neue Methoden `_isPlausibleTag`, `_normalizeParsedDocument`; Aufruf in `analyzeDocument`
- Test: `test/ollamaTagFilter.test.js` (create)

**Interfaces:**
- Consumes: die Zeile `const parsedResponse = this._processOllamaResponse(response);` in `analyzeDocument`, angelegt in Task 5
- Produces: `_isPlausibleTag(tag: string) → boolean`; `_normalizeParsedDocument(doc: object) → object` (mutiert `doc` und gibt es zurück)

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Neue Datei `test/ollamaTagFilter.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const ollamaService = require('../services/ollamaService');

test('ein normaler Kategorie-Tag ist plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Sozialversicherung'), true);
});

test('ein mehrwortiger Kategorie-Tag ist plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Vertrag Änderung'), true);
});

test('ein Tag mit Doppelpunkt ist ein Datenfeld, kein Kategorie-Tag', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Personal-Nr.: XXXXXX 000'), false);
});

test('ein Tag mit Zeitraumsangabe und Doppelpunkt wird verworfen', () => {
  assert.strictEqual(ollamaService._isPlausibleTag('Abrechnungszeitraum: 01.06.2026-30.06.2026'), false);
});

test('ein unplausibel langer Tag wird verworfen', () => {
  const long = 'x'.repeat(61);
  assert.strictEqual(ollamaService._isPlausibleTag(long), false);
});

test('ein Tag an der Laengengrenze von 60 Zeichen bleibt plausibel', () => {
  const atLimit = 'x'.repeat(60);
  assert.strictEqual(ollamaService._isPlausibleTag(atLimit), true);
});

test('ein leerer oder nicht-string Tag ist nicht plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleTag(''), false);
  assert.strictEqual(ollamaService._isPlausibleTag('   '), false);
  assert.strictEqual(ollamaService._isPlausibleTag(null), false);
  assert.strictEqual(ollamaService._isPlausibleTag(undefined), false);
});

test('_normalizeParsedDocument filtert unplausible Tags aus dem Dokument', () => {
  const doc = {
    tags: ['Rechnung', 'Personal-Nr.: XXXXXX 000', 'Versicherung'],
    document_date: null
  };

  ollamaService._normalizeParsedDocument(doc);

  assert.deepStrictEqual(doc.tags, ['Rechnung', 'Versicherung']);
});

test('_normalizeParsedDocument laesst ein Dokument ohne tags-Array unangetastet', () => {
  const doc = { correspondent: 'Finanzamt' };
  const result = ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(result, doc);
  assert.strictEqual(doc.tags, undefined);
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test test/ollamaTagFilter.test.js`
Expected: FAIL — `ollamaService._isPlausibleTag is not a function`

- [ ] **Step 3: `_isPlausibleTag` und `_normalizeParsedDocument` implementieren**

Füge in `services/ollamaService.js` diese beiden Methoden unmittelbar vor `_processOllamaResponse` ein:

```js
    /**
     * A category tag is a short label. Anything containing a colon is very
     * likely a "field: value" fragment the model extracted instead of
     * categorizing (observed baseline: "Personal-Nr.: XXXXXX 000"). Anything
     * implausibly long is likely a full sentence, not a label.
     * @param {*} tag
     * @returns {boolean}
     */
    _isPlausibleTag(tag) {
        if (typeof tag !== 'string') return false;
        const trimmed = tag.trim();
        if (!trimmed) return false;
        if (trimmed.includes(':')) return false;
        if (trimmed.length > 60) return false;
        return true;
    }

    /**
     * Defensive post-processing for a parsed model response. Runs
     * unconditionally after every successful parse, regardless of which
     * branch of _processOllamaResponse/_parseResponse produced it.
     * @param {Object} doc
     * @returns {Object} the same object, mutated
     */
    _normalizeParsedDocument(doc) {
        if (Array.isArray(doc.tags)) {
            const before = doc.tags.length;
            doc.tags = doc.tags.filter(tag => this._isPlausibleTag(tag));
            if (doc.tags.length < before) {
                console.warn(`[WARNING] Dropped ${before - doc.tags.length} tag(s) that looked like extracted data rather than category labels`);
            }
        }

        return doc;
    }
```

- [ ] **Step 4: In `analyzeDocument` verdrahten**

Ersetze in `services/ollamaService.js` in `analyzeDocument`:

```js
            // Process response
            const parsedResponse = this._processOllamaResponse(response);
```

durch:

```js
            // Process response
            const parsedResponse = this._normalizeParsedDocument(this._processOllamaResponse(response));
```

- [ ] **Step 5: Tests ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 45 Tests bestehen.

- [ ] **Step 6: Commit**

```bash
git add services/ollamaService.js test/ollamaTagFilter.test.js
git commit -m "fix: Tags filtern, die wie extrahierte Datenwerte aussehen

Baseline-Lauf zeigte Tags wie \"Personal-Nr.: XXXXXX 000\" - keine
Kategorien, sondern Datenfelder, die das Modell statt custom_fields in
tags geschrieben hat. Ein Doppelpunkt im Tag ist ein starkes Signal dafuer.

Defensiver Nachbearbeitungsfilter, nicht nur eine Prompt-Anweisung: ein 7B-
Modell haelt Formatvorgaben nicht zuverlaessig ein.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `document_date` auf `YYYY-MM-DD` normieren

Baseline-Beobachtung, Dokument 178: derselbe Prompt lieferte einmal `"2026-07-22"` (korrekt), einmal `"22.07.2026"` (deutsches Format). `document_date` wird in `buildUpdateData` ungeprüft nach `updateData.created` durchgereicht (`server.js`, Funktion `buildUpdateData`) — ein falsches Format kann dort einen fehlerhaften Wert in Paperless schreiben. Erweitert `_normalizeParsedDocument` aus Task 8 um eine zweite Normalisierung.

**Files:**
- Modify: `services/ollamaService.js` — neue Methode `_normalizeDocumentDate`, `_normalizeParsedDocument` erweitert
- Test: `test/ollamaDateNormalize.test.js` (create)

**Interfaces:**
- Consumes: `_normalizeParsedDocument` aus Task 8
- Produces: `_normalizeDocumentDate(value: string) → string|null` (null bedeutet: verwerfen, Aufrufer in `server.js` fällt bereits heute auf `doc.created` zurück, wenn `analysis.document.document_date` falsy ist)

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

Neue Datei `test/ollamaDateNormalize.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const ollamaService = require('../services/ollamaService');

test('ein ISO-Datum bleibt unveraendert', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate('2026-07-22'), '2026-07-22');
});

test('ein deutsches Datum wird zu ISO konvertiert', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate('22.07.2026'), '2026-07-22');
});

test('ein einstelliger Tag/Monat im deutschen Format wird nicht erkannt', () => {
  // Bewusst konservativ: nur das zweistellige Format wird konvertiert,
  // alles andere lieber verwerfen als falsch raten.
  assert.strictEqual(ollamaService._normalizeDocumentDate('2.7.2026'), null);
});

test('ein unbekanntes Format wird verworfen, nicht geraten', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate('22. Juli 2026'), null);
});

test('null und undefined werden verworfen', () => {
  assert.strictEqual(ollamaService._normalizeDocumentDate(null), null);
  assert.strictEqual(ollamaService._normalizeDocumentDate(undefined), null);
});

test('_normalizeParsedDocument normiert document_date im Dokument', () => {
  const doc = { tags: [], document_date: '22.07.2026' };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_date, '2026-07-22');
});

test('_normalizeParsedDocument verwirft ein unparsebares document_date', () => {
  const doc = { tags: [], document_date: '22. Juli 2026' };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_date, null);
});

test('_normalizeParsedDocument laesst ein fehlendes document_date unangetastet', () => {
  const doc = { tags: [] };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_date, undefined);
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `node --test test/ollamaDateNormalize.test.js`
Expected: FAIL — `ollamaService._normalizeDocumentDate is not a function`

- [ ] **Step 3: `_normalizeDocumentDate` implementieren**

Füge in `services/ollamaService.js` unmittelbar nach `_isPlausibleTag` (vor `_normalizeParsedDocument`) ein:

```js
    /**
     * Normalize document_date to YYYY-MM-DD. Accepts ISO as-is and converts
     * unambiguous German DD.MM.YYYY notation (observed in the baseline run
     * alongside correct ISO output from the same prompt). Anything else is
     * dropped rather than guessed, so the caller's existing fallback to the
     * document's current created date applies instead of writing a wrong one.
     * @param {*} value
     * @returns {string|null}
     */
    _normalizeDocumentDate(value) {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();

        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            return trimmed;
        }

        const german = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (german) {
            const [, day, month, year] = german;
            return `${year}-${month}-${day}`;
        }

        return null;
    }
```

- [ ] **Step 4: `_normalizeParsedDocument` um die Datumsnormierung erweitern**

Ersetze in `services/ollamaService.js` die **gesamte** Methode `_normalizeParsedDocument` (aus Task 8) durch:

```js
    /**
     * Defensive post-processing for a parsed model response. Runs
     * unconditionally after every successful parse, regardless of which
     * branch of _processOllamaResponse/_parseResponse produced it.
     * @param {Object} doc
     * @returns {Object} the same object, mutated
     */
    _normalizeParsedDocument(doc) {
        if (Array.isArray(doc.tags)) {
            const before = doc.tags.length;
            doc.tags = doc.tags.filter(tag => this._isPlausibleTag(tag));
            if (doc.tags.length < before) {
                console.warn(`[WARNING] Dropped ${before - doc.tags.length} tag(s) that looked like extracted data rather than category labels`);
            }
        }

        if (doc.document_date) {
            const normalized = this._normalizeDocumentDate(doc.document_date);
            if (normalized !== doc.document_date) {
                console.warn(`[WARNING] document_date "${doc.document_date}" did not match YYYY-MM-DD, normalized to ${normalized ?? '(verworfen, Aufrufer faellt auf doc.created zurueck)'}`);
            }
            doc.document_date = normalized;
        }

        return doc;
    }
```

- [ ] **Step 5: Tests ausführen, Erfolg bestätigen**

Run: `npm test`
Expected: PASS — 53 Tests bestehen.

- [ ] **Step 6: Commit**

```bash
git add services/ollamaService.js test/ollamaDateNormalize.test.js
git commit -m "fix: document_date auf YYYY-MM-DD normieren oder verwerfen

Baseline-Lauf zeigte fuer dasselbe Dokument in zwei Laeufen \"2026-07-22\"
und \"22.07.2026\" - der Prompt schreibt YYYY-MM-DD vor, das Modell haelt
sich nicht zuverlaessig daran. document_date landet ungeprueft in
updateData.created; ein falsches Format kann dort einen fehlerhaften Wert
nach Paperless schreiben.

Unbekannte Formate werden verworfen statt geraten - der bestehende
Fallback auf doc.created in server.js greift dann automatisch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Abschluss von Phase 1

- [ ] **Vollständiger Testlauf**

Run: `npm test`
Expected: PASS — 53 Tests, 0 Fehlschläge.

> **Nicht `npm run dev` / `npm start` verwenden, um Determinismus zu prüfen.**
> `DISABLE_AUTOMATIC_PROCESSING` ist in `data/.env` nicht gesetzt (Default: aus)
> und `PROCESS_PREDEFINED_DOCUMENTS=yes` ist gesetzt — ein normaler Serverstart
> verarbeitet sofort Dokumente und schreibt nach Paperless. Für alle folgenden
> Prüfungen ausschließlich `scripts/dry-run-eval.js` verwenden; es ruft nur
> `aiService.analyzeDocument` auf und schreibt nie zurück.

- [ ] **Bestandslisten im Prompt prüfen**

Öffne die von `writePromptToFile` geschriebene Log-Datei und prüfe im `--- SYSTEM ---`-Abschnitt, dass die Listen der bestehenden Tags, Korrespondenten und Dokumentarten tatsächlich enthalten und nicht leer sind. Das ist das Abnahmekriterium aus der Roadmap.

- [ ] **Baseline-Vergleich mit dem Dry-Run-Harness**

```bash
node scripts/dry-run-eval.js --limit 10 --repeat 2 --label nach-phase1
```

Vergleiche den neuen Report unter `data/eval/` mit
`data/eval/dryrun-baseline-*.json` vom 2026-08-01. Erwartung: die
Stabilitätsrate sinkt deutlich unter 10 von 10 instabilen Dokumenten; die
Anrede-/Anschrift-im-Namen- und Datums-Tag-Treffer aus der Baseline treten
seltener oder gar nicht mehr auf. Beide Reports enthalten personenbezogene
Daten und bleiben unter `data/eval/` (nicht in git — auf einem frischen
Checkout oder einer anderen Maschine existiert die alte Baseline-Datei
möglicherweise nicht; dieser Lauf wird dann selbst zur Baseline für Phase 2).

- [ ] **Roadmap-Status fortschreiben**

Setze in `docs/planning/klassifikations-konsistenz-roadmap.md` in der Phasentabelle die Zeile für Phase 1 auf `erledigt`.

- [ ] **Commit und Merge-Entscheidung**

```bash
git add docs/planning/klassifikations-konsistenz-roadmap.md
git commit -m "docs: Phase 1 als erledigt markieren

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Danach `superpowers:finishing-a-development-branch` für die Integration.
