# Phase 2: EntityResolver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vorschläge des Modells für Tags, Dokumentarten und Korrespondenten werden vor dem Anlegen gegen den Bestand abgeglichen — exakt, normalisiert oder über eine LLM-Judge-Entscheidung im Zweifelsband —, statt blind neue Einträge zu erzeugen. Jedes Entscheidungspaar wird höchstens einmal befragt und danach dauerhaft aus Alias- bzw. Reject-Tabelle beantwortet.

**Architecture:** Reine Entscheidungslogik (`entityResolver.js`) getrennt von Ausführung (`paperlessService.js`). Der Resolver bekommt `store` (SQLite, Alias- und Queue-Zugriff) und `judge` (kleiner separater Ollama-Call) injiziert und schreibt selbst nichts nach Paperless. Einhängepunkte sind `processTags`, `getOrCreateCorrespondent`, `getOrCreateDocumentType` — nicht `buildUpdateData` (doppelt vorhanden, wird nicht angefasst). Bei deaktiviertem oder fehlerhaftem Resolver ist das Verhalten identisch zum heutigen Stand.

**Baseline:** Phase 1 ist erledigt und gemerged; Determinismus und Bestandslisten im Prompt sind gesichert. Phase 2 baut darauf auf, ist aber unabhängig wirksam. `data/eval/entities.json` (Fixture aus Phase 0) enthält bereits reale Beispiele für orthografisch nahe (`Meldebescheid`/`Meldebescheinigung`/`Meldebeschreibung`) und orthografisch ferne, aber bedeutungsgleiche (`Entgeltabrechnung`/`Verdienstbescheinigung`/`Payroll Statement`) Namensgruppen.

**Tech Stack:** Node.js (CommonJS), `better-sqlite3` (bereits Dependency, `models/document.js` als Präzedenzfall), `node:test` (keine neue Dependency), axios (bereits Dependency, für den Judge-Call).

**Spec:** [../specs/2026-08-01-klassifikations-konsistenz-design.md](../specs/2026-08-01-klassifikations-konsistenz-design.md), Abschnitt „Phase 2 — EntityResolver"; Kurzfassung in [../../planning/klassifikations-konsistenz-roadmap.md](../../planning/klassifikations-konsistenz-roadmap.md), Abschnitt „Phase 2".

## Global Constraints

