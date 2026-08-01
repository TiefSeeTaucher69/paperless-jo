# Phase 3 — Review-UI, Merge, Altbestand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator a way to see, resolve, and bulk-check the EntityResolver's review queue: a review page to merge or reject open duplicate candidates, a `mergeEntity` operation that safely reassigns and deletes duplicate tags/correspondents/document types in Paperless, and a manual backfill pass that scans the existing entity bestand for undetected duplicates.

**Architecture:** Two new focused service modules (`reviewQueueService.js` for single-entry merge/reject lifecycle, `entityBackfillService.js` for pairwise bestand scanning) sit between a thin Express route (`routes/review.js`) and the existing `EntityStore`/`paperlessService`. `paperlessService` gains one new capability, `mergeEntity`, built on its existing Axios client. No new dependencies, no schema changes — every new column and parameter already exists from Phase 2, just unwired.

**Tech Stack:** Node.js, Express, EJS (server-rendered, no client framework), better-sqlite3 (via existing `EntityStore`), `node:test` + `node:assert` (existing test runner, no new test library), vanilla JS + `fetch` on the client (matching `public/js/history.js`).

## Global Constraints

- No new npm dependencies — `axios`, `better-sqlite3`, `jsonwebtoken`, `express` are already present (`package.json:33-55`).
- No SQL schema changes — `entity_review_queue` and `entity_aliases` (`models/entityStore.js:24-56`) already have every column this phase needs.
- Merge is irreversible once it deletes — every task touching it must preserve the existing behavior: verify zero remaining references before `DELETE`, never delete otherwise.
- `dryRun` defaults to `true` in every programmatic call to `mergeEntity`; only an explicit second UI confirmation may pass `dryRun: false`.
- Auth: page routes use `isAuthenticated` (redirect to `/login`), API/action routes use `authenticateJWT` (403/401 JSON) — both already exported from `routes/auth.js:53`, reused as-is, not duplicated.
- Follow existing test convention exactly: flat files in `test/*.test.js`, `require('node:test')`/`require('node:assert')`, no `beforeEach`/`afterEach`, state-mutating tests wrap cleanup in `try/finally` (see `test/entityResolverHookIn.test.js`).
- German inline comments only where the *why* isn't obvious from the code, matching the existing codebase's comment density (sparse, mostly none).

---

### Task 1: EntityStore — Queue read/update methods

**Files:**
- Modify: `models/entityStore.js` (add 4 methods after `insertQueueEntry`, currently ending at `models/entityStore.js:140`, before `close()` at `models/entityStore.js:142`)
- Test: `test/entityStore.test.js` (append after existing tests)

**Interfaces:**
- Consumes: existing `this.db` (better-sqlite3 handle, set in constructor `models/entityStore.js:19`), existing `entity_review_queue` schema (`models/entityStore.js:37-56`).
- Produces: `listOpenQueueEntries(): Array<Row>`, `getQueueEntryById(id: number): Row|null`, `updateQueueStatus(id: number, status: string): boolean`, `countOpenQueueEntries(): number` — consumed by `services/reviewQueueService.js` (Task 4) and `services/paperlessService.js` (Task 8, dashboard count).

- [ ] **Step 1: Write the failing tests**

Append to `test/entityStore.test.js`:

```js
test('listOpenQueueEntries liefert nur offene Eintraege, sortiert nach created_at', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: null });
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Mahnung', proposedId: 3, candidateName: 'Mahnungen', candidateId: 4, similarity: 0.75, llmVerdict: null, llmReason: null, status: 'rejected', documentId: null });

  const open = store.listOpenQueueEntries();

  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].proposed_name, 'Rechnung');
});

test('getQueueEntryById liefert den Eintrag inklusive document_id, oder null', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: 42 });
  const entry = store.listOpenQueueEntries()[0];

  const fetched = store.getQueueEntryById(entry.id);
  assert.strictEqual(fetched.document_id, 42);
  assert.strictEqual(store.getQueueEntryById(999999), null);
});

test('updateQueueStatus setzt status und resolved_at, liefert true bei Treffer', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: null });
  const entry = store.listOpenQueueEntries()[0];

  const updated = store.updateQueueStatus(entry.id, 'merged');

  assert.strictEqual(updated, true);
  const fetched = store.getQueueEntryById(entry.id);
  assert.strictEqual(fetched.status, 'merged');
  assert.ok(fetched.resolved_at);
});

test('updateQueueStatus liefert false, wenn die id nicht existiert', () => {
  const store = freshStore();
  assert.strictEqual(store.updateQueueStatus(999999, 'merged'), false);
});

test('countOpenQueueEntries zaehlt nur offene Eintraege', () => {
  const store = freshStore();
  assert.strictEqual(store.countOpenQueueEntries(), 0);
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Rechnung', proposedId: 1, candidateName: 'Rechnungen', candidateId: 2, similarity: 0.8, llmVerdict: null, llmReason: null, status: 'open', documentId: null });
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'Mahnung', proposedId: 3, candidateName: 'Mahnungen', candidateId: 4, similarity: 0.75, llmVerdict: null, llmReason: null, status: 'rejected', documentId: null });
  assert.strictEqual(store.countOpenQueueEntries(), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/entityStore.test.js`
Expected: FAIL — `store.listOpenQueueEntries is not a function` (and similarly for the other three).

- [ ] **Step 3: Implement the four methods**

Insert into `models/entityStore.js`, directly after `insertQueueEntry` ends (after the closing `}` that follows the `catch` block at what is currently line 140) and before `close()`:

```js
  listOpenQueueEntries() {
    try {
      return this.db.prepare(`
        SELECT * FROM entity_review_queue WHERE status = 'open' ORDER BY created_at ASC
      `).all();
    } catch (error) {
      console.error('[ERROR] entityStore.listOpenQueueEntries:', error.message);
      return [];
    }
  }

  getQueueEntryById(id) {
    try {
      return this.db.prepare(`SELECT * FROM entity_review_queue WHERE id = ?`).get(id) || null;
    } catch (error) {
      console.error('[ERROR] entityStore.getQueueEntryById:', error.message);
      return null;
    }
  }

  updateQueueStatus(id, status) {
    try {
      const result = this.db.prepare(`
        UPDATE entity_review_queue SET status = ?, resolved_at = ? WHERE id = ?
      `).run(status, new Date().toISOString(), id);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] entityStore.updateQueueStatus:', error.message);
      return false;
    }
  }

  countOpenQueueEntries() {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) as count FROM entity_review_queue WHERE status = 'open'`).get();
      return row.count;
    } catch (error) {
      console.error('[ERROR] entityStore.countOpenQueueEntries:', error.message);
      return 0;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/entityStore.test.js`
Expected: PASS, all tests including the 5 new ones green.

- [ ] **Step 5: Commit**

```bash
git add models/entityStore.js test/entityStore.test.js
git commit -m "feat: add queue read/update methods to EntityStore"
```

---

### Task 2: `documentId` durchreichen

**Files:**
- Modify: `services/paperlessService.js:191-200` (`_recordEntityQueue`), `services/paperlessService.js:399` (`processTags`, call site `:468`), `services/paperlessService.js:1123` (`getOrCreateCorrespondent`, call sites `:1172`, `:1191`), `services/paperlessService.js:1239` (`getOrCreateDocumentType`, call sites `:1277`, `:1296`)
- Modify: `server.js:223-329` (`buildUpdateData`)
- Modify: `routes/setup.js:1613-1662` (`buildUpdateData`, the second/duplicate copy)
- Test: `test/entityResolverHookIn.test.js` (append)

**Interfaces:**
- Consumes: existing `options` parameters already present on `processTags`/`getOrCreateCorrespondent`; existing `documentId` parameter already accepted (but never populated) by `entityResolver.recordCreatedAndQueued` (`services/entityResolver.js:131`) and `entityStore.insertQueueEntry` (`models/entityStore.js:113`).
- Produces: every `entity_review_queue` row created from the live classification path now has a non-null `document_id` when the document ID was known at call time — relied on by Task 6 (`routes/review.js`) to build the "link to triggering document".

- [ ] **Step 1: Write the failing test**

Append to `test/entityResolverHookIn.test.js`:

```js
test('processTags reicht options.documentId bis in die Review-Queue durch', async () => {
  const originalInstance = paperlessService._entityResolverInstance;
  const store = new EntityStore(':memory:');

  try {
    config.entityResolver.enabled = true;
    paperlessService._entityResolverInstance = new EntityResolver({
      store,
      judge: async () => ({ verdict: 'unsure', reason: 'Testfall erzwingt unsure' }),
      config: { autoThreshold: 1.1, judgeMin: 0 }
    });

    paperlessService.findExistingTag = async () => null;
    paperlessService.createTagSafely = async (name) => ({ id: 777, name });
    paperlessService.ensureTagCache = async () => {};
    paperlessService.tagCache.clear();
    paperlessService.tagCache.set('vollkommen anderer tag', { id: 601, name: 'Vollkommen Anderer Tag' });

    await paperlessService.processTags(['Testtag Fuer DocumentId'], { documentId: 4321 });

    const row = store.db.prepare(
      `SELECT * FROM entity_review_queue WHERE entity_type = ? AND proposed_name = ?`
    ).get('tag', 'Testtag Fuer DocumentId');

    assert.ok(row, 'Es sollte eine Zeile in entity_review_queue geschrieben worden sein');
    assert.strictEqual(row.document_id, 4321);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = originalInstance;
    paperlessService.tagCache.clear();
    store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/entityResolverHookIn.test.js`
Expected: FAIL — `row.document_id` is `null`, not `4321` (assertion fails).

- [ ] **Step 3: Thread `documentId` through `paperlessService.js`**

Change `_recordEntityQueue` (`services/paperlessService.js:191-200`):

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

In `processTags` (`services/paperlessService.js:468`), change:

```js
                this._recordEntityQueue('tag', tagName, tag.id, decision);
```

to:

```js
                this._recordEntityQueue('tag', tagName, tag.id, decision, options.documentId);
```

In `getOrCreateCorrespondent` (`services/paperlessService.js:1172` and `:1191`), change both:

```js
            if (decision.action === 'create_and_queue') {
                this._recordEntityQueue('correspondent', name, createResponse.data.id, decision);
            }
```

and

```js
                    if (decision.action === 'create_and_queue') {
                        this._recordEntityQueue('correspondent', name, justCreatedCorrespondent.id, decision);
                    }
```

to pass `options.documentId` as the fifth argument in each (`getOrCreateCorrespondent` already declares `options = {}` at `services/paperlessService.js:1123`, no signature change needed):

```js
            if (decision.action === 'create_and_queue') {
                this._recordEntityQueue('correspondent', name, createResponse.data.id, decision, options.documentId);
            }
```

```js
                    if (decision.action === 'create_and_queue') {
                        this._recordEntityQueue('correspondent', name, justCreatedCorrespondent.id, decision, options.documentId);
                    }
```

`getOrCreateDocumentType` (`services/paperlessService.js:1239`) has **no** `options` parameter today — add one. Change the signature line:

```js
async getOrCreateDocumentType(name) {
```

to:

```js
async getOrCreateDocumentType(name, options = {}) {
```

and change its two `_recordEntityQueue` calls (`:1277`, `:1296`) the same way as above, passing `options.documentId` as the fifth argument.

- [ ] **Step 4: Thread `documentId` into `options` at both `buildUpdateData` call sites**

In `server.js`, `buildUpdateData` (`server.js:223-329`) currently builds no `options` object at all. Add one at the top and pass it through every relevant call. Change:

```js
async function buildUpdateData(analysis, doc) {
  const updateData = {};

  console.log('TEST: ', config.addAIProcessedTag)
  console.log('TEST 2: ', config.addAIProcessedTags)
  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags);
```

to:

```js
async function buildUpdateData(analysis, doc) {
  const updateData = {};
  const options = { documentId: doc.id };

  console.log('TEST: ', config.addAIProcessedTag)
  console.log('TEST 2: ', config.addAIProcessedTags)
  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags, options);
```

and further down in the same function, change:

```js
    const { tagIds, errors } = await paperlessService.processTags(tags);
```

to:

```js
    const { tagIds, errors } = await paperlessService.processTags(tags, options);
```

and:

```js
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type);
```

to:

```js
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type, options);
```

and:

```js
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent);
```

to:

```js
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent, options);
```

In `routes/setup.js`, `buildUpdateData` (`routes/setup.js:1613-1662`) already builds an `options` object. Change:

```js
  // Create options object with restriction settings
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes' ? true : false,
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes' ? true : false
  };
```

to:

```js
  // Create options object with restriction settings
  const options = {
    restrictToExistingTags: config.restrictToExistingTags === 'yes' ? true : false,
    restrictToExistingCorrespondents: config.restrictToExistingCorrespondents === 'yes' ? true : false,
    documentId: doc.id
  };
```

and change:

```js
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type);
```

to:

```js
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type, options);
```

The two `processTags(..., options)` calls (`routes/setup.js:1626`, `:1636`) and the `getOrCreateCorrespondent(analysis.document.correspondent, options)` call (`routes/setup.js:1710`) already pass `options` — no further change needed at those three call sites; adding `documentId` to the `options` object above is sufficient to reach all of them.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/entityResolverHookIn.test.js`
Expected: PASS, including the new `documentId`-durchreichen test.

