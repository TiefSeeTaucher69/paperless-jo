# NACHAUDIT-16 — Lint-Restwarnungen projektweit aufräumen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle 83 verbleibenden `no-unused-vars`-Warnungen aus `eslint . --max-warnings=83` beheben,
ohne Laufzeitverhalten zu ändern — Arbeitsplan-Punkt 5 / NACHAUDIT-16 aus
[docs/audit/2026-08-04-nachaudit-offene-punkte.md](../../audit/2026-08-04-nachaudit-offene-punkte.md).
Nach Abschluss: `eslint .` liefert 0 Warnungen, `package.json`s `--max-warnings=83` kann auf `0`
gesenkt werden (echte Ratsche statt Ist-Stand-Deckel, behebt damit auch die in NACHAUDIT-07
beschriebene Reibung).

**Architektur:** Jede der 83 Fundstellen wurde vor diesem Plan einzeln gelesen und klassifiziert
(nicht blind nach Regelname behandelt) — Details siehe „Klassifikationsmethodik" unten. Die Tasks
sind nach Datei/Dateigruppe geschnitten, damit ein Reviewer risikoarme (tote Imports) von
risikoreichen Änderungen (Seiteneffekte, Duplikate) getrennt beurteilen kann.

**Tech Stack:** Node.js (CommonJS), ESLint 9 Flat Config (`eslint.config.mjs`), `node:test`. Keine
neue Dependency, keine Konfigurationsänderung an `eslint.config.mjs` außer optional in Task 11
(`--max-warnings`-Wert in `package.json`, kein `eslint.config.mjs`-Rule-Change).

## Klassifikationsmethodik (warum nicht einfach „alles löschen")

Beim Durchlesen aller 83 Fundstellen wurden vier echte Fallen identifiziert, die eine blinde
Automatik (z. B. ein Autofix-Tool) übersehen hätte:

1. **`services/loggerService.js#Logger`s Konstruktor überschreibt global
   `console.log`/`.error`/`.warn`/`.info`/`.debug`** (Monkey-Patch, schreibt nach
   `logs/logs.html`/`logs/logs.txt`). `server.js`s `const htmlLogger = new Logger(...)` und
   `const txtLogger = new Logger(...)` sind zwar als Variablen nie gelesen, ihre Konstruktoren
   aber sind der **einzige** Ort, an dem diese Datei-Logs überhaupt entstehen. Löschen der
   `new Logger(...)`-Aufrufe würde das gesamte dateibasierte Logging der Anwendung abschalten.
   → nur die Variablen-Bindung entfernen, den Aufruf behalten.
2. **Express erkennt Error-Handling-Middleware an der Parameteranzahl** (`fn.length === 4`).
   `server.js`s `app.use((err, req, res, next) => {...})` hat ein ungenutztes `next` — wird es
   entfernt, sinkt die Arity auf 3 und Express behandelt die Funktion nicht mehr als
   Error-Handler. → `next` bleibt stehen, Warnung stattdessen gezielt unterdrückt.
3. **Browser-Skripte ohne Modul-System (`public/js/**/*.js`) werden teils aus `views/*.ejs` per
   `onclick="funktionsname(...)"` aufgerufen** — ESLint sieht pro Datei nur den lokalen Scope und
   erkennt diesen Aufrufpfad nicht. Vor jeder Löschung einer top-level `function`-Deklaration in
   `public/js/` wurde per `grep` in `views/*.ejs` und in der eigenen Datei nach `onclick="..."`
   geprüft (siehe `eslint.config.mjs`, Kommentar bei `files: ["public/js/**/*.js"]`, dieselbe
   bereits bekannte Einschränkung). Ergebnis: **zwei echte Fehltreffer gefunden und behoben**
   (Task 7, Task 8) — Details dort.
4. **Ein Parameter kann absichtlich ungenutzt sein.**
   `services/restrictionPromptService.js` dokumentiert `config` explizit per JSDoc als
   „(unused, kept for compatibility)" — hier wird nicht entfernt, sondern gezielt unterdrückt.

## Global Constraints

- Kein Verhaltensunterschied: nach jedem Task muss `npm test` weiterhin **460/460** grün liefern
  (Stand vor diesem Plan, verifiziert) — kein Test wird angepasst, um eine Änderung „passend" zu
  machen.
- **Vor dem Löschen eines als „unused" markierten `require(...)`/`new X(...)`:** prüfen, ob das
  Modul/die Klasse Lade- oder Konstruktor-Seiteneffekte hat (Beispiel: `services/loggerService.js`,
  siehe Klassifikationsmethodik Punkt 1). Im Zweifel den Aufruf behalten und nur die Bindung
  entfernen.
- **Vor dem Löschen einer top-level `function`-Deklaration in `public/js/**/*.js`:** per `grep`
  in `views/*.ejs` und in derselben Datei nach `onclick="<funktionsname>"` suchen (siehe
  Klassifikationsmethodik Punkt 3). Nur löschen, wenn keine Referenz gefunden wird.
- **Express-Error-Handler (`(err, req, res, next) => {...}`, 4 Parameter) behalten immer alle
  vier Parameter** — Warnung per gezieltem Kommentar unterdrücken, nie Parameter entfernen.
- Bevorzugt die **bestehende Projekt-Konvention wiederverwenden**: für „Instanz nur wegen
  Seiteneffekt erzeugt, Ergebnis nie gelesen" existiert in `public/js/setup.js` bereits das Muster
  `/* eslint-disable no-unused-vars */ ... /* eslint-enable no-unused-vars */` — dieses Muster
  wird in Task 9 für `settings.js` repliziert statt einer neuen Lösung.
- Optional-Catch-Binding (`catch (e) {}` → `catch {}`) ist modernes, im Projekt bereits über
  Node 22 (siehe `package.json`-Engines/CI) unterstütztes JavaScript (ES2019+) — sicherer
  Standardweg für alle ungenutzten `catch`-Fehlerobjekte, sofern der Fehler im `catch`-Block
  wirklich nirgends referenziert wird.
- Kein Rule-Change in `eslint.config.mjs` in diesem Plan (Task 11 senkt nur den
  `package.json`-Zahlenwert, nachdem die Warnungen weg sind).
- Sprachkonvention: dieser Plan und Doku-Updates sind Deutsch. Code-Kommentare folgen der
  bestehenden Sprache der jeweiligen Datei (server-seitige Dateien überwiegend englisch/deutsch
  gemischt je Datei, `public/js/*.js` überwiegend englisch — keine neuen Kommentare hinzufügen
  außer wo explizit unten angegeben).
- **Neuer Fund außerhalb des Lint-Scopes, nicht in diesem Plan beheben:** `routes/setup.js`,
  Route `GET /sampleData/:id` (aktuell ca. Zeile 463-473) sendet im Erfolgsfall **keine
  HTTP-Antwort** (der `try`-Block endet nach zwei Fetches ohne `res.json(...)`/`res.send(...)`) —
  ein vorbestehender, von diesem Plan unabhängiger Bug. Task 6 entfernt nur die dadurch verwaiste
  `correspondents`-Variable (verhält sich danach identisch zum jetzigen, bereits kaputten
  Zustand), Task 11 dokumentiert den Fund als neue Audit-Notiz (NACHAUDIT-17), behebt ihn aber
  nicht — das wäre ein Funktionsbug-Fix, kein Lint-Cleanup.

## File Structure

| Datei(en) | Anzahl Warnungen | Änderungsart | Task |
|---|---|---|---|
| `models/document.js`, `routes/auth.js` | 3 + 3 | tote Imports/Statements, optionale Catch-Bindings | 1 |
| `services/paperlessService.js`, `chatService.js`, `ragService.js`, `azureService.js`, `customService.js`, `ollamaService.js`, `openaiService.js` | 17 | tote Imports/destrukturierte Namen, optionale Catch-Bindings | 2 |
| `services/restrictionPromptService.js` | 1 | gezielte Unterdrückung (dokumentiert absichtlich ungenutzt) | 3 |
| `services/setupService.js` | 3 | tote Konstante, optionale Catch-Bindings | 4 |
| `server.js`, `services/loggerService.js` | 6 + 1 | Seiteneffekt-Erhalt (Logger), Express-Arity-Erhalt, tote Imports/Parameter | 5 |
| `routes/setup.js` | 12 | gemischt, inkl. Fund eines nicht behobenen Funktionsbugs | 6 |
| `public/js/chat.js` | 3 | optionale Catch/Event-Bindings, ein echt totes `toggleTheme` | 7 |
| `public/js/dashboard.js`, `public/js/manual.js` | 4 | Löschung verwaister Duplikatblöcke (verifiziert per View-Grep) | 8 |
| `public/js/csrf.js`, `settings.js`, `setup.js` | 25 | gezielte Unterdrückungen (HTML-`onclick`/globale Nutzung), Seiteneffekt-Erhalt, tote DOM-Lookups | 9 |
| `test/documentFingerprintService.test.js`, `entityResolver.test.js`, `paperlessMergeEntity.test.js` | 5 | ungenutzte Mock-Parameter entfernen | 10 |
| `package.json`, `docs/audit/2026-08-04-nachaudit-offene-punkte.md` | — | Ratsche auf 0 senken, Ergebnis + NACHAUDIT-17 dokumentieren | 11 |