- Node.js (`node:test`, `node --test test/*.test.js`).
- **Keine neuen Runtime-Dependencies.** `better-sqlite3` und `axios` sind bereits vorhanden; `sqlite3` bleibt weiterhin unbenutzt und wird nicht angefasst.
- CommonJS, kein ESM. Log-Präfixe wie im Bestand: `[DEBUG]`, `[ERROR]`, `[WARNING]`.
- Interne Helfer für Tests unterstrichen exportieren (`_trigrams`, `_stripLegalForm`, …), Präzedenz: `config._parseEnvNumber`, `ollamaService._isPlausibleTag`.
- `data/.env` enthält echte Zugangsdaten und wird von keinem Test gelesen. Tests, die eine DB brauchen, verwenden `:memory:`; Tests, die einen Judge brauchen, verwenden einen Fake, nie echtes Ollama/Netzwerk.
- Der Resolver ist per Default **deaktiviert** (`ENTITY_RESOLVER_ENABLED` Default `no`) — Phase 2 liefert die Maschinerie, nicht zwangsläufig den scharfgeschalteten Zustand; Aktivierung ist eine bewusste Entscheidung nach Task 11 (Schwellwert-Messung).
- Jede Änderung an `paperlessService.js` muss bei deaktiviertem oder fehlerhaftem Resolver exakt das heutige Verhalten reproduzieren (siehe „## Fehlerverhalten" der Spec) — kein Absturz, kein verändertes Anlegen-Verhalten.
- **Vor Task 1:** auf dem bestehenden Arbeits-Branch fortsetzen (Phase 1 wurde bereits direkt auf `docs/klassifikations-konsistenz` umgesetzt und gemergt/committed — kein neuer Branch nötig, außer der Nutzer wünscht ausdrücklich Isolation).

## Architektur-Entscheidungen

**Datenbankdatei: eigene `data/entities.db`, nicht `data/documents.db`.** `models/document.js` öffnet seine Verbindung als Modul-Singleton beim `require` — nicht injizierbar, für Tests bräuchte man die reale Datei. `entityStore.js` muss aber `:memory:` in Tests annehmen können (Testing-Abschnitt der Spec verlangt Resolver-Tests ohne echte DB). Deshalb wird `entityStore.js` als **Klasse** gebaut, die den DB-Pfad im Konstruktor entgegennimmt (Default `data/entities.db`, Tests übergeben `:memory:`). Eine eigene Datei statt neuer Tabellen in `documents.db` hält die bounded contexts getrennt: Alias-Lernen lässt sich zurücksetzen (Datei löschen), ohne die Verarbeitungshistorie in `processed_documents` zu berühren, und es entsteht keine Kopplung zwischen zwei unabhängigen Schreibmustern in derselben WAL-Datei.

**Judge-Integration: eigener minimaler Ollama-Call in `services/entityJudge.js`, nicht `ollamaService._callOllamaAPI`.** `_callOllamaAPI` ist zwar generisch genug (Prompt/System/Schema), koppelt aber an `config.ollama.temperature`/`seed` — Werte, die für die Dokumentenanalyse gedacht sind und vom Nutzer verändert werden können. Der Judge braucht **immer** `temperature: 0`, unabhängig von der globalen Sampling-Config. `entityJudge.js` macht einen eigenen schlanken axios-POST gegen `${config.ollama.apiUrl}/api/generate`, mit eigenem kleinen Schema, festem `temperature: 0`, kleinem `num_ctx` (die Eingabe sind zwei kurze Namen, keine Dokumente). Modell wird aus `config.ollama.model` übernommen (dasselbe bereits geladene Modell, kein zusätzliches VRAM).

**Existierende Entity-Listen für die Ähnlichkeitsstufe.** Stufe 4 der Kaskade muss den Vorschlag gegen **alle** bestehenden Einträge eines Typs vergleichen, nicht nur gegen eine `icontains`-Teilmenge (die reale Paare wie `Entgeltabrechnung`/`Verdienstbescheinigung` gar nicht als Kandidaten liefern würde). `paperlessService` hat für Tags bereits `tagCache`/`ensureTagCache`/`refreshTagCache`; für Korrespondenten und Dokumentarten existiert das nicht. Task 9 ergänzt zwei analoge Caches, gespeist aus den bereits vorhandenen `listCorrespondentsNames()`/`listDocumentTypesNames()`.

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `services/entityNormalizer.js` | Normalisierung (allgemein + Rechtsform-Stripping) | Create |
| `services/entitySimilarity.js` | Trigram-Dice-Ähnlichkeit | Create |
| `models/entityStore.js` | SQLite: `entity_aliases`, `entity_review_queue` | Create |
| `services/entityResolver.js` | Entscheidungskaskade | Create |
| `services/entityJudge.js` | Ollama-Judge-Call, Structured Output | Create |
| `config/config.js` | `entityResolver`-Block, Env-Vars | Modify |
| `services/paperlessService.js` | Korrespondenten-/Dokumentart-Caches, Einhängen in `processTags`/`getOrCreateCorrespondent`/`getOrCreateDocumentType` | Modify |
| `scripts/tune-thresholds.js` | Schwellwert-Sweep über gelabelte Fixture | Create |
| `data/eval/entity-labels.json` | Hand-kuratierte Same/Different-Paare (gitignored, unter `data/`) | Create (manuell, Task 11) |
| `test/entityNormalizer.test.js` | Normalisierung, Rechtsform-Stripping | Create |
| `test/entitySimilarity.test.js` | Trigram-Dice | Create |
| `test/entityStore.test.js` | Alias-CRUD, Negativ-Cache, Queue | Create |
| `test/entityResolver.test.js` | Kaskade über alle Stufen, Fake-Store, Fake-Judge | Create |
| `test/entityJudge.test.js` | Request-Form, Parsing, Fehlerfall | Create |
| `test/entityResolverHookIn.test.js` | Verhalten bei deaktiviertem/fehlerhaftem Resolver in `paperlessService` | Create |
| `test/configEntityResolver.test.js` | Env-Parsing des neuen Blocks | Create |

`package.json` bleibt unverändert (`"test": "node --test test/*.test.js"` deckt neue Dateien automatisch ab).

---

### Task 1: `entityNormalizer.js` — allgemeine Normalisierung

Grundlage für alle folgenden Stufen (Alias-Lookup, Stufe 3, Ähnlichkeit). Muss vor Rechtsform-Stripping stehen, weil Stripping auf bereits normalisierten Tokens arbeitet. Reihenfolge ist kritisch: Umlaut-/ß-Faltung **vor** NFKD, weil NFKD `ä` sonst in `a` + Kombinationszeichen zerlegt und die explizite `ae`-Regel übergangen würde.

**Files:**
- Create: `services/entityNormalizer.js`
- Test: `test/entityNormalizer.test.js` (create)

**Interfaces:**
- Consumes: nichts
- Produces: `normalize(value: string) → string`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../services/entityNormalizer');

test('Kleinschreibung und Whitespace-Kollaps', () => {
  assert.strictEqual(normalize('  Stadt WERKE   Musterstadt '), 'stadt werke musterstadt');
});

test('Umlaute und scharfes S werden gefaltet', () => {
  assert.strictEqual(normalize('Müller Straße'), 'mueller strasse');
  assert.strictEqual(normalize('ÄÖÜ Größe'), 'aeoeue groesse');
});

test('Interpunktion wird zu Leerzeichen', () => {
  assert.strictEqual(normalize('Stadtwerke, GmbH & Co. KG'), 'stadtwerke gmbh co kg');
});

test('fremdsprachige Diakritika werden ueber NFKD entfernt', () => {
  assert.strictEqual(normalize('Café Résumé'), 'cafe resume');
});

test('leerer oder Nicht-String-Input liefert Leerstring', () => {
  assert.strictEqual(normalize(''), '');
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
});

test('keine Plural-/Singular-Stemming', () => {
  assert.notStrictEqual(normalize('Rechnung'), normalize('Rechnungen'));
});
```

- [ ] **Step 2:** Run `node --test test/entityNormalizer.test.js` → FAIL (Modul existiert nicht).

- [ ] **Step 3: Implementieren**

```js
// services/entityNormalizer.js
function normalize(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let s = value.toLowerCase();

  // Deutsche Faltung MUSS vor NFKD passieren, sonst zerlegt NFKD "ä" in
  // "a" + Kombinationszeichen und die explizite ae/oe/ue/ss-Regel greift nie.
  s = s
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');

  // Restliche Diakritika (z.B. franzoesische Korrespondentennamen) neutral entfernen
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

  // Interpunktion zu Leerzeichen, dann kollabieren
  s = s.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

  return s;
}

module.exports = { normalize };
```

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add services/entityNormalizer.js test/entityNormalizer.test.js
git commit -m "$(cat <<'EOF'
feat: allgemeine Entity-Normalisierung

Kleinschreibung, NFKD, explizite Umlaut- und ss-Faltung vor der
Diakritika-Entfernung, Interpunktion zu Leerzeichen. Bewusst kein
Plural-/Singular-Stemming, wie im Design festgelegt.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `entityNormalizer.js` — Rechtsform-Stripping für Korrespondenten

Nur Korrespondenten dürfen Rechtsform-Tokens verlieren; bei Tags/Dokumentarten wären sie bedeutungstragend. `e v` ist ein Zwei-Wort-Token und muss als Bigramm behandelt werden. Ein Korrespondent, der **nur** aus einem Rechtsform-Token besteht (z. B. schlicht `"GmbH"`), darf nicht auf einen leeren String kollabieren — das würde in Stufe 3 der Kaskade jeden anderen leeren Korrespondenten fälschlich matchen.

**Files:**
- Modify: `services/entityNormalizer.js`
- Test: `test/entityNormalizer.test.js` (erweitern)

**Interfaces:**
- Consumes: `normalize` aus Task 1
- Produces: `normalizeForType(value: string, type: 'tag'|'document_type'|'correspondent') → string`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
const { normalizeForType } = require('../services/entityNormalizer');

test('Rechtsform-Token wird nur bei Korrespondenten entfernt', () => {
  assert.strictEqual(normalizeForType('Stadtwerke Musterstadt GmbH', 'correspondent'), 'stadtwerke musterstadt');
  assert.strictEqual(normalizeForType('Stadtwerke Musterstadt GmbH', 'tag'), 'stadtwerke musterstadt gmbh');
});

test('e V als Bigramm wird entfernt', () => {
  assert.strictEqual(normalizeForType('Sportverein Musterstadt e.V.', 'correspondent'), 'sportverein musterstadt');
});

test('mehrere Rechtsform-Token gemischt', () => {
  assert.strictEqual(normalizeForType('Muster AG & Co. KGaA', 'correspondent'), 'muster');
});

test('reines Rechtsform-Token kollabiert nicht auf Leerstring', () => {
  assert.strictEqual(normalizeForType('GmbH', 'correspondent'), 'gmbh');
});

test('document_type und tag bleiben unveraendert zu normalize', () => {
  assert.strictEqual(normalizeForType('Rechnung AG', 'document_type'), normalizeForType('Rechnung AG', 'tag'));
});
```

- [ ] **Step 2:** Run `node --test test/entityNormalizer.test.js` → FAIL.

- [ ] **Step 3: Implementieren** — an `services/entityNormalizer.js` anhängen:

```js
const LEGAL_FORM_TOKENS = new Set([
  'gmbh', 'ag', 'kg', 'ohg', 'gbr', 'mbh', 'ug', 'se', 'co', 'kgaa',
  'ltd', 'inc', 'bv', 'sa'
]);

function _stripLegalForm(normalized) {
  const tokens = normalized.split(' ').filter(Boolean);
  const withoutBigram = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'e' && tokens[i + 1] === 'v') {
      i++; // "e v" als Rechtsform-Bigramm ueberspringen
      continue;
    }
    withoutBigram.push(tokens[i]);
  }

  const filtered = withoutBigram.filter(t => !LEGAL_FORM_TOKENS.has(t));

  // Ein Korrespondent, der ausschliesslich aus Rechtsform-Tokens besteht,
  // faellt auf die ungestrippte Form zurueck statt auf Leerstring zu kollabieren.
  return filtered.length > 0 ? filtered.join(' ') : normalized;
}

function normalizeForType(value, type) {
  const base = normalize(value);
  return type === 'correspondent' ? _stripLegalForm(base) : base;
}

module.exports = { normalize, normalizeForType, _stripLegalForm };
```

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add services/entityNormalizer.js test/entityNormalizer.test.js
git commit -m "$(cat <<'EOF'
feat: Rechtsform-Stripping fuer Korrespondenten

Nur Korrespondenten verlieren Rechtsform-Tokens (gmbh, ag, kg, ...);
bei Tags und Dokumentarten waeren sie bedeutungstragend. "e v" wird
als Bigramm behandelt. Ein Korrespondent, der nur aus einem
Rechtsform-Token besteht, faellt auf die ungestrippte Form zurueck
statt auf Leerstring zu kollabieren.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `entitySimilarity.js` — Trigram-Dice-Ähnlichkeit

Reine Funktion, operiert auf bereits normalisierten Strings (der Resolver ruft `normalizeForType` vorher auf). Padding mit einem Leerzeichen an beiden Rändern, damit auch kurze Strings mindestens ein Trigramm ergeben.

**Files:**
- Create: `services/entitySimilarity.js`
- Test: `test/entitySimilarity.test.js` (create)

**Interfaces:**
- Consumes: nichts (arbeitet auf rohen Strings, der Aufrufer normalisiert)
- Produces: `diceCoefficient(a: string, b: string) → number` (0..1)

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
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
```

- [ ] **Step 2:** Run `node --test test/entitySimilarity.test.js` → FAIL.

- [ ] **Step 3: Implementieren**

```js
// services/entitySimilarity.js
function _trigrams(value) {
  const s = ` ${value} `;
  const grams = new Set();
  for (let i = 0; i < s.length - 2; i++) {
    grams.add(s.slice(i, i + 3));
  }
  return grams;
}

function diceCoefficient(a, b) {
  if (a === b) {
    return a.length > 0 ? 1 : 0;
  }
  if (!a || !b) {
    return 0;
  }

  const gramsA = _trigrams(a);
  const gramsB = _trigrams(b);
  if (gramsA.size === 0 || gramsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection++;
  }

  return (2 * intersection) / (gramsA.size + gramsB.size);
}

module.exports = { diceCoefficient, _trigrams };
```

- [ ] **Step 4:** Run `npm test` → PASS. Bei Test 6 explizit prüfen: schlägt er unerwartet fehl (Ähnlichkeit ≥ 0.5), ist das ein wichtiger Befund für Task 11 (Schwellwert-Tuning), kein Bug — Test dann anpassen und im Tuning-Ergebnis vermerken.

- [ ] **Step 5: Commit**

```bash
git add services/entitySimilarity.js test/entitySimilarity.test.js
git commit -m "$(cat <<'EOF'
feat: Trigram-Dice-Aehnlichkeit fuer Entity-Namen

Reine Funktion auf bereits normalisierten Strings. Ein Test
dokumentiert bewusst den erwarteten blinden Fleck bei orthografisch
fernen Synonymen (Entgeltabrechnung/Verdienstbescheinigung) - dafuer
existiert die Judge-Stufe der Kaskade.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `models/entityStore.js` — Schema, Alias-CRUD, Negativ-Cache/Queue

Eigene Klasse statt Modul-Singleton (Begründung: siehe „Architektur-Entscheidungen"), damit Tests `:memory:` verwenden können. Folgt sonst dem Muster aus `models/document.js`: `better-sqlite3`, `WAL`, idempotentes `CREATE TABLE IF NOT EXISTS`, jede Methode fängt Fehler ab und liefert einen sicheren Fallback statt zu werfen.

**Files:**
- Create: `models/entityStore.js`
- Test: `test/entityStore.test.js` (create)

**Interfaces:**
- Consumes: nichts
- Produces: `new EntityStore(dbPath?)`, `.findAlias(type, aliasNormalized)`, `.insertAlias({...})`, `.deleteAlias(type, aliasNormalized)`, `.findRejectedPair(type, proposedName, candidateName)`, `.insertQueueEntry({...})`, `.close()`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const EntityStore = require('../models/entityStore');

function freshStore() {
  return new EntityStore(':memory:');
}

test('findAlias liefert null, wenn nichts gespeichert ist', () => {
  const store = freshStore();
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('insertAlias und findAlias roundtrip', () => {
  const store = freshStore();
  const ok = store.insertAlias({
    entityType: 'correspondent', aliasNormalized: 'stadtwerke musterstadt',
    canonicalName: 'Stadtwerke Musterstadt GmbH', canonicalId: 42, source: 'auto'
  });
  assert.strictEqual(ok, true);

  const found = store.findAlias('correspondent', 'stadtwerke musterstadt');
  assert.strictEqual(found.canonical_id, 42);
  assert.strictEqual(found.canonical_name, 'Stadtwerke Musterstadt GmbH');
  assert.strictEqual(found.source, 'auto');
});

test('UNIQUE(entity_type, alias_normalized): erneutes Insert ueberschreibt statt zu duplizieren', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'auto' });
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'user' });

  const found = store.findAlias('tag', 'rechnung');
  assert.strictEqual(found.source, 'user');
});

