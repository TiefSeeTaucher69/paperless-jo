# Phase 5 — Dokument-Fingerprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeat-classification instability (measured 2026-08-02: 4/10 documents unstable even with Phase 1–4 active) by recognizing recurring documents from the same correspondent via content-embedding similarity, and reusing their already-confirmed tags/document type instead of trusting a fresh, possibly inconsistent LLM guess.

**Architecture:** After the existing entity-resolver-based ID resolution in `buildUpdateData` (so `updateData.correspondent` is already a canonical Paperless ID), a new `DocumentFingerprintService` embeds the document's text (reusing the Phase 4 `entityEmbeddingService`/`bge-m3` infrastructure) and compares it against previously processed documents from the *same correspondent*, stored in a new `document_fingerprints` table in `data/entities.db`. Above a similarity threshold, the historical `tags`/`document_type` are copied onto `updateData`; title and date always stay the freshly extracted values.

**Tech Stack:** Node.js, `better-sqlite3` (existing `data/entities.db`), Ollama `/api/embed` via the existing `entityEmbeddingService`, `node:test`.

## Global Constraints

- Additive only: `DOCUMENT_FINGERPRINT_ENABLED` defaults to `'no'` — with no env change, behavior must be byte-for-byte identical to the current Phase 4 state.
- `FINGERPRINT_SIMILARITY_THRESHOLD` defaults to `0.90` (unmeasured placeholder, per design doc's "Offener Folgeschritt") — do not tune it as part of this plan.
- No LLM-judge stage, no review queue for fingerprint matches — a match is applied silently. Every match must be logged (correspondent id, similarity, matched document id) so it is auditable after the fact.
- Never call `paperlessService` or the Ollama classification endpoint from a unit test — all tests use fakes/in-memory stores, exactly like `test/entityResolver.test.js` and `test/entityBackfillService.test.js`.
- Respect the existing `config.limitFunctions.activateTagging`/`activateDocumentType` switches — a fingerprint match must never re-enable a field the user explicitly turned off.
- Follow the existing code style in this repo: `console.warn`/`console.error` with a `[WARNING]`/`[ERROR]` prefix and the throwing method's name, never let a fingerprint failure abort document processing.

---

### Task 1: `DocumentFingerprintStore`

**Files:**
- Create: `models/documentFingerprintStore.js`
- Test: `test/documentFingerprintStore.test.js`

**Interfaces:**
- Consumes: `better-sqlite3` (`Database`), Node's `path`/`fs` — same as `models/entityStore.js`.
- Produces: `class DocumentFingerprintStore` with `constructor(dbPath)`, `findCandidates(correspondentId) -> Array<{documentId, correspondentId, documentTypeId, tagIds, embedding}>`, `upsertFingerprint({documentId, correspondentId, documentTypeId, tagIds, embedding}) -> boolean`, `close()`. Task 2 consumes exactly this shape.

- [ ] **Step 1: Write the failing tests**

Create `test/documentFingerprintStore.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const DocumentFingerprintStore = require('../models/documentFingerprintStore');

test('upsertFingerprint speichert, findCandidates liefert ihn fuer denselben Korrespondenten zurueck', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({
      documentId: 101, correspondentId: 5, documentTypeId: 3,
      tagIds: [1, 2], embedding: [1, 0, 0]
    });

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentId, 101);
    assert.strictEqual(candidates[0].correspondentId, 5);
    assert.strictEqual(candidates[0].documentTypeId, 3);
    assert.deepStrictEqual(candidates[0].tagIds, [1, 2]);
    assert.deepStrictEqual(candidates[0].embedding, [1, 0, 0]);
  } finally {
    store.close();
  }
});

test('findCandidates liefert leeres Array fuer Korrespondenten ohne gespeicherten Fingerprint', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    assert.deepStrictEqual(store.findCandidates(999), []);
  } finally {
    store.close();
  }
});

test('findCandidates filtert nach correspondent_id, liefert nicht die Fingerprints anderer Korrespondenten', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0] });
    store.upsertFingerprint({ documentId: 2, correspondentId: 6, documentTypeId: 1, tagIds: [1], embedding: [1, 0] });

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentId, 1);
  } finally {
    store.close();
  }
});

test('upsertFingerprint bei gleicher document_id ersetzt statt zu duplizieren', () => {
  const store = new DocumentFingerprintStore(':memory:');
  try {
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0] });
    store.upsertFingerprint({ documentId: 1, correspondentId: 5, documentTypeId: 2, tagIds: [9], embedding: [0, 1] });

    const candidates = store.findCandidates(5);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].documentTypeId, 2);
    assert.deepStrictEqual(candidates[0].tagIds, [9]);
    assert.deepStrictEqual(candidates[0].embedding, [0, 1]);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/documentFingerprintStore.test.js`
Expected: FAIL with `Cannot find module '../models/documentFingerprintStore'`

- [ ] **Step 3: Write the implementation**

Create `models/documentFingerprintStore.js`:

```js
// models/documentFingerprintStore.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DocumentFingerprintStore {
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
      CREATE TABLE IF NOT EXISTS document_fingerprints (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL UNIQUE,
        correspondent_id INTEGER NOT NULL,
        document_type_id INTEGER,
        tag_ids TEXT NOT NULL,
        content_embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_document_fingerprints_correspondent
      ON document_fingerprints(correspondent_id)
    `).run();
  }

  findCandidates(correspondentId) {
    try {
      const rows = this.db.prepare(
        `SELECT * FROM document_fingerprints WHERE correspondent_id = ?`
      ).all(correspondentId);
      return rows.map(row => ({
        documentId: row.document_id,
        correspondentId: row.correspondent_id,
        documentTypeId: row.document_type_id,
        tagIds: JSON.parse(row.tag_ids),
        embedding: this._bufferToVector(row.content_embedding)
      }));
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.findCandidates:', error.message);
      return [];
    }
  }

  upsertFingerprint({ documentId, correspondentId, documentTypeId, tagIds, embedding }) {
    try {
      this.db.prepare(`
        INSERT INTO document_fingerprints (document_id, correspondent_id, document_type_id, tag_ids, content_embedding, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          correspondent_id = excluded.correspondent_id,
          document_type_id = excluded.document_type_id,
          tag_ids = excluded.tag_ids,
          content_embedding = excluded.content_embedding,
          created_at = excluded.created_at
      `).run(
        documentId, correspondentId, documentTypeId ?? null,
        JSON.stringify(tagIds), this._vectorToBuffer(embedding), new Date().toISOString()
      );
      return true;
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.upsertFingerprint:', error.message);
      return false;
    }
  }

  _vectorToBuffer(vector) {
    return Buffer.from(Float32Array.from(vector).buffer);
  }

  _bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }

  close() {
    try {
      this.db.close();
    } catch (error) {
      console.error('[ERROR] documentFingerprintStore.close:', error.message);
    }
  }
}