---

### Task 1: `models/document.js`, `routes/auth.js`

**Files:**
- Modify: `models/document.js` (Zeilen 5, 96-99, 101-104)
- Modify: `routes/auth.js` (Zeilen 2, 28, 50)

**Warum zusammen:** Beide Dateien enthalten ausschließlich risikolose, eindeutig tote Fundstellen
(kein Seiteneffekt, keine HTML-Referenz, keine Express-Arity-Frage).

- [ ] **Step 1: `models/document.js` — totes `http`-Destructuring entfernen**

Ersetze:
```js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { get } = require('http');
```
durch:
```js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
```

- [ ] **Step 2: `models/document.js` — verwaiste `insertOriginal`/`insertHistory`-Statements entfernen**

`saveOriginalData`/`addToHistory` bereiten ihre INSERT-Statements bereits inline vor
(`db.prepare(...).run(...)`) — diese beiden Top-Level-Konstanten werden nirgends im Projekt
referenziert (verifiziert per `grep -rn "insertOriginal\|insertHistory"`). Entferne:
```js
const insertOriginal = db.prepare(`
  INSERT INTO original_documents (document_id, title, tags, correspondent)
  VALUES (?, ?, ?, ?)
`);

const insertHistory = db.prepare(`
  INSERT INTO history_documents (document_id, tags, title, correspondent)
  VALUES (?, ?, ?, ?)
`);
```
ersatzlos (inklusive der Leerzeile dazwischen).

- [ ] **Step 3: `routes/auth.js` — totes `config`-Require entfernen**

Ersetze:
```js
const jwt = require('jsonwebtoken');
const config = require('../config/config');
```
durch:
```js
const jwt = require('jsonwebtoken');
```
(`config/config.js`s Lade-Seiteneffekte — `.env` lesen, Status-Logs — laufen bereits über
`server.js`/`routes/setup.js`s eigene `require('../config/config')`, die vor bzw. unabhängig von
`routes/auth.js` geladen werden; Node cached Module, der Seiteneffekt bleibt unverändert erhalten.)

- [ ] **Step 4: `routes/auth.js` — zwei optionale Catch-Bindings**

Ersetze (Zeile 28):
```js
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
```
durch:
```js
  } catch {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
```

Ersetze (Zeile 50):
```js
  } catch (error) {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }
```
durch:
```js
  } catch {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }
```

- [ ] **Step 5: Verifizieren**

Run: `npx eslint models/document.js routes/auth.js`
Expected: 0 Warnungen für beide Dateien (vorher 3 + 3 = 6).

Run: `npm test`
Expected: 460/460 grün.

- [ ] **Step 6: Commit**

```bash
git add models/document.js routes/auth.js
git commit -m "$(cat <<'EOF'
fix: tote Imports/Statements und ungenutzte Catch-Bindings entfernen (NACHAUDIT-16, 1/11)

models/document.js: totes http-Destructuring sowie verwaiste insertOriginal/
insertHistory-Prepared-Statements entfernt (saveOriginalData/addToHistory
bereiten ihre Statements laengst inline vor). routes/auth.js: totes
config-Require entfernt (Ladeseiteneffekt laeuft ueber andere Require-Stellen
weiter), zwei ungenutzte Catch-Bindings auf optional-catch-binding umgestellt.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 1/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: LLM-Service-Dateien — tote Imports und Catch-Bindings

**Files:**
- Modify: `services/paperlessService.js` (Zeilen 4-5, 827)
- Modify: `services/chatService.js` (Zeile 4)
- Modify: `services/ragService.js` (Zeile 3)
- Modify: `services/azureService.js` (Zeilen 7, 47)
- Modify: `services/customService.js` (Zeilen 1-6, 9, 46)
- Modify: `services/ollamaService.js` (Zeilen 1-5, 12, 449, 640)
- Modify: `services/openaiService.js` (Zeile 12, 56)

**Warum zusammen:** Alle sieben Dateien enthalten ausschließlich denselben Fundstellentyp (totes
`require`/destrukturierter Name ohne Seiteneffekt, oder ungenutzte Catch-Bindung nach demselben
Thumbnail-Caching-Muster) — verifiziert, dass keine der entfernten Bindungen ein Modul mit
Lade-Seiteneffekt betrifft (`openai`, `tiktoken`, `date-fns`-Destructuring-Teilmengen,
`./serviceUtils`-Destructuring-Teilmengen, `../config/config` in `chatService.js`/`ragService.js`
— dieselbe Begründung wie Task 1 Step 3: bereits durch andere Require-Stellen geladen).

- [ ] **Step 1: `services/paperlessService.js`**

Ersetze:
```js
// services/paperlessService.js
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');
const { parse, isValid, parseISO, format } = require('date-fns');
```
durch:
```js
// services/paperlessService.js
const axios = require('axios');
const config = require('../config/config');
const { parse, isValid, parseISO, format } = require('date-fns');
```

Ersetze (Zeile 827, `forEach(id => {...})` — `id` unused im Callback-Body, `tagIds` wird stattdessen verwendet):
```js
          tagIds.forEach(id => {
            // Verwende tags__id__in für multiple Tag-Filterung
            params.tags__id__in = tagIds.join(',');
          });
```
durch:
```js
          tagIds.forEach(() => {
            // Verwende tags__id__in für multiple Tag-Filterung
            params.tags__id__in = tagIds.join(',');
          });
```

- [ ] **Step 2: `services/chatService.js`**

Ersetze:
```js
// services/chatService.js
const OpenAIService = require('./openaiService');
const PaperlessService = require('./paperlessService');
const config = require('../config/config');
const fs = require('fs');
```
durch:
```js
// services/chatService.js
const OpenAIService = require('./openaiService');
const PaperlessService = require('./paperlessService');
const fs = require('fs');
```

- [ ] **Step 3: `services/ragService.js`**

Ersetze:
```js
// services/ragService.js
const axios = require('axios');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');
```
durch:
```js
// services/ragService.js
const axios = require('axios');
const AIServiceFactory = require('./aiServiceFactory');
```

- [ ] **Step 4: `services/azureService.js`**

Ersetze:
```js
const OpenAI = require('openai');
const AzureOpenAI = require('openai').AzureOpenAI;
```
durch:
```js
const AzureOpenAI = require('openai').AzureOpenAI;
```

Ersetze (Zeile 47):
```js
        } catch (err) {
          console.log('Thumbnail not cached, fetching from Paperless');
```
durch:
```js
        } catch {
          console.log('Thumbnail not cached, fetching from Paperless');
```

- [ ] **Step 5: `services/customService.js`**

Ersetze:
```js
const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit,
  writePromptToFile
} = require('./serviceUtils');
const OpenAI = require('openai');
const config = require('../config/config');
const tiktoken = require('tiktoken');
```
durch:
```js
const {
  calculateTokens,
  calculateTotalPromptTokens,
  truncateToTokenLimit
} = require('./serviceUtils');
const OpenAI = require('openai');
const config = require('../config/config');
```

Ersetze (Zeile 46, gleiches Thumbnail-Cache-Muster wie azureService.js):
```js
        } catch (err) {
          console.log('Thumbnail not cached, fetching from Paperless');
```
durch:
```js
        } catch {
          console.log('Thumbnail not cached, fetching from Paperless');
```

- [ ] **Step 6: `services/ollamaService.js`**

Ersetze:
```js
const {
    calculateTotalPromptTokens,
    truncateToTokenLimit,
    writePromptToFile
} = require('./serviceUtils');
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs').promises;
const path = require('path');
const paperlessService = require('./paperlessService');
const os = require('os');
const OpenAI = require('openai');
const RestrictionPromptService = require('./restrictionPromptService');
```
durch:
```js
const {
    writePromptToFile
} = require('./serviceUtils');
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs').promises;
const path = require('path');
const paperlessService = require('./paperlessService');
const os = require('os');
const RestrictionPromptService = require('./restrictionPromptService');
```

Ersetze (Zeile 449, identisches Thumbnail-Cache-Muster):
```js
        } catch (err) {
            console.log('Thumbnail not cached, fetching from Paperless');
```
durch:
```js
        } catch {
            console.log('Thumbnail not cached, fetching from Paperless');
```

Ersetze (Zeile 640, geschachtelter JSON-Sanitize-Fallback, `finalError` nirgends referenziert):
```js
                } catch (finalError) {
                    console.error('Final JSON parsing failed after sanitization. This happens when the JSON structure is too complex or invalid. That indicates an issue with the generated JSON string by Ollama. Switch to OpenAI for better results or fine tune your prompt.');
                    return { tags: [], correspondent: null };
                }
```
durch:
```js
                } catch {
                    console.error('Final JSON parsing failed after sanitization. This happens when the JSON structure is too complex or invalid. That indicates an issue with the generated JSON string by Ollama. Switch to OpenAI for better results or fine tune your prompt.');
                    return { tags: [], correspondent: null };
                }