test('deleteAlias entfernt den Eintrag', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 1, source: 'auto' });
  store.deleteAlias('tag', 'rechnung');
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('findRejectedPair liefert null ohne Eintrag, gefunden nach insertQueueEntry mit status rejected', () => {
  const store = freshStore();
  assert.strictEqual(store.findRejectedPair('document_type', 'Verdienstbescheinigung', 'Entgeltabrechnung'), null);

  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 9,
    candidateName: 'Entgeltabrechnung', candidateId: 3, similarity: 0.4,
    llmVerdict: 'different', llmReason: 'unterschiedliche Dokumentarten', status: 'rejected'
  });

  const found = store.findRejectedPair('document_type', 'Verdienstbescheinigung', 'Entgeltabrechnung');
  assert.ok(found);
  assert.strictEqual(found.status, 'rejected');
});

test('offene Queue-Eintraege werden von findRejectedPair NICHT gefunden', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'A', proposedId: 1,
    candidateName: 'B', candidateId: 2, similarity: 0.7,
    llmVerdict: 'unsure', llmReason: null, status: 'open'
  });
  assert.strictEqual(store.findRejectedPair('tag', 'A', 'B'), null);
});

test('Fehlerfall: geschlossene DB liefert Fallback statt zu werfen', () => {
  const store = freshStore();
  store.close();
  assert.doesNotThrow(() => store.findAlias('tag', 'rechnung'));
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});
```

- [ ] **Step 2:** Run `node --test test/entityStore.test.js` → FAIL.

- [ ] **Step 3: Implementieren**

```js
// models/entityStore.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class EntityStore {
  constructor(dbPath) {
    const resolvedPath = dbPath || path.join(process.cwd(), 'data', 'entities.db');

    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this._createTables();
  }

  _createTables() {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        alias_normalized TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        canonical_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, alias_normalized)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS entity_review_queue (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        proposed_name TEXT NOT NULL,
        proposed_id INTEGER,
        candidate_name TEXT NOT NULL,
        candidate_id INTEGER NOT NULL,
        similarity REAL NOT NULL,
        llm_verdict TEXT,
        llm_reason TEXT,
        status TEXT NOT NULL,
        document_id INTEGER,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(entity_type, proposed_name, candidate_name)
      )
    `).run();
  }

  findAlias(entityType, aliasNormalized) {
    try {
      return this.db.prepare(
        `SELECT * FROM entity_aliases WHERE entity_type = ? AND alias_normalized = ?`
      ).get(entityType, aliasNormalized) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.findAlias:', error.message);
      return null;
    }
  }

  insertAlias({ entityType, aliasNormalized, canonicalName, canonicalId, source }) {
    try {
      this.db.prepare(`
        INSERT INTO entity_aliases (entity_type, alias_normalized, canonical_name, canonical_id, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, alias_normalized) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          canonical_id = excluded.canonical_id,
          source = excluded.source
      `).run(entityType, aliasNormalized, canonicalName, canonicalId, source, new Date().toISOString());
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertAlias:', error.message);
      return false;
    }
  }

  deleteAlias(entityType, aliasNormalized) {
    try {
      this.db.prepare(`DELETE FROM entity_aliases WHERE entity_type = ? AND alias_normalized = ?`)
        .run(entityType, aliasNormalized);
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.deleteAlias:', error.message);
      return false;
    }
  }

  findRejectedPair(entityType, proposedName, candidateName) {
    try {
      return this.db.prepare(`
        SELECT * FROM entity_review_queue
        WHERE entity_type = ? AND proposed_name = ? AND candidate_name = ? AND status = 'rejected'
      `).get(entityType, proposedName, candidateName) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.findRejectedPair:', error.message);
      return null;
    }
  }

  insertQueueEntry({ entityType, proposedName, proposedId, candidateName, candidateId, similarity, llmVerdict, llmReason, status, documentId }) {
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO entity_review_queue
          (entity_type, proposed_name, proposed_id, candidate_name, candidate_id, similarity, llm_verdict, llm_reason, status, document_id, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, proposed_name, candidate_name) DO UPDATE SET
          proposed_id = excluded.proposed_id,
          status = excluded.status,
          llm_verdict = excluded.llm_verdict,
          llm_reason = excluded.llm_reason,
          resolved_at = CASE WHEN excluded.status != 'open' THEN excluded.created_at ELSE entity_review_queue.resolved_at END
      `).run(
        entityType, proposedName, proposedId ?? null, candidateName, candidateId, similarity,
        llmVerdict ?? null, llmReason ?? null, status, documentId ?? null,
        now, status !== 'open' ? now : null
      );
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertQueueEntry:', error.message);
      return false;
    }
  }

  close() {
    try {
      this.db.close();
    } catch (error) {
      console.error('[ERROR] entityStore.close:', error.message);
    }
  }
}