- [ ] **Step 6: Commit**

```bash
git add services/paperlessService.js server.js routes/setup.js test/entityResolverHookIn.test.js
git commit -m "feat: thread documentId through to entity_review_queue"
```

---

### Task 3: `paperlessService.mergeEntity`

**Files:**
- Modify: `services/paperlessService.js` (add 3 methods near the end of the class, e.g. after `removeUnusedTagsFromDocument` at `services/paperlessService.js:1309`, before the class closes)
- Test: new `test/paperlessMergeEntity.test.js`

**Interfaces:**
- Consumes: `this.client` (Axios instance, already configured with `baseURL`/token — `services/paperlessService.js:22-32`).
- Produces: `mergeEntity(type: 'tag'|'correspondent'|'document_type', fromId: number, toId: number, { dryRun?: boolean }): Promise<{ affectedCount: number, documentIds: number[], deleted: boolean }>` — consumed by `services/reviewQueueService.js` (Task 4).

- [ ] **Step 1: Write the failing tests**

Create `test/paperlessMergeEntity.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const paperlessService = require('../services/paperlessService');

function withMockClient(mockClient, fn) {
  const original = paperlessService.client;
  paperlessService.client = mockClient;
  return fn().finally(() => { paperlessService.client = original; });
}

test('mergeEntity mit dryRun=true fragt nur ab, schreibt und loescht nichts', async () => {
  const calls = [];
  const mockClient = {
    get: async (url, config) => {
      calls.push({ method: 'get', url, config });
      return { data: { results: [{ id: 10 }, { id: 11 }], next: null } };
    },
    post: async () => { throw new Error('post haette nicht aufgerufen werden duerfen'); },
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.mergeEntity('tag', 5, 6, { dryRun: true })
  );

  assert.deepStrictEqual(result, { affectedCount: 2, documentIds: [10, 11], deleted: false });
  assert.strictEqual(calls.filter(c => c.method === 'get').length, 1);
});

test('mergeEntity mit dryRun=false hängt um, verifiziert und loescht', async () => {
  let getCallCount = 0;
  const bulkEditCalls = [];
  const mockClient = {
    get: async () => {
      getCallCount++;
      // Erster Aufruf (vor dem Umhaengen) findet Dokumente, zweiter (danach) findet keine mehr.
      return getCallCount === 1
        ? { data: { results: [{ id: 20 }], next: null } }
        : { data: { results: [], next: null } };
    },
    post: async (url, body) => {
      bulkEditCalls.push({ url, body });
      return { data: {} };
    },
    delete: async (url) => ({ data: {}, url })
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.mergeEntity('correspondent', 7, 8, { dryRun: false })
  );

  assert.deepStrictEqual(result, { affectedCount: 1, documentIds: [20], deleted: true });
  assert.strictEqual(bulkEditCalls.length, 1);
  assert.strictEqual(bulkEditCalls[0].url, '/documents/bulk_edit/');
  assert.deepStrictEqual(bulkEditCalls[0].body, {
    documents: [20],
    method: 'set_correspondent',
    parameters: { correspondent: 8 }
  });
});

test('mergeEntity mit dryRun=false wirft und loescht nicht, wenn Dokumente uebrig bleiben', async () => {
  const mockClient = {
    get: async () => ({ data: { results: [{ id: 30 }], next: null } }), // bleibt bei jedem Aufruf gleich
    post: async () => ({ data: {} }),
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.mergeEntity('document_type', 1, 2, { dryRun: false })),
    /Merge unvollstaendig/
  );
});

test('mergeEntity fuer type=tag nutzt modify_tags mit add_tags/remove_tags', async () => {
  let getCallCount = 0;
  const bulkEditCalls = [];
  const mockClient = {
    get: async () => {
      getCallCount++;
      return getCallCount === 1
        ? { data: { results: [{ id: 40 }], next: null } }
        : { data: { results: [], next: null } };
    },
    post: async (url, body) => { bulkEditCalls.push(body); return { data: {} }; },
    delete: async () => ({ data: {} })
  };

  await withMockClient(mockClient, () => paperlessService.mergeEntity('tag', 100, 200, { dryRun: false }));

  assert.deepStrictEqual(bulkEditCalls[0], {
    documents: [40],
    method: 'modify_tags',
    parameters: { add_tags: [200], remove_tags: [100] }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: FAIL — `paperlessService.mergeEntity is not a function`.

- [ ] **Step 3: Implement `mergeEntity` and its two helpers**

Add to `services/paperlessService.js`, after `removeUnusedTagsFromDocument` (currently ending around `services/paperlessService.js:1309`, before the next method):

```js
  async _findDocumentsWithEntity(type, id) {
    const filterFieldMap = {
      tag: 'tags__id',
      correspondent: 'correspondent__id',
      document_type: 'document_type__id'
    };
    const filterField = filterFieldMap[type];
    if (!filterField) {
      throw new Error(`mergeEntity: unbekannter Typ "${type}"`);
    }

    let documents = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await this.client.get('/documents/', {
        params: { [filterField]: id, page, page_size: 100 }
      });
      const { results, next } = response.data;
      documents = documents.concat(results.map(doc => ({ id: doc.id })));
      hasNextPage = Boolean(next);
      page++;
    }

    return documents;
  }

  async _bulkReassignDocuments(type, documentIds, fromId, toId) {
    const methodMap = {
      tag: 'modify_tags',
      correspondent: 'set_correspondent',
      document_type: 'set_document_type'
    };
    const parametersMap = {
      tag: { add_tags: [toId], remove_tags: [fromId] },
      correspondent: { correspondent: toId },
      document_type: { document_type: toId }
    };

    await this.client.post('/documents/bulk_edit/', {
      documents: documentIds,
      method: methodMap[type],
      parameters: parametersMap[type]
    });
  }

  async mergeEntity(type, fromId, toId, { dryRun = true } = {}) {
    this.initialize();
    const affected = await this._findDocumentsWithEntity(type, fromId);

    if (dryRun) {
      return { affectedCount: affected.length, documentIds: affected.map(d => d.id), deleted: false };
    }

    if (affected.length > 0) {
      await this._bulkReassignDocuments(type, affected.map(d => d.id), fromId, toId);
    }

    // Erst nach verifiziert leerem fromId loeschen - der einzige unumkehrbare Schritt.
    const remaining = await this._findDocumentsWithEntity(type, fromId);
    if (remaining.length > 0) {
      throw new Error(`Merge unvollstaendig: ${remaining.length} Dokument(e) zeigen noch auf fromId=${fromId}`);
    }

    await this.client.delete(`/${type}s/${fromId}/`);
    return { affectedCount: affected.length, documentIds: affected.map(d => d.id), deleted: true };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/paperlessService.js test/paperlessMergeEntity.test.js
git commit -m "feat: add mergeEntity to paperlessService"
```

---

### Task 4: `services/reviewQueueService.js`

**Files:**
- Create: `services/reviewQueueService.js`
- Test: `test/reviewQueueService.test.js`

**Interfaces:**
- Consumes: `EntityStore` instance (`getQueueEntryById`, `updateQueueStatus`, `insertAlias`, `listOpenQueueEntries` from Task 1 and `models/entityStore.js:70-85`); `paperlessService.mergeEntity` (Task 3).
- Produces: `class ReviewQueueService { constructor({ store, paperlessService }) }` with `listOpen()`, `previewMerge(id)`, `merge(id)`, `reject(id)` — consumed by `routes/review.js` (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `test/reviewQueueService.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const ReviewQueueService = require('../services/reviewQueueService');

function fakeStore(overrides = {}) {
  const entries = new Map();
  return {
    entries,
    listOpenQueueEntries: () => Array.from(entries.values()).filter(e => e.status === 'open'),
    getQueueEntryById: (id) => entries.get(id) || null,
    updateQueueStatus: (id, status) => {
      if (!entries.has(id)) return false;
      entries.get(id).status = status;
      return true;
    },
    insertAlias: () => true,
    ...overrides
  };
}

test('listOpen delegiert an store.listOpenQueueEntries', () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'tag' });
  const service = new ReviewQueueService({ store, paperlessService: {} });

  assert.strictEqual(service.listOpen().length, 1);
});

