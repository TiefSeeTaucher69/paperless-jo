# Phase 4: Embeddings-Ähnlichkeitskanal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein zweiter, semantischer Ähnlichkeitskanal über Text-Embeddings (`bge-m3` via Ollama) ergänzt die bestehende Trigram-Ähnlichkeit im EntityResolver, damit orthografisch ferne, aber bedeutungsgleiche Namen (`Entgeltabrechnung`/`Verdienstbescheinigung`, sprachübergreifend `Entgeltabrechnung`/`Payroll Statement`) erkannt werden, statt am Judge vorbeizulaufen.

**Architecture:** Kandidatenauswahl über `combinedScore = max(trigramSim, embeddingSim)` pro Bestandsentität; die Entscheidung (Auto-Merge/Judge/Create) prüft danach den rohen Wert jedes Kanals gegen dessen eigenen, separat konfigurierbaren Schwellwert (`EMBED_AUTO_THRESHOLD`/`EMBED_JUDGE_MIN`), weil Cosine-Ähnlichkeit und Dice-Koeffizient nicht auf derselben Skala liegen. Ein neuer `entity_embeddings`-Cache (SQLite) vermeidet wiederholte Ollama-Calls für den kleinen, weitgehend statischen Bestand. Alles additiv und per Default deaktiviert (`EMBEDDING_SIMILARITY_ENABLED=no`) — bei `no` verhält sich die Anwendung exakt wie nach Phase 3.

**Baseline:** Phase 1–3 sind erledigt und gemerged. `services/entityResolver.js`, `models/entityStore.js`, `services/entityBackfillService.js`, `routes/review.js`, `views/review.ejs` existieren bereits in der Form, die Phase 2/3 hergestellt haben (siehe Global Constraints für den genauen Stand). `data/eval/entity-labels.json` (Phase 2, Task 11) enthält bereits gelabelte Same/Different-Paare, u.a. das orthografisch ferne Synonym-Paar, an dem `scripts/tune-thresholds.js` schon einen Hinweiskommentar für genau diese Phase trägt.

**Tech Stack:** Node.js (CommonJS), `better-sqlite3` (bereits Dependency), `axios` (bereits Dependency, Muster wie `services/entityJudge.js`), `node:test` (keine neue Dependency). **Keine neue Runtime-Dependency** — Embeddings kommen über Ollamas `/api/embed`, kein Vektor-DB-Package.

**Spec:** [../specs/2026-08-02-phase4-embeddings-design.md](../specs/2026-08-02-phase4-embeddings-design.md); Kurzfassung in [../../planning/klassifikations-konsistenz-roadmap.md](../../planning/klassifikations-konsistenz-roadmap.md), Abschnitt „Phase 4".

## Global Constraints

- Node.js (`node:test`, `node --test test/*.test.js` via `npm test`).
- **Keine neuen Runtime-Dependencies.** `axios` und `better-sqlite3` reichen.
- CommonJS, kein ESM. Log-Präfixe wie im Bestand: `[DEBUG]`, `[ERROR]`, `[WARNING]`.
- Tests, die eine DB brauchen, verwenden `:memory:` (Ausnahme: der explizite Migrationstest in Task 3, der eine echte Datei braucht, um eine Alt-Datenbank zu simulieren — Datei wird in `finally` gelöscht). Tests, die Ollama brauchen, verwenden einen injizierten Fake oder ein monkeypatchbares `.client` (Muster: `services/entityJudge.js` / `test/entityJudge.test.js`), nie echtes Netzwerk.
- Der Embedding-Kanal ist per Default **deaktiviert** (`EMBEDDING_SIMILARITY_ENABLED` Code-Default `no`) — diese Phase liefert die Maschinerie, Aktivierung ist eine bewusste Folgeentscheidung nach dem Tuning-Task (Task 10), analog zu `ENTITY_RESOLVER_ENABLED` in Phase 2.
- Bei deaktiviertem oder fehlerhaftem Embedding-Kanal muss `entityResolver.resolve()` exakt das heutige (Phase-2/3-)Verhalten reproduzieren — kein Absturz, kein einziger Embedding-Call.
- Betriebsvoraussetzung (kein Code, aber Bedingung für den scharfgeschalteten Zustand): `ollama pull bge-m3` auf der Ollama-VM, bevor `EMBEDDING_SIMILARITY_ENABLED=yes` gesetzt wird.
- Auf dem bestehenden Arbeits-Branch fortsetzen (kein neuer Branch nötig, außer der Nutzer wünscht ausdrücklich Isolation).

## Aktueller Stand relevanter Dateien (Referenz für alle Tasks)

- `services/entityResolver.js`: Kaskade mit Stufen 0–4d, Konstruktor `new EntityResolver({ store, judge, config })`, Stufe 4 wählt aktuell den besten Kandidaten ausschließlich über `diceCoefficient`.
- `models/entityStore.js`: Klasse mit `entity_aliases` und `entity_review_queue` (inkl. `proposed_normalized`/`candidate_normalized` aus Phase 2, Task 11). `insertQueueEntry` verlangt `similarity` (NOT NULL in der Tabelle).
- `services/paperlessService.js`: `_getEntityResolver()` (Zeile ~158) baut den Singleton-Resolver inkl. `entityJudge`; `_recordEntityQueue()` (Zeile ~200) reicht `decision.candidate/similarity/verdict` an `recordCreatedAndQueued` durch; `processTags`/`getOrCreateCorrespondent`/`getOrCreateDocumentType` rufen `_resolveEntity(type, name, existingEntities)` auf — **diese drei Aufrufer ändern sich in Phase 4 nicht**, weil die gesamte Embedding-Logik innerhalb von `resolver.resolve()` verkapselt ist.
- `services/entityBackfillService.js`: aktuell synchrones `run(entityType, existingEntities)`, quadratischer Vergleich über `diceCoefficient`, Duplikat-Schutz über `store.findQueueEntryPair` (nicht `findRejectedPair` — prüft jeden Status, nicht nur `rejected`).
- `routes/review.js`: `getServices()` baut `store`/`reviewQueueService`/`backfillService` lazy beim ersten Request.
- `views/review.ejs`: Tabelle mit einer `Similarity`-Spalte (`entry.similarity.toFixed(2)`).
- `config/config.js`: `entityResolver`-Block mit geklemmten Schwellwerten (`clampThreshold`-Helper, wiederverwendbar).

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `config/config.js` | `embedding`-Block, Env-Vars, Schwellwert-Klemmung | Modify |
| `services/entityEmbeddingService.js` | Ollama-`/api/embed`-Call, Cosine-Ähnlichkeit, Cache-aware Lookup | Create |
| `models/entityStore.js` | `entity_embeddings`-Tabelle + CRUD, `entity_review_queue` um `trigram_similarity`/`embedding_similarity` erweitert | Modify |
| `services/entityResolver.js` | Kombinierte Kandidatenauswahl, Embedding-Schwellwerte, `auto_embedding`-Alias-Quelle | Modify |
| `services/paperlessService.js` | Embedding-Service in `_getEntityResolver()` verdrahten, `_recordEntityQueue` erweitert | Modify |
| `services/entityBackfillService.js` | Async `run()`, Embedding-Prefetch, kombinierter Score | Modify |
| `routes/review.js` | `await` für async `run()`, Embedding-Service injizieren | Modify |
| `views/review.ejs` | Trigram-/Embedding-Spalten statt einer `Similarity`-Spalte | Modify |
| `scripts/tune-thresholds.js` | Embedding-Messlauf über dieselbe gelabelte Fixture | Modify |
| `test/configEmbedding.test.js` | Env-Parsing des neuen Blocks | Create |
| `test/entityEmbeddingService.test.js` | `embed`, `cosineSimilarity`, `getOrComputeEmbedding` | Create |
| `test/entityStore.test.js` | `entity_embeddings`-CRUD, Queue-Spalten, Migration | Modify (erweitert) |
| `test/entityResolver.test.js` | Embedding-Pfade der Kaskade | Modify (erweitert) |
| `test/entityResolverHookIn.test.js` | Verdrahtung in `paperlessService` | Modify (erweitert) |
| `test/entityBackfillService.test.js` | Async-Umstellung + Embedding-Score | Modify (alle Tests async) |

`package.json` bleibt unverändert (`"test": "node --test test/*.test.js"` deckt neue Dateien automatisch ab).

---

### Task 1: `config/config.js` — `embedding`-Block

Muss vor jeder anderen Task stehen, weil `entityEmbeddingService.js` (Task 2) sofort `config.embedding.apiUrl`/`.model` braucht.

**Files:**
- Modify: `config/config.js:65-97` (Threshold-Block), `config/config.js:134-139` (`entityResolver`-Export)
- Test: `test/configEmbedding.test.js` (create)

**Interfaces:**
- Consumes: bestehende Helper `parseEnvBoolean`, `parseEnvNumber`, `clampThreshold` (alle bereits generisch, keine Änderung nötig)
- Produces: `config.embedding = { enabled: boolean, apiUrl: string, model: string, autoThreshold: number, judgeMin: number }` — konsumiert von Task 2 (`entityEmbeddingService.js`), Task 5 (`entityResolver.js` via `paperlessService`), Task 7 (`entityBackfillService.js` via `routes/review.js`)

- [ ] **Step 1: Write the failing tests**