module.exports = EntityStore;
```

Hinweis: `close()` markiert die Verbindung intern als geschlossen; `better-sqlite3` wirft bei Zugriff auf eine geschlossene DB eine synchrone Exception — die try/catch-Blöcke der einzelnen Methoden fangen das ab (Test 7).

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add models/entityStore.js test/entityStore.test.js
git commit -m "$(cat <<'EOF'
feat: SQLite-Store fuer Entity-Aliase und Review-Queue

Eigene Klasse statt Modul-Singleton (anders als models/document.js),
damit Tests eine :memory:-Datenbank injizieren koennen. Eine Tabelle
(entity_review_queue) dient zugleich als Review-Queue und als
Negativ-Cache ueber status='rejected'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `services/entityResolver.js` — Kaskade Stufen 0-3

Skip, Alias-Tabelle, exakter Treffer, normalisierter Treffer. Diese vier Stufen kommen ohne LLM-Call aus und sind die günstigsten. Stufe 1 behandelt defensiv den Fall eines Alias, der auf eine in Paperless inzwischen gelöschte ID zeigt (Fehlerverhalten-Tabelle der Spec: „Alias verwerfen und neu entscheiden").

**Files:**
- Create: `services/entityResolver.js`
- Test: `test/entityResolver.test.js` (create)

**Interfaces:**
- Consumes: `normalizeForType` (Task 1/2), `EntityStore` (Task 4)
- Produces: `new EntityResolver({ store, judge, config })`, `async resolve(type, proposedName, existingEntities) → { action, ... }`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const EntityResolver = require('../services/entityResolver');
const EntityStore = require('../models/entityStore');

function makeResolver(overrides = {}) {
  const store = overrides.store || new EntityStore(':memory:');
  const judge = overrides.judge || (async () => { throw new Error('Judge sollte in diesem Test nicht aufgerufen werden'); });
  return new EntityResolver({ store, judge, config: { autoThreshold: 0.90, judgeMin: 0.65 } });
}

test('Stufe 0: leer oder nur Whitespace -> skip', async () => {
  const resolver = makeResolver();
  assert.deepStrictEqual(await resolver.resolve('tag', '   ', []), { action: 'skip' });
  assert.deepStrictEqual(await resolver.resolve('tag', '', []), { action: 'skip' });
});

test('Stufe 1: Alias-Tabelle kennt normalize(N) -> map ohne API/LLM', async () => {
  const store = new EntityStore(':memory:');
  store.insertAlias({ entityType: 'correspondent', aliasNormalized: 'stadtwerke musterstadt', canonicalName: 'Stadtwerke Musterstadt', canonicalId: 5, source: 'user' });
  const resolver = makeResolver({ store });

  const result = await resolver.resolve('correspondent', 'Stadtwerke Musterstadt GmbH', [{ id: 5, name: 'Stadtwerke Musterstadt' }]);
  assert.deepStrictEqual(result, { action: 'map', id: 5, canonicalName: 'Stadtwerke Musterstadt', via: 'alias' });
});

test('Stufe 1 Fehlerfall: Alias zeigt auf geloeschte ID -> verworfen, neu entschieden', async () => {
  const store = new EntityStore(':memory:');
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'rechnung', canonicalName: 'Rechnung', canonicalId: 999, source: 'auto' });
  const resolver = makeResolver({ store });

  // 999 existiert nicht mehr im Bestand -> Alias verwerfen, dann Stufe 4d (keine Aehnlichkeit) -> create
  const result = await resolver.resolve('tag', 'Rechnung', [{ id: 1, name: 'Vertrag' }]);
  assert.strictEqual(result.action, 'create');
  assert.strictEqual(store.findAlias('tag', 'rechnung'), null);
});

test('Stufe 2: exakter Treffer im Bestand -> map', async () => {
  const resolver = makeResolver();
  const result = await resolver.resolve('tag', 'Rechnung', [{ id: 7, name: 'Rechnung' }]);
  assert.deepStrictEqual(result, { action: 'map', id: 7, canonicalName: 'Rechnung', via: 'exact' });
});

test('Stufe 3: normalisierter Treffer -> map, Alias wird geschrieben', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  const result = await resolver.resolve('correspondent', 'Müller Straße GmbH', [{ id: 3, name: 'Mueller Strasse' }]);
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.id, 3);
  assert.strictEqual(result.via, 'normalized');

  const alias = store.findAlias('correspondent', 'mueller strasse');
  assert.ok(alias, 'Alias sollte geschrieben worden sein');
  assert.strictEqual(alias.source, 'auto');
});
```

- [ ] **Step 2:** Run `node --test test/entityResolver.test.js` → FAIL (Modul existiert nicht).

- [ ] **Step 3: Grundgerüst implementieren** (Stufe 4 folgt in Task 6, hier `create`-Fallback):

```js
// services/entityResolver.js
const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityResolver {
  constructor({ store, judge, config = {} }) {
    this.store = store;
    this.judge = judge; // async (type, nameA, nameB) => { verdict, reason }
    this.autoThreshold = config.autoThreshold ?? 0.90;
    this.judgeMin = config.judgeMin ?? 0.65;
  }

  async resolve(type, proposedName, existingEntities) {
    if (!proposedName || !proposedName.trim()) {
      return { action: 'skip' };
    }

    const normalizedProposed = normalizeForType(proposedName, type);

    // Stufe 1: Alias-Tabelle
    const alias = this.store.findAlias(type, normalizedProposed);
    if (alias) {
      const stillExists = existingEntities.some(e => e.id === alias.canonical_id);
      if (stillExists) {
        return { action: 'map', id: alias.canonical_id, canonicalName: alias.canonical_name, via: 'alias' };
      }
      // Fehlerverhalten: Alias zeigt ins Leere -> verwerfen und neu entscheiden
      console.warn(`[WARNING] entityResolver: Alias "${normalizedProposed}" (${type}) zeigt auf geloeschte ID ${alias.canonical_id}, wird verworfen`);
      this.store.deleteAlias(type, normalizedProposed);
    }

    // Stufe 2: exakter Treffer (heutiges Verhalten)
    const exact = existingEntities.find(e => e.name.toLowerCase() === proposedName.toLowerCase());
    if (exact) {
      return { action: 'map', id: exact.id, canonicalName: exact.name, via: 'exact' };
    }

    // Stufe 3: normalisierter Treffer
    for (const entity of existingEntities) {
      if (normalizeForType(entity.name, type) === normalizedProposed) {
        this.store.insertAlias({
          entityType: type, aliasNormalized: normalizedProposed,
          canonicalName: entity.name, canonicalId: entity.id, source: 'auto'
        });
        return { action: 'map', id: entity.id, canonicalName: entity.name, via: 'normalized' };
      }
    }

    // Stufe 4 folgt in Task 6
    return { action: 'create' };
  }
}

module.exports = EntityResolver;
```

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add services/entityResolver.js test/entityResolver.test.js
git commit -m "$(cat <<'EOF'
feat: EntityResolver Kaskade, Stufen 0-3

Skip bei leerem Vorschlag, Alias-Tabelle, exakter und normalisierter
Treffer - alle vier ohne API- oder LLM-Call. Stufe 1 verwirft
defensiv Aliase, die auf eine in Paperless geloeschte ID zeigen, und
entscheidet neu statt auf eine ungueltige ID zu mappen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `entityResolver.js` — Kaskade Stufen 4a-4d (Ähnlichkeit, Negativ-Cache, Judge)

Kernstück der Kaskade. Negativ-Cache wird sowohl vor 4a als auch vor 4c geprüft (eine ausdrückliche Nutzerentscheidung übersticht einen hohen Ähnlichkeitswert). Der Judge wird injiziert und in try/catch behandelt: nicht erreichbar oder unparsbare Antwort → `unsure` (Fehlerverhalten-Tabelle der Spec). `unsure` erzeugt **keinen** Queue-Eintrag im Resolver selbst — `proposed_id` ist zu diesem Zeitpunkt noch unbekannt, weil der Resolver nichts anlegt. Der Aufrufer muss nach dem tatsächlichen Anlegen `recordCreatedAndQueued` aufrufen.

**Files:**
- Modify: `services/entityResolver.js`
- Test: `test/entityResolver.test.js` (erweitern)

**Interfaces:**
- Consumes: nichts Neues
- Produces: erweitert `resolve()` um die Stufen 4a-4d; neue Methode `recordCreatedAndQueued({ type, proposedName, proposedId, candidate, similarity, verdict, documentId }) → void`

- [ ] **Step 1: Fehlschlagenden Test schreiben** (an `test/entityResolver.test.js` anhängen)

```js
test('Stufe 4a: Aehnlichkeit >= AUTO_THRESHOLD -> map, Alias source=auto', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  const result = await resolver.resolve('document_type', 'Meldebescheid', [{ id: 1, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'similarity');
  assert.strictEqual(store.findAlias('document_type', 'meldebescheid').source, 'auto');
});

test('Stufe 4b: als rejected bekanntes Paar -> create, kein LLM-Call trotz hoher Aehnlichkeit', async () => {
  const store = new EntityStore(':memory:');
  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Meldebescheid', proposedId: 9,
    candidateName: 'Meldebescheinigung', candidateId: 1, similarity: 0.8,
    llmVerdict: 'different', llmReason: 'Nutzerentscheidung', status: 'rejected'
  });
  const resolver = makeResolver({ store }); // judge wirft, falls aufgerufen

  const result = await resolver.resolve('document_type', 'Meldebescheid', [{ id: 1, name: 'Meldebescheinigung' }]);
  assert.deepStrictEqual(result, { action: 'create' });
});

test('Stufe 4c: JUDGE_MIN <= Aehnlichkeit < AUTO_THRESHOLD, Judge sagt same -> map, Alias source=llm', async () => {
  const store = new EntityStore(':memory:');
  const judge = async (type, a, b) => ({ verdict: 'same', reason: 'gleiche Sache, andere Schreibweise' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Meldebeschreibung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'llm');
  assert.strictEqual(store.findAlias('document_type', 'meldebeschreibung').source, 'llm');
});

test('Stufe 4c: Judge sagt different -> create, Negativ-Eintrag geschrieben', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => ({ verdict: 'different', reason: 'unterschiedliche Dokumentarten' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create');
  assert.ok(store.findRejectedPair('document_type', 'Verdienstbescheinigung', 'Meldebescheinigung'));
});

test('Stufe 4c: Judge sagt unsure -> create_and_queue, ohne Queue-Eintrag zu schreiben', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => ({ verdict: 'unsure', reason: 'nicht eindeutig' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.deepStrictEqual(result.candidate, { id: 4, name: 'Meldebescheinigung' });
  assert.strictEqual(result.verdict, 'unsure');
  assert.strictEqual(store.findRejectedPair('document_type', 'Verdienstbescheinigung', 'Meldebescheinigung'), null);
});

test('Fehlerverhalten: Judge wirft (nicht erreichbar) -> unsure statt Absturz', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => { throw new Error('ECONNREFUSED'); };
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.strictEqual(result.verdict, 'unsure');
});

test('Fehlerverhalten: Judge liefert unparsbares Urteil -> unsure', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => ({ verdict: 'ja klar', reason: 'kaputte Antwort' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.strictEqual(result.verdict, 'unsure');
});

test('Stufe 4d: Aehnlichkeit unter JUDGE_MIN -> create, kein Judge-Call', async () => {
  const resolver = makeResolver(); // judge wirft, falls aufgerufen
  const result = await resolver.resolve('correspondent', 'Voellig Anderer Name', [{ id: 1, name: 'Stadtwerke Musterstadt' }]);
  assert.deepStrictEqual(result, { action: 'create' });
});

test('recordCreatedAndQueued schreibt den Queue-Eintrag mit der echten proposed_id', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  resolver.recordCreatedAndQueued({
    type: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 55,
    candidate: { id: 4, name: 'Meldebescheinigung' }, similarity: 0.42, verdict: 'unsure',
    documentId: 123
  });

  const found = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ? AND candidate_name = ?`
  ).get('Verdienstbescheinigung', 'Meldebescheinigung');
  assert.strictEqual(found.proposed_id, 55);
  assert.strictEqual(found.status, 'open');
  assert.strictEqual(found.document_id, 123);
});
```

- [ ] **Step 2:** Run `node --test test/entityResolver.test.js` → FAIL.

- [ ] **Step 3: Stufe 4 implementieren** — ersetze in `services/entityResolver.js` den Kommentar `// Stufe 4 folgt in Task 6\n    return { action: 'create' };` durch:

```js
    // Stufe 4: Ähnlichkeit gegen den besten Kandidaten
    let best = null;
    for (const entity of existingEntities) {
      const sim = diceCoefficient(normalizedProposed, normalizeForType(entity.name, type));
      if (!best || sim > best.similarity) {
        best = { entity, similarity: sim };
      }
    }

    if (!best) {
      return { action: 'create' };
    }

    // Negativ-Cache geht sowohl 4a als auch 4c vor
    const rejected = this.store.findRejectedPair(type, proposedName, best.entity.name);

    if (best.similarity >= this.autoThreshold) {
      if (rejected) {
        return { action: 'create' }; // Stufe 4b: Nutzerentscheidung uebersticht hohe Aehnlichkeit
      }
      this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'auto'
      });
      return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'similarity' };
    }

    if (rejected) {
      return { action: 'create' };
    }

    if (best.similarity >= this.judgeMin) {
      const verdict = await this._askJudge(type, proposedName, best.entity.name);

      if (verdict.verdict === 'same') {
        this.store.insertAlias({
          entityType: type, aliasNormalized: normalizedProposed,
          canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'llm'
        });
        return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'llm' };
      }

      if (verdict.verdict === 'different') {
        this.store.insertQueueEntry({
          entityType: type, proposedName, proposedId: null,
          candidateName: best.entity.name, candidateId: best.entity.id,
          similarity: best.similarity, llmVerdict: 'different', llmReason: verdict.reason,
          status: 'rejected'
        });
        return { action: 'create' };
      }

      // 'unsure': proposed_id ist hier noch unbekannt, der Resolver legt nichts an.
      // Der Aufrufer ruft nach dem tatsaechlichen Anlegen recordCreatedAndQueued auf.
      return {
        action: 'create_and_queue',
        candidate: { id: best.entity.id, name: best.entity.name },
        similarity: best.similarity,
        verdict: verdict.verdict
      };
    }

    // Stufe 4d
    return { action: 'create' };
  }

  async _askJudge(type, nameA, nameB) {
    try {
      const result = await this.judge(type, nameA, nameB);
      if (!result || !['same', 'different', 'unsure'].includes(result.verdict)) {
        return { verdict: 'unsure', reason: 'ungueltige oder leere Judge-Antwort' };
      }
      return result;
    } catch (error) {
      console.warn(`[WARNING] entityResolver: Judge nicht erreichbar fuer "${nameA}" vs "${nameB}", werte als unsure:`, error.message);
      return { verdict: 'unsure', reason: `judge nicht erreichbar: ${error.message}` };
    }
  }

  recordCreatedAndQueued({ type, proposedName, proposedId, candidate, similarity, verdict, documentId }) {
    this.store.insertQueueEntry({
      entityType: type, proposedName, proposedId,
      candidateName: candidate.name, candidateId: candidate.id,
      similarity, llmVerdict: verdict, llmReason: null,
      status: 'open', documentId
    });
  }
```

(`resolve` endet jetzt mit der `recordCreatedAndQueued`-Methode als weiteres Klassenmitglied; die schließende Klammer der Klasse rückt entsprechend nach unten.)

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add services/entityResolver.js test/entityResolver.test.js
git commit -m "$(cat <<'EOF'
feat: EntityResolver Kaskade, Stufen 4a-4d (Aehnlichkeit, Negativ-Cache, Judge)

Negativ-Cache greift vor Auto-Merge und vor dem Judge - eine
ausdrueckliche Nutzerentscheidung uebersticht einen hohen
Aehnlichkeitswert. Judge-Fehler (nicht erreichbar, unparsbares
Urteil) werden als "unsure" behandelt statt einen Fehler zu werfen.

create_and_queue schreibt keinen Queue-Eintrag im Resolver selbst,
weil die ID des neu angelegten Eintrags dort noch unbekannt ist;
recordCreatedAndQueued() traegt sie nach, sobald paperlessService
tatsaechlich angelegt hat.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `services/entityJudge.js` — Ollama-Judge-Call

Kleiner, separater Call mit `temperature: 0`, unabhängig von `config.ollama.temperature` (Begründung siehe „Architektur-Entscheidungen"). Nutzt dasselbe Modell wie die Dokumentenanalyse.

**Files:**
- Create: `services/entityJudge.js`
- Test: `test/entityJudge.test.js` (create)

**Interfaces:**
- Consumes: `config.ollama.apiUrl`, `config.ollama.model`
- Produces: `entityJudge.judge(entityType, nameA, nameB) → Promise<{ verdict: 'same'|'different'|'unsure', reason: string }>`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const entityJudge = require('../services/entityJudge');

function captureRequest(responseData) {
  const captured = {};
  entityJudge.client = {
    post: async (url, body) => {
      captured.url = url;
      captured.body = body;
      return { data: responseData };
    }
  };
  return captured;
}

test('sendet temperature 0 unabhaengig von der globalen Konfiguration', async () => {
  const captured = captureRequest({ response: { verdict: 'same', reason: 'gleiche Sache' } });
  await entityJudge.judge('document_type', 'Meldebescheid', 'Meldebescheinigung');

  assert.strictEqual(captured.body.options.temperature, 0);
  assert.strictEqual(captured.body.stream, false);
  assert.ok(captured.body.prompt.includes('Meldebescheid'));
  assert.ok(captured.body.prompt.includes('Meldebescheinigung'));
});

test('parst ein strukturiertes Objekt direkt', async () => {
  captureRequest({ response: { verdict: 'different', reason: 'unterschiedlich' } });
  const result = await entityJudge.judge('tag', 'A', 'B');
  assert.deepStrictEqual(result, { verdict: 'different', reason: 'unterschiedlich' });
});

test('parst eine JSON-Zeichenkette (Fallback, falls Ollama Text statt Objekt liefert)', async () => {
  captureRequest({ response: JSON.stringify({ verdict: 'unsure', reason: 'unklar' }) });
  const result = await entityJudge.judge('tag', 'A', 'B');
  assert.deepStrictEqual(result, { verdict: 'unsure', reason: 'unklar' });
});

test('wirft bei Netzwerkfehler (Aufrufer in entityResolver faengt das ab)', async () => {
  entityJudge.client = { post: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => entityJudge.judge('tag', 'A', 'B'), /ECONNREFUSED/);
});
```

- [ ] **Step 2:** Run `node --test test/entityJudge.test.js` → FAIL.

- [ ] **Step 3: Implementieren**

```js
// services/entityJudge.js
const axios = require('axios');
const config = require('../config/config');

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['same', 'different', 'unsure'] },
    reason: { type: 'string' }
  },
  required: ['verdict', 'reason']
};

class EntityJudge {
  constructor() {
    this.client = axios.create({ timeout: 15000 });
  }

  async judge(entityType, nameA, nameB) {
    const system = 'Du beurteilst, ob zwei Namen desselben Entity-Typs dieselbe reale Sache '
      + 'bezeichnen (z.B. Synonym, Abkuerzung, Schreibvariante) oder tatsaechlich verschieden '
      + 'sind. Du kennst nur die beiden Namen, kein Dokument. Antworte ausschliesslich ueber '
      + 'das vorgegebene JSON-Schema.';

    const prompt = `Typ: ${entityType}\nName A: ${nameA}\nName B: ${nameB}\n\n`
      + 'Bezeichnen A und B dieselbe Sache? "same", "different" oder "unsure", falls unklar.';

    const response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, {
      model: config.ollama.model,
      prompt,
      system,
      stream: false,
      format: JUDGE_SCHEMA,
      options: {
        temperature: 0, // bewusst fest, unabhaengig von config.ollama.temperature
        num_ctx: 1024,
        num_predict: 200
      }
    });