test('previewMerge ruft mergeEntity mit dryRun=true auf und aendert nichts am Eintrag', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'correspondent', proposed_id: 10, candidate_id: 20, proposed_normalized: 'stadtwerke', candidate_name: 'Stadtwerke GmbH' });
  const calls = [];
  const paperlessService = {
    mergeEntity: async (type, fromId, toId, opts) => { calls.push({ type, fromId, toId, opts }); return { affectedCount: 3, documentIds: [1, 2, 3], deleted: false }; }
  };
  const service = new ReviewQueueService({ store, paperlessService });

  const result = await service.previewMerge(1);

  assert.deepStrictEqual(result, { affectedCount: 3, documentIds: [1, 2, 3], deleted: false });
  assert.deepStrictEqual(calls, [{ type: 'correspondent', fromId: 10, toId: 20, opts: { dryRun: true } }]);
  assert.strictEqual(store.entries.get(1).status, 'open');
});

test('merge fuehrt echten Merge aus, schreibt Alias mit source=user und setzt status=merged', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'correspondent', proposed_id: 10, candidate_id: 20, proposed_normalized: 'stadtwerke', candidate_name: 'Stadtwerke GmbH' });
  const aliasCalls = [];
  store.insertAlias = (args) => { aliasCalls.push(args); return true; };
  const paperlessService = { mergeEntity: async () => ({ affectedCount: 3, documentIds: [1, 2, 3], deleted: true }) };
  const service = new ReviewQueueService({ store, paperlessService });

  const result = await service.merge(1);

  assert.strictEqual(result.deleted, true);
  assert.deepStrictEqual(aliasCalls, [{
    entityType: 'correspondent', aliasNormalized: 'stadtwerke', canonicalName: 'Stadtwerke GmbH', canonicalId: 20, source: 'user'
  }]);
  assert.strictEqual(store.entries.get(1).status, 'merged');
});

test('merge wirft, wenn die id nicht existiert, und schreibt keinen Alias', async () => {
  const store = fakeStore();
  const service = new ReviewQueueService({ store, paperlessService: { mergeEntity: async () => { throw new Error('haette nicht aufgerufen werden duerfen'); } } });

  await assert.rejects(() => service.merge(999), /Kein Queue-Eintrag/);
});

test('reject setzt status=rejected und ruft mergeEntity nicht auf', () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'tag' });
  const service = new ReviewQueueService({ store, paperlessService: { mergeEntity: async () => { throw new Error('haette nicht aufgerufen werden duerfen'); } } });

  const entry = service.reject(1);

  assert.strictEqual(entry.id, 1);
  assert.strictEqual(store.entries.get(1).status, 'rejected');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/reviewQueueService.test.js`
Expected: FAIL — `Cannot find module '../services/reviewQueueService'`.

- [ ] **Step 3: Implement `ReviewQueueService`**

Create `services/reviewQueueService.js`:

```js
class ReviewQueueService {
  constructor({ store, paperlessService }) {
    this.store = store;
    this.paperlessService = paperlessService;
  }

  listOpen() {
    return this.store.listOpenQueueEntries();
  }

  _getEntryOrThrow(id) {
    const entry = this.store.getQueueEntryById(id);
    if (!entry) {
      throw new Error(`Kein Queue-Eintrag mit id=${id}`);
    }
    return entry;
  }

  async previewMerge(id) {
    const entry = this._getEntryOrThrow(id);
    return this.paperlessService.mergeEntity(entry.entity_type, entry.proposed_id, entry.candidate_id, { dryRun: true });
  }