Create `test/configEmbedding.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('embedding-Block hat sichere Defaults', () => {
  const savedEnv = {
    enabled: process.env.EMBEDDING_SIMILARITY_ENABLED,
    model: process.env.EMBEDDING_MODEL,
    autoThreshold: process.env.EMBED_AUTO_THRESHOLD,
    judgeMin: process.env.EMBED_JUDGE_MIN
  };

  try {
    process.env.EMBEDDING_SIMILARITY_ENABLED = '';
    process.env.EMBEDDING_MODEL = '';
    process.env.EMBED_AUTO_THRESHOLD = '';
    process.env.EMBED_JUDGE_MIN = '';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.embedding.enabled, false);
    assert.strictEqual(config.embedding.model, 'bge-m3');
    assert.strictEqual(config.embedding.autoThreshold, 0.90);
    assert.strictEqual(config.embedding.judgeMin, 0.65);
    assert.ok(config.embedding.apiUrl);
  } finally {
    for (const [key, value] of Object.entries({
      EMBEDDING_SIMILARITY_ENABLED: savedEnv.enabled,
      EMBEDDING_MODEL: savedEnv.model,
      EMBED_AUTO_THRESHOLD: savedEnv.autoThreshold,
      EMBED_JUDGE_MIN: savedEnv.judgeMin
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../config/config')];
  }
});

test('EMBEDDING_SIMILARITY_ENABLED=yes aktiviert den Kanal', () => {
  const saved = process.env.EMBEDDING_SIMILARITY_ENABLED;
  try {
    process.env.EMBEDDING_SIMILARITY_ENABLED = 'yes';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.embedding.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.EMBEDDING_SIMILARITY_ENABLED;
    else process.env.EMBEDDING_SIMILARITY_ENABLED = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('EMBED_AUTO_THRESHOLD ausserhalb [0,1] wird geklemmt und warnt', () => {
  const saved = process.env.EMBED_AUTO_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.EMBED_AUTO_THRESHOLD = '1.4';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.embedding.autoThreshold, 1);
    assert.ok(warnMessages.some(msg => msg.includes('EMBED_AUTO_THRESHOLD')));
  } finally {
    console.warn = savedWarn;
    if (saved === undefined) delete process.env.EMBED_AUTO_THRESHOLD;
    else process.env.EMBED_AUTO_THRESHOLD = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('EMBED_JUDGE_MIN > EMBED_AUTO_THRESHOLD warnt, wird nicht automatisch korrigiert', () => {
  const savedJudgeMin = process.env.EMBED_JUDGE_MIN;
  const savedAutoThreshold = process.env.EMBED_AUTO_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.EMBED_JUDGE_MIN = '0.95';
    process.env.EMBED_AUTO_THRESHOLD = '0.90';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.embedding.judgeMin, 0.95);
    assert.strictEqual(config.embedding.autoThreshold, 0.90);
    assert.ok(warnMessages.some(msg => msg.includes('unerreichbar')));
  } finally {
    console.warn = savedWarn;
    if (savedJudgeMin === undefined) delete process.env.EMBED_JUDGE_MIN;
    else process.env.EMBED_JUDGE_MIN = savedJudgeMin;
    if (savedAutoThreshold === undefined) delete process.env.EMBED_AUTO_THRESHOLD;
    else process.env.EMBED_AUTO_THRESHOLD = savedAutoThreshold;
    delete require.cache[require.resolve('../config/config')];
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/configEmbedding.test.js`
Expected: FAIL — `config.embedding` is `undefined`.

- [ ] **Step 3: Implement**

In `config/config.js`, directly after the existing block that ends with (currently `config/config.js:87-89`):

```js
if (entityResolverJudgeMin > entityResolverAutoThreshold) {
  console.warn(`[WARNING] ENTITY_RESOLVER_JUDGE_MIN (${entityResolverJudgeMin}) > ENTITY_RESOLVER_AUTO_THRESHOLD (${entityResolverAutoThreshold}): Stufe 4c (LLM-Judge) ist damit unerreichbar`);
}
```

insert:

```js

const embeddingAutoThreshold = clampThreshold(
  parseEnvNumber(process.env.EMBED_AUTO_THRESHOLD, 0.90),
  'EMBED_AUTO_THRESHOLD'
);
const embeddingJudgeMin = clampThreshold(
  parseEnvNumber(process.env.EMBED_JUDGE_MIN, 0.65),
  'EMBED_JUDGE_MIN'
);

if (embeddingJudgeMin > embeddingAutoThreshold) {
  console.warn(`[WARNING] EMBED_JUDGE_MIN (${embeddingJudgeMin}) > EMBED_AUTO_THRESHOLD (${embeddingAutoThreshold}): die Embedding-Judge-Stufe ist damit unerreichbar`);
}
```

Then, in `module.exports`, directly after the existing `entityResolver` block (currently `config/config.js:134-139`):

```js
  entityResolver: {
    enabled: parseEnvBoolean(process.env.ENTITY_RESOLVER_ENABLED, 'no') === 'yes',
    autoThreshold: entityResolverAutoThreshold,
    judgeMin: entityResolverJudgeMin,
    dbPath: process.env.ENTITY_RESOLVER_DB_PATH || path.join(process.cwd(), 'data', 'entities.db')
  },
```

insert:

```js
  embedding: {
    enabled: parseEnvBoolean(process.env.EMBEDDING_SIMILARITY_ENABLED, 'no') === 'yes',
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.EMBEDDING_MODEL || 'bge-m3',
    autoThreshold: embeddingAutoThreshold,
    judgeMin: embeddingJudgeMin
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/configEmbedding.test.js`
Expected: PASS, all 4 tests green.

Also run the full suite once to confirm nothing else in `config/config.js` broke:

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/config.js test/configEmbedding.test.js
git commit -m "$(cat <<'EOF'
feat: add embedding config block, default disabled

EMBEDDING_SIMILARITY_ENABLED defaults to no, same pattern as
ENTITY_RESOLVER_ENABLED in Phase 2 - the machinery ships, activation
is a conscious follow-up decision after threshold tuning (Task 10).
Reuses the existing OLLAMA_API_URL (same Ollama instance) and the
generic clampThreshold helper.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `services/entityEmbeddingService.js` — `embed()` und `cosineSimilarity()`

Kleiner, injizierbarer Client nach dem Muster von `services/entityJudge.js` (monkeypatchbares `.client`). Reine `cosineSimilarity` ohne Netzwerk.

**Files:**
- Create: `services/entityEmbeddingService.js`
- Test: `test/entityEmbeddingService.test.js` (create)

**Interfaces:**
- Consumes: `config.embedding.apiUrl`, `config.embedding.model` (Task 1)
- Produces: `entityEmbeddingService.embed(text: string) → Promise<number[]>`, `entityEmbeddingService.cosineSimilarity(a: number[], b: number[]) → number` — konsumiert von Task 4 (`getOrComputeEmbedding`), Task 5 (`entityResolver.js`), Task 7 (`entityBackfillService.js`)

- [ ] **Step 1: Write the failing tests**

Create `test/entityEmbeddingService.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const entityEmbeddingService = require('../services/entityEmbeddingService');

function captureRequest(responseData) {
  const captured = {};
  entityEmbeddingService.client = {
    post: async (url, body) => {
      captured.url = url;
      captured.body = body;
      return { data: responseData };
    }
  };
  return captured;
}

test('embed sendet model und input an /api/embed und liefert den ersten Vektor', async () => {
  const captured = captureRequest({ embeddings: [[0.1, 0.2, 0.3]] });
  const vector = await entityEmbeddingService.embed('Entgeltabrechnung');

  assert.ok(captured.url.endsWith('/api/embed'));
  assert.strictEqual(captured.body.input, 'Entgeltabrechnung');
  assert.ok(captured.body.model);
  assert.deepStrictEqual(vector, [0.1, 0.2, 0.3]);
});

test('embed wirft, wenn die Antwort keinen gueltigen Vektor enthaelt', async () => {
  captureRequest({ embeddings: [] });
  await assert.rejects(() => entityEmbeddingService.embed('X'), /keinen gueltigen Vektor/);
});

test('embed wirft bei Netzwerkfehler (Aufrufer faengt das ab)', async () => {
  entityEmbeddingService.client = { post: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => entityEmbeddingService.embed('X'), /ECONNREFUSED/);
});

test('cosineSimilarity: identische Vektoren ergeben 1', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [1, 0]), 1);
});

test('cosineSimilarity: orthogonale Vektoren ergeben 0', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: entgegengesetzte Vektoren ergeben -1', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [-1, 0]), -1);
});

test('cosineSimilarity: Nullvektor ergibt 0 statt NaN', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([0, 0], [1, 1]), 0);
});

test('cosineSimilarity: unterschiedliche Vektorlaenge ergibt 0', () => {
  assert.strictEqual(entityEmbeddingService.cosineSimilarity([1, 0], [1, 0, 0]), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/entityEmbeddingService.test.js`
Expected: FAIL — `Cannot find module '../services/entityEmbeddingService'`.

- [ ] **Step 3: Implement**

Create `services/entityEmbeddingService.js`:

```js
// services/entityEmbeddingService.js
const axios = require('axios');
const config = require('../config/config');

class EntityEmbeddingService {
  constructor() {
    this.client = axios.create({ timeout: 15000 });
  }

  async embed(text) {
    const response = await this.client.post(`${config.embedding.apiUrl}/api/embed`, {
      model: config.embedding.model,
      input: text
    });

    const vector = response.data?.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Ollama /api/embed lieferte keinen gueltigen Vektor');
    }
    return vector;
  }

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

module.exports = new EntityEmbeddingService();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/entityEmbeddingService.test.js`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/entityEmbeddingService.js test/entityEmbeddingService.test.js
git commit -m "$(cat <<'EOF'
feat: add entityEmbeddingService with Ollama /api/embed client

Injectable .client like entityJudge, testable without network.
cosineSimilarity is a pure function guarded against zero vectors
and mismatched lengths (returns 0 instead of NaN/throwing).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `models/entityStore.js` — `entity_embeddings`-Cache und Queue-Spalten

Zwei additive Schema-Änderungen: eine neue Tabelle für den Embedding-Cache, und zwei neue nullable Spalten auf `entity_review_queue`. Die bestehende `similarity`-Spalte bleibt unverändert (NOT NULL, wird weiterhin von jedem Aufrufer befüllt) — die neuen Spalten sind rein additiv, jeder bestehende `insertQueueEntry`-Aufruf in Tests und Code funktioniert unverändert weiter.

**Files:**
- Modify: `models/entityStore.js`
- Test: `test/entityStore.test.js` (erweitern)

**Interfaces:**
- Consumes: nichts Neues
- Produces: `getEmbedding(entityType, entityId) → { entity_name, model, vector: number[] } | null`, `upsertEmbedding({ entityType, id, name, model, vector }) → boolean`, `deleteEmbedding(entityType, entityId) → boolean`; `insertQueueEntry` akzeptiert zusätzlich optionale `trigramSimilarity`/`embeddingSimilarity` — konsumiert von Task 4, Task 5, Task 7

- [ ] **Step 1: Write the failing tests**

Append to `test/entityStore.test.js`:

```js
test('getEmbedding liefert null, wenn nichts gespeichert ist', () => {
  const store = freshStore();
  assert.strictEqual(store.getEmbedding('tag', 1), null);
});

test('upsertEmbedding und getEmbedding roundtrip mit Float32-Praezision', () => {
  const store = freshStore();
  const ok = store.upsertEmbedding({ entityType: 'document_type', id: 4, name: 'Meldebescheinigung', model: 'bge-m3', vector: [0.1, 0.2, 0.3] });
  assert.strictEqual(ok, true);

  const found = store.getEmbedding('document_type', 4);
  assert.strictEqual(found.entity_name, 'Meldebescheinigung');
  assert.strictEqual(found.model, 'bge-m3');
  assert.strictEqual(found.vector.length, 3);
  [0.1, 0.2, 0.3].forEach((v, i) => assert.ok(Math.abs(found.vector[i] - v) < 1e-6));
});

test('UNIQUE(entity_type, entity_id): erneutes Upsert ueberschreibt statt zu duplizieren', () => {
  const store = freshStore();
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'bge-m3', vector: [1, 0] });
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnungen', model: 'bge-m3', vector: [0, 1] });

  const found = store.getEmbedding('tag', 1);
  assert.strictEqual(found.entity_name, 'Rechnungen');
  assert.deepStrictEqual(found.vector, [0, 1]);
});

test('deleteEmbedding entfernt den Eintrag', () => {
  const store = freshStore();
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'bge-m3', vector: [1, 0] });
  store.deleteEmbedding('tag', 1);
  assert.strictEqual(store.getEmbedding('tag', 1), null);
});

test('Fehlerfall: geschlossene DB liefert Fallback statt zu werfen (Embeddings)', () => {
  const store = freshStore();
  store.close();
  assert.doesNotThrow(() => store.getEmbedding('tag', 1));
  assert.strictEqual(store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'X', model: 'bge-m3', vector: [1, 0] }), false);
  assert.doesNotThrow(() => store.deleteEmbedding('tag', 1));
});

test('entity_review_queue: trigram_similarity und embedding_similarity werden persistiert', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'document_type', proposedName: 'Entgeltabrechnung', proposedId: 9,
    candidateName: 'Verdienstbescheinigung', candidateId: 3,
    similarity: 0.85, trigramSimilarity: 0.10, embeddingSimilarity: 0.85,
    llmVerdict: 'same', llmReason: 'semantisch gleich', status: 'open'
  });

  const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE proposed_name = 'Entgeltabrechnung'`).get();
  assert.strictEqual(row.trigram_similarity, 0.10);
  assert.strictEqual(row.embedding_similarity, 0.85);
});

test('entity_review_queue: trigram_similarity/embedding_similarity bleiben null ohne Angabe (Rueckwaertskompatibilitaet)', () => {
  const store = freshStore();
  store.insertQueueEntry({
    entityType: 'tag', proposedName: 'A', proposedId: 1,
    candidateName: 'B', candidateId: 2, similarity: 0.7,
    llmVerdict: 'unsure', llmReason: null, status: 'open'
  });

  const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE proposed_name = 'A'`).get();
  assert.strictEqual(row.trigram_similarity, null);
  assert.strictEqual(row.embedding_similarity, null);
});

test('Migration: eine bestehende entity_review_queue ohne die neuen Spalten wird beim Oeffnen ergaenzt, Daten bleiben erhalten', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const Database = require('better-sqlite3');

  const dbPath = path.join(os.tmpdir(), `entity-store-migration-test-${process.pid}-${Math.floor(Math.random() * 1e6)}.db`);
  try {
    const raw = new Database(dbPath);
    raw.prepare(`
      CREATE TABLE entity_review_queue (
        id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, proposed_name TEXT NOT NULL,
        proposed_normalized TEXT NOT NULL, proposed_id INTEGER, candidate_name TEXT NOT NULL,
        candidate_normalized TEXT NOT NULL, candidate_id INTEGER NOT NULL, similarity REAL NOT NULL,
        llm_verdict TEXT, llm_reason TEXT, status TEXT NOT NULL, document_id INTEGER,
        created_at TEXT NOT NULL, resolved_at TEXT,
        UNIQUE(entity_type, proposed_normalized, candidate_normalized)
      )
    `).run();
    raw.prepare(`
      INSERT INTO entity_review_queue
        (entity_type, proposed_name, proposed_normalized, proposed_id, candidate_name, candidate_normalized, candidate_id, similarity, status, created_at)
      VALUES ('tag', 'Alt', 'alt', 1, 'Bestand', 'bestand', 2, 0.8, 'open', '2026-01-01T00:00:00.000Z')
    `).run();
    raw.close();

    const store = new EntityStore(dbPath);
    try {
      const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE proposed_name = 'Alt'`).get();
      assert.strictEqual(row.similarity, 0.8, 'bestehende Daten bleiben erhalten');
      assert.strictEqual(row.trigram_similarity, null);
      assert.strictEqual(row.embedding_similarity, null);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/entityStore.test.js`
Expected: FAIL — `store.getEmbedding is not a function` (and similarly for the others).

- [ ] **Step 3: Implement**

In `models/entityStore.js`, inside `_createTables()`, directly after the existing `entity_review_queue` `CREATE TABLE IF NOT EXISTS` block ends (currently `models/entityStore.js:37-56`), add the new table and the column migration:

```js
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS entity_embeddings (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        entity_name TEXT NOT NULL,
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, entity_id)
      )
    `).run();

    this._ensureColumn('entity_review_queue', 'trigram_similarity', 'REAL');
    this._ensureColumn('entity_review_queue', 'embedding_similarity', 'REAL');
  }

  // Additive Spalten-Migration: CREATE TABLE IF NOT EXISTS legt bei einer bereits
  // existierenden Alt-Datenbank keine neuen Spalten an - das muss ALTER TABLE
  // uebernehmen, idempotent per PRAGMA table_info-Check.
  _ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(c => c.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }
```

(Die schließende `}` der bisherigen `_createTables()`-Methode rückt dadurch eine Ebene nach unten, direkt hinter `_ensureColumn`.)

Add the CRUD methods and the Buffer/Array-Helfer, direkt nach `deleteAlias` (currently `models/entityStore.js:87-96`), vor `findRejectedPair`:

```js
  getEmbedding(entityType, entityId) {
    try {
      const row = this.db.prepare(
        `SELECT entity_name, model, vector FROM entity_embeddings WHERE entity_type = ? AND entity_id = ?`
      ).get(entityType, entityId);
      if (!row) return null;
      return { entity_name: row.entity_name, model: row.model, vector: this._bufferToVector(row.vector) };
    } catch (error) {
      console.error('[ERROR] entityStore.getEmbedding:', error.message);
      return null;
    }
  }

  upsertEmbedding({ entityType, id, name, model, vector }) {
    try {
      this.db.prepare(`
        INSERT INTO entity_embeddings (entity_type, entity_id, entity_name, model, vector, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          entity_name = excluded.entity_name,
          model = excluded.model,
          vector = excluded.vector,
          created_at = excluded.created_at
      `).run(entityType, id, name, model, this._vectorToBuffer(vector), new Date().toISOString());
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.upsertEmbedding:', error.message);
      return false;
    }
  }

  deleteEmbedding(entityType, entityId) {
    try {
      this.db.prepare(`DELETE FROM entity_embeddings WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.deleteEmbedding:', error.message);
      return false;
    }
  }

  _vectorToBuffer(vector) {
    return Buffer.from(Float32Array.from(vector).buffer);
  }

  _bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
```

Finally, extend `insertQueueEntry` (currently `models/entityStore.js:98-152`). Change the destructured parameter list and the `INSERT` statement. Replace:

```js
  insertQueueEntry({ entityType, proposedName, proposedId, candidateName, candidateId, similarity, llmVerdict, llmReason, status, documentId }) {
    try {
      const now = new Date().toISOString();
      // proposedNormalized/candidateNormalized MUESSEN bereits normalisiert sein (siehe
      // services/entityNormalizer.js#normalizeForType) - der Aufrufer normalisiert, damit
      // z.B. "meldebescheinigung" und "Meldebescheinigung" denselben Cache-Eintrag treffen.
      const proposedNormalized = normalizeForType(proposedName, entityType);
      const candidateNormalized = normalizeForType(candidateName, entityType);
      this.db.prepare(`
        INSERT INTO entity_review_queue
          (entity_type, proposed_name, proposed_normalized, proposed_id, candidate_name, candidate_normalized, candidate_id, similarity, llm_verdict, llm_reason, status, document_id, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, proposed_normalized, candidate_normalized) DO UPDATE SET
          proposed_id = excluded.proposed_id,
          status = excluded.status,
          llm_verdict = excluded.llm_verdict,
          llm_reason = excluded.llm_reason,
          resolved_at = CASE WHEN excluded.status != 'open' THEN excluded.created_at ELSE entity_review_queue.resolved_at END
      `).run(
        entityType, proposedName, proposedNormalized, proposedId ?? null, candidateName, candidateNormalized, candidateId, similarity,
        llmVerdict ?? null, llmReason ?? null, status, documentId ?? null,
        now, status !== 'open' ? now : null
      );
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertQueueEntry:', error.message);
      return false;
    }
  }
```

with:

```js
  insertQueueEntry({ entityType, proposedName, proposedId, candidateName, candidateId, similarity, trigramSimilarity = null, embeddingSimilarity = null, llmVerdict, llmReason, status, documentId }) {
    try {
      const now = new Date().toISOString();
      // proposedNormalized/candidateNormalized MUESSEN bereits normalisiert sein (siehe
      // services/entityNormalizer.js#normalizeForType) - der Aufrufer normalisiert, damit
      // z.B. "meldebescheinigung" und "Meldebescheinigung" denselben Cache-Eintrag treffen.
      const proposedNormalized = normalizeForType(proposedName, entityType);
      const candidateNormalized = normalizeForType(candidateName, entityType);
      this.db.prepare(`
        INSERT INTO entity_review_queue
          (entity_type, proposed_name, proposed_normalized, proposed_id, candidate_name, candidate_normalized, candidate_id, similarity, trigram_similarity, embedding_similarity, llm_verdict, llm_reason, status, document_id, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, proposed_normalized, candidate_normalized) DO UPDATE SET
          proposed_id = excluded.proposed_id,
          status = excluded.status,
          llm_verdict = excluded.llm_verdict,
          llm_reason = excluded.llm_reason,
          trigram_similarity = excluded.trigram_similarity,
          embedding_similarity = excluded.embedding_similarity,
          resolved_at = CASE WHEN excluded.status != 'open' THEN excluded.created_at ELSE entity_review_queue.resolved_at END
      `).run(
        entityType, proposedName, proposedNormalized, proposedId ?? null, candidateName, candidateNormalized, candidateId, similarity,
        trigramSimilarity, embeddingSimilarity,
        llmVerdict ?? null, llmReason ?? null, status, documentId ?? null,
        now, status !== 'open' ? now : null
      );
      return true;
    } catch (error) {
      console.error('[ERROR] entityStore.insertQueueEntry:', error.message);
      return false;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/entityStore.test.js`
Expected: PASS, all tests including the 8 new ones green.

Also run the full suite (other test files construct `EntityStore` and call `insertQueueEntry` without the new params — must stay green unchanged):

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/entityStore.js test/entityStore.test.js
git commit -m "$(cat <<'EOF'
feat: add entity_embeddings cache and queue similarity columns

New entity_embeddings table caches one vector per (type, id), keyed
so a rename or model switch invalidates the row (checked by the
caller in entityEmbeddingService, not here - this stays a plain
storage layer). entity_review_queue gains nullable
trigram_similarity/embedding_similarity columns via an idempotent
_ensureColumn migration, since CREATE TABLE IF NOT EXISTS is a no-op
against an already-existing table. similarity stays required and
unchanged for full backward compatibility.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `services/entityEmbeddingService.js` — `getOrComputeEmbedding()`

Cache-aware Lookup mit Staleness-Erkennung (Name- oder Modellwechsel invalidiert den Cache-Eintrag), defensiv wie der bestehende Alias-Mechanismus in `entityResolver.js`.

**Files:**
- Modify: `services/entityEmbeddingService.js`
- Test: `test/entityEmbeddingService.test.js` (erweitern)

**Interfaces:**
- Consumes: `store.getEmbedding`/`upsertEmbedding` (Task 3), `this.embed` (Task 2), `config.embedding.model`
- Produces: `entityEmbeddingService.getOrComputeEmbedding(store: EntityStore, entityType: string, entity: { id: number, name: string }) → Promise<number[]>` — konsumiert von Task 5 (`entityResolver.js`), Task 7 (`entityBackfillService.js`)

- [ ] **Step 1: Write the failing tests**

Append to `test/entityEmbeddingService.test.js`:

```js
const EntityStore = require('../models/entityStore');

test('getOrComputeEmbedding: Cache-Treffer liest ohne Ollama-Call', async () => {
  const store = new EntityStore(':memory:');
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'bge-m3', vector: [0.5, 0.5] });
  entityEmbeddingService.client = { post: async () => { throw new Error('sollte nicht aufgerufen werden'); } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 1, name: 'Rechnung' });
  assert.ok(Math.abs(vector[0] - 0.5) < 1e-6 && Math.abs(vector[1] - 0.5) < 1e-6);
});