module.exports = DocumentFingerprintStore;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/documentFingerprintStore.test.js`
Expected: PASS, 4/4 tests green

- [ ] **Step 5: Commit**

```bash
git add models/documentFingerprintStore.js test/documentFingerprintStore.test.js
git commit -m "feat: add DocumentFingerprintStore for Phase 5 recurring-document detection"
```

---

### Task 2: `DocumentFingerprintService`

**Files:**
- Create: `services/documentFingerprintService.js`
- Test: `test/documentFingerprintService.test.js`

**Interfaces:**
- Consumes: a store matching Task 1's shape (`findCandidates`, `upsertFingerprint`); an embedding service matching `services/entityEmbeddingService.js`'s shape (`embed(text) -> Promise<number[]>`, `cosineSimilarity(a, b) -> number`).
- Produces: `class DocumentFingerprintService` with `constructor({ store, embeddingService, similarityThreshold })`, `async findMatch(correspondentId, content) -> Promise<{tagIds, documentTypeId} | null>`, `async recordFingerprint({documentId, correspondentId, documentTypeId, tagIds, content}) -> Promise<void>`. Task 4 consumes exactly this shape.

- [ ] **Step 1: Write the failing tests**

Create `test/documentFingerprintService.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const DocumentFingerprintService = require('../services/documentFingerprintService');