    const raw = response.data.response;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    return { verdict: parsed.verdict, reason: parsed.reason };
  }
}

module.exports = new EntityJudge();
```

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add services/entityJudge.js test/entityJudge.test.js
git commit -m "$(cat <<'EOF'
feat: EntityJudge - kleiner separater Ollama-Call mit Structured Output

Eigener minimaler Call statt Wiederverwendung von
ollamaService._callOllamaAPI: der Judge braucht immer temperature 0,
unabhaengig von der fuer die Dokumentenanalyse konfigurierbaren
Sampling-Temperatur. Nutzt dasselbe bereits geladene Modell.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `config/config.js` — `entityResolver`-Block

Folgt exakt dem `parseEnvNumber`-Muster aus Phase 1. Default `enabled: false` — sicherer Rollout, siehe Global Constraints.

**Files:**
- Modify: `config/config.js`
- Test: `test/configEntityResolver.test.js` (create)

**Interfaces:**
- Consumes: `parseEnvNumber` (Phase 1)
- Produces: `config.entityResolver.{enabled, autoThreshold, judgeMin, dbPath}`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');

test('entityResolver-Block hat sichere Defaults', () => {
  assert.strictEqual(typeof config.entityResolver.enabled, 'boolean');
  assert.strictEqual(config.entityResolver.enabled, false);
  assert.strictEqual(config.entityResolver.autoThreshold, 0.90);
  assert.strictEqual(config.entityResolver.judgeMin, 0.65);
  assert.ok(config.entityResolver.dbPath.endsWith('entities.db'));
});
```

- [ ] **Step 2:** Run `node --test test/configEntityResolver.test.js` → FAIL.

- [ ] **Step 3: Ergänzen** — in `config/config.js` nach dem `ollama`-Block (Zeilen 98-107) einfügen:

```js
  entityResolver: {
    enabled: parseEnvBoolean(process.env.ENTITY_RESOLVER_ENABLED, 'no') === 'yes',
    autoThreshold: parseEnvNumber(process.env.ENTITY_RESOLVER_AUTO_THRESHOLD, 0.90),
    judgeMin: parseEnvNumber(process.env.ENTITY_RESOLVER_JUDGE_MIN, 0.65),
    dbPath: process.env.ENTITY_RESOLVER_DB_PATH || path.join(process.cwd(), 'data', 'entities.db')
  },
```

(`path` ist in `config/config.js` bereits importiert.)

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add config/config.js test/configEntityResolver.test.js
git commit -m "$(cat <<'EOF'
feat: entityResolver-Konfigurationsblock

ENTITY_RESOLVER_ENABLED (Default no), ENTITY_RESOLVER_AUTO_THRESHOLD
(0.90), ENTITY_RESOLVER_JUDGE_MIN (0.65), ENTITY_RESOLVER_DB_PATH -
folgt dem parseEnvNumber-Muster aus Phase 1. Default deaktiviert:
Rollout ist eine bewusste Entscheidung nach dem Schwellwert-Tuning.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `paperlessService.js` — Korrespondenten-/Dokumentart-Caches

Voraussetzung für Task 10: die Ähnlichkeitsstufe braucht den **vollständigen** Bestand pro Typ, nicht nur `icontains`-Treffer. Analog zu `tagCache`/`ensureTagCache`/`refreshTagCache`, gespeist aus den bereits vorhandenen `listCorrespondentsNames()` (Zeile 505) und `listDocumentTypesNames()` (Zeile 550).

**Files:**
- Modify: `services/paperlessService.js` — Konstruktor (Zeilen 9-15), neue Methoden
- Test: `test/entityResolverHookIn.test.js` (create, Grundgerüst)

**Interfaces:**
- Consumes: `listCorrespondentsNames()`, `listDocumentTypesNames()` (bestehend)
- Produces: `this.correspondentCache: Map`, `this.documentTypeCache: Map`, `ensureCorrespondentCache()`, `ensureDocumentTypeCache()`

- [ ] **Step 1: Fehlschlagenden Test schreiben**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

test('correspondentCache und documentTypeCache existieren und sind leer vor erstem Refresh', () => {
  assert.ok(paperlessService.correspondentCache instanceof Map);
  assert.ok(paperlessService.documentTypeCache instanceof Map);
});

test('ensureCorrespondentCache befuellt den Cache aus listCorrespondentsNames', async () => {
  paperlessService.listCorrespondentsNames = async () => ([{ id: 1, name: 'Stadtwerke Musterstadt', document_count: 3 }]);
  paperlessService.correspondentCache.clear();
  paperlessService.lastCorrespondentRefresh = 0;

  await paperlessService.ensureCorrespondentCache();

  assert.strictEqual(paperlessService.correspondentCache.get('stadtwerke musterstadt').id, 1);
});

test('ensureDocumentTypeCache befuellt den Cache aus listDocumentTypesNames', async () => {
  paperlessService.listDocumentTypesNames = async () => ([{ id: 2, name: 'Rechnung' }]);
  paperlessService.documentTypeCache.clear();
  paperlessService.lastDocumentTypeRefresh = 0;

  await paperlessService.ensureDocumentTypeCache();

  assert.strictEqual(paperlessService.documentTypeCache.get('rechnung').id, 2);
});
```

- [ ] **Step 2:** Run `node --test test/entityResolverHookIn.test.js` → FAIL.

- [ ] **Step 3: Konstruktor erweitern** — in `services/paperlessService.js`, ersetze den bestehenden Konstruktor (Zeilen 9-15):

```js
  constructor() {
    this.client = null;
    this.tagCache = new Map();
    this.correspondentCache = new Map();
    this.documentTypeCache = new Map();
    this.customFieldCache = new Map();
    this.lastTagRefresh = 0;
    this.lastCorrespondentRefresh = 0;
    this.lastDocumentTypeRefresh = 0;
    this.CACHE_LIFETIME = 3000; // 3 Sekunden
    this._entityResolverInstance = null;
  }
```

Und ergänze zwei neue Methoden (z. B. direkt nach `refreshTagCache`):

```js
  async ensureCorrespondentCache() {
    const now = Date.now();
    if (this.correspondentCache.size === 0 || (now - this.lastCorrespondentRefresh) > this.CACHE_LIFETIME) {
      await this.refreshCorrespondentCache();
    }
  }

  async refreshCorrespondentCache() {
    try {
      const all = await this.listCorrespondentsNames();
      this.correspondentCache.clear();
      all.forEach(c => this.correspondentCache.set(c.name.toLowerCase(), c));
      this.lastCorrespondentRefresh = Date.now();
      console.log(`[DEBUG] Correspondent cache refreshed. Found ${this.correspondentCache.size} correspondents.`);
    } catch (error) {
      console.error('[ERROR] refreshing correspondent cache:', error.message);
    }
  }

  async ensureDocumentTypeCache() {
    const now = Date.now();
    if (this.documentTypeCache.size === 0 || (now - this.lastDocumentTypeRefresh) > this.CACHE_LIFETIME) {
      await this.refreshDocumentTypeCache();
    }
  }

  async refreshDocumentTypeCache() {
    try {
      const all = await this.listDocumentTypesNames();
      this.documentTypeCache.clear();
      all.forEach(dt => this.documentTypeCache.set(dt.name.toLowerCase(), dt));
      this.lastDocumentTypeRefresh = Date.now();
      console.log(`[DEBUG] Document type cache refreshed. Found ${this.documentTypeCache.size} document types.`);
    } catch (error) {
      console.error('[ERROR] refreshing document type cache:', error.message);
    }
  }
```

(Bewusst kein `throw` wie bei `refreshTagCache` — Fehlerverhalten-Tabelle: Cache-Fehler dürfen den Anlegen-Pfad nicht blockieren; ein leerer Cache führt in Task 10 dazu, dass der Resolver ohne Kandidaten dasteht und `create` liefert, was dem heutigen Verhalten entspricht.)

- [ ] **Step 4:** Run `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add services/paperlessService.js test/entityResolverHookIn.test.js
git commit -m "$(cat <<'EOF'
feat: Korrespondenten- und Dokumentart-Cache in paperlessService

Analog zu tagCache/ensureTagCache/refreshTagCache. Voraussetzung fuer
den EntityResolver-Einhaengepunkt: die Aehnlichkeitsstufe braucht den
vollstaendigen Bestand pro Typ, nicht nur icontains-Treffer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `paperlessService.js` — Einhängen in `processTags`, `getOrCreateCorrespondent`, `getOrCreateDocumentType`

Der eigentliche Einhängepunkt. `_resolveEntity` ist die zentrale Fehlerbarriere: deaktivierter Resolver oder jeder interne Fehler liefert `{ action: 'create' }`, was in allen drei Methoden exakt den bisherigen Code-Pfad reproduziert (heutiges Anlegen-Verhalten).