test('getOrComputeEmbedding: fehlender Cache-Eintrag wird berechnet und gecached', async () => {
  const store = new EntityStore(':memory:');
  let calls = 0;
  entityEmbeddingService.client = { post: async () => { calls++; return { data: { embeddings: [[0.1, 0.2]] } }; } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 5, name: 'Mahnung' });
  assert.deepStrictEqual(vector, [0.1, 0.2]);
  assert.strictEqual(calls, 1);

  const cached = store.getEmbedding('tag', 5);
  assert.ok(cached);
});

test('getOrComputeEmbedding: Umbenennung macht den Cache-Eintrag stale, wird neu berechnet', async () => {
  const store = new EntityStore(':memory:');
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Alter Name', model: 'bge-m3', vector: [1, 0] });
  let calls = 0;
  entityEmbeddingService.client = { post: async () => { calls++; return { data: { embeddings: [[0, 1]] } }; } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 1, name: 'Neuer Name' });
  assert.deepStrictEqual(vector, [0, 1]);
  assert.strictEqual(calls, 1);
});

test('getOrComputeEmbedding: Modellwechsel macht den Cache-Eintrag stale, wird neu berechnet', async () => {
  const store = new EntityStore(':memory:');
  store.upsertEmbedding({ entityType: 'tag', id: 1, name: 'Rechnung', model: 'ein-anderes-modell', vector: [1, 0] });
  let calls = 0;
  entityEmbeddingService.client = { post: async () => { calls++; return { data: { embeddings: [[0, 1]] } }; } };

  const vector = await entityEmbeddingService.getOrComputeEmbedding(store, 'tag', { id: 1, name: 'Rechnung' });
  assert.deepStrictEqual(vector, [0, 1]);
  assert.strictEqual(calls, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/entityEmbeddingService.test.js`
Expected: FAIL — `entityEmbeddingService.getOrComputeEmbedding is not a function`.

- [ ] **Step 3: Implement**

Add to `services/entityEmbeddingService.js`, as a new method on `EntityEmbeddingService` (after `cosineSimilarity`, before the closing `}` of the class):

```js
  async getOrComputeEmbedding(store, entityType, entity) {
    const cached = store.getEmbedding(entityType, entity.id);
    if (cached && cached.entity_name === entity.name && cached.model === config.embedding.model) {
      return cached.vector;
    }

    const vector = await this.embed(entity.name);
    store.upsertEmbedding({ entityType, id: entity.id, name: entity.name, model: config.embedding.model, vector });
    return vector;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/entityEmbeddingService.test.js`
Expected: PASS, all 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/entityEmbeddingService.js test/entityEmbeddingService.test.js
git commit -m "$(cat <<'EOF'
feat: add cache-aware getOrComputeEmbedding

Reads models/entityStore's entity_embeddings cache; a name or model
mismatch is treated as stale and recomputed, same defensive pattern
as the existing alias staleness check in entityResolver.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `services/entityResolver.js` — kombinierte Kandidatenauswahl und Embedding-Schwellwerte

Kernstück der Phase. Stufe 4 wählt den besten Kandidaten künftig über `combinedScore = max(trigramSim, embeddingSim)`, prüft die Entscheidung aber gegen die **rohen**, kanalspezifischen Schwellwerte. Bei deaktiviertem Embedding-Kanal (`embeddingEnabled: false`, der Default in jedem bestehenden Test) bleibt das Verhalten exakt wie zuvor — `embeddingSim` wird dann nie berechnet, `combined` reduziert sich auf `trigramSim`.

**Files:**
- Modify: `services/entityResolver.js`
- Test: `test/entityResolver.test.js` (erweitern)

**Interfaces:**
- Consumes: `entityEmbeddingService`-artiges Objekt mit `embed`, `cosineSimilarity`, `getOrComputeEmbedding` (Task 2/4, injiziert — kein direktes `require` in dieser Datei, Testbarkeit über Fakes)
- Produces: Konstruktor erweitert um `embeddingService`-Parameter und `config.embeddingEnabled`/`embedAutoThreshold`/`embedJudgeMin`; `resolve()` liefert bei `map` zusätzlich `via: 'embedding_similarity'` als neue Möglichkeit; `create_and_queue` liefert zusätzlich `trigramSimilarity`/`embeddingSimilarity`; `recordCreatedAndQueued` akzeptiert dieselben zwei neuen Felder — konsumiert von Task 6 (`paperlessService.js`)

- [ ] **Step 1: Write the failing tests**

Append to `test/entityResolver.test.js`:

```js
function fakeEmbeddingService(vectors) {
  return {
    embed: async (text) => {
      if (!(text in vectors)) throw new Error(`kein Test-Vektor fuer "${text}" hinterlegt`);
      return vectors[text];
    },
    getOrComputeEmbedding: async (_store, _type, entity) => {
      if (!(entity.name in vectors)) throw new Error(`kein Test-Vektor fuer "${entity.name}" hinterlegt`);
      return vectors[entity.name];
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
  };
}

test('Embedding-Auto: Embedding >= EMBED_AUTO_THRESHOLD, Trigram weit darunter -> map via embedding_similarity, Alias source=auto_embedding', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Verdienstbescheinigung': [1, 0] // identisch -> Cosine = 1
  });
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'embedding_similarity');
  const alias = store.findAlias('document_type', normalizeForType('Entgeltabrechnung', 'document_type'));
  assert.strictEqual(alias.source, 'auto_embedding');
});

test('Embedding-Judge-Zone: Trigram unter JUDGE_MIN, Embedding im Judge-Fenster -> Judge wird gefragt', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = fakeEmbeddingService({
    'Entgeltabrechnung': [1, 0],
    'Verdienstbescheinigung': [0.7, 0.714142842854285] // Cosine ~0.7
  });
  const resolver = new EntityResolver({
    store, judge: async () => ({ verdict: 'same', reason: 'semantisch gleich' }),
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  assert.strictEqual(result.action, 'map');
  assert.strictEqual(result.via, 'llm');
});

test('Embedding deaktiviert trotz injiziertem Service -> kein Embedding-Call, Verhalten wie ohne Embeddings', async () => {
  const store = new EntityStore(':memory:');
  let calls = 0;
  const embeddingService = {
    embed: async () => { calls++; return [1, 0]; },
    getOrComputeEmbedding: async () => { calls++; return [1, 0]; },
    cosineSimilarity: () => 1
  };
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: false }
  });

  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);

  assert.strictEqual(result.action, 'create');
  assert.strictEqual(calls, 0);
});

test('Fehlerverhalten: Embedding-Call wirft -> faellt auf Trigram-only zurueck, kein Absturz', async () => {
  const store = new EntityStore(':memory:');
  const embeddingService = {
    embed: async () => { throw new Error('ECONNREFUSED'); },
    getOrComputeEmbedding: async () => { throw new Error('sollte nicht erreicht werden'); },
    cosineSimilarity: () => { throw new Error('sollte nicht erreicht werden'); }
  };
  const resolver = new EntityResolver({
    store, judge: async () => { throw new Error('Judge sollte nicht aufgerufen werden'); },
    embeddingService,
    config: { autoThreshold: 0.90, judgeMin: 0.65, embeddingEnabled: true, embedAutoThreshold: 0.90, embedJudgeMin: 0.65 }
  });

  // Trigram-Aehnlichkeit dieser beiden Namen liegt unter judgeMin -> create, trotz kaputtem Embedding-Kanal
  const result = await resolver.resolve('document_type', 'Entgeltabrechnung', [{ id: 4, name: 'Verdienstbescheinigung' }]);
  assert.strictEqual(result.action, 'create');
});