  async merge(id) {
    const entry = this._getEntryOrThrow(id);
    const result = await this.paperlessService.mergeEntity(entry.entity_type, entry.proposed_id, entry.candidate_id, { dryRun: false });

    this.store.insertAlias({
      entityType: entry.entity_type,
      aliasNormalized: entry.proposed_normalized,
      canonicalName: entry.candidate_name,
      canonicalId: entry.candidate_id,
      source: 'user'
    });
    this.store.updateQueueStatus(id, 'merged');

    return result;
  }

  reject(id) {
    const entry = this._getEntryOrThrow(id);
    this.store.updateQueueStatus(id, 'rejected');
    return entry;
  }
}

module.exports = ReviewQueueService;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/reviewQueueService.test.js`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/reviewQueueService.js test/reviewQueueService.test.js
git commit -m "feat: add ReviewQueueService for merge/reject lifecycle"
```

---

### Task 5: `services/entityBackfillService.js`

**Files:**
- Create: `services/entityBackfillService.js`
- Test: `test/entityBackfillService.test.js`

**Interfaces:**
- Consumes: `normalizeForType` (`services/entityNormalizer.js:49-52`), `diceCoefficient` (`services/entitySimilarity.js:10-30`), `EntityStore.findRejectedPair`/`insertQueueEntry` (`models/entityStore.js:101-140`).
- Produces: `class EntityBackfillService { constructor({ store, judgeMin }) }` with `run(entityType: string, existingEntities: Array<{id, name}>): { inserted: number }` — consumed by `routes/review.js` (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `test/entityBackfillService.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const EntityBackfillService = require('../services/entityBackfillService');
const EntityStore = require('../models/entityStore');

test('run findet ein aehnliches Paar oberhalb judgeMin und schreibt einen Queue-Eintrag, aeltere id wird kanonisch', () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = service.run('document_type', [
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

test('run ueberspringt Paare unterhalb judgeMin', () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = service.run('document_type', [
      { id: 1, name: 'Entgeltabrechnung' },
      { id: 2, name: 'Verdienstbescheinigung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run ueberspringt bereits als rejected bekannte Paare', () => {
  const store = new EntityStore(':memory:');
  try {
    const { normalizeForType } = require('../services/entityNormalizer');
    store.insertQueueEntry({
      entityType: 'tag',
      proposedName: 'Mahnung', proposedId: 2,
      candidateName: 'Mahnungen', candidateId: 1,
      similarity: 0.9, llmVerdict: 'different', llmReason: 'Test', status: 'rejected', documentId: null
    });

    const service = new EntityBackfillService({ store, judgeMin: 0.5 });
    const result = service.run('tag', [
      { id: 1, name: 'Mahnungen' },
      { id: 2, name: 'Mahnung' }
    ]);

    assert.strictEqual(result.inserted, 0);
  } finally {
    store.close();
  }
});

test('run vergleicht jedes Paar nur einmal bei mehr als zwei Eintraegen', () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.99 }); // nur exakte Duplikate treffen

    const result = service.run('tag', [
      { id: 1, name: 'Rechnung' },
      { id: 2, name: 'Rechnung' },
      { id: 3, name: 'Voellig Anders' }
    ]);

    assert.strictEqual(result.inserted, 1);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/entityBackfillService.test.js`
Expected: FAIL — `Cannot find module '../services/entityBackfillService'`.

- [ ] **Step 3: Implement `EntityBackfillService`**

Create `services/entityBackfillService.js`:

```js
const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityBackfillService {
  constructor({ store, judgeMin }) {
    this.store = store;
    this.judgeMin = judgeMin;
  }

  run(entityType, existingEntities) {
    let inserted = 0;

    for (let i = 0; i < existingEntities.length; i++) {
      for (let j = i + 1; j < existingEntities.length; j++) {
        const a = existingEntities[i];
        const b = existingEntities[j];

        // Aeltere (kleinere) id gilt als kanonisch, die neuere als moeglicher Dublette-Kandidat -
        // dieselbe Richtung, die auch der Live-Pfad fuer Merge annimmt (proposed -> candidate).
        const [candidate, proposed] = a.id < b.id ? [a, b] : [b, a];

        const normalizedCandidate = normalizeForType(candidate.name, entityType);
        const normalizedProposed = normalizeForType(proposed.name, entityType);
        const similarity = diceCoefficient(normalizedCandidate, normalizedProposed);

        if (similarity < this.judgeMin) {
          continue;
        }
        if (this.store.findRejectedPair(entityType, normalizedProposed, normalizedCandidate)) {
          continue;
        }

        const written = this.store.insertQueueEntry({
          entityType,
          proposedName: proposed.name,
          proposedId: proposed.id,
          candidateName: candidate.name,
          candidateId: candidate.id,
          similarity,
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
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/entityBackfillService.js test/entityBackfillService.test.js
git commit -m "feat: add EntityBackfillService for pairwise bestand scan"
```

---

### Task 6: `routes/review.js` + mount in `server.js`

**Files:**
- Create: `routes/review.js`
- Modify: `server.js` (add require near `server.js:10`, mount near `server.js:434`)

**Interfaces:**
- Consumes: `isAuthenticated`/`authenticateJWT` (`routes/auth.js:53`), `ReviewQueueService` (Task 4), `EntityBackfillService` (Task 5), `EntityStore` (`models/entityStore.js`), `paperlessService.getTags`/`listCorrespondentsNames`/`listDocumentTypesNames` (existing), `config.entityResolver.dbPath`/`judgeMin` (`config/config.js:134-139`).
- Produces: `GET /review`, `POST /api/review/:id/merge`, `POST /api/review/:id/reject`, `POST /api/review/backfill/:entityType` — consumed by `views/review.ejs` and `public/js/review.js` (Task 7).

No automated route-level tests: the codebase has no HTTP test harness (no `supertest` in `package.json`, and `routes/setup.js` itself has zero tests) — all business logic lives in the already-tested `ReviewQueueService`/`EntityBackfillService`, so this route file is a thin, manually-verified glue layer, consistent with the existing convention. Manual verification happens in Task 7's final step.

- [ ] **Step 1: Create `routes/review.js`**

```js
const express = require('express');
const router = express.Router();
const { isAuthenticated, authenticateJWT } = require('./auth');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const EntityStore = require('../models/entityStore');
const ReviewQueueService = require('../services/reviewQueueService');
const EntityBackfillService = require('../services/entityBackfillService');

const store = new EntityStore(config.entityResolver.dbPath);
const reviewQueueService = new ReviewQueueService({ store, paperlessService });
const backfillService = new EntityBackfillService({ store, judgeMin: config.entityResolver.judgeMin });

const ENTITY_LISTERS = {
  tag: () => paperlessService.getTags(),
  correspondent: () => paperlessService.listCorrespondentsNames(),
  document_type: () => paperlessService.listDocumentTypesNames()
};

router.get('/review', isAuthenticated, (req, res) => {
  const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
  const queue = reviewQueueService.listOpen().map(entry => ({
    ...entry,
    documentLink: entry.document_id ? `${baseURL}/documents/${entry.document_id}/` : null
  }));

  res.render('review', { queue, version: config.PAPERLESS_AI_VERSION || ' ' });
});

router.post('/api/review/:id/merge', authenticateJWT, async (req, res) => {
  const id = Number(req.params.id);
  const dryRun = req.body?.dryRun !== false;

  try {
    const result = dryRun
      ? await reviewQueueService.previewMerge(id)
      : await reviewQueueService.merge(id);
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] Merge fuer Queue-Eintrag ${id} fehlgeschlagen:`, error.message);
    res.status(400).json({ message: error.message });
  }
});