**Files:**
- Modify: `services/paperlessService.js` — `processTags` (Zeilen 312-413), `getOrCreateCorrespondent` (Zeilen 1025-1083), `getOrCreateDocumentType` (Zeilen 1120-1167), neue private Methoden
- Test: `test/entityResolverHookIn.test.js` (erweitern)

**Interfaces:**
- Consumes: `EntityResolver`, `EntityStore`, `entityJudge` (Tasks 4-8), `config.entityResolver`
- Produces: `_resolveEntity(type, name, existingEntities) → decision`, `_recordEntityQueue(type, proposedName, proposedId, decision)`, `_getEntityResolver()`

- [ ] **Step 1: Fehlschlagenden Test schreiben** (an `test/entityResolverHookIn.test.js` anhängen)

```js
const config = require('../config/config');

test('deaktivierter Resolver: _resolveEntity liefert immer create, ohne Store/Judge anzufassen', async () => {
  config.entityResolver.enabled = false;
  const decision = await paperlessService._resolveEntity('tag', 'Irgendwas', [{ id: 1, name: 'Anderes' }]);
  assert.deepStrictEqual(decision, { action: 'create' });
});

test('fehlerhafter Resolver faellt auf create zurueck statt zu werfen', async () => {
  config.entityResolver.enabled = true;
  paperlessService._entityResolverInstance = {
    resolve: async () => { throw new Error('DB kaputt'); }
  };

  const decision = await paperlessService._resolveEntity('tag', 'Irgendwas', []);
  assert.deepStrictEqual(decision, { action: 'create' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('aktivierter Resolver mit funktionierender Instanz liefert deren Entscheidung durch', async () => {
  config.entityResolver.enabled = true;
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'map', id: 42, canonicalName: 'Kanonisch', via: 'exact' })
  };

  const decision = await paperlessService._resolveEntity('correspondent', 'Kanonisch', [{ id: 42, name: 'Kanonisch' }]);
  assert.deepStrictEqual(decision, { action: 'map', id: 42, canonicalName: 'Kanonisch', via: 'exact' });

  config.entityResolver.enabled = false;
  paperlessService._entityResolverInstance = null;
});

test('processTags: bei deaktiviertem Resolver unveraendertes Verhalten', async () => {
  config.entityResolver.enabled = false;
  paperlessService.findExistingTag = async () => null;
  paperlessService.createTagSafely = async (name) => ({ id: 99, name });
  paperlessService.ensureTagCache = async () => {};

  const result = await paperlessService.processTags(['Neuer Tag']);
  assert.deepStrictEqual(result.tagIds, [99]);
});
```

- [ ] **Step 2:** Run `node --test test/entityResolverHookIn.test.js` → FAIL.

- [ ] **Step 3: Private Helfer ergänzen** — in `services/paperlessService.js` nach `refreshDocumentTypeCache`:

```js
  _getEntityResolver() {
    if (!this._entityResolverInstance) {
      const EntityStore = require('../models/entityStore');
      const EntityResolver = require('./entityResolver');
      const entityJudge = require('./entityJudge');

      const store = new EntityStore(config.entityResolver.dbPath);
      this._entityResolverInstance = new EntityResolver({
        store,
        judge: (type, a, b) => entityJudge.judge(type, a, b),
        config: {
          autoThreshold: config.entityResolver.autoThreshold,
          judgeMin: config.entityResolver.judgeMin
        }
      });
    }
    return this._entityResolverInstance;
  }

  // Zentrale Fehlerbarriere: deaktiviert oder jeder interne Fehler => heutiges Verhalten (create).
  async _resolveEntity(type, name, existingEntities) {
    if (!config.entityResolver.enabled) {
      return { action: 'create' };
    }
    try {
      const resolver = this._getEntityResolver();
      return await resolver.resolve(type, name, existingEntities);
    } catch (error) {
      console.warn(`[WARNING] entityResolver fehlgeschlagen fuer "${name}" (${type}), falle zurueck auf bisheriges Verhalten:`, error.message);
      return { action: 'create' };
    }
  }

  _recordEntityQueue(type, proposedName, proposedId, decision) {
    try {
      this._getEntityResolver().recordCreatedAndQueued({
        type, proposedName, proposedId,
        candidate: decision.candidate, similarity: decision.similarity, verdict: decision.verdict
      });
    } catch (error) {
      console.warn(`[WARNING] Konnte Review-Queue-Eintrag fuer "${proposedName}" nicht schreiben:`, error.message);
    }
  }
```

- [ ] **Step 4: `processTags` einhängen** — ersetze in `processTags` den Block ab `let tag = await this.findExistingTag(tagName);` bis vor `if (tag && tag.id) {`:

```js
          let tag = await this.findExistingTag(tagName);

          if (!tag) {
            const decision = await this._resolveEntity('tag', tagName, Array.from(this.tagCache.values()));

            if (decision.action === 'map') {
              tag = { id: decision.id, name: decision.canonicalName };
            } else if (decision.action === 'skip') {
              errors.push({ tagName, error: 'Vorschlag ist leer' });
              continue;
            } else if (restrictToExistingTags) {
              console.log(`[DEBUG] Tag "${tagName}" does not exist and restrictions are enabled, skipping`);
              errors.push({ tagName, error: 'Tag does not exist and restrictions are enabled' });
              continue;
            } else {
              tag = await this.createTagSafely(tagName);
              if (decision.action === 'create_and_queue' && tag && tag.id) {
                this._recordEntityQueue('tag', tagName, tag.id, decision);
              }
            }
          }
```

- [ ] **Step 5: `getOrCreateCorrespondent` einhängen** — ersetze den Block ab `if (restrictToExistingCorrespondents) {` bis vor `// Create new correspondent only if restrictions are not enabled`:

```js
        await this.ensureCorrespondentCache();
        const decision = await this._resolveEntity('correspondent', name, Array.from(this.correspondentCache.values()));

        if (decision.action === 'skip') {
            return null;
        }

        if (decision.action === 'map') {
            return { id: decision.id, name: decision.canonicalName };
        }

        // If we're restricting to existing correspondents and none was found, return null
        if (restrictToExistingCorrespondents) {
            console.log(`[DEBUG] Correspondent "${name}" does not exist and restrictions are enabled, returning null`);
            return null;
        }

        // Create new correspondent only if restrictions are not enabled
```

Und nach dem erfolgreichen `createResponse`/`justCreatedCorrespondent`-Rückgaben:

```js
            if (decision.action === 'create_and_queue') {
                this._recordEntityQueue('correspondent', name, createResponse.data.id, decision);
            }
            return createResponse.data;
```

(analog beim Race-Condition-Retry-Zweig).

- [ ] **Step 6: `getOrCreateDocumentType` analog einhängen** — gleiches Muster mit `this.ensureDocumentTypeCache()` und `Array.from(this.documentTypeCache.values())`.

- [ ] **Step 7:** Run `npm test` → PASS. Bestehende Tests aus Task 9 müssen weiterhin bestehen (deaktivierter Resolver → unverändertes Verhalten).

- [ ] **Step 8: Kein Serverstart zum Prüfen.** Wie in Phase 1: `PROCESS_PREDEFINED_DOCUMENTS=yes` verarbeitet bei Start sofort und schreibt nach Paperless. Prüfung ausschließlich über `npm test` und, sobald verfügbar, `scripts/dry-run-eval.js` mit `ENTITY_RESOLVER_ENABLED=yes` gegen eine Testinstanz — nicht Teil dieses Tasks.

- [ ] **Step 9: Commit**