function fakeEmbeddingService(vectorsByText) {
  return {
    embed: async (text) => {
      if (!(text in vectorsByText)) throw new Error(`kein Test-Vektor fuer "${text}" hinterlegt`);
      return vectorsByText[text];
    },
    cosineSimilarity: (a, b) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
  };
}

function fakeStore(candidates = []) {
  const upserts = [];
  return {
    findCandidates: () => candidates,
    upsertFingerprint: (args) => { upserts.push(args); return true; },
    upserts
  };
}

test('findMatch: keine Kandidaten -> null', async () => {
  const store = fakeStore([]);
  const embeddingService = fakeEmbeddingService({});
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  const result = await service.findMatch(5, 'Inhalt egal');
  assert.strictEqual(result, null);
});

test('findMatch: Kandidat ueber Schwelle -> tagIds/documentTypeId des Kandidaten', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0] }
  ]);
  const embeddingService = fakeEmbeddingService({ 'Gehaltsabrechnung Juli': [1, 0] }); // Cosine = 1
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  const result = await service.findMatch(5, 'Gehaltsabrechnung Juli');
  assert.deepStrictEqual(result, { tagIds: [1, 2], documentTypeId: 3 });
});

test('findMatch: Kandidat unter Schwelle -> null', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0] }
  ]);
  const embeddingService = fakeEmbeddingService({ 'Voellig anderer Inhalt': [0, 1] }); // Cosine = 0
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  const result = await service.findMatch(5, 'Voellig anderer Inhalt');
  assert.strictEqual(result, null);
});

test('findMatch: mehrere Kandidaten, aehnlichster gewinnt', async () => {
  const store = fakeStore([
    { documentId: 1, correspondentId: 5, documentTypeId: 1, tagIds: [1], embedding: [1, 0] },
    { documentId: 2, correspondentId: 5, documentTypeId: 2, tagIds: [2], embedding: [0.99, 0.14] }
  ]);
  const embeddingService = fakeEmbeddingService({ 'Text': [0.99, 0.14] });
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  const result = await service.findMatch(5, 'Text');
  assert.deepStrictEqual(result, { tagIds: [2], documentTypeId: 2 });
});

test('findMatch: Embedding-Fehler -> null, kein Absturz', async () => {
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0] }
  ]);
  const embeddingService = {
    embed: async () => { throw new Error('ECONNREFUSED'); },
    cosineSimilarity: () => { throw new Error('sollte nicht erreicht werden'); }
  };
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  const result = await service.findMatch(5, 'Text');
  assert.strictEqual(result, null);
});

test('findMatch: Text wird vor dem Embedding-Call auf 3000 Zeichen gekuerzt', async () => {
  const longContent = 'A'.repeat(5000);
  const truncated = 'A'.repeat(3000);
  const store = fakeStore([
    { documentId: 101, correspondentId: 5, documentTypeId: 3, tagIds: [1], embedding: [1, 0] }
  ]);
  const embeddingService = fakeEmbeddingService({ [truncated]: [1, 0] });
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  const result = await service.findMatch(5, longContent);
  assert.deepStrictEqual(result, { tagIds: [1], documentTypeId: 3 });
});

test('recordFingerprint: berechnet Embedding und speichert ueber den Store', async () => {
  const store = fakeStore([]);
  const embeddingService = fakeEmbeddingService({ 'Neuer Inhalt': [1, 0] });
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  await service.recordFingerprint({
    documentId: 55, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], content: 'Neuer Inhalt'
  });

  assert.strictEqual(store.upserts.length, 1);
  assert.deepStrictEqual(store.upserts[0], {
    documentId: 55, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], embedding: [1, 0]
  });
});