router.post('/api/review/:id/reject', authenticateJWT, (req, res) => {
  const id = Number(req.params.id);

  try {
    const entry = reviewQueueService.reject(id);
    res.json({ id: entry.id, status: 'rejected' });
  } catch (error) {
    console.error(`[ERROR] Reject fuer Queue-Eintrag ${id} fehlgeschlagen:`, error.message);
    res.status(400).json({ message: error.message });
  }
});

router.post('/api/review/backfill/:entityType', authenticateJWT, async (req, res) => {
  const entityType = req.params.entityType;
  const lister = ENTITY_LISTERS[entityType];

  if (!lister) {
    return res.status(400).json({ message: `Unbekannter Entity-Typ "${entityType}"` });
  }

  try {
    const existingEntities = await lister();
    const result = backfillService.run(entityType, existingEntities);
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] Altbestands-Durchlauf fuer "${entityType}" fehlgeschlagen:`, error.message);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount the router in `server.js`**

Add the require next to the existing `setupRoutes` require (`server.js:10`):

```js
const setupRoutes = require('./routes/setup');
const reviewRoutes = require('./routes/review');
```

Add the mount line directly after `app.use('/', setupRoutes);` (`server.js:434`):

```js
app.use('/', setupRoutes);
app.use('/', reviewRoutes);
```

- [ ] **Step 3: Verify the server starts without error**

Run: `node -e "require('./server.js')"` is not viable (server.js starts listeners/cron on require) — instead run a syntax/require smoke check:

Run: `node --check routes/review.js && node --check server.js`
Expected: no output, exit code 0 (both files parse without syntax errors).

Then run the full test suite to make sure nothing else broke from the `server.js` edit:

Run: `npm test`
Expected: PASS, all existing and new tests green.

- [ ] **Step 4: Commit**

```bash
git add routes/review.js server.js
git commit -m "feat: add review routes and mount in server.js"
```

---

### Task 7: `views/review.ejs` + `public/js/review.js`

**Files:**
- Create: `views/review.ejs`
- Create: `public/js/review.js`

**Interfaces:**
- Consumes: `queue` array and `version` string passed by `res.render('review', {...})` (Task 6, `routes/review.js`); each `queue` entry has `id, entity_type, proposed_name, candidate_name, similarity, llm_verdict, llm_reason, documentLink` (nullable).
- Produces: a working page at `/review` with merge (two-step dry-run/confirm), reject, and backfill actions wired via `fetch` to the Task 6 endpoints.

No automated tests (this is a view + vanilla-JS client file — the codebase has no browser/DOM test harness, matching `public/js/history.js` which is also untested). Verified manually in Step 3.

- [ ] **Step 1: Create `views/review.ejs`**

Modeled directly on `views/history.ejs`'s standalone-page structure (no shared layout exists in this codebase — `views/layout.ejs` is dead code, its middleware is commented out at `server.js:136-146`):

```html
<!-- views/review.ejs -->
<!DOCTYPE html>
<html lang="en" class="h-full" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Review Queue - Paperless-AI</title>
    <script src="https://cdn.tailwindcss.com/3.4.16"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.0/css/all.min.css">
    <link rel="stylesheet" href="css/dashboard.css">
    <style>
        .modal {
            transition: opacity 0.3s ease-in-out;
            opacity: 0;
            pointer-events: none;
        }
        .modal.show {
            opacity: 1;
            pointer-events: auto;
        }
        .modal.hidden {
            display: none;
        }
    </style>
</head>
<body class="h-full">
    <button id="themeToggle" class="theme-toggle">
        <i class="fas fa-moon dark:fas fa-sun"></i>
    </button>

    <div class="layout-container">
        <button id="mobileMenuButton" class="mobile-menu-button">
            <i class="fas fa-bars"></i>
        </button>
        <div id="sidebarOverlay" class="sidebar-overlay"></div>
        <aside class="sidebar">
            <div class="sidebar-header">
                <img src="/favicon.ico" class="no-invert" alt="Paperless AI Logo" style="height: 60px;">
                <h1 class="brand-title">Paperless-AI<small style="display: block;"><%= version %></small></h1>
            </div>

            <nav class="sidebar-nav">
                <ul>
                    <li><a href="/dashboard" class="sidebar-link"><i class="fas fa-home"></i><span>Dashboard</span></a></li>
                    <li><a href="/manual" class="sidebar-link"><i class="fas fa-file-alt"></i><span>Manual</span></a></li>
                    <li><a href="/chat" class="sidebar-link"><i class="fa-solid fa-comment"></i><span>Chat</span></a></li>
                    <li><a href="/history" class="sidebar-link"><i class="fa-solid fa-clock-rotate-left"></i><span>History</span></a></li>
                    <li><a href="/review" class="sidebar-link active"><i class="fa-solid fa-code-compare"></i><span>Review Queue</span></a></li>
                    <li><a href="/settings" class="sidebar-link"><i class="fas fa-cog"></i><span>Settings</span></a></li>
                    <li><a href="/logout" class="sidebar-link"><i class="fa-solid fa-right-from-bracket"></i><span>Logout</span></a></li>
                </ul>
            </nav>
        </aside>

        <main class="main-content">
            <div class="content-wrapper">
                <div class="content-header flex justify-between items-center mb-6">
                    <h1 class="content-title">Review Queue</h1>
                </div>

                <div class="flex flex-wrap gap-4 mb-6">
                    <button class="backfill-btn px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors" data-entity-type="tag">Altbestand: Tags pruefen</button>
                    <button class="backfill-btn px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors" data-entity-type="correspondent">Altbestand: Korrespondenten pruefen</button>
                    <button class="backfill-btn px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors" data-entity-type="document_type">Altbestand: Dokumentarten pruefen</button>
                </div>

                <div class="material-card">
                    <div class="overflow-x-auto">
                        <table class="w-full" id="reviewTable">
                            <thead>
                                <tr>
                                    <th>Typ</th>
                                    <th>Vorschlag</th>
                                    <th>Kandidat</th>
                                    <th>Aehnlichkeit</th>
                                    <th>Judge</th>
                                    <th>Dokument</th>
                                    <th>Aktionen</th>
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
                                            <a href="<%= entry.documentLink %>" target="_blank" class="text-blue-500 hover:underline">Ansehen</a>
                                        <% } else { %>
                                            <span class="text-gray-400">-</span>
                                        <% } %>
                                    </td>
                                    <td>
                                        <div class="flex gap-2">
                                            <button class="merge-btn px-3 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors" data-id="<%= entry.id %>">Zusammenfuehren</button>
                                            <button class="reject-btn px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors" data-id="<%= entry.id %>">Sind verschieden</button>
                                        </div>
                                    </td>
                                </tr>
                                <% }); %>
                                <% if (queue.length === 0) { %>
                                <tr><td colspan="7" class="text-center text-gray-400 py-6">Keine offenen Eintraege</td></tr>
                                <% } %>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <div id="mergeConfirmModal" class="modal hidden">
        <div class="modal-overlay"></div>
        <div class="modal-container">
            <div class="modal-header">
                <h3 class="modal-title">Merge bestaetigen</h3>
                <button class="modal-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-content">
                <p class="mb-4" id="mergePreviewText"></p>
                <div class="flex justify-end gap-4">
                    <button id="cancelMerge" class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100">Abbrechen</button>
                    <button id="confirmMerge" class="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600">Endgueltig zusammenfuehren</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const mobileMenuButton = document.getElementById('mobileMenuButton');
            const sidebar = document.querySelector('.sidebar');
            const sidebarOverlay = document.getElementById('sidebarOverlay');

            function toggleSidebar(event) {
                event.stopPropagation();
                sidebar.classList.toggle('active');
                sidebarOverlay.classList.toggle('active');
            }

            mobileMenuButton.addEventListener('click', toggleSidebar);
            sidebarOverlay.addEventListener('click', function(event) {
                event.stopPropagation();
                if (sidebar.classList.contains('active')) toggleSidebar(event);
            });
            sidebar.addEventListener('click', function(event) { event.stopPropagation(); });
        });
    </script>
    <script src="js/review.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/js/review.js`**