```bash
git add services/paperlessService.js test/entityResolverHookIn.test.js
git commit -m "$(cat <<'EOF'
feat: EntityResolver in processTags/getOrCreateCorrespondent/getOrCreateDocumentType einhaengen

_resolveEntity ist die zentrale Fehlerbarriere: deaktivierter
Resolver oder jeder interne Fehler liefert {action:'create'} und
reproduziert damit exakt den bisherigen Anlegen-Pfad in allen drei
Methoden. buildUpdateData (doppelt in server.js und routes/setup.js)
bleibt bewusst unangetastet - beide Pfade profitieren automatisch
ueber paperlessService.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `scripts/tune-thresholds.js` + Labels-Datei

Kein `AUTO_THRESHOLD`/`JUDGE_MIN` ist vor der Messung vertrauenswürdig. Das Skript liest `data/eval/entities.json` (Bestand, bereits vorhanden) und eine neue, hand-kuratierte `data/eval/entity-labels.json`.

**Labels-Datei-Design** (`data/eval/entity-labels.json`, gitignored, manuell gepflegt): flache Liste von **Clustern** statt einzelner Paare, damit man nicht jedes Paar von Hand ausschreiben muss — alle Namen in einem Cluster gelten paarweise als `same`, alle Namen aus verschiedenen Clustern desselben Typs gelten paarweise als `different`:

```json
{
  "document_type": [
    ["Entgeltabrechnung", "Payroll Statement", "Verdienstbescheinigung"],
    ["Meldebescheid", "Meldebescheinigung", "Meldebeschreibung"],
    ["Rechnung"],
    ["Vertrag"]
  ],
  "correspondent": [],
  "tag": []
}
```

Jeder Eintrag außerhalb des Namens selbst kommt aus `data/eval/entities.json`. Einzelne echte Namen genügen als eigener Ein-Element-Cluster, damit sie als „different" zu allen anderen Clustern beitragen. Das deckt exakt die beiden aus dem Umgebungscheck bekannten Fälle ab, ohne dass Nutzer:innen exhaustiv jedes Negativpaar hand-etikettieren müssen.

**Files:**
- Create: `scripts/tune-thresholds.js`
- Create (manuell, außerhalb TDD): `data/eval/entity-labels.json`

**Interfaces:**
- Consumes: `entitySimilarity.diceCoefficient`, `entityNormalizer.normalizeForType`, `data/eval/entities.json`, `data/eval/entity-labels.json`
- Produces: Konsolen-Report (Precision/Recall über Schwellwertbereich), optional `data/eval/threshold-tuning-<timestamp>.json`

- [ ] **Step 1: Skript implementieren** (kein TDD — Analyse-Skript, kein Teil der Kaskade, analog zu `scripts/export-entity-fixture.js`/`scripts/dry-run-eval.js` aus Phase 0):

```js
#!/usr/bin/env node
// scripts/tune-thresholds.js
const fs = require('fs');
const path = require('path');
const { normalizeForType } = require('../services/entityNormalizer');
const { diceCoefficient } = require('../services/entitySimilarity');

function loadJson(relativePath, fallback) {
  const full = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(full)) return fallback;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function buildLabeledPairs(clustersByType) {
  const pairs = []; // { type, a, b, label: 'same'|'different' }

  for (const [type, clusters] of Object.entries(clustersByType)) {
    for (let i = 0; i < clusters.length; i++) {
      for (let j = 0; j < clusters[i].length; j++) {
        for (let k = j + 1; k < clusters[i].length; k++) {
          pairs.push({ type, a: clusters[i][j], b: clusters[i][k], label: 'same' });
        }
      }
    }
    for (let i = 0; i < clusters.length; i++) {
      for (let ci = i + 1; ci < clusters.length; ci++) {
        for (const a of clusters[i]) {
          for (const b of clusters[ci]) {
            pairs.push({ type, a, b, label: 'different' });
          }
        }
      }
    }
  }

  return pairs;
}

function evaluateThreshold(pairs, threshold) {
  let tp = 0, fp = 0, fn = 0, tn = 0;

  for (const { type, a, b, label } of pairs) {
    const sim = diceCoefficient(normalizeForType(a, type), normalizeForType(b, type));
    const predictedSame = sim >= threshold;
    const actualSame = label === 'same';

    if (predictedSame && actualSame) tp++;
    else if (predictedSame && !actualSame) fp++;
    else if (!predictedSame && actualSame) fn++;
    else tn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return { threshold, tp, fp, fn, tn, precision, recall };
}

function main() {
  const labels = loadJson('data/eval/entity-labels.json', null);
  if (!labels) {
    console.error('[ERROR] data/eval/entity-labels.json fehlt. Siehe Plan-Dokument Task 11 fuer das Format.');
    process.exit(1);
  }

  const pairs = buildLabeledPairs(labels);
  console.log(`Gelabelte Paare: ${pairs.length} (${pairs.filter(p => p.label === 'same').length} same, ${pairs.filter(p => p.label === 'different').length} different)`);

  const results = [];
  for (let t = 0.05; t <= 0.95; t += 0.05) {
    results.push(evaluateThreshold(pairs, Math.round(t * 100) / 100));
  }

  console.log('\nThreshold | Precision | Recall | TP | FP | FN | TN');
  for (const r of results) {
    console.log(
      `${r.threshold.toFixed(2)}      | `
      + `${r.precision === null ? '  n/a  ' : r.precision.toFixed(2).padStart(7)} | `
      + `${r.recall === null ? '  n/a ' : r.recall.toFixed(2).padStart(6)} | `
      + `${String(r.tp).padStart(2)} | ${String(r.fp).padStart(2)} | ${String(r.fn).padStart(2)} | ${String(r.tn).padStart(2)}`
    );
  }

  const outPath = path.join('data', 'eval', `threshold-tuning-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pairs, results }, null, 2));
  console.log(`\nDetails geschrieben nach ${outPath} (nicht in git).`);

  const worstRecallSamePairs = pairs
    .filter(p => p.label === 'same')
    .map(p => ({ ...p, sim: diceCoefficient(normalizeForType(p.a, p.type), normalizeForType(p.b, p.type)) }))
    .sort((x, y) => x.sim - y.sim)
    .slice(0, 5);

  console.log('\nSchwierigste "same"-Paare (niedrigste Trigram-Aehnlichkeit - Kandidaten fuer die Embeddings-Entscheidung):');
  worstRecallSamePairs.forEach(p => console.log(`  ${p.a} / ${p.b} (${p.type}): ${p.sim.toFixed(3)}`));
}

main();
```

- [ ] **Step 2: Labels-Datei anlegen** (manueller Schritt, keine TDD): `data/eval/entity-labels.json` mit mindestens den beiden bekannten Clustern aus dem Umgebungscheck (`Entgeltabrechnung`/`Payroll Statement`/`Verdienstbescheinigung`, `Meldebescheid`/`Meldebescheinigung`/`Meldebeschreibung`) plus einer Handvoll unstrittiger Ein-Element-Cluster aus `data/eval/entities.json` als Negativbeispiele. Dieser Schritt ist **manuell** und **nicht Teil des Commits** dieses Tasks (Datei bleibt unter `data/`, gitignored).

- [ ] **Step 3: Skript ausführen**

```bash
node scripts/tune-thresholds.js
```

Erwartung: Report läuft durch. Prüfen, ob es einen Schwellwertbereich gibt, in dem `Entgeltabrechnung`/`Verdienstbescheinigung` unterhalb von `AUTO_THRESHOLD`, aber oberhalb eines sinnvollen `JUDGE_MIN` liegt. Liegt die Ähnlichkeit für dieses Paar nahe 0, ist das der im Design erwartete Befund — dokumentieren, nicht als Bug behandeln.

- [ ] **Step 4: `AUTO_THRESHOLD`/`JUDGE_MIN` auf gemessene Werte setzen** — in `data/.env`:

```
ENTITY_RESOLVER_AUTO_THRESHOLD=<gemessener Wert>
ENTITY_RESOLVER_JUDGE_MIN=<gemessener Wert>
```

- [ ] **Step 5: Commit** (nur das Skript, nicht die Labels- oder Tuning-Ergebnisdatei)

```bash
git add scripts/tune-thresholds.js
git commit -m "$(cat <<'EOF'
feat: Schwellwert-Tuning-Skript

Liest data/eval/entities.json und die manuell gepflegte
data/eval/entity-labels.json (Cluster-Format: alle Namen in einem
Cluster gelten paarweise als "same", ueber Cluster hinweg als
"different"), sweept AUTO_THRESHOLD/JUDGE_MIN und berichtet Precision
und Recall. Zeigt zugleich die schwierigsten "same"-Paare - das ist
die Grundlage fuer die Embeddings-Entscheidung aus der Roadmap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Abschluss von Phase 2

- [ ] **Vollständiger Testlauf:** `npm test` → PASS, 0 Fehlschläge.
- [ ] **Schwellwert-Messung liegt vor** und `AUTO_THRESHOLD`/`JUDGE_MIN` sind in `data/.env` auf gemessene statt geschätzte Werte gesetzt (Abnahmekriterium der Roadmap).
- [ ] **Embeddings-Entscheidung dokumentiert:** anhand des Tuning-Reports festhalten, ob reine Trigram-Ähnlichkeit für `Entgeltabrechnung`/`Verdienstbescheinigung`-artige Paare ausreicht oder ob Ansatz B (Embeddings) für Phase 3+ vorgemerkt wird.
- [ ] **Resolver bewusst (de)aktiviert:** `ENTITY_RESOLVER_ENABLED` auf den gewünschten Zustand setzen; Default bleibt `no`, bis eine bewusste Entscheidung dafür getroffen ist.
- [ ] **Roadmap-Status fortschreiben:** Phase 2 in `docs/planning/klassifikations-konsistenz-roadmap.md` auf `erledigt` setzen.
- [ ] **Commit und Merge-Entscheidung:**

```bash
git add docs/planning/klassifikations-konsistenz-roadmap.md
git commit -m "$(cat <<'EOF'
docs: Phase 2 als erledigt markieren

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

Danach `superpowers:finishing-a-development-branch` für die Integration.