test('recordFingerprint: Embedding-Fehler -> kein Absturz, kein Store-Write', async () => {
  const store = fakeStore([]);
  const embeddingService = {
    embed: async () => { throw new Error('ECONNREFUSED'); }
  };
  const service = new DocumentFingerprintService({ store, embeddingService, similarityThreshold: 0.90 });

  await service.recordFingerprint({
    documentId: 55, correspondentId: 5, documentTypeId: 3, tagIds: [1, 2], content: 'Text'
  });

  assert.strictEqual(store.upserts.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/documentFingerprintService.test.js`
Expected: FAIL with `Cannot find module '../services/documentFingerprintService'`

- [ ] **Step 3: Write the implementation**

Create `services/documentFingerprintService.js`:

```js
// services/documentFingerprintService.js

// Nur ein struktureller Fingerabdruck noetig, kein vollstaendiges Verstaendnis -
// deutlich kuerzer als die 50000 Zeichen vor dem eigentlichen LLM-Klassifikationscall.
const FINGERPRINT_CONTENT_CHARS = 3000;

function truncate(content) {
  return (content || '').slice(0, FINGERPRINT_CONTENT_CHARS);
}

class DocumentFingerprintService {
  constructor({ store, embeddingService, similarityThreshold = 0.90 }) {
    this.store = store;
    this.embeddingService = embeddingService;
    this.similarityThreshold = similarityThreshold;
  }

  async findMatch(correspondentId, content) {
    const candidates = this.store.findCandidates(correspondentId);
    if (candidates.length === 0) {
      return null;
    }

    let vector;
    try {
      vector = await this.embeddingService.embed(truncate(content));
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Embedding fehlgeschlagen, kein Treffer:', error.message);
      return null;
    }

    let best = null;
    for (const candidate of candidates) {
      const similarity = this.embeddingService.cosineSimilarity(vector, candidate.embedding);
      if (Number.isFinite(similarity) && (!best || similarity > best.similarity)) {
        best = { similarity, candidate };
      }
    }

    if (!best || best.similarity < this.similarityThreshold) {
      return null;
    }

    console.log(`[INFO] documentFingerprintService: Treffer fuer correspondent=${correspondentId}, similarity=${best.similarity.toFixed(3)}, document_id=${best.candidate.documentId}`);
    return { tagIds: best.candidate.tagIds, documentTypeId: best.candidate.documentTypeId };
  }

  async recordFingerprint({ documentId, correspondentId, documentTypeId, tagIds, content }) {
    try {
      const vector = await this.embeddingService.embed(truncate(content));
      this.store.upsertFingerprint({ documentId, correspondentId, documentTypeId, tagIds, embedding: vector });
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Fingerprint konnte nicht gespeichert werden:', error.message);
    }
  }
}

module.exports = DocumentFingerprintService;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/documentFingerprintService.test.js`
Expected: PASS, 8/8 tests green

- [ ] **Step 5: Commit**

```bash
git add services/documentFingerprintService.js test/documentFingerprintService.test.js
git commit -m "feat: add DocumentFingerprintService for recurring-document tag/doctype reuse"
```

---

### Task 3: Config wiring

**Files:**
- Modify: `config/config.js`
- Test: `test/configDocumentFingerprint.test.js`

**Interfaces:**
- Consumes: existing `clampThreshold`, `parseEnvNumber`, `parseEnvBoolean` helpers already defined in `config/config.js` (used identically for `config.embedding`).
- Produces: `config.documentFingerprint.enabled` (boolean), `config.documentFingerprint.similarityThreshold` (number). Task 4 consumes exactly these two fields.

- [ ] **Step 1: Write the failing tests**

Create `test/configDocumentFingerprint.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('documentFingerprint-Block hat sichere Defaults', () => {
  const saved = {
    enabled: process.env.DOCUMENT_FINGERPRINT_ENABLED,
    threshold: process.env.FINGERPRINT_SIMILARITY_THRESHOLD
  };
  try {
    process.env.DOCUMENT_FINGERPRINT_ENABLED = '';
    process.env.FINGERPRINT_SIMILARITY_THRESHOLD = '';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.documentFingerprint.enabled, false);
    assert.strictEqual(config.documentFingerprint.similarityThreshold, 0.90);
  } finally {
    for (const [key, value] of Object.entries({
      DOCUMENT_FINGERPRINT_ENABLED: saved.enabled,
      FINGERPRINT_SIMILARITY_THRESHOLD: saved.threshold
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../config/config')];
  }
});

test('DOCUMENT_FINGERPRINT_ENABLED=yes aktiviert das Feature', () => {
  const saved = process.env.DOCUMENT_FINGERPRINT_ENABLED;
  try {
    process.env.DOCUMENT_FINGERPRINT_ENABLED = 'yes';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.documentFingerprint.enabled, true);
  } finally {
    if (saved === undefined) delete process.env.DOCUMENT_FINGERPRINT_ENABLED;
    else process.env.DOCUMENT_FINGERPRINT_ENABLED = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('FINGERPRINT_SIMILARITY_THRESHOLD ausserhalb [0,1] wird geklemmt und warnt', () => {
  const saved = process.env.FINGERPRINT_SIMILARITY_THRESHOLD;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.FINGERPRINT_SIMILARITY_THRESHOLD = '1.4';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');

    assert.strictEqual(config.documentFingerprint.similarityThreshold, 1);
    assert.ok(warnMessages.some(msg => msg.includes('FINGERPRINT_SIMILARITY_THRESHOLD')));
  } finally {
    console.warn = savedWarn;
    if (saved === undefined) delete process.env.FINGERPRINT_SIMILARITY_THRESHOLD;
    else process.env.FINGERPRINT_SIMILARITY_THRESHOLD = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/configDocumentFingerprint.test.js`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'enabled')`

- [ ] **Step 3: Write the implementation**

In `config/config.js`, immediately after the existing `embeddingJudgeMin` block (the block ending with the `if (embeddingJudgeMin > embeddingAutoThreshold)` warning, right before the `embeddingExcludedTypes` block added for the tag-exclusion fix), add:

```js
// Unmeasured placeholder (siehe Design-Doc "Offener Folgeschritt") - braucht eine eigene
// Tuning-Messung mit gelabelten Dokumentpaaren, bevor der Kanal produktiv scharf geschaltet wird.
const documentFingerprintSimilarityThreshold = clampThreshold(
  parseEnvNumber(process.env.FINGERPRINT_SIMILARITY_THRESHOLD, 0.90),
  'FINGERPRINT_SIMILARITY_THRESHOLD'
);
```

Then, in the exported config object, immediately after the existing `embedding: { ... }` block, add:

```js
  documentFingerprint: {
    enabled: parseEnvBoolean(process.env.DOCUMENT_FINGERPRINT_ENABLED, 'no') === 'yes',
    similarityThreshold: documentFingerprintSimilarityThreshold
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/configDocumentFingerprint.test.js`
Expected: PASS, 3/3 tests green

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests pass (198 previously + 4 + 8 + 3 new = 213), no failures

- [ ] **Step 6: Commit**

```bash
git add config/config.js test/configDocumentFingerprint.test.js
git commit -m "feat: add documentFingerprint config block, default disabled"
```

---

### Task 4: Wire the fingerprint check into `server.js`

**Files:**
- Modify: `server.js:38` (module-level state), `server.js:221` (`processDocument` return value), `server.js:378-380` (`scanInitial` loop body), `server.js:420-422` (`scanDocuments` loop body)

**Interfaces:**
- Consumes: `DocumentFingerprintStore` (Task 1), `DocumentFingerprintService` (Task 2), `config.documentFingerprint`/`config.entityResolver.dbPath` (Task 3, existing), `services/entityEmbeddingService.js` (existing, Phase 4).
- Produces: no new exports — this task only changes `server.js` control flow. No new automated test (see rationale below); verified by the full suite staying green and a manual read-through.

This task has no isolated unit to TDD (`server.js` has no existing test file, and the design doc explicitly puts all decision logic in `DocumentFingerprintService`, already covered by Task 2's tests) — it is pure wiring. Follow the steps exactly; the "test" here is the regression run in Step 4.

- [ ] **Step 1: Add the lazy service getter**

In `server.js`, immediately after the existing `let runningTask = false;` (line 38), add:

```js
let documentFingerprintServiceInstance = null;

// Lazy statt Modul-Top-Level: verhindert, dass jeder Server-Boot data/entities.db
// oeffnet, auch wenn DOCUMENT_FINGERPRINT_ENABLED=no (dieselbe Begruendung wie
// paperlessService.js#_getEntityResolver und routes/review.js#getServices).
function getDocumentFingerprintService() {
  if (!documentFingerprintServiceInstance) {
    const DocumentFingerprintStore = require('./models/documentFingerprintStore');
    const DocumentFingerprintService = require('./services/documentFingerprintService');
    const entityEmbeddingService = require('./services/entityEmbeddingService');

    const store = new DocumentFingerprintStore(config.entityResolver.dbPath);
    documentFingerprintServiceInstance = new DocumentFingerprintService({
      store,
      embeddingService: entityEmbeddingService,
      similarityThreshold: config.documentFingerprint.similarityThreshold
    });
  }
  return documentFingerprintServiceInstance;
}

async function applyDocumentFingerprint(doc, updateData, content) {
  if (!config.documentFingerprint.enabled || !updateData.correspondent) {
    return;
  }
  const match = await getDocumentFingerprintService().findMatch(updateData.correspondent, content);
  if (!match) {
    return;
  }
  // Respektiert dieselben Aktivierungs-Schalter wie buildUpdateData selbst - ein per
  // activateTagging='no'/activateDocumentType='no' abgeschaltetes Feld darf der
  // Fingerprint nicht wieder anschalten.
  if (config.limitFunctions?.activateTagging !== 'no') {
    updateData.tags = match.tagIds;
  }
  if (config.limitFunctions?.activateDocumentType !== 'no' && match.documentTypeId) {
    updateData.document_type = match.documentTypeId;
  }
}

async function recordDocumentFingerprint(doc, updateData, content) {
  if (!config.documentFingerprint.enabled || !updateData.correspondent) {
    return;
  }
  await getDocumentFingerprintService().recordFingerprint({
    documentId: doc.id,
    correspondentId: updateData.correspondent,
    documentTypeId: updateData.document_type ?? null,
    tagIds: updateData.tags ?? [],
    content
  });
}
```

- [ ] **Step 2: Thread `content` out of `processDocument`**

In `server.js`, change the return statement at the end of `processDocument` (currently around line 221):

```js
  return { analysis, originalData };
```

to:

```js
  return { analysis, originalData, content };
```

- [ ] **Step 3: Hook both call sites**

In `scanInitial` (currently around lines 378-380):

```js
        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
```

becomes:

```js
        const { analysis, originalData, content } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await applyDocumentFingerprint(doc, updateData, content);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
        await recordDocumentFingerprint(doc, updateData, content);
```

In `scanDocuments` (currently around lines 420-422):

```js
        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
```

becomes:

```js
        const { analysis, originalData, content } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await applyDocumentFingerprint(doc, updateData, content);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
        await recordDocumentFingerprint(doc, updateData, content);
```

- [ ] **Step 4: Run the full suite to check for regressions**

Run: `npm test`
Expected: all 213 tests still pass (no test exercises `server.js` directly, so this confirms nothing else broke — e.g. a typo in the edited files would fail `require()` at test-load time for any test file that transitively requires `config/config.js`)

- [ ] **Step 5: Confirm the feature is inert by default**

Run: `node -e "const config = require('./config/config'); console.log(config.documentFingerprint);"`
Expected output: `{ enabled: false, similarityThreshold: 0.9 }` — confirms that without any `data/.env` change, the new code paths in `server.js` are unreachable (`applyDocumentFingerprint`/`recordDocumentFingerprint` both return immediately on `!config.documentFingerprint.enabled`).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: wire DocumentFingerprintService into the document processing loop"
```

---

## Acceptance Criteria

- `npm test` passes in full (213/213).
- With no `data/.env` change, `config.documentFingerprint.enabled === false` and the application behaves identically to the pre-Phase-5 state (Step 5 of Task 4 is the check for this).
- `DOCUMENT_FINGERPRINT_ENABLED` and `FINGERPRINT_SIMILARITY_THRESHOLD` are **not** set in the real `data/.env` as part of this plan — activation is a deliberate follow-up decision after the threshold-tuning measurement described in the design doc's "Offener Folgeschritt", exactly like `ENTITY_RESOLVER_ENABLED` in Phase 2 and `EMBEDDING_SIMILARITY_ENABLED` in Phase 4 before their respective tuning runs.