```js
class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }
    initialize() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        this.themeToggle?.addEventListener('click', () => this.toggleTheme());
    }
    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        const icon = this.themeToggle.querySelector('i');
        if (icon) icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }
    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        this.setTheme(currentTheme === 'light' ? 'dark' : 'light');
    }
}

class ReviewManager {
    constructor() {
        this.modal = document.getElementById('mergeConfirmModal');
        this.previewText = document.getElementById('mergePreviewText');
        this.confirmBtn = document.getElementById('confirmMerge');
        this.pendingMergeId = null;
        this.initialize();
    }

    initialize() {
        document.querySelectorAll('.merge-btn').forEach(btn => {
            btn.addEventListener('click', () => this.previewMerge(btn.dataset.id));
        });
        document.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', () => this.reject(btn.dataset.id));
        });
        document.querySelectorAll('.backfill-btn').forEach(btn => {
            btn.addEventListener('click', () => this.backfill(btn.dataset.entityType, btn));
        });

        this.modal?.querySelector('.modal-overlay')?.addEventListener('click', () => this.hideModal());
        this.modal?.querySelector('.modal-close')?.addEventListener('click', () => this.hideModal());
        document.getElementById('cancelMerge')?.addEventListener('click', () => this.hideModal());
        this.confirmBtn?.addEventListener('click', () => this.confirmMerge());
    }

    async previewMerge(id) {
        try {
            const response = await fetch(`/api/review/${id}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun: true })
            });
            if (!response.ok) throw new Error('Vorschau fehlgeschlagen');
            const preview = await response.json();

            this.pendingMergeId = id;
            this.previewText.textContent = `${preview.affectedCount} Dokument(e) werden umgehaengt. Fortfahren?`;
            this.showModal();
        } catch (error) {
            console.error('Merge-Vorschau fehlgeschlagen:', error);
            alert('Merge-Vorschau fehlgeschlagen. Bitte erneut versuchen.');
        }
    }

    async confirmMerge() {
        if (!this.pendingMergeId) return;
        try {
            const response = await fetch(`/api/review/${this.pendingMergeId}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun: false })
            });
            if (!response.ok) throw new Error('Merge fehlgeschlagen');

            document.querySelector(`tr[data-queue-id="${this.pendingMergeId}"]`)?.remove();
            this.hideModal();
        } catch (error) {
            console.error('Merge fehlgeschlagen:', error);
            alert('Merge fehlgeschlagen. Bitte erneut versuchen.');
        } finally {
            this.pendingMergeId = null;
        }
    }

    async reject(id) {
        try {
            const response = await fetch(`/api/review/${id}/reject`, { method: 'POST' });
            if (!response.ok) throw new Error('Ablehnen fehlgeschlagen');

            document.querySelector(`tr[data-queue-id="${id}"]`)?.remove();
        } catch (error) {
            console.error('Ablehnen fehlgeschlagen:', error);
            alert('Ablehnen fehlgeschlagen. Bitte erneut versuchen.');
        }
    }

    async backfill(entityType, button) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Laeuft...';
        try {
            const response = await fetch(`/api/review/backfill/${entityType}`, { method: 'POST' });
            if (!response.ok) throw new Error('Altbestands-Durchlauf fehlgeschlagen');
            const result = await response.json();
            alert(`${result.inserted} neue Eintraege gefunden.`);
            if (result.inserted > 0) window.location.reload();
        } catch (error) {
            console.error('Altbestands-Durchlauf fehlgeschlagen:', error);
            alert('Altbestands-Durchlauf fehlgeschlagen. Bitte erneut versuchen.');
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    showModal() {
        this.modal?.classList.remove('hidden');
        this.modal?.classList.add('show');
    }

    hideModal() {
        this.modal?.classList.remove('show');
        this.modal?.classList.add('hidden');
        this.pendingMergeId = null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.reviewManager = new ReviewManager();
});
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, log in, navigate to `http://localhost:<port>/review`.
Expected: page loads without console errors; if `entity_review_queue` has open rows (insert one manually via `sqlite3 data/entities.db` or trigger one through the live classification path with `ENTITY_RESOLVER_ENABLED=yes` if comfortable testing against a non-production instance), the row renders with working "Zusammenfuehren" (opens the confirm modal with a real `affectedCount`) and "Sind verschieden" (removes the row) buttons, and each "Altbestand: ... pruefen" button returns an inserted-count alert without a server error.

- [ ] **Step 4: Commit**

```bash
git add views/review.ejs public/js/review.js
git commit -m "feat: add review queue page and client-side wiring"
```

---

### Task 8: Dashboard-Zähler

**Files:**
- Modify: `services/paperlessService.js` (add one method, near `_getEntityResolver` at `services/paperlessService.js:158-175`)
- Modify: `routes/setup.js:2578-2613` (`GET /dashboard` handler)
- Modify: `views/dashboard.ejs:172-205` (add one `.stat-box`)
- Test: `test/paperlessMergeEntity.test.js` (append) or a new small test — append to `test/paperlessMergeEntity.test.js` to keep entity-resolver-adjacent `paperlessService` tests together

**Interfaces:**
- Consumes: `EntityStore.countOpenQueueEntries` (Task 1).
- Produces: `paperlessService.getOpenReviewQueueCount(): number`, and a new `paperless_data.openReviewQueueCount` key rendered in `views/dashboard.ejs`.

- [ ] **Step 1: Write the failing test**

Append to `test/paperlessMergeEntity.test.js`:

```js
test('getOpenReviewQueueCount liefert die Anzahl offener Queue-Eintraege', () => {
  const original = paperlessService._entityResolverInstance;
  paperlessService._entityResolverInstance = { store: { countOpenQueueEntries: () => 3 } };

  try {
    assert.strictEqual(paperlessService.getOpenReviewQueueCount(), 3);
  } finally {
    paperlessService._entityResolverInstance = original;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: FAIL — `paperlessService.getOpenReviewQueueCount is not a function`.

- [ ] **Step 3: Implement `getOpenReviewQueueCount`**

Add to `services/paperlessService.js`, directly after `_getEntityResolver` (`services/paperlessService.js:158-175`):

```js
  getOpenReviewQueueCount() {
    try {
      return this._getEntityResolver().store.countOpenQueueEntries();
    } catch (error) {
      console.warn('[WARNING] Konnte offene Review-Queue-Eintraege nicht zaehlen:', error.message);
      return 0;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: PASS, including the new test.

- [ ] **Step 5: Wire the count into the dashboard route**

In `routes/setup.js`, the `GET /dashboard` handler (`routes/setup.js:2578-2613`), change:

```js
  const tagCount = await paperlessService.getTagCount();
  const correspondentCount = await paperlessService.getCorrespondentCount();
  const documentCount = await paperlessService.getDocumentCount();
```

to:

```js
  const tagCount = await paperlessService.getTagCount();
  const correspondentCount = await paperlessService.getCorrespondentCount();
  const documentCount = await paperlessService.getDocumentCount();
  const openReviewQueueCount = paperlessService.getOpenReviewQueueCount();
```

and change the `paperless_data` object in the same `res.render('dashboard', {...})` call:

```js
  res.render('dashboard', { 
    paperless_data: { 
      tagCount, 
      correspondentCount, 
      documentCount, 
      processedDocumentCount,
      processingTimeStats,
      tokenDistribution,
      documentTypes
    }, 
```

to:

```js
  res.render('dashboard', { 
    paperless_data: { 
      tagCount, 
      correspondentCount, 
      documentCount, 
      processedDocumentCount,
      processingTimeStats,
      tokenDistribution,
      documentTypes,
      openReviewQueueCount
    }, 
```

- [ ] **Step 6: Add the stat-box to `views/dashboard.ejs`**

In `views/dashboard.ejs`, inside the `System Statistics` `material-card` (`views/dashboard.ejs:172-205`), directly after the `Correspondents` `.stat-box` (before the closing `</div>` of `.space-y-6`), add:

```html
                            <div class="stat-box cursor-pointer hover:shadow-lg transition-all" onclick="window.location.href='/review'">
                                <div class="flex items-center justify-between">
                                    <div class="flex items-center">
                                        <div class="w-10 h-10 rounded-lg bg-yellow-100 flex items-center justify-center mr-3">
                                            <i class="fas fa-code-compare text-yellow-500"></i>
                                        </div>
                                        <div>
                                            <div class="text-sm text-gray-600">Offene Review-Eintraege</div>
                                            <div class="text-xl font-bold"><%= paperless_data.openReviewQueueCount %></div>
                                        </div>
                                    </div>
                                    <i class="fas fa-chevron-right text-gray-400"></i>
                                </div>
                            </div>
```

- [ ] **Step 7: Manual verification**

Run: `npm run dev`, log in, open `/dashboard`.
Expected: a new "Offene Review-Eintraege" tile renders with a number (0 if the queue is empty), clicking it navigates to `/review`.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS, every test in `test/*.test.js` green, including all tests added across Tasks 1–8.

- [ ] **Step 9: Commit**

```bash
git add services/paperlessService.js routes/setup.js views/dashboard.ejs test/paperlessMergeEntity.test.js
git commit -m "feat: add open review queue counter to dashboard"
```