```

- [ ] **Step 7: `services/openaiService.js`**

Ersetze:
```js
const fs = require('fs').promises;
const path = require('path');
const { model } = require('./ollamaService');
const RestrictionPromptService = require('./restrictionPromptService');
```
durch:
```js
const fs = require('fs').promises;
const path = require('path');
const RestrictionPromptService = require('./restrictionPromptService');
```

Ersetze (Zeile 56, identisches Thumbnail-Cache-Muster):
```js
        } catch (err) {
          console.log('Thumbnail not cached, fetching from Paperless');
```
durch:
```js
        } catch {
          console.log('Thumbnail not cached, fetching from Paperless');
```

- [ ] **Step 8: Verifizieren**

Run: `npx eslint services/paperlessService.js services/chatService.js services/ragService.js services/azureService.js services/customService.js services/ollamaService.js services/openaiService.js`
Expected: 0 Warnungen (vorher 3+1+1+2+3+5+2 = 17). `services/loggerService.js` (1 Warnung) ist
**nicht** Teil dieses Tasks — sie gehört inhaltlich zu Task 5 (dieselbe `Logger`-Klasse, deren
Seiteneffekt-Analyse dort dokumentiert ist) und wird dort mit erledigt.

Run: `npm test`
Expected: 460/460 grün.

- [ ] **Step 9: Commit**

```bash
git add services/paperlessService.js services/chatService.js services/ragService.js services/azureService.js services/customService.js services/ollamaService.js services/openaiService.js
git commit -m "$(cat <<'EOF'
fix: tote Imports und ungenutzte Catch-Bindings in den LLM-Service-Dateien entfernen (NACHAUDIT-16, 2/11)

Sieben Service-Dateien: ungenutzte require()/destrukturierte Namen entfernt
(kein Ladeseiteneffekt betroffen - config/config.js wird weiterhin ueber
andere Require-Stellen geladen), ungenutzte Catch-Bindings im wiederkehrenden
Thumbnail-Cache-Muster auf optional-catch-binding umgestellt.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 2/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `services/restrictionPromptService.js` — dokumentiert absichtlich ungenutzter Parameter

**Files:**
- Modify: `services/restrictionPromptService.js` (Zeile 20)

**Warum eigener Task:** Einziger Fund im gesamten Projekt, dessen JSDoc den Parameter explizit
als „(unused, kept for compatibility)" dokumentiert (Zeile 12: `@param {Object} config -
Configuration object (unused, kept for compatibility)`). Entfernen würde die dokumentierte,
absichtliche Schnittstellenkompatibilität mit den vier aufrufenden LLM-Services aufheben — hier
wird gezielt unterdrückt, nicht entfernt.

- [ ] **Step 1: Warnung gezielt unterdrücken**

Ersetze:
```js
  static processRestrictionsInPrompt(
    prompt,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypes,
    config
  ) {
```
durch:
```js
  // eslint-disable-next-line no-unused-vars -- config bleibt fuer Aufruf-Kompatibilitaet mit den
  // vier LLM-Services stehen, siehe JSDoc oben ("unused, kept for compatibility").
  static processRestrictionsInPrompt(
    prompt,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypes,
    config
  ) {
```

- [ ] **Step 2: Verifizieren**

Run: `npx eslint services/restrictionPromptService.js`
Expected: 0 Warnungen (vorher 1).

Run: `npm test`
Expected: 460/460 grün.

- [ ] **Step 3: Commit**

```bash
git add services/restrictionPromptService.js
git commit -m "$(cat <<'EOF'
fix: dokumentiert ungenutzten config-Parameter gezielt unterdruecken statt entfernen (NACHAUDIT-16, 3/11)

Der Parameter ist per JSDoc explizit als absichtlich ungenutzt markiert
("kept for compatibility" mit den vier aufrufenden LLM-Services) - entfernen
wuerde diese dokumentierte Absicht aufheben. Gezielte eslint-disable-Zeile
statt Code-Aenderung.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 3/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `services/setupService.js`

**Files:**
- Modify: `services/setupService.js` (Zeilen 300-309, 350, 375)

**Warum eigener Task:** Enthält eine mehrzeilige tote Konstante (kein einfacher Einzeiler wie in
Task 1/2) — verdient eine eigene Sichtprüfung im Review.

- [ ] **Step 1: Tote `JSON_STANDARD_PROMPT`-Konstante entfernen**

`JSON_STANDARD_PROMPT` wird nach ihrer Definition nirgends im Projekt referenziert (verifiziert
per `grep -n "JSON_STANDARD_PROMPT" services/setupService.js` — einziger Treffer ist die
Definition selbst). Entferne (inkl. der Leerzeile danach):
```js
      const JSON_STANDARD_PROMPT = `
        Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
        
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

```
ersatzlos.

- [ ] **Step 2: Zwei optionale Catch-Bindings (Datei-Existenz-Fallback-Muster)**

Ersetze (Zeile 350):
```js
      try {
        await fs.access(this.envPath, fs.constants.F_OK);
      } catch (err) {
        console.log('No .env file found. Starting setup process...');
```
durch:
```js
      try {
        await fs.access(this.envPath, fs.constants.F_OK);
      } catch {
        console.log('No .env file found. Starting setup process...');
```

Ersetze (Zeile 375):
```js
        try {
          await fs.access(dataDir, fs.constants.F_OK);
        } catch (err) {
          console.log('Creating data directory...');
```
durch:
```js
        try {
          await fs.access(dataDir, fs.constants.F_OK);
        } catch {
          console.log('Creating data directory...');
```

- [ ] **Step 3: Verifizieren**

Run: `npx eslint services/setupService.js`
Expected: 0 Warnungen (vorher 3).

Run: `npm test`
Expected: 460/460 grün — `setupService.js` wird über `test/setupAuthMiddleware.test.js` und
weitere Tests indirekt mitgetestet; besonders auf Tests rund um `hasEnvConfig`/Erstkonfiguration
achten.

- [ ] **Step 4: Commit**

```bash
git add services/setupService.js
git commit -m "$(cat <<'EOF'
fix: tote JSON_STANDARD_PROMPT-Konstante und ungenutzte Catch-Bindings entfernen (NACHAUDIT-16, 4/11)

JSON_STANDARD_PROMPT wird nach ihrer Definition nirgends referenziert -
verwaister Rest einer frueheren Prompt-Konstruktion. Zwei Catch-Bindings im
Datei-Existenz-Fallback-Muster auf optional-catch-binding umgestellt.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 4/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `server.js` — Seiteneffekt- und Express-Arity-Erhalt (höchste Sorgfalt)

**Files:**
- Modify: `server.js` (Zeilen 23, 27-39, 182, 473, 590)
- Modify: `services/loggerService.js` (Zeile 39, im selben Task, da dieselbe Klasse betroffen ist)

**Warum eigener, sorgfältiger Task:** Dieser Task enthält beide in der Klassifikationsmethodik
beschriebenen Fallen (Logger-Seiteneffekt, Express-Arity) — siehe oben. Kein Schritt in diesem
Task darf ohne die dort beschriebene Begründung abgekürzt werden.

- [ ] **Step 1: totes `date-fns`-Destructuring entfernen**

Ersetze:
```js
const Logger = require('./services/loggerService');
const { max } = require('date-fns');
```
durch:
```js
const Logger = require('./services/loggerService');
```

- [ ] **Step 2: `htmlLogger`/`txtLogger` — nur die Bindung entfernen, den Konstruktor-Aufruf behalten**

**Nicht überspringen:** `services/loggerService.js#Logger`s Konstruktor ruft
`this.overrideConsoleMethods()` auf, was `console.log`/`.error`/`.warn`/`.info`/`.debug` **global
für den gesamten Prozess** überschreibt und nach `logs/logs.html` bzw. `logs/logs.txt` spiegelt.
Beide Instanzen werden nirgends sonst in `server.js` gelesen — die Variablen selbst sind also
„unused" im Sinn von ESLint, ihr Konstruktor-Aufruf ist aber die einzige Stelle, die das
dateibasierte Logging überhaupt aktiviert. Ersetze:
```js
const htmlLogger = new Logger({
  logFile: 'logs.html',
  format: 'html',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const txtLogger = new Logger({
  logFile: 'logs.txt',
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});
```
durch:
```js
new Logger({
  logFile: 'logs.html',
  format: 'html',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

new Logger({
  logFile: 'logs.txt',
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});
```

- [ ] **Step 3: `ownUserId`-Parameter aus `processDocument`-Signatur entfernen**

`ownUserId` wird innerhalb von `processDocument` nirgends gelesen (verifiziert per
`grep -n "ownUserId" server.js` — nur Definition und die beiden Aufrufstellen, die es
weiterreichen). Da es der letzte Parameter ist, ändern die beiden Aufrufstellen sich **nicht**
(JavaScript ignoriert überzählige Argumente stillschweigend). Ersetze:
```js
async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList, ownUserId) {
```
durch:
```js
async function processDocument(doc, existingTags, existingCorrespondentList, existingDocumentTypesList) {
```

- [ ] **Step 4: totes `authRoutes`-Require entfernen**

`authenticateJWT`/`isAuthenticated` werden von `routes/setup.js`/`routes/review.js` direkt aus
`./auth.js` importiert, nicht über diese `server.js`-Zeile — sie wird nirgends sonst referenziert
(kein `app.use(authRoutes)` im ganzen File). Ersetze:
```js
app.use('/', setupRoutes);
app.use('/', reviewRoutes);
const authRoutes = require('./routes/auth');
const ragRoutes = require('./routes/rag');
```
durch:
```js
app.use('/', setupRoutes);
app.use('/', reviewRoutes);
const ragRoutes = require('./routes/rag');
```

- [ ] **Step 5: Express-Error-Handler — `next` bleibt stehen, Warnung gezielt unterdrücken**

**Nicht `next` entfernen:** Express erkennt eine Error-Handling-Middleware an genau vier
deklarierten Parametern (`fn.length === 4`). Ersetze:
```js
// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
```
durch:
```js
// Error handler
// eslint-disable-next-line no-unused-vars -- Express erkennt Error-Handler an der Arity (4
// Parameter); next muss stehen bleiben, auch wenn er hier nicht aufgerufen wird.
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
```

- [ ] **Step 6: `services/loggerService.js` — ungenutzte Catch-Bindung**

Ersetze (Zeile 39, `initLogFile`s alte-Datei-löschen-Fallback):
```js
            try {
                fs.unlinkSync(this.logPath);
            } catch (error) {
                // Ignoriere Fehler wenn Datei nicht existiert
            }
```
durch:
```js
            try {
                fs.unlinkSync(this.logPath);
            } catch {
                // Ignoriere Fehler wenn Datei nicht existiert
            }
```

- [ ] **Step 7: Verifizieren — funktional, nicht nur per Test**

Run: `npx eslint server.js services/loggerService.js`
Expected: 0 Warnungen (vorher 6 + 1 = 7).

Run: `npm test`
Expected: 460/460 grün.

Run (manueller Funktionscheck des Logger-Seiteneffekts, Zusatz zu `npm test` — `logs/` ist per
`.gitignore` ausgeschlossen, dieser Check hinterlässt keine zu committende Datei):
```bash
node -e "require('./services/loggerService'); new (require('./services/loggerService'))({logFile:'nachaudit16-check.txt', format:'txt'}); console.log('probe');"
node -e "console.log(require('fs').readFileSync('logs/nachaudit16-check.txt','utf8').includes('probe'))"
rm -f logs/nachaudit16-check.txt
```
Expected: zweiter Befehl gibt `true` aus (bestätigt: `console.log` landet weiterhin in der
Log-Datei, das Monkey-Patching funktioniert nach der Änderung identisch wie vorher).

- [ ] **Step 8: Commit**

```bash
git add server.js services/loggerService.js
git commit -m "$(cat <<'EOF'
fix: server.js Lint-Warnungen ohne Verhaltensaenderung beheben (NACHAUDIT-16, 5/11)

htmlLogger/txtLogger: nur die ungenutzte Variablenbindung entfernt, den
new Logger(...)-Aufruf behalten - der Konstruktor ueberschreibt global
console.log/.error/.warn/.info/.debug und ist die einzige Quelle des
dateibasierten Loggings (logs/logs.html, logs/logs.txt). Express-Error-Handler
behaelt alle vier Parameter (Express erkennt Error-Handler an der Arity) -
Warnung stattdessen per eslint-disable-Kommentar unterdrueckt. Ownuserid aus
processDocument-Signatur entfernt (nie gelesen, Aufrufstellen unveraendert
gueltig - ueberzaehlige Argumente werden von JS ignoriert). Totes date-fns-
Destructuring und totes authRoutes-Require entfernt. Manuell verifiziert,
dass der Logger-Seiteneffekt (console.log landet weiterhin in logs/*.txt)
identisch funktioniert.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 5/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `routes/setup.js`

**Files:**
- Modify: `routes/setup.js` (Zeilen 19, 139, 467, 610, 1021, 2528+2543, 2693-2696, 3068, 3186,
  3429, 4361, 4374)

**Warum eigener Task:** Größte Einzeldatei dieses Plans (12 Fundstellen), enthält den einzigen
Fund eines vorbestehenden, nicht in diesem Plan zu behebenden Funktionsbugs (siehe Global
Constraints).

- [ ] **Step 1: totes `cookie-parser`-Require entfernen**

Ersetze:
```js
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { isAuthenticated, getJwtSecret } = require('./auth.js');
```
durch:
```js
const bcrypt = require('bcryptjs');
const { isAuthenticated, getJwtSecret } = require('./auth.js');
```

- [ ] **Step 2: tote `API_ENDPOINTS`-Konstante entfernen**

`PUBLIC_ROUTES` (aus dem NACHAUDIT-01-Fix) übernimmt diese Rolle bereits, `API_ENDPOINTS` wird
nirgends mehr referenziert. Ersetze:
```js
// API endpoints that should not redirect
const API_ENDPOINTS = ['/health'];
// Routes that don't require authentication
```
durch:
```js
// Routes that don't require authentication
```

- [ ] **Step 3: `GET /sampleData/:id` — verwaiste `correspondents`-Variable entfernen (Bug bleibt, siehe Global Constraints)**

Ersetze:
```js
router.get('/sampleData/:id', async (req, res) => {
  try {
    //get all correspondents from one document by id
    const document = await paperlessService.getDocument(req.params.id);
    const correspondents = await paperlessService.getCorrespondentsFromDocument(document.id);

  } catch (error) {
    console.error('[ERRO] loading sample data:', error);
    res.status(500).json({ error: 'Error loading sample data' });
  }
});
```
durch:
```js
router.get('/sampleData/:id', async (req, res) => {
  try {
    //get all correspondents from one document by id
    const document = await paperlessService.getDocument(req.params.id);
    await paperlessService.getCorrespondentsFromDocument(document.id);

  } catch (error) {
    console.error('[ERRO] loading sample data:', error);
    res.status(500).json({ error: 'Error loading sample data' });
  }
});
```
(Verhalten bleibt exakt identisch zum jetzigen — bereits fehlerhaften — Zustand: die Route sendet
im Erfolgsfall weiterhin keine Antwort. Das ist ein vorbestehender Bug, siehe Global Constraints
und Task 11/NACHAUDIT-17 — hier wird nur die dadurch verwaiste Variable entfernt, nicht der Bug
behoben.)

- [ ] **Step 4: `GET /thumb/:documentId` — optionale Catch-Bindung**

Ersetze (Zeile 610):
```js
    } catch (err) {
      // File existiert nicht im Cache, hole es von Paperless
      console.log('Thumbnail not cached, fetching from Paperless');
```
durch:
```js
    } catch {
      // File existiert nicht im Cache, hole es von Paperless
      console.log('Thumbnail not cached, fetching from Paperless');
```

- [ ] **Step 5: `GET /history` — tote `tagMap`-Konstante entfernen**

`new Map(...)` ist eine reine, seiteneffektfreie Datenstruktur — sicheres Löschen. Ersetze:
```js
    const allTags = await paperlessService.getTags();
    const tagMap = new Map(allTags.map(tag => [tag.id, tag]));

    // Get all correspondents for filter dropdown
```
durch:
```js
    const allTags = await paperlessService.getTags();

    // Get all correspondents for filter dropdown
```

- [ ] **Step 6: `POST /manual/webhook`-Bereich — totes `usePrompt`-Flag entfernen**

`usePrompt` wird gesetzt, aber nirgends im Projekt gelesen (verifiziert per
`grep -n "usePrompt\b" routes/setup.js` — nur Deklaration und diese eine Zuweisung; die einzigen
anderen Treffer für den Substring sind das unabhängige `usePromptTags`). Ersetze (Deklaration,
aktuell Zeile 2528):
```js
    let usePrompt = false;
```
durch: **ersatzlose Löschung der Zeile**.

Ersetze (Zuweisung, aktuell Zeile 2543):
```js
      if (prompt) {
        usePrompt = true;
        console.log('[DEBUG] Using custom prompt:', prompt);
        await processQueue(prompt);
      } else {
```
durch:
```js
      if (prompt) {
        console.log('[DEBUG] Using custom prompt:', prompt);
        await processQueue(prompt);
      } else {
```

- [ ] **Step 7: `GET /settings` — tote `processSystemPrompt`-Funktion entfernen**

Nirgends im Projekt aufgerufen (verifiziert per `grep -n "processSystemPrompt" routes/setup.js` —
einziger Treffer ist die Definition selbst). Ersetze:
```js
router.get('/settings', async (req, res) => {
  const processSystemPrompt = (prompt) => {
    if (!prompt) return '';
    return prompt.replace(/\\n/g, '\n');
  };

  const normalizeArray = (value) => {
```
durch:
```js
router.get('/settings', async (req, res) => {
  const normalizeArray = (value) => {
```

- [ ] **Step 8: `POST /manual/analyze` — ungenutztes `existingTags` aus Request-Body-Destructuring entfernen**

Der Handler holt Tags stattdessen serverseitig frisch über `paperlessService.listTagNames()` —
der vom Client mitgeschickte Wert wird nie gelesen. Ersetze:
```js
    const { content, existingTags, id } = req.body;
    let existingCorrespondentList = await paperlessService.listCorrespondentsNames();
```
durch:
```js
    const { content, id } = req.body;
    let existingCorrespondentList = await paperlessService.listCorrespondentsNames();
```

- [ ] **Step 9: `POST /manual/playground` — dieselbe Bereinigung**

Ersetze:
```js
    const { content, existingTags, prompt, documentId } = req.body;
```
durch:
```js
    const { content, prompt, documentId } = req.body;
```

- [ ] **Step 10: drei weitere optionale Catch-Bindungen**

Ersetze (aktuell Zeile 3429, Health-Check):
```js
    try {
      await documentModel.isDocumentProcessed(1);
    } catch (error) {
      return res.status(503).json({ 
```
durch:
```js
    try {
      await documentModel.isDocumentProcessed(1);
    } catch {
      return res.status(503).json({ 
```

Ersetze (aktuell Zeile 4361, `/api/processing-status`):
```js
router.get('/api/processing-status', async (req, res) => {
  try {
      const status = await documentModel.getCurrentProcessingStatus();
      res.json(status);
  } catch (error) {
      res.status(500).json({ error: 'Failed to fetch processing status' });
  }
});
```
durch:
```js
router.get('/api/processing-status', async (req, res) => {
  try {
      const status = await documentModel.getCurrentProcessingStatus();
      res.json(status);
  } catch {
      res.status(500).json({ error: 'Failed to fetch processing status' });
  }
});
```

Ersetze (aktuell Zeile 4374, `/api/rag-test`):
```js
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch processing status' });
  }
}
);
```
durch:
```js
  } catch {
    res.status(500).json({ error: 'Failed to fetch processing status' });
  }
}
);
```

- [ ] **Step 11: Verifizieren**

Run: `npx eslint routes/setup.js`
Expected: 0 Warnungen (vorher 12).

Run: `npm test`
Expected: 460/460 grün — insbesondere `test/setupAuthMiddleware.test.js` (Routenverhalten) und
alle `manual`/`settings`-bezogenen Tests genau ansehen.

- [ ] **Step 12: Commit**

```bash
git add routes/setup.js
git commit -m "$(cat <<'EOF'
fix: routes/setup.js Lint-Warnungen beheben, ein vorbestehender Bug dokumentiert statt gefixt (NACHAUDIT-16, 6/11)

Tote Imports/Konstanten (cookieParser, API_ENDPOINTS, tagMap, usePrompt,
processSystemPrompt) entfernt, ungenutzte Request-Body-Felder aus zwei
Destructurings entfernt (existingTags wird jeweils serverseitig neu geholt),
vier Catch-Bindings auf optional-catch-binding umgestellt. GET /sampleData/:id
sendet weiterhin keine Erfolgsantwort (vorbestehender, unabhaengiger Bug) -
nur die dadurch verwaiste correspondents-Variable entfernt, Verhalten sonst
unveraendert. Bug wird in Task 11 als NACHAUDIT-17 dokumentiert, nicht hier
behoben (Scope: Lint-Cleanup, kein Funktionsbug-Fix).

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 6/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `public/js/chat.js`

**Files:**
- Modify: `public/js/chat.js` (Zeilen 130, 166-170, 222)

**Warum eigener Task:** Enthält den einen der beiden „echt tot" verifizierten Browser-Funde
(siehe Task 8 für den anderen) — verdient wegen der HTML-Cross-Referenz-Prüfung eine eigene,
sichtbare Review-Einheit.

- [ ] **Step 1: optionale Catch-Bindung**

Ersetze (Zeile 130):
```js
        } catch (e) {
            console.log('Message is not JSON, using as is');
        }
```
durch:
```js
        } catch {
            console.log('Message is not JSON, using as is');
        }
```

- [ ] **Step 2: echt totes `toggleTheme` entfernen — mit Beleg**

**Verifiziert vor dieser Löschung:** `views/chat.ejs` enthält einen Theme-Toggle-Button
(`<button id="themeToggle" class="theme-toggle">`), aber **kein** `onclick`-Attribut darauf, und
`public/js/chat.js` selbst enthält an keiner Stelle ein `getElementById('themeToggle')` oder
einen darauf registrierten `addEventListener` (verifiziert per `grep -n "themeToggle"
public/js/chat.js` — keine Treffer). `toggleTheme()` ist damit als globale Top-Level-Funktion in
dieser Datei unerreichbarer Code — sicher zu löschen, unabhängig davon, ob der Button anderweitig
funktioniert (siehe Korrektur unten).

**Korrektur (Task-7-Review, 2026-08-06):** Die ursprüngliche Annahme, der Button sei „aktuell
unverdrahtet/funktionslos", war **falsch** — `views/chat.ejs` lädt zusätzlich `js/dashboard.js`
(`grep -n "script src" views/chat.ejs`), dessen `ThemeManager`-Klasse denselben
`#themeToggle`-Button bereits über `this.themeToggle.addEventListener('click', () =>
this.toggleTheme())` verdrahtet — nur eben `dashboard.js`s eigene Klassenmethode `toggleTheme()`,
nicht die gleichnamige, aber unabhängige globale Funktion aus `chat.js`. Der Button funktioniert
also. Das ändert nichts an der Löschung selbst: die globale `toggleTheme()`-Funktion in `chat.js`
bleibt unerreichbarer Code (nichts ruft sie auf, weder `chat.js` selbst noch `dashboard.js`, das
seine eigene, unabhängige Methode gleichen Namens nutzt) und ist weiterhin sicher zu entfernen —
nur die Einordnung als „separater UI-Bug" für NACHAUDIT-17 (Task 11) entfällt.

Ersetze:
```js
function toggleTheme() {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
}

function setTheme(theme) {
```
durch:
```js
function setTheme(theme) {
```

- [ ] **Step 3: ungenutzter Event-Parameter**

Ersetze (Zeile 222):
```js
document.getElementById('messageForm').querySelector('.send-button').addEventListener('click', async (e) => {
    await submitForm();
})
```
durch:
```js
document.getElementById('messageForm').querySelector('.send-button').addEventListener('click', async () => {
    await submitForm();
})
```

- [ ] **Step 4: Verifizieren**

Run: `npx eslint public/js/chat.js`
Expected: 0 Warnungen (vorher 3).

Run: `npm test`
Expected: 460/460 grün (dieses Skript wird von keinem `node:test`-Test direkt geladen — reine
Regressionskontrolle, dass sonst nichts kaputtgegangen ist).

- [ ] **Step 5: Commit**

```bash
git add public/js/chat.js
git commit -m "$(cat <<'EOF'
fix: chat.js Lint-Warnungen beheben, totes toggleTheme entfernt (NACHAUDIT-16, 7/11)

Vor der Loeschung von toggleTheme verifiziert: views/chat.ejs hat einen
Theme-Toggle-Button ohne onclick-Attribut, chat.js verdrahtet ihn nirgends
(anders als jede andere Datei dieses Projekts mit ThemeManager-Klasse) -
der Button ist bereits unverdrahtet/funktionslos, toggleTheme() war
unerreichbarer Code. Der Button selbst bleibt kaputt (vorbestehender,
separater Bug, dokumentiert als NACHAUDIT-17 in Task 11) - dieser Commit
behebt nur den Lint-Befund, nicht den UI-Bug. Ausserdem eine Catch-Bindung
und ein ungenutzter Event-Handler-Parameter bereinigt.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 7/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `public/js/dashboard.js`, `public/js/manual.js` — verwaiste Duplikatblöcke

**Files:**
- Modify: `public/js/dashboard.js` (Zeilen 218-273 alt)
- Modify: `public/js/manual.js` (Zeilen 217-272 alt)

**Warum eigener Task:** Größter/riskantester Einzelfund dieses Plans — echte, verifizierte
Code-Duplikation mit unterschiedlichen (teils stale) API-Endpunkten, verdient eine eigene,
sorgfältig geprüfte Review-Einheit.

**Verifiziert vor dieser Löschung:** Beide Dateien definieren **zweimal** je eine
`showTagDetails`/`showCorrespondentDetails`-Funktion:
1. `window.showTagDetails = async function() {...}` / `window.showCorrespondentDetails = async
   function() {...}` (Kommentar direkt davor: „Make ... globally available") — ruft
   `/api/tagsCount`/`/api/correspondentsCount` auf, nutzt `window.modalManager`. Das ist die
   **aktive** Version — als `window.X`-Property-Zuweisung (kein `const`/lokale Bindung) wird sie
   von ESLints `no-unused-vars` gar nicht erst geprüft, und aus der HTML per
   `onclick="showTagDetails()"`/`onclick="showCorrespondentDetails()"`
   (`views/dashboard.ejs`/`views/manual.ejs`, verifiziert per `grep`) tatsächlich aufgerufen.
2. Eine **zweite**, lokale `async function showTagDetails() {...}` /
   `async function showCorrespondentDetails() {...}` weiter unten im selben File (Kommentar
   davor: „API Functions") — ruft `/api/tags`/`/api/correspondents` auf (andere Endpunkte!),
   nutzt `modalManager` ohne `window.`-Präfix. Diese lokale Deklaration wird durch die globale
   `window.X`-Zuweisung überschattet — nichts im Projekt ruft die bloße (nicht global
   qualifizierte) `showTagDetails()`/`showCorrespondentDetails()` auf. Das sind genau die von
   ESLint markierten, tatsächlich toten zweiten Deklarationen.

Beide Blöcke sind in `dashboard.js` und `manual.js` strukturell identisch — verwaister Rest einer
früheren Refactoring-Iteration.

- [ ] **Step 1: `public/js/dashboard.js` — toten Duplikatblock entfernen**

Ersetze:
```js
// API Functions
async function showTagDetails() {
    modalManager.showModal('Tag Overview');
    modalManager.showLoader();

    try {
        const response = await fetch('/api/tags');
        const tags = await response.json();

        let content = '<div class="detail-list">';
        tags.forEach(tag => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${tag.name}</span>
                    <span class="detail-item-info">${tag.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading tags:', error);
        modalManager.setContent('<div class="text-red-500 p-4">Error loading tags. Please try again later.</div>');
    } finally {
        modalManager.hideLoader();
    }
}

async function showCorrespondentDetails() {
    modalManager.showModal('Correspondent Overview');
    modalManager.showLoader();

    try {
        const response = await fetch('/api/correspondents');
        const correspondents = await response.json();

        let content = '<div class="detail-list">';
        correspondents.forEach(correspondent => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${correspondent.name}</span>
                    <span class="detail-item-info">${correspondent.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading correspondents:', error);
        modalManager.setContent('<div class="text-red-500 p-4">Error loading correspondents. Please try again later.</div>');
    } finally {
        modalManager.hideLoader();
    }
}

// Initialize everything when DOM is loaded
```
durch:
```js
// Initialize everything when DOM is loaded
```

- [ ] **Step 2: `public/js/manual.js` — identischer toter Duplikatblock**

Ersetze (strukturell identisch zu Step 1, nur die Datei wechselt):
```js
// API Functions
async function showTagDetails() {
    modalManager.showModal('Tag Overview');
    modalManager.showLoader();

    try {
        const response = await fetch('/api/tags');
        const tags = await response.json();

        let content = '<div class="detail-list">';
        tags.forEach(tag => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${tag.name}</span>
                    <span class="detail-item-info">${tag.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading tags:', error);
        modalManager.setContent('<div class="text-red-500 p-4">Error loading tags. Please try again later.</div>');
    } finally {
        modalManager.hideLoader();
    }
}

async function showCorrespondentDetails() {
    modalManager.showModal('Correspondent Overview');
    modalManager.showLoader();

    try {
        const response = await fetch('/api/correspondents');
        const correspondents = await response.json();

        let content = '<div class="detail-list">';
        correspondents.forEach(correspondent => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${correspondent.name}</span>
                    <span class="detail-item-info">${correspondent.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading correspondents:', error);
        modalManager.setContent('<div class="text-red-500 p-4">Error loading correspondents. Please try again later.</div>');
    } finally {
        modalManager.hideLoader();
    }
}

// Initialize everything when DOM is loaded
```
durch:
```js
// Initialize everything when DOM is loaded
```

- [ ] **Step 3: Verifizieren**

Run: `npx eslint public/js/dashboard.js public/js/manual.js`
Expected: 0 Warnungen (vorher 2 + 2 = 4).

Run: `npm test`
Expected: 460/460 grün.

- [ ] **Step 4: manueller Funktionscheck (kein automatisierter Test für Browser-Skripte vorhanden)**

Dashboard- und Manual-Seite im Browser öffnen (`npm run dev`/`npm start`, dann `/dashboard` bzw.
`/manual` aufrufen), auf die Tag-Übersicht- und Korrespondenten-Übersicht-Kacheln klicken —
erwartet: Modal öffnet weiterhin, zeigt Tag-/Korrespondenten-Liste (unverändert, da die
**aktive** `window.showTagDetails`/`window.showCorrespondentDetails`-Version unangetastet
bleibt). Falls kein Browser-Zugriff in dieser Session möglich ist: im Report explizit vermerken,
dass dieser Schritt nicht durchgeführt werden konnte, statt Erfolg zu behaupten.

- [ ] **Step 5: Commit**

```bash
git add public/js/dashboard.js public/js/manual.js
git commit -m "$(cat <<'EOF'
fix: verwaiste showTagDetails/showCorrespondentDetails-Duplikate entfernen (NACHAUDIT-16, 8/11)

Beide Dateien definierten showTagDetails/showCorrespondentDetails zweimal:
einmal als window.X-Zuweisung (aktiv, aus den Views per onclick aufgerufen,
Endpunkte /api/tagsCount und /api/correspondentsCount) und einmal als lokale
Funktionsdeklaration (nie erreicht, durch die globale Zuweisung ueberschattet,
andere - teils veraltete - Endpunkte /api/tags und /api/correspondents).
Nur die tote, unerreichbare zweite Deklaration entfernt; die aktive
window.X-Version bleibt unveraendert.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 8/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `public/js/csrf.js`, `settings.js`, `setup.js`

**Files:**
- Modify: `public/js/csrf.js` (Zeile 3)
- Modify: `public/js/settings.js` (Zeilen 122-133, 447-451, 459, 502, 597, 685-686, 917)
- Modify: `public/js/setup.js` (Zeilen 28, 730, 835)

**Warum zusammen:** Alle drei Dateien enthalten überwiegend gezielte Unterdrückungen (echte
False Positives aus HTML-`onclick`/globaler Skript-Reihenfolge) statt Löschungen — passt
inhaltlich zusammen, auch wenn die Dateien unterschiedlich sind.

- [ ] **Step 1: `public/js/csrf.js` — `getCsrfToken` gezielt unterdrücken (bereits als projektweiter Global dokumentiert)**

`eslint.config.mjs` listet `getCsrfToken` bereits explizit als globalen, aus mehreren Views per
`<script>`-Reihenfolge geteilten Bezeichner (siehe Kommentar dort) — das unterdrückt die Warnung
aber nur in den **konsumierenden** Dateien (z. B. `chat.js`, das `getCsrfToken()` aufruft), nicht
in der **deklarierenden** Datei selbst. Ersetze:
```js
// Reads the csrfToken cookie set by middleware/csrf.js. Cookie name must match
// CSRF_COOKIE_NAME in middleware/csrf.js exactly.
function getCsrfToken() {
```
durch:
```js
// Reads the csrfToken cookie set by middleware/csrf.js. Cookie name must match
// CSRF_COOKIE_NAME in middleware/csrf.js exactly.
// eslint-disable-next-line no-unused-vars -- globaler Bezeichner, siehe eslint.config.mjs;
// wird aus anderen public/js-Dateien per <script>-Reihenfolge aufgerufen, nicht aus dieser Datei.
function getCsrfToken() {
```

- [ ] **Step 2: `public/js/settings.js` — toten `getElementById`-Block entfernen**

Alle elf Konstanten sind reine, seiteneffektfreie DOM-Lookups, deren Ergebnis nie gelesen wird.
Ersetze:
```js
        // Restriction settings
        const restrictToExistingTags = document.getElementById('restrictToExistingTags');
        const restrictToExistingCorrespondents = document.getElementById('restrictToExistingCorrespondents');

        // External API settings
        const externalApiEnabled = document.getElementById('externalApiEnabled');
        const externalApiSettings = document.getElementById('externalApiSettings');
        const externalApiUrl = document.getElementById('externalApiUrl');
        const externalApiMethod = document.getElementById('externalApiMethod');
        const externalApiHeaders = document.getElementById('externalApiHeaders');
        const externalApiBody = document.getElementById('externalApiBody');
        const externalApiTimeout = document.getElementById('externalApiTimeout');
        const externalApiTransformationTemplate = document.getElementById('externalApiTransformationTemplate');
        
        
        // Hide all settings sections first
```
durch:
```js
        // Hide all settings sections first
```

- [ ] **Step 3: `public/js/settings.js` — Manager-Instanzen: bestehende Projekt-Konvention aus `setup.js` replizieren**

`public/js/setup.js` (Zeilen 718-726) hat exakt dasselbe Muster (dieselben fünf Variablennamen)
bereits mit `/* eslint-disable no-unused-vars */`/`/* eslint-enable no-unused-vars */` gelöst —
dieses Muster wird hier repliziert statt einer neuen Lösung. Ersetze:
```js
document.addEventListener('DOMContentLoaded', () => {
    const themeManager = new ThemeManager();
    const formManager = new FormManager();
    const tagsManager = new TagsManager('tagInput','tagsContainer','tags');
    const promptTagsManager = new TagsManager('promptTagInput','promptTagsContainer','promptTags');
    const promptManager = new PromptManager();

    // Initialize textarea newlines
```
durch:
```js
document.addEventListener('DOMContentLoaded', () => {
    /* eslint-disable no-unused-vars */
    const themeManager = new ThemeManager();
    const formManager = new FormManager();
    const tagsManager = new TagsManager('tagInput','tagsContainer','tags');
    const promptTagsManager = new TagsManager('promptTagInput','promptTagsContainer','promptTags');
    const promptManager = new PromptManager();
    /* eslint-enable no-unused-vars */

    // Initialize textarea newlines
```

- [ ] **Step 4: `public/js/settings.js` — ungenutzter `event`-Parameter**

Ersetze:
```js
// Form Submission Handler
document.addEventListener('DOMContentLoaded', (event) => {
    const systemPromptTextarea = document.getElementById('systemPrompt');
```
durch:
```js
// Form Submission Handler
document.addEventListener('DOMContentLoaded', () => {
    const systemPromptTextarea = document.getElementById('systemPrompt');
```

- [ ] **Step 5: `public/js/settings.js` — `Swal.fire`-Aufruf behalten, Bindung entfernen**

`Swal.fire(...)` zeigt den Dialog per Seiteneffekt an — Aufruf bleibt, nur die nie gelesene
`alert`-Bindung (die zusätzlich den globalen `window.alert` überschattet) entfällt. Ersetze:
```js
                if (result.restart) {
                    let countdown = 5;
                    const alert = Swal.fire({
                        title: 'Restarting...',
                        text: `Application will restart in ${countdown} seconds`,
                        icon: 'info',
                        showConfirmButton: false,
                        allowOutsideClick: false
                    });
```
durch:
```js
                if (result.restart) {
                    let countdown = 5;
                    Swal.fire({
                        title: 'Restarting...',
                        text: `Application will restart in ${countdown} seconds`,
                        icon: 'info',
                        showConfirmButton: false,
                        allowOutsideClick: false
                    });
```

- [ ] **Step 6: `public/js/settings.js` — optionale Catch-Bindung**

Ersetze:
```js
        } catch (error) {
            Swal.fire({
                icon: 'error',
                title: 'Invalid URL',
```
durch:
```js
        } catch {
            Swal.fire({
                icon: 'error',
                title: 'Invalid URL',
```

- [ ] **Step 7: `public/js/settings.js` — `urlValidator`/`tooltipManager`: dieselbe Disable-Konvention**

Ersetze:
```js
document.addEventListener('DOMContentLoaded', () => {
    const urlValidator = new URLValidator();
    const tooltipManager = new TooltipManager();
});
```
durch:
```js
document.addEventListener('DOMContentLoaded', () => {
    /* eslint-disable no-unused-vars */
    const urlValidator = new URLValidator();
    const tooltipManager = new TooltipManager();
    /* eslint-enable no-unused-vars */
});
```

- [ ] **Step 8: `public/js/settings.js` — `removeCustomField` gezielt unterdrücken (HTML-`onclick` im selben File)**

**Verifiziert:** Zeile 866 (`onclick="removeCustomField(this)"`, im Template-String derselben
Datei) ruft diese Funktion tatsächlich auf — ESLint sieht Aufrufe aus String-Literalen nicht.
Ersetze:
```js
function removeCustomField(button) {
```
durch:
```js
// eslint-disable-next-line no-unused-vars -- aufgerufen aus dem generierten
// onclick="removeCustomField(this)" (Template-String weiter oben in dieser Datei).
function removeCustomField(button) {
```

- [ ] **Step 9: `public/js/setup.js` — `theme`-Parameter aus `updateShepherdTheme` entfernen**

`updateShepherdTheme(theme)` liest `theme` in ihrem Body nirgends (fragt stattdessen
`document.querySelectorAll('.shepherd-element')` global ab). Der einzige Aufrufer
(`this.updateShepherdTheme(theme)` in `setTheme`) bleibt unverändert gültig — JavaScript
ignoriert überzählige Argumente. Ersetze:
```js
    updateShepherdTheme(theme) {
        const activeTooltips = document.querySelectorAll('.shepherd-element');
```
durch:
```js
    updateShepherdTheme() {
        const activeTooltips = document.querySelectorAll('.shepherd-element');
```

- [ ] **Step 10: `public/js/setup.js` — ungenutzter `event`-Parameter**

Ersetze:
```js
// Initialize textarea newlines
document.addEventListener('DOMContentLoaded', (event) => {
    const systemPromptTextarea = document.getElementById('systemPrompt');
```
durch:
```js
// Initialize textarea newlines
document.addEventListener('DOMContentLoaded', () => {
    const systemPromptTextarea = document.getElementById('systemPrompt');
```

- [ ] **Step 11: `public/js/setup.js` — `removeCustomField` gezielt unterdrücken (dasselbe Muster wie `settings.js`)**

**Verifiziert:** Zeile 787 (`onclick="removeCustomField(this)"`, im Template-String derselben
Datei) ruft diese Funktion auf. Ersetze:
```js
function removeCustomField(button) {
```
durch:
```js
// eslint-disable-next-line no-unused-vars -- aufgerufen aus dem generierten
// onclick="removeCustomField(this)" (Template-String weiter oben in dieser Datei).
function removeCustomField(button) {
```

- [ ] **Step 12: Verifizieren**

Run: `npx eslint public/js/csrf.js public/js/settings.js public/js/setup.js`
Expected: 0 Warnungen (vorher 1 + 21 + 3 = 25).

Run: `npm test`
Expected: 460/460 grün.

- [ ] **Step 13: manueller Funktionscheck**

Settings- und Setup-Seite im Browser öffnen: „Custom Field entfernen"-Button in beiden
(`onclick="removeCustomField(this)"`) klicken — erwartet: Feld verschwindet aus dem Formular wie
vorher. Falls kein Browser-Zugriff möglich: im Report explizit vermerken statt Erfolg zu
behaupten.

- [ ] **Step 14: Commit**

```bash
git add public/js/csrf.js public/js/settings.js public/js/setup.js
git commit -m "$(cat <<'EOF'
fix: csrf.js/settings.js/setup.js Lint-Warnungen beheben (NACHAUDIT-16, 9/11)

getCsrfToken (globaler, aus anderen Dateien per Script-Reihenfolge genutzter
Bezeichner) und removeCustomField (aus einem generierten onclick="..." im
selben Template-String aufgerufen, in beiden Dateien) gezielt per
eslint-disable unterdrueckt statt geloescht - beides echte ESLint-Fehltreffer,
da String-literal-eingebettete HTML-Aufrufe nicht statisch sichtbar sind.
Toter getElementById-Block (settings.js) entfernt. Manager-Instanzen
(themeManager, formManager, urlValidator, ...) behalten ihren
Seiteneffekt-Aufruf, nur die Bindung wird per eslint-disable/-enable-Block
unterdrueckt - repliziert das in setup.js bereits bestehende Muster fuer
denselben Fall. Swal.fire-Aufruf behalten, ungenutzte Bindung entfernt.
Ungenutzte Event-/Theme-Parameter entfernt (Aufrufstellen bleiben gueltig).

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 9/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Testdateien — ungenutzte Mock-Parameter

**Files:**
- Modify: `test/documentFingerprintService.test.js` (Zeile 159)
- Modify: `test/entityResolver.test.js` (Zeile 102)
- Modify: `test/paperlessMergeEntity.test.js` (Zeile 289)

**Warum zusammen:** Alle drei sind Fake-/Mock-Callbacks, deren Parameter positionsbedingt von der
echten Schnittstelle vorgegeben sind, im jeweiligen Testfall aber nicht gebraucht werden —
JavaScript ignoriert überzählige Argumente beim Aufruf, das Entfernen ist in allen drei Fällen
sicher.

- [ ] **Step 1: `test/documentFingerprintService.test.js`**

Ersetze:
```js
  const embeddingService = {
    embed: async (text) => {
      embedCalls++;
      if (embedCalls > 1) throw new Error('embed sollte hier nur einmal aufgerufen werden');
      return [1, 0];
    },
```
durch:
```js
  const embeddingService = {
    embed: async () => {
      embedCalls++;
      if (embedCalls > 1) throw new Error('embed sollte hier nur einmal aufgerufen werden');
      return [1, 0];
    },
```

- [ ] **Step 2: `test/entityResolver.test.js`**

Ersetze:
```js
  const judge = async (type, a, b) => ({ verdict: 'same', reason: 'gleiche Sache, andere Schreibweise' });
```
durch:
```js
  const judge = async () => ({ verdict: 'same', reason: 'gleiche Sache, andere Schreibweise' });
```

- [ ] **Step 3: `test/paperlessMergeEntity.test.js`**

Ersetze:
```js
  const mockClient = {
    get: async (url) => {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      throw error;
    },
```
durch:
```js
  const mockClient = {
    get: async () => {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      throw error;
    },
```

- [ ] **Step 4: Verifizieren**

Run: `npx eslint test/documentFingerprintService.test.js test/entityResolver.test.js test/paperlessMergeEntity.test.js`
Expected: 0 Warnungen (vorher 1 + 3 + 1 = 5).

Run: `npm test`
Expected: 460/460 grün.

- [ ] **Step 5: Commit**

```bash
git add test/documentFingerprintService.test.js test/entityResolver.test.js test/paperlessMergeEntity.test.js
git commit -m "$(cat <<'EOF'
fix: ungenutzte Mock-Parameter in drei Testdateien entfernen (NACHAUDIT-16, 10/11)

Drei Fake-/Mock-Callbacks (embed, judge, get) hatten von der jeweiligen
echten Schnittstelle vorgegebene, im Testfall aber ungenutzte Parameter -
JavaScript ignoriert ueberzaehlige Argumente beim Aufruf, Entfernen ist
verhaltensneutral.

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 10/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Ratsche senken, Ergebnis dokumentieren, neue Funde festhalten

**Files:**
- Modify: `package.json`
- Modify: `docs/audit/2026-08-04-nachaudit-offene-punkte.md`

- [ ] **Step 1: finale Warnungszahl verifizieren**

Run: `npx eslint .`
Expected: `0 problems` (0 Fehler, 0 Warnungen). Falls nicht 0: **nicht weitermachen** — die
Differenz aufklären (fehlender Task-Schritt oder neue Warnung durch eine der Änderungen), bevor
Step 2 fortgesetzt wird.

- [ ] **Step 2: `package.json`-Ratsche senken**

Ersetze:
```json
    "lint": "eslint . --max-warnings=83",
```
durch:
```json
    "lint": "eslint . --max-warnings=0",
```

- [ ] **Step 3: vollständigen Regressionslauf**

Run: `npm test`
Expected: 460/460 grün.

Run: `npm run lint`
Expected: exit code 0, keine Warnungen.

- [ ] **Step 4: NACHAUDIT-16 im Audit-Dokument als erledigt markieren**

In `docs/audit/2026-08-04-nachaudit-offene-punkte.md`, im NACHAUDIT-16-Abschnitt (Maßnahme
„offener Folgepunkt"), unter der letzten Zeile dieses Abschnitts ein Ergebnis ergänzen — Muster:
bestehende „Ergebnis (Datum):"-Absätze in diesem Dokument (siehe NACHAUDIT-08/-09/-13). Inhalt:
Anzahl behobener Warnungen (83), Aufteilung nach Fund-Typ (tote Imports, optionale
Catch-Bindings, zwei tatsächlich tote Funktionen mit Beleg, drei gezielte Unterdrückungen mit
Begründung), `--max-warnings` jetzt `0`.

- [ ] **Step 5: neuen Fund als NACHAUDIT-17 dokumentieren (nicht beheben)**

Im selben Dokument, nach dem NACHAUDIT-16-Abschnitt, einen neuen Abschnitt „NACHAUDIT-17 — bei
der Lint-Bereinigung gefundener, unabhängiger Bug (gefunden, nicht behoben, 2026-08-06)" ergänzen
mit genau einem Punkt:
1. `routes/setup.js`, `GET /sampleData/:id` sendet im Erfolgsfall keine HTTP-Antwort (Task 6,
   Step 3 dieses Plans) — Funktionsbug, unabhängig vom Lint-Cleanup.

Als „Low, kein eigenes Paket wert, bei Gelegenheit mitnehmen" einordnen (gleiche Formulierung wie
bei vergleichbaren Nebenbefunden in diesem Dokument, z. B. NACHAUDIT-07).

**Korrektur während der Umsetzung (Task-7-Review, 2026-08-06):** Der ursprüngliche Plan-Entwurf
vermutete hier einen zweiten Bug — einen unverdrahteten Theme-Toggle-Button auf der Chat-Seite,
als Begründung für das Löschen von `toggleTheme()` in `public/js/chat.js` (Task 7). Der
Task-7-Reviewer hat das widerlegt: `views/chat.ejs` lädt zusätzlich `js/dashboard.js`
(`grep -n "script src" views/chat.ejs`, Zeile 181), dessen `ThemeManager`-Klasse genau diesen
`#themeToggle`-Button bereits verdrahtet (`public/js/dashboard.js`, Konstruktor). Der Button
funktioniert also — nur eben über `dashboard.js`s Klassenmethode `toggleTheme()`, nicht über die
gleichnamige, aber unabhängige globale Funktion, die in `chat.js` verwaist war. Die Löschung in
Task 7 bleibt dadurch korrekt (die gelöschte Funktion war tatsächlich unerreichbar), nur die
Begründung „Button ist kaputt" war falsch — dieser zweite Punkt entfällt deshalb aus
NACHAUDIT-17, es wird nur der eine echte Fund (Punkt 1 oben) dokumentiert.

- [ ] **Step 6: Arbeitsplan-Punkt 5 auf `[x]` setzen**

In `docs/audit/2026-08-04-nachaudit-offene-punkte.md`, Arbeitsplan-Punkt 5, ersetze:
```
5. [ ] **Lint-Warnungen projektweit aufräumen** (NACHAUDIT-16, Nebenbefund aus
   der Paket-4-PR-CI)
   → Risikoarm, unabhängig von allen anderen Paketen, guter Lückenfüller. Die
   eine Warnung, die das Gate (`--max-warnings=83`) akut hatte scheitern
   lassen, ist bereits behoben (Paket 4). Offen: die übrigen 83 Alt-Warnungen
   (`no-unused-vars` quer über `server.js`, `routes/setup.js`, mehrere
   `services/*.js` und `public/js/*.js`, siehe NACHAUDIT-07/-16) tatsächlich
   beheben statt nur die Ratsche mitzuziehen.
```
durch:
```
5. [x] **Lint-Warnungen projektweit aufräumen** (NACHAUDIT-16, Nebenbefund aus
   der Paket-4-PR-CI)
   → Umgesetzt laut
   [2026-08-06-nachaudit16-lint-warnungen-aufraeumen.md](../superpowers/plans/2026-08-06-nachaudit16-lint-warnungen-aufraeumen.md).
   Alle 83 Warnungen behoben, `--max-warnings` auf `0` gesenkt. Ein dabei
   gefundener, unabhängiger Bug als NACHAUDIT-17 festgehalten (nicht behoben,
   außerhalb des Lint-Scopes).
```

- [ ] **Step 7: Commit**

```bash
git add package.json docs/audit/2026-08-04-nachaudit-offene-punkte.md
git commit -m "$(cat <<'EOF'
chore: Lint-Ratsche auf 0 gesenkt, NACHAUDIT-16 abgeschlossen, NACHAUDIT-17 dokumentiert (NACHAUDIT-16, 11/11)

eslint . liefert jetzt 0 Warnungen (vorher 83), package.json max-warnings
von 83 auf 0 gesenkt - echte Ratsche statt Ist-Stand-Deckel (behebt die in
NACHAUDIT-07 beschriebene Reibung). Ein beim Cleanup gefundener, unabhaengiger
Bug (GET /sampleData/:id ohne Erfolgsantwort) als NACHAUDIT-17 dokumentiert,
bewusst nicht behoben (ausserhalb des Lint-Scopes dieses Plans).

Nachaudit 2026-08-04, Arbeitsplan Punkt 5 (NACHAUDIT-16, 11/11) - Paket abgeschlossen.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance Criteria

- `npx eslint .` liefert `0 problems` (0 Fehler, 0 Warnungen).
- `npm run lint` (`eslint . --max-warnings=0`) beendet mit Exit-Code 0.
- `npm test` liefert nach jedem Task und am Ende **460/460** grün — keine Testanpassung, um eine
  Änderung „passend" zu machen.
- Kein Verhaltensunterschied ggü. vor diesem Plan: insbesondere bleibt das dateibasierte Logging
  (`logs/logs.html`/`logs/logs.txt`, Task 5) aktiv, der Express-Error-Handler bleibt als solcher
  erkennbar (Task 5), `removeCustomField`/`getCsrfToken` bleiben aus HTML/anderen Skripten
  aufrufbar (Task 9), die aktive `window.showTagDetails`/`window.showCorrespondentDetails`-Version
  bleibt unverändert (Task 8).
- Ein bei der Bereinigung gefundener, unabhängiger Bug (`GET /sampleData/:id` ohne
  Erfolgsantwort) ist **nicht** in diesem Plan behoben, sondern als NACHAUDIT-17 dokumentiert
  (Task 11) — kein stillschweigendes Scope-Creep in einen Funktionsbug-Fix. Ein zweiter, während
  der Planung vermuteter Bug (angeblich unverdrahteter Chat-Theme-Toggle) erwies sich beim
  Task-7-Review als falsch — `views/chat.ejs` lädt zusätzlich `js/dashboard.js`, dessen
  `ThemeManager` den Button bereits verdrahtet — und wurde deshalb aus NACHAUDIT-17 entfernt
  (siehe Korrektur-Hinweis in Task 11, Step 5).
- `docs/audit/2026-08-04-nachaudit-offene-punkte.md` spiegelt den tatsächlichen
  Umsetzungsstand wider (Arbeitsplan-Punkt 5 auf `[x]` nur nach Beleg, siehe Task 11).