test('recordCreatedAndQueued schreibt trigram_similarity und embedding_similarity mit', async () => {
  const store = new EntityStore(':memory:');
  const resolver = makeResolver({ store });

  resolver.recordCreatedAndQueued({
    type: 'document_type', proposedName: 'Verdienstbescheinigung', proposedId: 55,
    candidate: { id: 4, name: 'Meldebescheinigung' }, similarity: 0.81,
    trigramSimilarity: 0.42, embeddingSimilarity: 0.81,
    verdict: 'unsure', documentId: 123
  });

  const found = store.db.prepare(
    `SELECT * FROM entity_review_queue WHERE proposed_name = ? AND candidate_name = ?`
  ).get('Verdienstbescheinigung', 'Meldebescheinigung');
  assert.strictEqual(found.trigram_similarity, 0.42);
  assert.strictEqual(found.embedding_similarity, 0.81);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/entityResolver.test.js`
Expected: FAIL — new tests fail (`result.via` is `undefined`/wrong, `found.trigram_similarity` missing, `calls` mismatches). Existing tests should still pass at this point (regression baseline).

- [ ] **Step 3: Implement**

In `services/entityResolver.js`, change the constructor. Replace:

```js
  constructor({ store, judge, config = {} }) {
    this.store = store;
    this.judge = judge; // async (type, nameA, nameB) => { verdict, reason }
    this.autoThreshold = config.autoThreshold ?? 0.90;
    this.judgeMin = config.judgeMin ?? 0.65;
  }
```

with:

```js
  constructor({ store, judge, embeddingService = null, config = {} }) {
    this.store = store;
    this.judge = judge; // async (type, nameA, nameB) => { verdict, reason }
    this.embeddingService = embeddingService; // { embed, cosineSimilarity, getOrComputeEmbedding }
    this.autoThreshold = config.autoThreshold ?? 0.90;
    this.judgeMin = config.judgeMin ?? 0.65;
    this.embeddingEnabled = Boolean(config.embeddingEnabled) && Boolean(embeddingService);
    this.embedAutoThreshold = config.embedAutoThreshold ?? 0.90;
    this.embedJudgeMin = config.embedJudgeMin ?? 0.65;
  }
```

Replace the entire Stufe-4 block through the end of `resolve()`, plus `recordCreatedAndQueued` (currently everything from the `// Stufe 4: Ähnlichkeit gegen den besten Kandidaten` comment through the closing `}` of `recordCreatedAndQueued`):

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

    // Negativ-Cache geht sowohl 4a als auch 4c vor. findRejectedPair vergleicht
    // normalisiert, damit Gross-/Kleinschreibung oder Whitespace-Varianten des
    // Paars denselben Cache-Treffer liefern (siehe entityStore.js).
    const normalizedCandidate = normalizeForType(best.entity.name, type);
    const rejected = this.store.findRejectedPair(type, normalizedProposed, normalizedCandidate);

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
}
```

with:

```js
    // Stufe 4: kombinierte Kandidatenauswahl. combinedScore = max(trigram, embedding)
    // pro Bestandsentitaet waehlt den Kandidaten, unabhaengig davon, welcher Kanal ihn
    // erkennt. Die Entscheidung darunter prueft dagegen den rohen Wert jedes Kanals
    // gegen dessen EIGENEN Schwellwert - Cosine-Aehnlichkeit und Dice-Koeffizient liegen
    // nicht auf derselben Skala, ein gemeinsamer Schwellwert auf dem Max-Wert waere
    // statistisch nicht belastbar (siehe Design-Doc Phase 4).
    let proposedVector = null;
    if (this.embeddingEnabled) {
      try {
        proposedVector = await this.embeddingService.embed(proposedName);
      } catch (error) {
        console.warn(`[WARNING] entityResolver: Embedding fuer Vorschlag "${proposedName}" nicht berechenbar, faellt auf Trigram-only zurueck:`, error.message);
        proposedVector = null;
      }
    }

    let best = null;
    for (const entity of existingEntities) {
      const trigramSim = diceCoefficient(normalizedProposed, normalizeForType(entity.name, type));
      const embeddingSim = await this._embeddingSimilarityFor(type, proposedVector, entity);
      const combined = Math.max(trigramSim, embeddingSim ?? -1);

      if (!best || combined > best.combined) {
        best = { entity, trigramSim, embeddingSim, combined };
      }
    }

    if (!best) {
      return { action: 'create' };
    }

    // Negativ-Cache geht allen Auto-Stufen und dem Judge vor. findRejectedPair vergleicht
    // normalisiert, damit Gross-/Kleinschreibung oder Whitespace-Varianten des
    // Paars denselben Cache-Treffer liefern (siehe entityStore.js).
    const normalizedCandidate = normalizeForType(best.entity.name, type);
    const rejected = this.store.findRejectedPair(type, normalizedProposed, normalizedCandidate);

    if (!rejected && best.trigramSim >= this.autoThreshold) {
      this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'auto'
      });
      return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'similarity' };
    }

    if (!rejected && best.embeddingSim !== null && best.embeddingSim >= this.embedAutoThreshold) {
      this.store.insertAlias({
        entityType: type, aliasNormalized: normalizedProposed,
        canonicalName: best.entity.name, canonicalId: best.entity.id, source: 'auto_embedding'
      });
      return { action: 'map', id: best.entity.id, canonicalName: best.entity.name, via: 'embedding_similarity' };
    }

    if (rejected) {
      return { action: 'create' };
    }

    const reachesJudgeZone = best.trigramSim >= this.judgeMin
      || (best.embeddingSim !== null && best.embeddingSim >= this.embedJudgeMin);

    if (reachesJudgeZone) {
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
          similarity: best.combined, trigramSimilarity: best.trigramSim, embeddingSimilarity: best.embeddingSim,
          llmVerdict: 'different', llmReason: verdict.reason,
          status: 'rejected'
        });
        return { action: 'create' };
      }

      // 'unsure': proposed_id ist hier noch unbekannt, der Resolver legt nichts an.
      // Der Aufrufer ruft nach dem tatsaechlichen Anlegen recordCreatedAndQueued auf.
      return {
        action: 'create_and_queue',
        candidate: { id: best.entity.id, name: best.entity.name },
        similarity: best.combined,
        trigramSimilarity: best.trigramSim,
        embeddingSimilarity: best.embeddingSim,
        verdict: verdict.verdict
      };
    }

    // Stufe 4d/5: unter beiden Judge-Schwellen
    return { action: 'create' };
  }

  async _embeddingSimilarityFor(type, proposedVector, entity) {
    if (!proposedVector) {
      return null;
    }
    try {
      const entityVector = await this.embeddingService.getOrComputeEmbedding(this.store, type, entity);
      return this.embeddingService.cosineSimilarity(proposedVector, entityVector);
    } catch (error) {
      console.warn(`[WARNING] entityResolver: Embedding-Aehnlichkeit fuer "${entity.name}" (${type}) nicht berechenbar, wird ignoriert:`, error.message);
      return null;
    }
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

  recordCreatedAndQueued({ type, proposedName, proposedId, candidate, similarity, trigramSimilarity = null, embeddingSimilarity = null, verdict, documentId }) {
    this.store.insertQueueEntry({
      entityType: type, proposedName, proposedId,
      candidateName: candidate.name, candidateId: candidate.id,
      similarity, trigramSimilarity, embeddingSimilarity,
      llmVerdict: verdict, llmReason: null,
      status: 'open', documentId
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/entityResolver.test.js`
Expected: PASS, every test — all pre-existing Stufe-0-bis-4d-Tests unveraendert gruen (Regression), plus die 5 neuen.

Run the full suite once, weil `entityResolverHookIn.test.js` denselben Resolver ueber `paperlessService` konstruiert:

Run: `npm test`
Expected: PASS (Task 6 verdrahtet `embeddingService` erst als Naechstes — bis dahin bleibt `_getEntityResolver()` unveraendert und uebergibt weiterhin kein `embeddingService`, was per Default `embeddingEnabled: false` ergibt).

- [ ] **Step 5: Commit**

```bash
git add services/entityResolver.js test/entityResolver.test.js
git commit -m "$(cat <<'EOF'
feat: combined trigram/embedding candidate selection in EntityResolver

Stage 4 now picks the best candidate by max(trigramSim, embeddingSim)
per bestand entity, but decides map/judge/create against each
channel's own raw value and threshold - cosine similarity and dice
coefficient aren't on the same scale, so a single shared threshold
on the combined max wouldn't be statistically sound. Embedding
auto-matches write alias source='auto_embedding' instead of 'auto'
for traceability. Disabled or errored embedding channel reduces to
exactly the prior trigram-only behavior (regression-tested).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `services/paperlessService.js` — Embedding-Service verdrahten

`_getEntityResolver()` injiziert künftig `entityEmbeddingService` (nur wenn `config.embedding.enabled`) und die neuen Schwellwerte. `_recordEntityQueue` reicht `trigramSimilarity`/`embeddingSimilarity` durch. Die drei Aufrufer (`processTags`, `getOrCreateCorrespondent`, `getOrCreateDocumentType`) ändern sich **nicht** — sie rufen bereits `_resolveEntity`/`_recordEntityQueue` generisch auf.

**Files:**
- Modify: `services/paperlessService.js:158-209`
- Test: `test/entityResolverHookIn.test.js` (erweitern)

**Interfaces:**
- Consumes: `config.embedding` (Task 1), `entityEmbeddingService` (Task 2/4), `EntityResolver` mit `embeddingService`-Parameter (Task 5)
- Produces: `_getEntityResolver()` liefert einen `EntityResolver`, dessen `embeddingEnabled` `config.embedding.enabled` widerspiegelt

- [ ] **Step 1: Write the failing test**

Append to `test/entityResolverHookIn.test.js`. Zuerst pruefen, welche Requires die Datei bereits hat (`EntityStore`, `EntityResolver`, `paperlessService`, `config` — falls einer fehlt, am Dateianfang ergaenzen):

```js
test('_getEntityResolver injiziert den Embedding-Service nur, wenn config.embedding.enabled=true', () => {
  const originalInstance = paperlessService._entityResolverInstance;
  const originalEmbeddingEnabled = config.embedding.enabled;

  try {
    paperlessService._entityResolverInstance = null;
    config.embedding.enabled = false;
    const resolverDisabled = paperlessService._getEntityResolver();
    assert.strictEqual(resolverDisabled.embeddingEnabled, false);

    paperlessService._entityResolverInstance = null;
    config.embedding.enabled = true;
    const resolverEnabled = paperlessService._getEntityResolver();
    assert.strictEqual(resolverEnabled.embeddingEnabled, true);
    assert.strictEqual(resolverEnabled.embedAutoThreshold, config.embedding.autoThreshold);
    assert.strictEqual(resolverEnabled.embedJudgeMin, config.embedding.judgeMin);
  } finally {
    config.embedding.enabled = originalEmbeddingEnabled;
    paperlessService._entityResolverInstance = originalInstance;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/entityResolverHookIn.test.js`
Expected: FAIL — `resolverEnabled.embeddingEnabled` is `false` (kein `embeddingService` wird injiziert).

- [ ] **Step 3: Implement**

In `services/paperlessService.js`, replace `_getEntityResolver` (currently `services/paperlessService.js:158-175`) and `_recordEntityQueue` (currently `services/paperlessService.js:200-209`).

Replace:

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
```

with:

```js
  _getEntityResolver() {
    if (!this._entityResolverInstance) {
      const EntityStore = require('../models/entityStore');
      const EntityResolver = require('./entityResolver');
      const entityJudge = require('./entityJudge');
      const entityEmbeddingService = require('./entityEmbeddingService');

      const store = new EntityStore(config.entityResolver.dbPath);
      this._entityResolverInstance = new EntityResolver({
        store,
        judge: (type, a, b) => entityJudge.judge(type, a, b),
        embeddingService: config.embedding.enabled ? entityEmbeddingService : null,
        config: {
          autoThreshold: config.entityResolver.autoThreshold,
          judgeMin: config.entityResolver.judgeMin,
          embeddingEnabled: config.embedding.enabled,
          embedAutoThreshold: config.embedding.autoThreshold,
          embedJudgeMin: config.embedding.judgeMin
        }
      });
    }
    return this._entityResolverInstance;
  }
```

Replace:

```js
  _recordEntityQueue(type, proposedName, proposedId, decision, documentId) {
    try {
      this._getEntityResolver().recordCreatedAndQueued({
        type, proposedName, proposedId, documentId,
        candidate: decision.candidate, similarity: decision.similarity, verdict: decision.verdict
      });
    } catch (error) {
      console.warn(`[WARNING] Konnte Review-Queue-Eintrag fuer "${proposedName}" nicht schreiben:`, error.message);
    }
  }
```

with:

```js
  _recordEntityQueue(type, proposedName, proposedId, decision, documentId) {
    try {
      this._getEntityResolver().recordCreatedAndQueued({
        type, proposedName, proposedId, documentId,
        candidate: decision.candidate, similarity: decision.similarity,
        trigramSimilarity: decision.trigramSimilarity, embeddingSimilarity: decision.embeddingSimilarity,
        verdict: decision.verdict
      });
    } catch (error) {
      console.warn(`[WARNING] Konnte Review-Queue-Eintrag fuer "${proposedName}" nicht schreiben:`, error.message);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/entityResolverHookIn.test.js`
Expected: PASS.

Run the full suite (`_entityResolverInstance` ist ein Modul-Singleton — sicherstellen, dass kein anderer Test durch den `try/finally`-Reset im neuen Test beeinflusst wird):

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/paperlessService.js test/entityResolverHookIn.test.js
git commit -m "$(cat <<'EOF'
feat: wire entityEmbeddingService into paperlessService's resolver

_getEntityResolver only injects the embedding service when
config.embedding.enabled is true, so the default-disabled channel
never touches Ollama. _recordEntityQueue forwards the two new raw
similarity fields the resolver's create_and_queue decision now
carries. processTags/getOrCreateCorrespondent/getOrCreateDocumentType
are unchanged - they already call the generic hook points.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `services/entityBackfillService.js` — asynchrone Kaskade mit Embedding-Prefetch

`run()` wird asynchron. Vor dem quadratischen Vergleich werden fehlende Embeddings für den gesamten Bestand einmalig vorgezogen (ein Cache-Lookup/Call pro Entität, nicht pro Paar) und in einer lokalen `Map` gehalten — die eigentliche Vergleichsschleife bleibt danach synchron.

**Files:**
- Modify: `services/entityBackfillService.js`
- Test: `test/entityBackfillService.test.js` (alle bestehenden Tests werden async; neue Tests ergänzt)

**Interfaces:**
- Consumes: `entityEmbeddingService`-artiges Objekt (injiziert, wie in Task 5), `store.findQueueEntryPair` (unverändert)
- Produces: `new EntityBackfillService({ store, judgeMin, embeddingService, embeddingEnabled, embedJudgeMin })`, `async run(entityType, existingEntities) → Promise<{ inserted: number }>` — konsumiert von Task 8 (`routes/review.js`)

- [ ] **Step 1: Write the failing tests**

Replace the entire content of `test/entityBackfillService.test.js` (every existing test becomes `async` with `await service.run(...)`, plus four new tests):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const EntityBackfillService = require('../services/entityBackfillService');
const EntityStore = require('../models/entityStore');

function fakeEmbeddingService(vectors) {
  return {
    getOrComputeEmbedding: async (_store, _type, entity) => {
      if (!(entity.name in vectors)) throw new Error(`kein Test-Vektor fuer "${entity.name}" hinterlegt`);
      return vectors[entity.name];
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
  };
}

test('run findet ein aehnliches Paar oberhalb judgeMin und schreibt einen Queue-Eintrag, aeltere id wird kanonisch', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = await service.run('document_type', [
      { id: 5, name: 'Meldebescheinigung' },
      { id: 12, name: 'Meldebeschreibung' }
    ]);

    assert.strictEqual(result.inserted, 1);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'document_type'`).get();
    assert.strictEqual(row.candidate_id, 5);
    assert.strictEqual(row.proposed_id, 12);
    assert.strictEqual(row.llm_verdict, null);
    assert.strictEqual(row.status, 'open');
  } finally {
    store.close();
  }
});

test('run ueberspringt Paare unterhalb judgeMin', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run ueberspringt bereits als rejected bekannte Paare', async () => {
  const store = new EntityStore(':memory:');
  try {
    store.insertQueueEntry({
      entityType: 'tag',
      proposedName: 'Mahnung', proposedId: 2,
      candidateName: 'Mahnungen', candidateId: 1,
      similarity: 0.9, llmVerdict: 'different', llmReason: 'Test', status: 'rejected', documentId: null
    });

    const service = new EntityBackfillService({ store, judgeMin: 0.5 });
    const result = await service.run('tag', [
      { id: 1, name: 'Mahnungen' },
      { id: 2, name: 'Mahnung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run ueberschreibt den llm_verdict eines bereits offenen Queue-Eintrags nicht', async () => {
  const store = new EntityStore(':memory:');
  try {
    store.insertQueueEntry({
      entityType: 'tag',
      proposedName: 'Mahnung', proposedId: 2,
      candidateName: 'Mahnungen', candidateId: 1,
      similarity: 0.9, llmVerdict: 'unsure', llmReason: 'Vom Live-Pfad gesetzt', status: 'open', documentId: null
    });

    const service = new EntityBackfillService({ store, judgeMin: 0.5 });
    const result = await service.run('tag', [
      { id: 1, name: 'Mahnungen' },
      { id: 2, name: 'Mahnung' }
    ]);

    assert.strictEqual(result.inserted, 0);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'tag'`).get();
    assert.strictEqual(row.llm_verdict, 'unsure');
    assert.strictEqual(row.status, 'open');
  } finally {
    store.close();
  }
});

test('run vergleicht jedes Paar nur einmal bei mehr als zwei Eintraegen', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.99 }); // nur exakte Duplikate treffen

    const result = await service.run('tag', [
      { id: 1, name: 'Rechnung' },
      { id: 2, name: 'Rechnung' },
      { id: 3, name: 'Voellig Anders' }
    ]);

    assert.strictEqual(result.inserted, 1);
  } finally {
    store.close();
  }
});

test('run findet mit aktiviertem Embedding-Kanal ein Paar, das Trigram allein verpassen wuerde', async () => {
  const store = new EntityStore(':memory:');
  try {
    const embeddingService = fakeEmbeddingService({
      'Entgeltabrechnung': [1, 0],
      'Verdienstbescheinigung': [1, 0] // identisch -> Cosine = 1
    });
    const service = new EntityBackfillService({
      store, judgeMin: 0.99, embeddingService, embeddingEnabled: true, embedJudgeMin: 0.90
    });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 1);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'document_type'`).get();
    assert.ok(row.embedding_similarity > 0.9);
    assert.ok(row.trigram_similarity < 0.3);
  } finally {
    store.close();
  }
});

test('run bleibt bei deaktiviertem Embedding-Kanal trigram-only, kein Embedding-Call', async () => {
  const store = new EntityStore(':memory:');
  let calls = 0;
  try {
    const embeddingService = {
      getOrComputeEmbedding: async () => { calls++; return [1, 0]; },
      cosineSimilarity: () => 1
    };
    const service = new EntityBackfillService({ store, judgeMin: 0.99, embeddingService, embeddingEnabled: false });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 0);
    assert.strictEqual(calls, 0);
  } finally {
    store.close();
  }
});

test('run ignoriert einen einzelnen fehlgeschlagenen Embedding-Call, statt abzubrechen', async () => {
  const store = new EntityStore(':memory:');
  try {
    const embeddingService = {
      getOrComputeEmbedding: async (_store, _type, entity) => {
        if (entity.name === 'Verdienstbescheinigung') throw new Error('ECONNREFUSED');
        return [1, 0];
      },
      cosineSimilarity: () => 1
    };
    const service = new EntityBackfillService({
      store, judgeMin: 0.99, embeddingService, embeddingEnabled: true, embedJudgeMin: 0.90
    });

    const result = await service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    // Ein Vektor fehlt (Fehler beim Prefetch) -> embeddingSim fuer dieses Paar bleibt null,
    // trigram allein (weit unter judgeMin 0.99) entscheidet -> kein Absturz, kein Insert.
    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/entityBackfillService.test.js`
Expected: FAIL — `service.run(...)` gibt eine `Promise` zurueck, die bestehenden (nun `await`-erweiterten) Assertions auf `result.inserted` schlagen fehl, weil `run` noch synchron implementiert ist und die neuen Konstruktor-Optionen ignoriert.

- [ ] **Step 3: Implement**

Replace the entire content of `services/entityBackfillService.js`:

```js
const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityBackfillService {
  constructor({ store, judgeMin, embeddingService = null, embeddingEnabled = false, embedJudgeMin = 0.65 }) {
    this.store = store;
    this.judgeMin = judgeMin;
    this.embeddingService = embeddingService;
    this.embeddingEnabled = Boolean(embeddingEnabled) && Boolean(embeddingService);
    this.embedJudgeMin = embedJudgeMin;
  }

  async run(entityType, existingEntities) {
    let inserted = 0;

    // Embeddings werden VOR der quadratischen Vergleichsschleife einmal pro Entitaet
    // vorgezogen (Cache-Treffer oder ein Call), damit die eigentliche Paarvergleichsschleife
    // ohne weitere Ollama-Calls auskommt - sonst waere jedes Paar ein eigener Call.
    const vectors = new Map();
    if (this.embeddingEnabled) {
      for (const entity of existingEntities) {
        try {
          const vector = await this.embeddingService.getOrComputeEmbedding(this.store, entityType, entity);
          vectors.set(entity.id, vector);
        } catch (error) {
          console.warn(`[WARNING] entityBackfillService: Embedding fuer "${entity.name}" (${entityType}) nicht berechenbar, wird ignoriert:`, error.message);
        }
      }
    }

    for (let i = 0; i < existingEntities.length; i++) {
      for (let j = i + 1; j < existingEntities.length; j++) {
        const a = existingEntities[i];
        const b = existingEntities[j];

        // Aeltere (kleinere) id gilt als kanonisch, die neuere als moeglicher Dublette-Kandidat -
        // dieselbe Richtung, die auch der Live-Pfad fuer Merge annimmt (proposed -> candidate).
        const [candidate, proposed] = a.id < b.id ? [a, b] : [b, a];

        const normalizedCandidate = normalizeForType(candidate.name, entityType);
        const normalizedProposed = normalizeForType(proposed.name, entityType);
        const trigramSim = diceCoefficient(normalizedCandidate, normalizedProposed);

        let embeddingSim = null;
        if (vectors.has(candidate.id) && vectors.has(proposed.id)) {
          embeddingSim = this.embeddingService.cosineSimilarity(vectors.get(candidate.id), vectors.get(proposed.id));
        }

        const reachesThreshold = trigramSim >= this.judgeMin
          || (embeddingSim !== null && embeddingSim >= this.embedJudgeMin);
        if (!reachesThreshold) {
          continue;
        }
        // Ueberspringt jedes bereits existierende Paar (egal ob open/merged/rejected) - verhindert,
        // dass ein erneuter Backfill-Lauf ein echtes LLM-Urteil auf noch offenen Eintraegen ueberschreibt.
        if (this.store.findQueueEntryPair(entityType, normalizedProposed, normalizedCandidate)) {
          continue;
        }

        const written = this.store.insertQueueEntry({
          entityType,
          proposedName: proposed.name,
          proposedId: proposed.id,
          candidateName: candidate.name,
          candidateId: candidate.id,
          similarity: Math.max(trigramSim, embeddingSim ?? -1),
          trigramSimilarity: trigramSim,
          embeddingSimilarity: embeddingSim,
          llmVerdict: null,
          llmReason: null,
          status: 'open',
          documentId: null
        });
        if (written) inserted++;
      }
    }

    return { inserted };
  }
}

module.exports = EntityBackfillService;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/entityBackfillService.test.js`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/entityBackfillService.js test/entityBackfillService.test.js
git commit -m "$(cat <<'EOF'
feat: async EntityBackfillService with embedding prefetch

run() is now async: embeddings for the whole bestand are prefetched
once (cache hit or one call per entity) before the O(n^2) pairwise
loop, which then stays synchronous - no per-pair network call.
Disabled or errored embedding channel reduces to the prior
trigram-only behavior (regression-tested).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `routes/review.js` — `await` und Embedding-Service injizieren

**Files:**
- Modify: `routes/review.js`

**Interfaces:**
- Consumes: `config.embedding` (Task 1), `entityEmbeddingService` (Task 2/4), `EntityBackfillService` mit neuen Konstruktor-Optionen (Task 7)
- Produces: `POST /api/review/backfill/:entityType` wartet korrekt auf das jetzt asynchrone `run()`

Keine automatisierten Route-Tests — folgt der bestehenden Konvention dieser Datei (siehe Phase 3: kein HTTP-Test-Harness im Projekt, Geschäftslogik liegt vollständig in den bereits getesteten Services).

- [ ] **Step 1: `getServices()` erweitern**

In `routes/review.js`, replace:

```js
const express = require('express');
const router = express.Router();
const { isAuthenticated, authenticateJWT } = require('./auth');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const EntityStore = require('../models/entityStore');
const ReviewQueueService = require('../services/reviewQueueService');
const EntityBackfillService = require('../services/entityBackfillService');

let store = null;
let reviewQueueService = null;
let backfillService = null;

// Lazy statt Modul-Top-Level: verhindert, dass jeder Server-Boot data/entities.db oeffnet
// (auch wenn ENTITY_RESOLVER_ENABLED=no) und dass ein DB-Fehler den gesamten Server-Start crasht.
function getServices() {
  if (!store) {
    store = new EntityStore(config.entityResolver.dbPath);
    reviewQueueService = new ReviewQueueService({ store, paperlessService });
    backfillService = new EntityBackfillService({ store, judgeMin: config.entityResolver.judgeMin });
  }
  return { store, reviewQueueService, backfillService };
}
```

with:

```js
const express = require('express');
const router = express.Router();
const { isAuthenticated, authenticateJWT } = require('./auth');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const EntityStore = require('../models/entityStore');
const ReviewQueueService = require('../services/reviewQueueService');
const EntityBackfillService = require('../services/entityBackfillService');
const entityEmbeddingService = require('../services/entityEmbeddingService');

let store = null;
let reviewQueueService = null;
let backfillService = null;

// Lazy statt Modul-Top-Level: verhindert, dass jeder Server-Boot data/entities.db oeffnet
// (auch wenn ENTITY_RESOLVER_ENABLED=no) und dass ein DB-Fehler den gesamten Server-Start crasht.
function getServices() {
  if (!store) {
    store = new EntityStore(config.entityResolver.dbPath);
    reviewQueueService = new ReviewQueueService({ store, paperlessService });
    backfillService = new EntityBackfillService({
      store,
      judgeMin: config.entityResolver.judgeMin,
      embeddingService: config.embedding.enabled ? entityEmbeddingService : null,
      embeddingEnabled: config.embedding.enabled,
      embedJudgeMin: config.embedding.judgeMin
    });
  }
  return { store, reviewQueueService, backfillService };
}
```

- [ ] **Step 2: `await` fuer das jetzt asynchrone `run()`**

Replace:

```js
  try {
    const { backfillService } = getServices();
    const existingEntities = await lister();
    const result = backfillService.run(entityType, existingEntities);
    res.json(result);
  } catch (error) {
```

with:

```js
  try {
    const { backfillService } = getServices();
    const existingEntities = await lister();
    const result = await backfillService.run(entityType, existingEntities);
    res.json(result);
  } catch (error) {
```

- [ ] **Step 3: Syntax-Check und volle Testsuite**

Run: `node --check routes/review.js`
Expected: kein Output, Exit-Code 0.

Run: `npm test`
Expected: PASS, alle Tests gruen (dieser Datei fehlt eine dedizierte Testdatei — Regression zeigt sich indirekt ueber `entityBackfillService.test.js`, das dieselbe Klasse direkt testet).

- [ ] **Step 4: Commit**

```bash
git add routes/review.js
git commit -m "feat: await async backfill run(), inject embedding service"
```

---

### Task 9: `views/review.ejs` — Trigram-/Embedding-Spalten

Ersetzt die eine `Similarity`-Spalte durch zwei nullable-sichere Spalten, damit sichtbar ist, welcher Kanal einen Kandidaten geliefert hat (die höhere der beiden Zahlen).

**Files:**
- Modify: `views/review.ejs`

Keine automatisierten Tests (View-Datei, kein Browser-Test-Harness im Projekt — siehe Phase 3). Manuell verifiziert in Step 2.

- [ ] **Step 1: Tabelle anpassen**

In `views/review.ejs`, replace (currently `views/review.ejs:69-110`):

```html
                        <table class="w-full" id="reviewTable">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Proposed</th>
                                    <th>Candidate</th>
                                    <th>Similarity</th>
                                    <th>Judge</th>
                                    <th>Document</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <% queue.forEach(function(entry) { %>
                                <tr data-queue-id="<%= entry.id %>">
                                    <td><%= entry.entity_type %></td>
                                    <td><%= entry.proposed_name %></td>
                                    <td><%= entry.candidate_name %></td>
                                    <td><%= entry.similarity.toFixed(2) %></td>
                                    <td><%= entry.llm_verdict || '-' %></td>
                                    <td>
                                        <% if (entry.documentLink) { %>
                                            <a href="<%= entry.documentLink %>" target="_blank" class="text-blue-500 hover:underline">View</a>
                                        <% } else { %>
                                            <span class="text-gray-400">-</span>
                                        <% } %>
                                    </td>
                                    <td>
                                        <div class="flex gap-2">
                                            <button class="preview-btn px-3 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors" data-id="<%= entry.id %>" title="Preview">
                                                <i class="fa-solid fa-eye"></i>
                                                <span class="hidden sm:inline ml-1">Preview</span>
                                            </button>
                                            <button class="merge-btn px-3 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors" data-id="<%= entry.id %>" data-proposed-name="<%= entry.proposed_name %>" data-candidate-name="<%= entry.candidate_name %>">Merge</button>
                                            <button class="reject-btn px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors" data-id="<%= entry.id %>">Not a duplicate</button>
                                        </div>
                                    </td>
                                </tr>
                                <% }); %>
                                <% if (queue.length === 0) { %>
                                <tr><td colspan="7" class="text-center text-gray-400 py-6">No open entries</td></tr>
                                <% } %>
                            </tbody>
                        </table>
```

with:

```html
                        <table class="w-full" id="reviewTable">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Proposed</th>
                                    <th>Candidate</th>
                                    <th>Trigram</th>
                                    <th>Embedding</th>
                                    <th>Judge</th>
                                    <th>Document</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <% queue.forEach(function(entry) { %>
                                <tr data-queue-id="<%= entry.id %>">
                                    <td><%= entry.entity_type %></td>
                                    <td><%= entry.proposed_name %></td>
                                    <td><%= entry.candidate_name %></td>
                                    <td><%= entry.trigram_similarity != null ? entry.trigram_similarity.toFixed(2) : '-' %></td>
                                    <td><%= entry.embedding_similarity != null ? entry.embedding_similarity.toFixed(2) : '-' %></td>
                                    <td><%= entry.llm_verdict || '-' %></td>
                                    <td>
                                        <% if (entry.documentLink) { %>
                                            <a href="<%= entry.documentLink %>" target="_blank" class="text-blue-500 hover:underline">View</a>
                                        <% } else { %>
                                            <span class="text-gray-400">-</span>
                                        <% } %>
                                    </td>
                                    <td>
                                        <div class="flex gap-2">
                                            <button class="preview-btn px-3 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors" data-id="<%= entry.id %>" title="Preview">
                                                <i class="fa-solid fa-eye"></i>
                                                <span class="hidden sm:inline ml-1">Preview</span>
                                            </button>
                                            <button class="merge-btn px-3 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors" data-id="<%= entry.id %>" data-proposed-name="<%= entry.proposed_name %>" data-candidate-name="<%= entry.candidate_name %>">Merge</button>
                                            <button class="reject-btn px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors" data-id="<%= entry.id %>">Not a duplicate</button>
                                        </div>
                                    </td>
                                </tr>
                                <% }); %>
                                <% if (queue.length === 0) { %>
                                <tr><td colspan="8" class="text-center text-gray-400 py-6">No open entries</td></tr>
                                <% } %>
                            </tbody>
                        </table>
```

Note: `entry.similarity` bleibt in der DB erhalten (Rückwärtskompatibilität, Task 3), wird aber in dieser Tabelle nicht mehr angezeigt — die beiden granularen Spalten sind informativer und decken denselben Wert ab (`similarity` ist ohnehin `max(trigram, embedding)`).

- [ ] **Step 2: Manuelle Verifikation**

Run: `npm run dev`, einloggen, `/review` öffnen.
Expected: Tabelle rendert ohne Fehler mit den neuen Spalten „Trigram" und „Embedding"; für Alteinträge (vor Phase 4 angelegt) zeigen beide `-`; bei leerer Queue erstreckt sich die „No open entries"-Zeile über alle 8 Spalten ohne visuellen Bruch.

- [ ] **Step 3: Commit**

```bash
git add views/review.ejs
git commit -m "feat: show trigram/embedding similarity columns in review table"
```

---

### Task 10: `scripts/tune-thresholds.js` — Embedding-Messlauf

Erweitert das bestehende Skript um denselben Precision/Recall-Sweep, diesmal über Embedding-Ähnlichkeit statt Trigram — gegen dieselbe gelabelte Fixture aus Phase 2. Läuft nur, wenn Ollama mit dem konfigurierten Modell erreichbar ist; sonst wird der Embedding-Teil übersprungen und nur die bestehende Trigram-Auswertung ausgegeben (kein harter Fehler, das Skript bleibt ohne laufendes Ollama benutzbar).

**Files:**
- Modify: `scripts/tune-thresholds.js`

Kein `node:test` (manuelles Betriebsskript gegen echtes Ollama, wie in Phase 2 bereits etabliert — `data/eval/entity-labels.json` liegt außerhalb des Repos und enthält reale Bestandsnamen).

- [ ] **Step 1: Embedding-Sweep ergänzen**

In `scripts/tune-thresholds.js`, add the require and a new async evaluation function near the top (after the existing requires):

```js
const entityEmbeddingService = require('../services/entityEmbeddingService');
```

Add a new function, directly after `evaluateThreshold`:

```js
async function evaluateEmbeddingThresholds(pairs) {
  const uniqueTexts = [...new Set(pairs.flatMap(p => [p.a, p.b]))];
  const vectors = new Map();

  for (const text of uniqueTexts) {
    try {
      vectors.set(text, await entityEmbeddingService.embed(text));
    } catch (error) {
      console.warn(`[WARNING] Embedding fuer "${text}" fehlgeschlagen, Embedding-Sweep wird uebersprungen:`, error.message);
      return null;
    }
  }

  const pairsWithSim = pairs.map(p => ({
    ...p,
    sim: entityEmbeddingService.cosineSimilarity(vectors.get(p.a), vectors.get(p.b))
  }));

  const results = [];
  for (let i = 1; i <= 19; i++) {
    const threshold = i / 20;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const { sim, label } of pairsWithSim) {
      const predictedSame = sim >= threshold;
      const actualSame = label === 'same';
      if (predictedSame && actualSame) tp++;
      else if (predictedSame && !actualSame) fp++;
      else if (!predictedSame && actualSame) fn++;
      else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    results.push({ threshold, tp, fp, fn, tn, precision, recall });
  }

  return { pairsWithSim, results };
}
```

Modify `main()` to become `async` and call the new function after the existing Trigram output. Replace:

```js
function main() {
  const labels = loadJson('data/eval/entity-labels.json', null);
  if (!labels) {
    console.error('[ERROR] data/eval/entity-labels.json fehlt. Siehe Plan-Dokument Task 11 fuer das Format.');
    process.exit(1);
  }

  const pairs = buildLabeledPairs(labels);
  console.log(`Gelabelte Paare: ${pairs.length} (${pairs.filter(p => p.label === 'same').length} same, ${pairs.filter(p => p.label === 'different').length} different)`);

  const results = [];
  for (let i = 1; i <= 19; i++) {
    const t = i / 20;
    results.push(evaluateThreshold(pairs, t));
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

with:

```js
async function main() {
  const labels = loadJson('data/eval/entity-labels.json', null);
  if (!labels) {
    console.error('[ERROR] data/eval/entity-labels.json fehlt. Siehe Plan-Dokument Task 11 fuer das Format.');
    process.exit(1);
  }

  const pairs = buildLabeledPairs(labels);
  console.log(`Gelabelte Paare: ${pairs.length} (${pairs.filter(p => p.label === 'same').length} same, ${pairs.filter(p => p.label === 'different').length} different)`);

  const results = [];
  for (let i = 1; i <= 19; i++) {
    const t = i / 20;
    results.push(evaluateThreshold(pairs, t));
  }

  console.log('\n=== Trigram-Aehnlichkeit ===');
  console.log('Threshold | Precision | Recall | TP | FP | FN | TN');
  for (const r of results) {
    console.log(
      `${r.threshold.toFixed(2)}      | `
      + `${r.precision === null ? '  n/a  ' : r.precision.toFixed(2).padStart(7)} | `
      + `${r.recall === null ? '  n/a ' : r.recall.toFixed(2).padStart(6)} | `
      + `${String(r.tp).padStart(2)} | ${String(r.fp).padStart(2)} | ${String(r.fn).padStart(2)} | ${String(r.tn).padStart(2)}`
    );
  }

  const worstRecallSamePairs = pairs
    .filter(p => p.label === 'same')
    .map(p => ({ ...p, sim: diceCoefficient(normalizeForType(p.a, p.type), normalizeForType(p.b, p.type)) }))
    .sort((x, y) => x.sim - y.sim)
    .slice(0, 5);

  console.log('\nSchwierigste "same"-Paare (niedrigste Trigram-Aehnlichkeit - Kandidaten fuer die Embeddings-Entscheidung):');
  worstRecallSamePairs.forEach(p => console.log(`  ${p.a} / ${p.b} (${p.type}): ${p.sim.toFixed(3)}`));

  console.log('\n=== Embedding-Aehnlichkeit (Phase 4) ===');
  const embeddingResult = await evaluateEmbeddingThresholds(pairs);
  let embeddingOutput = null;
  if (!embeddingResult) {
    console.log('Ollama/Embedding-Modell nicht erreichbar - Embedding-Sweep uebersprungen. EMBED_AUTO_THRESHOLD/EMBED_JUDGE_MIN bleiben auf den geschaetzten Defaults, bis dieses Skript mit laufendem Ollama erneut ausgefuehrt wird.');
  } else {
    console.log('Threshold | Precision | Recall | TP | FP | FN | TN');
    for (const r of embeddingResult.results) {
      console.log(
        `${r.threshold.toFixed(2)}      | `
        + `${r.precision === null ? '  n/a  ' : r.precision.toFixed(2).padStart(7)} | `
        + `${r.recall === null ? '  n/a ' : r.recall.toFixed(2).padStart(6)} | `
        + `${String(r.tp).padStart(2)} | ${String(r.fp).padStart(2)} | ${String(r.fn).padStart(2)} | ${String(r.tn).padStart(2)}`
      );
    }

    const worstRecallSamePairsEmbedding = embeddingResult.pairsWithSim
      .filter(p => p.label === 'same')
      .sort((x, y) => x.sim - y.sim)
      .slice(0, 5);
    console.log('\nSchwierigste "same"-Paare (niedrigste Embedding-Aehnlichkeit):');
    worstRecallSamePairsEmbedding.forEach(p => console.log(`  ${p.a} / ${p.b} (${p.type}): ${p.sim.toFixed(3)}`));

    embeddingOutput = embeddingResult;
  }

  const outPath = path.join('data', 'eval', `threshold-tuning-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pairs, trigram: results, embedding: embeddingOutput }, null, 2));
  console.log(`\nDetails geschrieben nach ${outPath} (nicht in git).`);
}

main();
```

- [ ] **Step 2: Syntax-Check**

Run: `node --check scripts/tune-thresholds.js`
Expected: kein Output, Exit-Code 0.

- [ ] **Step 3: Manuelle Verifikation (nur mit erreichbarem Ollama + gezogenem `bge-m3` sinnvoll)**

Run: `node scripts/tune-thresholds.js` (setzt `data/eval/entity-labels.json` voraus, siehe Phase 2 Task 11)
Expected: gibt zuerst wie bisher die Trigram-Tabelle aus, danach entweder die Embedding-Tabelle (Ollama erreichbar) oder die Warnmeldung, dass der Embedding-Sweep übersprungen wurde (Ollama/Modell nicht erreichbar) — in beiden Fällen kein Absturz.

- [ ] **Step 4: Commit**

```bash
git add scripts/tune-thresholds.js
git commit -m "$(cat <<'EOF'
feat: extend tune-thresholds.js with an embedding sweep

Same labeled fixture as the existing trigram sweep, now also
measuring cosine-similarity precision/recall so
EMBED_AUTO_THRESHOLD/EMBED_JUDGE_MIN can be set from measurement
instead of the estimated code defaults, mirroring how the trigram
thresholds were derived in Phase 2. Skips gracefully (warns, keeps
the trigram output) when Ollama or the embedding model isn't
reachable.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Vollständige Verifikation

**Files:** keine (Verifikation, kein Code)

- [ ] **Step 1: Vollständige Testsuite**

Run: `npm test`
Expected: PASS, jeder Test in `test/*.test.js` grün, inklusive aller in Task 1–10 hinzugefügten und geänderten Tests.

- [ ] **Step 2: Manueller Smoke-Test bei deaktiviertem Embedding-Kanal (Default)**

Run: `npm run dev`, Server startet ohne Fehler (Standardkonfiguration, `EMBEDDING_SIMILARITY_ENABLED` nicht gesetzt).
Expected: kein Unterschied zum Phase-3-Verhalten spürbar — `/review` lädt, zeigt in den neuen Spalten `-`/`-` für Alteinträge.

- [ ] **Step 3: Betriebshinweis für die spätere Aktivierung dokumentieren**

Kein Code-Task — Erinnerung für den nächsten Schritt außerhalb dieses Plans: vor `EMBEDDING_SIMILARITY_ENABLED=yes` in `data/.env` muss auf der Ollama-VM `ollama pull bge-m3` gelaufen sein, danach `scripts/tune-thresholds.js` (Task 10) für gemessene statt geschätzte `EMBED_AUTO_THRESHOLD`/`EMBED_JUDGE_MIN`-Werte laufen lassen — exakt der Ablauf, den Phase 2 für die Trigram-Schwellwerte etabliert hat.

- [ ] **Step 4: Kein Commit** (reine Verifikation — falls Step 1 oder 2 etwas findet, zurück zur betroffenen Task, fixen, dort committen)
