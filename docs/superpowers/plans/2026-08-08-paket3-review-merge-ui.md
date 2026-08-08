# Paket 3 — Review-/Merge-UI: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four required fixes of [docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md](../../audit/2026-08-06-fixplan-konsistenz-und-review-ui.md), section "Paket 3" (lines 603–706): merge direction is stuck at "smaller id wins" and can silently delete the better-populated entity (3.1/B-3); the merge confirmation dialog hides the exact information that would reveal a wrong merge (3.2/B-4); nothing in the UI shows past alias decisions or lets you undo one (3.3/A-6, B-8); and the queue gives no explanation of what a row means or that a dash can mean "never scored" instead of "empty" (3.4/B-1, B-2). Plus four small, low-risk UI fixes bundled from the fixplan's "Kleinere Punkte" table (3.5) that touch the same three files: B-5 (silent permanent reject), B-9 (unexplained O(n²) backfill button), B-6 (swallowed server error messages), B-7 (no loading state, stale counter).

**Architecture:** No new subsystems. All work lands in the three files the fixplan names (`views/review.ejs`, `public/js/review.js`, `routes/review.js`), plus their two direct collaborators (`services/reviewQueueService.js`, `services/entityBackfillService.js`) and `models/entityStore.js` for new read/write methods on `entity_aliases`/`entity_review_queue`. One new EJS view (`views/review-aliases.ejs`) and one new client script (`public/js/review-aliases.js`) for the alias tab (3.3). Two new small `paperlessService` methods (`getDocumentCountForEntity`, reusing the existing `listDocumentTypesWithCounts` from Paket 2) supply the live document counts the fixplan requires in three places (merge direction default, confirm dialog, queue table column) — no new backend subsystem, just filling a gap the existing `getExampleDocumentsForEntity`/`mergeEntity` pair already left (they return up to 3 example titles or a reassignment count, never a total).

**Tech Stack:** Node.js (CommonJS), Express, EJS, `node:test` + `node:assert` (no test framework, no jsdom/supertest — this repo has no browser-DOM or HTTP-route test harness), `better-sqlite3`, vanilla DOM JS (no frontend framework), Tailwind (CDN, unchanged by this plan — see "Out of scope" below).

## Global Constraints

- Test runner: `npm test` → `node --test test/*.test.js`. Baseline at plan start: assume green (Paket 1's acceptance criterion). Every task ends with `npm test` green and `npm run lint` → `0 problems`.
- **This repo has no frontend test harness.** Changes to `views/*.ejs` and `public/js/*.js` are verified manually (`npm run dev`, exercise the page in a browser) — do not invent jsdom/supertest infrastructure for this plan. Automated `node:test` coverage applies only to `models/entityStore.js`, `services/reviewQueueService.js`, `services/entityBackfillService.js`, `services/paperlessService.js`.
- Every state-changing `fetch()` call in `public/js/*.js` sends `'X-CSRF-Token': getCsrfToken()` (see `public/js/csrf.js`, already loaded in `views/review.ejs`) — carry this into `views/review-aliases.ejs` too.
- Every state-changing route uses `authenticateJWT`; every page route uses `isAuthenticated` — match the existing pattern in `routes/review.js:44,80,112,129,142,161`.
- AUDIT-030 convention: any query-string or request-body value that selects a SQL column, ordering, or status must be checked against a server-side whitelist constant (see `ENTITY_TYPES`, `QUEUE_SORTS` in `routes/review.js:40-41`) — never interpolate the raw value.
- **Never print, log, or commit real values from `data/.env`.** It holds the live Paperless token and Ollama URL (see `CLAUDE.md`). Nothing in this plan touches `data/.env`.
- German inline comments in this codebase explain **why**, not what — match that style in any new comment. Existing comments being modified must keep any audit-finding reference (`AUDIT-NNN`, `1.1.c`, etc.) that is still accurate; drop ones that no longer are and say why in the diff, not by leaving it stale.
- Every task ends with `npm test` and `npm run lint` both clean, then one commit for that task's changes.

---

### Task 1: Merge-Richtung umkehrbar machen (3.1, B-3)

**Files:**
- Modify: `services/paperlessService.js` (new method after `getExampleDocumentsForEntity`, ~line 1663)
- Modify: `routes/review.js:33-37` (ENTITY_LISTERS.document_type), `:80-110` (GET `/api/review/:id/documents`), `:112-127` (POST `/api/review/:id/merge`)
- Modify: `services/entityBackfillService.js:33-56` (canonical selection)
- Modify: `services/reviewQueueService.js:30-84` (`previewMerge`, `merge`)
- Modify: `views/review.ejs:139` (merge button), `:175-190` (confirm modal)
- Modify: `public/js/review.js:1-2` (new module-level helper), `:23-57` (constructor/initialize), `:116-162` (previewMerge/confirmMerge), `:229-239` (showModal/hideModal)
- Test: `test/entityBackfillService.test.js`, `test/reviewQueueService.test.js`

**Interfaces:**
- Consumes: `services/paperlessService.js:1506` `mergeEntity(type, fromId, toId, {dryRun, expectedDocumentIds})` (unchanged signature — this task only changes which id is `fromId` vs `toId`).
- Produces: `paperlessService.getDocumentCountForEntity(type, id): Promise<number>` — consumed by Task 2 and Task 4. `GET /api/review/:id/documents` response shape becomes `{ proposed: {name, documentCount, documents}, candidate: {name, documentCount, documents} }` — consumed by Task 2. `reviewQueueService.previewMerge(id, {reverse=false})` / `merge(id, {expectedDocumentIds, reverse=false})` — the `reverse` option is consumed only by this task's own frontend, but the shape is now the permanent contract for both callers.

**Root cause:** `entityBackfillService.js:38-40` hardcodes "smaller id is canonical". The fixplan's own test evidence: `Zeugnis` (5 documents) would be deleted in favor of `Zeugniss` (0 documents) purely because `Zeugniss` has the smaller id. There is no way in the UI today to merge the other direction — `services/reviewQueueService.js:30-33`/`:35` always call `mergeEntity(type, proposed_id, candidate_id, ...)`.

- [ ] **Step 1: Add `paperlessService.getDocumentCountForEntity`**

Insert directly after `getExampleDocumentsForEntity` (`services/paperlessService.js:1663`):

```js
  async getDocumentCountForEntity(type, id) {
    this.initialize();
    const filterFieldMap = {
      tag: 'tags__id',
      correspondent: 'correspondent__id',
      document_type: 'document_type__id'
    };
    const filterField = filterFieldMap[type];
    if (!filterField) {
      throw new Error(`getDocumentCountForEntity: unknown type "${type}"`);
    }

    const response = await this.client.get('/documents/', {
      params: { [filterField]: id, page: 1, page_size: 1 }
    });
    return response.data.count;
  }
```

No test file exists for `paperlessService.js` (mocked-client tests live in `test/paperlessListOrdering.test.js` for the listers only) — this method is exercised indirectly through Task 1 Step 6's `reviewQueueService` tests via a stub, and through manual verification in Step 8. No dedicated unit test needed here; do not invent a mock-client test file for a single method when the project has no existing harness for `paperlessService` beyond that one file.

- [ ] **Step 2: Give `entityBackfillService` document counts to compare, and let the canonical side follow them**

`routes/review.js:33-37`, change the document_type lister (this repo already has a counts-aware lister from Paket 2 — reuse it instead of adding a new one):

```js
const ENTITY_LISTERS = {
  tag: () => paperlessService.getTags(),
  correspondent: () => paperlessService.listCorrespondentsNames(),
  document_type: () => paperlessService.listDocumentTypesWithCounts()
};
```

`services/entityBackfillService.js:33-40`, replace:

```js
    for (let i = 0; i < existingEntities.length; i++) {
      for (let j = i + 1; j < existingEntities.length; j++) {
        const a = existingEntities[i];
        const b = existingEntities[j];

        // Aeltere (kleinere) id gilt als kanonisch, die neuere als moeglicher Dublette-Kandidat -
        // dieselbe Richtung, die auch der Live-Pfad fuer Merge annimmt (proposed -> candidate).
        const [candidate, proposed] = a.id < b.id ? [a, b] : [b, a];
```

with:

```js
    for (let i = 0; i < existingEntities.length; i++) {
      for (let j = i + 1; j < existingEntities.length; j++) {
        const a = existingEntities[i];
        const b = existingEntities[j];

        // Bevorzugt die Seite mit mehr Dokumenten als kanonisch (3.1/B-3) - ein Merge in die
        // falsche Richtung loescht sonst die etablierte Variante zugunsten einer kaum genutzten,
        // z.B. "Zeugnis" (5 Dokumente) haette "Zeugniss" (0 Dokumente) verloren, weil Zeugniss
        // die kleinere id hatte. Bei Gleichstand (typischerweise 0 = 0, oder wenn der Aufrufer
        // eine Liste ohne document_count uebergibt) faellt der Tiebreak auf die aeltere
        // (kleinere) id zurueck, wie bisher.
        const countA = a.document_count ?? 0;
        const countB = b.document_count ?? 0;
        const [candidate, proposed] = countA !== countB
          ? (countA > countB ? [a, b] : [b, a])
          : (a.id < b.id ? [a, b] : [b, a]);
```

- [ ] **Step 3: Write the failing tests for the canonical-selection change**

Add to `test/entityBackfillService.test.js` (same file/pattern as the existing `run findet ein aehnliches Paar...` test — real `EntityStore(':memory:')`, `try/finally { store.close() }`):

```js
test('run bevorzugt die Seite mit mehr Dokumenten als kanonisch, auch wenn die id groesser ist', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    // Zeugniss hat die kleinere id, aber 0 Dokumente - Zeugnis (5 Dokumente) muss trotzdem
    // kanonisch (candidate) bleiben.
    const result = await service.run('tag', [
      { id: 10, name: 'Zeugniss', document_count: 0 },
      { id: 20, name: 'Zeugnis', document_count: 5 }
    ]);

    assert.strictEqual(result.inserted, 1);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'tag'`).get();
    assert.strictEqual(row.candidate_id, 20);
    assert.strictEqual(row.candidate_name, 'Zeugnis');
    assert.strictEqual(row.proposed_id, 10);
    assert.strictEqual(row.proposed_name, 'Zeugniss');
  } finally {
    store.close();
  }
});

test('run faellt bei gleicher Dokumentzahl auf die kleinere id zurueck', async () => {
  const store = new EntityStore(':memory:');
  try {
    const service = new EntityBackfillService({ store, judgeMin: 0.6 });

    const result = await service.run('document_type', [
      { id: 5, name: 'Meldebescheinigung', document_count: 3 },
      { id: 12, name: 'Meldebeschreibung', document_count: 3 }
    ]);

    assert.strictEqual(result.inserted, 1);
    const row = store.db.prepare(`SELECT * FROM entity_review_queue WHERE entity_type = 'document_type'`).get();
    assert.strictEqual(row.candidate_id, 5);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 4: Run the new tests, confirm pass**

Run: `node --test test/entityBackfillService.test.js`
Expected: all tests pass, including the two new ones and the pre-existing `aeltere id wird kanonisch` test (its fixture entities have no `document_count`, so `countA ?? 0 === countB ?? 0 === 0` and it still falls through to the id tiebreak — unchanged behavior).

- [ ] **Step 5: Add `reverse` to `reviewQueueService.previewMerge`/`merge`**

Replace `services/reviewQueueService.js:30-84`:

```js
  async previewMerge(id, { reverse = false } = {}) {
    const entry = this._getEntryOrThrow(id);
    const [fromId, toId] = reverse ? [entry.candidate_id, entry.proposed_id] : [entry.proposed_id, entry.candidate_id];
    return this.paperlessService.mergeEntity(entry.entity_type, fromId, toId, { dryRun: true });
  }

  async merge(id, { expectedDocumentIds = null, reverse = false } = {}) {
    const entry = this._getEntryOrThrow(id);
    // reverse (3.1/B-3): welche Seite geloescht wird, folgt jetzt einer expliziten Nutzerwahl
    // statt fest "proposed wird geloescht" zu sein - siehe views/review.ejs Merge-Dialog.
    const [fromId, toId] = reverse ? [entry.candidate_id, entry.proposed_id] : [entry.proposed_id, entry.candidate_id];
    const [fromName, toName] = reverse ? [entry.candidate_name, entry.proposed_name] : [entry.proposed_name, entry.candidate_name];
    const fromNormalized = reverse ? entry.candidate_normalized : entry.proposed_normalized;

    let result;
    try {
      result = await this.paperlessService.mergeEntity(entry.entity_type, fromId, toId, { dryRun: false, expectedDocumentIds });
    } catch (error) {
      const progress = error.mergeProgress || {};
      this.store.insertMergeLog({
        queueEntryId: id, entityType: entry.entity_type, fromId, toId,
        affectedCount: progress.affectedCount ?? 0, chunksCompleted: progress.chunksCompleted ?? 0, chunksTotal: progress.chunksTotal ?? 0,
        status: 'failed', errorMessage: error.message
      });
      throw error;
    }

    const persisted = this.store.completeMerge({
      alias: {
        entityType: entry.entity_type,
        aliasNormalized: fromNormalized,
        canonicalName: toName,
        canonicalId: toId,
        source: 'user'
      },
      queueEntryId: id,
      mergeLog: {
        queueEntryId: id, entityType: entry.entity_type, fromId, toId,
        affectedCount: result.affectedCount, chunksCompleted: result.chunksCompleted ?? 0, chunksTotal: result.chunksTotal ?? 0,
        status: 'completed', errorMessage: null
      }
    });
    if (!persisted) {
      // Der Merge in Paperless ist bereits vollzogen (fromId geloescht) - ein erneuter Versuch
      // ueber die UI wuerde jetzt fehlschlagen. Laut loggen statt den Fehler zu verschlucken,
      // aber dem Aufrufer trotzdem das erfolgreiche Paperless-Ergebnis zurueckgeben (AUDIT-015).
      console.error(`[ERROR] reviewQueueService.merge: Merge fuer Queue-Eintrag ${id} in Paperless erfolgreich, aber Alias/Queue-Status/Merge-Log konnten nicht gespeichert werden - Eintrag bleibt inkonsistent, manuelle Pruefung von entity_aliases/entity_review_queue noetig`);
      this.store.insertMergeLog({
        queueEntryId: id, entityType: entry.entity_type, fromId, toId,
        affectedCount: result.affectedCount, chunksCompleted: result.chunksCompleted ?? 0, chunksTotal: result.chunksTotal ?? 0,
        status: 'completed', errorMessage: 'Alias/Queue-Status nicht persistiert (completeMerge fehlgeschlagen)'
      });
    }

    return result;
  }
```

- [ ] **Step 6: Write the failing tests for reverse merge**

Add to `test/reviewQueueService.test.js`, using the same `fakeStore()`/inline `paperlessService` stub pattern as the existing `previewMerge ruft mergeEntity mit dryRun=true auf...` test:

```js
test('previewMerge mit reverse=true vertauscht fromId/toId', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'tag', proposed_id: 10, proposed_name: 'Zeugniss', proposed_normalized: 'zeugniss', candidate_id: 20, candidate_name: 'Zeugnis', candidate_normalized: 'zeugnis' });
  const calls = [];
  const paperlessService = {
    mergeEntity: async (type, fromId, toId, opts) => { calls.push({ type, fromId, toId, opts }); return { affectedCount: 5, documentIds: [1, 2, 3, 4, 5], deleted: false }; }
  };
  const service = new ReviewQueueService({ store, paperlessService });

  await service.previewMerge(1, { reverse: true });

  assert.strictEqual(calls[0].fromId, 20);
  assert.strictEqual(calls[0].toId, 10);
});

test('merge mit reverse=true speichert den Alias in die andere Richtung', async () => {
  const store = fakeStore();
  store.entries.set(1, { id: 1, status: 'open', entity_type: 'tag', proposed_id: 10, proposed_name: 'Zeugniss', proposed_normalized: 'zeugniss', candidate_id: 20, candidate_name: 'Zeugnis', candidate_normalized: 'zeugnis' });
  const paperlessService = {
    mergeEntity: async () => ({ affectedCount: 0, documentIds: [], deleted: true, chunksCompleted: 0, chunksTotal: 0 })
  };
  const service = new ReviewQueueService({ store, paperlessService });

  await service.merge(1, { reverse: true });

  const alias = store.completeMergeArgs.alias;
  assert.strictEqual(alias.aliasNormalized, 'zeugnis');
  assert.strictEqual(alias.canonicalId, 10);
  assert.strictEqual(alias.canonicalName, 'Zeugniss');
});
```

If `fakeStore()` does not currently record `completeMergeArgs`, extend its `completeMerge` stub to store its argument (`completeMerge(args) { this.completeMergeArgs = args; return true; }`) — check the existing fixture at the top of `test/reviewQueueService.test.js` first; do not duplicate the fixture if a similar capture already exists for the non-reverse `merge` tests.

- [ ] **Step 7: Run the new tests, confirm pass**

Run: `node --test test/reviewQueueService.test.js`
Expected: all tests pass, including the two new ones and every pre-existing `merge`/`previewMerge` test (they call without `reverse`, which defaults to `false` — behavior unchanged).

- [ ] **Step 8: Wire `reverse` through the route, add the direction toggle to the confirm modal**

`routes/review.js:80-110`, replace the whole handler to also return document counts (needed now for the default-direction calculation and reused by Task 2 for the visible counts):

```js
router.get('/api/review/:id/documents', authenticateJWT, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const { store } = getServices();
    const entry = store.getQueueEntryById(id);
    if (!entry) {
      return res.status(404).json({ message: `No queue entry with id=${id}` });
    }

    const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
    const withLinks = (docs) => docs.map(doc => ({ ...doc, link: `${baseURL}/documents/${doc.id}/` }));
    // proposed_id ist nullable (Schema), candidate_id nicht - siehe models/entityStore.js.
    const fetchDocs = (entityId) => entityId
      ? paperlessService.getExampleDocumentsForEntity(entry.entity_type, entityId, 3)
      : Promise.resolve([]);
    const fetchCount = (entityId) => entityId
      ? paperlessService.getDocumentCountForEntity(entry.entity_type, entityId)
      : Promise.resolve(0);

    const [proposedDocs, candidateDocs, proposedCount, candidateCount] = await Promise.all([
      fetchDocs(entry.proposed_id),
      fetchDocs(entry.candidate_id),
      fetchCount(entry.proposed_id),
      fetchCount(entry.candidate_id)
    ]);

    res.json({
      proposed: { name: entry.proposed_name, documentCount: proposedCount, documents: withLinks(proposedDocs) },
      candidate: { name: entry.candidate_name, documentCount: candidateCount, documents: withLinks(candidateDocs) }
    });
  } catch (error) {
    console.error(`[ERROR] Example documents for queue entry ${id} failed:`, error.message);
    res.status(500).json({ message: error.message });
  }
});
```

`routes/review.js:112-127`, replace:

```js
router.post('/api/review/:id/merge', authenticateJWT, async (req, res) => {
  const id = Number(req.params.id);
  const dryRun = req.body?.dryRun !== false;
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  const reverse = req.body?.reverse === true;

  try {
    const { reviewQueueService } = getServices();
    const result = dryRun
      ? await reviewQueueService.previewMerge(id, { reverse })
      : await reviewQueueService.merge(id, { expectedDocumentIds: documentIds, reverse });
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] Merge fuer Queue-Eintrag ${id} fehlgeschlagen:`, error.message);
    res.status(400).json({ message: error.message });
  }
});
```

`views/review.ejs:139`, the merge button no longer needs the name data-attributes (previewMerge now fetches names from the server):

```html
<button class="merge-btn px-3 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors" data-id="<%= entry.id %>">Merge</button>
```

`views/review.ejs:175-190`, replace the confirm modal body to add the reverse toggle and a container for Task 2's example-titles block:

```html
    <div id="mergeConfirmModal" class="modal hidden">
        <div class="modal-overlay"></div>
        <div class="modal-container">
            <div class="modal-header">
                <h3 class="modal-title">Confirm merge</h3>
                <button class="modal-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-content">
                <p class="mb-4" id="mergePreviewText"></p>
                <label class="flex items-center gap-2 mb-4">
                    <input type="checkbox" id="mergeReverseToggle">
                    <span>Merge the other way round</span>
                </label>
                <div id="mergePreviewExamples" class="mb-4 text-sm"></div>
                <div class="flex justify-end gap-4">
                    <button id="cancelMerge" class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100">Cancel</button>
                    <button id="confirmMerge" class="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600">Merge permanently</button>
                </div>
            </div>
        </div>
    </div>
```

`public/js/review.js:1-2`, add a module-level helper used from here on for every fetch's error path (Task 6 finishes migrating the remaining call sites onto it):

```js
async function extractErrorMessage(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return body.message || fallback;
}

class ThemeManager {
```

`public/js/review.js:23-33`, extend the constructor:

```js
class ReviewManager {
    constructor() {
        this.modal = document.getElementById('mergeConfirmModal');
        this.previewText = document.getElementById('mergePreviewText');
        this.previewExamples = document.getElementById('mergePreviewExamples');
        this.reverseToggle = document.getElementById('mergeReverseToggle');
        this.confirmBtn = document.getElementById('confirmMerge');
        this.pendingMergeId = null;
        this.pendingDocumentIds = null;
        this.pendingReverse = false;
        this.pendingInfo = null;
        this.docPreviewModal = document.getElementById('previewModal');
        this.docPreviewContent = document.getElementById('previewContent');
        this.initialize();
    }
```

`public/js/review.js:35-57`, add the toggle listener inside `initialize()` (after the existing `this.confirmBtn?.addEventListener(...)` line):

```js
        this.confirmBtn?.addEventListener('click', () => this.confirmMerge());
        this.reverseToggle?.addEventListener('change', () => {
            this.loadMergeDirection(this.reverseToggle.checked).catch(error => {
                console.error('Failed to switch merge direction:', error);
                alert(error.message || 'Failed to switch merge direction. Please try again.');
            });
        });
```

`public/js/review.js:116-140`, replace `previewMerge` and add `loadMergeDirection`/`renderMergePreview`:

```js
    async previewMerge(button) {
        const id = button.dataset.id;
        try {
            const infoResponse = await fetch(`/api/review/${id}/documents`);
            if (!infoResponse.ok) throw new Error(await extractErrorMessage(infoResponse, 'Merge preview failed'));
            const info = await infoResponse.json();

            this.pendingMergeId = id;
            this.pendingInfo = info;
            // Vorbelegung folgt der Dokumentzahl (3.1/B-3): die Seite mit mehr Dokumenten bleibt
            // standardmaessig erhalten, unabhaengig davon, welche Seite proposed/candidate ist.
            const defaultReverse = info.proposed.documentCount > info.candidate.documentCount;
            await this.loadMergeDirection(defaultReverse);
            this.showModal();
        } catch (error) {
            console.error('Merge preview failed:', error);
            alert(error.message || 'Merge preview failed. Please try again.');
        }
    }

    async loadMergeDirection(reverse) {
        const response = await fetch(`/api/review/${this.pendingMergeId}/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify({ dryRun: true, reverse })
        });
        if (!response.ok) throw new Error(await extractErrorMessage(response, 'Merge preview failed'));
        const preview = await response.json();

        this.pendingReverse = reverse;
        this.pendingDocumentIds = preview.documentIds;
        this.renderMergePreview(preview);
    }

    renderMergePreview(preview) {
        const { proposed, candidate } = this.pendingInfo;
        const [fromSide, toSide] = this.pendingReverse ? [candidate, proposed] : [proposed, candidate];

        this.previewText.textContent = `"${fromSide.name}" (${fromSide.documentCount} document(s)) will be deleted. `
            + `${preview.affectedCount} document(s) will be reassigned to "${toSide.name}" (${toSide.documentCount} document(s)). Continue?`;

        if (this.reverseToggle) this.reverseToggle.checked = this.pendingReverse;
    }
```

`public/js/review.js:142-162`, `confirmMerge` sends `reverse` and resets it on completion:

```js
    async confirmMerge() {
        if (!this.pendingMergeId) return;
        try {
            const response = await fetch(`/api/review/${this.pendingMergeId}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ dryRun: false, documentIds: this.pendingDocumentIds, reverse: this.pendingReverse })
            });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Merge failed'));

            document.querySelector(`tr[data-queue-id="${this.pendingMergeId}"]`)?.remove();
            this.hideModal();
        } catch (error) {
            console.error('Merge failed:', error);
            alert(error.message || 'Merge failed. Please try again.');
            this.hideModal();
        }
    }
```

`public/js/review.js:234-239`, reset the new state in `hideModal`:

```js
    hideModal() {
        this.modal?.classList.remove('show');
        this.modal?.classList.add('hidden');
        this.pendingMergeId = null;
        this.pendingDocumentIds = null;
        this.pendingReverse = false;
        this.pendingInfo = null;
    }
```

- [ ] **Step 9: Manual verification**

Run: `npm run dev`, open `/review` in a browser with at least one open queue entry (or trigger a backfill scan first — "Scan existing tags" etc.). Click "Merge" on an entry: confirm the dialog shows both document counts in the text, and that toggling "Merge the other way round" changes the text (deleted/kept sides swap) without closing the modal. Cancel — no request should have executed a real merge.

Run: `npm test && npm run lint`
Expected: all tests pass, `0 problems`.

- [ ] **Step 10: Commit**

```bash
git add services/paperlessService.js services/entityBackfillService.js services/reviewQueueService.js routes/review.js views/review.ejs public/js/review.js test/entityBackfillService.test.js test/reviewQueueService.test.js
git commit -m "feat: make merge direction reversible, default to the side with more documents (3.1/B-3)"
```

---

### Task 2: Bestätigungsdialog zeigt den Sachverhalt (3.2, B-4)

**Files:**
- Modify: `views/review.ejs:125` (Judge column), `views/review.ejs` (merge modal, extends Task 1's markup)
- Modify: `public/js/review.js` (`buildPreviewSection` reuse, `renderMergePreview`)

**Interfaces:**
- Consumes: `GET /api/review/:id/documents` response shape from Task 1 (`{proposed: {name, documentCount, documents}, candidate: {...}}`), and the existing `buildPreviewSection(label, side)` method (`public/js/review.js:77-109`) which already expects exactly `{name, documents}` — `documentCount` is simply an extra field it ignores, no signature change needed.
- Produces: nothing new for later tasks.

**What this fixes, precisely:** today the confirm dialog only says `"X" will be deleted. N document(s) will be reassigned to "Y". Continue?` — Task 1 already added the document counts of both sides to that sentence. What's still missing is the **example document titles** (today locked behind a second click on the separate "Preview" eye-icon button) and the **Judge's reasoning being visible without hovering** (today a `title` attribute, unreachable on touch devices — `views/review.ejs:125`).

- [ ] **Step 1: Show example titles for both sides inside the merge confirm modal**

`public/js/review.js`, extend `renderMergePreview` (written in Task 1) to reuse the existing `buildPreviewSection` helper for both sides — replace the whole method:

```js
    renderMergePreview(preview) {
        const { proposed, candidate } = this.pendingInfo;
        const [fromSide, toSide] = this.pendingReverse ? [candidate, proposed] : [proposed, candidate];

        this.previewText.textContent = `"${fromSide.name}" (${fromSide.documentCount} document(s)) will be deleted. `
            + `${preview.affectedCount} document(s) will be reassigned to "${toSide.name}" (${toSide.documentCount} document(s)). Continue?`;

        this.previewExamples.replaceChildren(
            this.buildPreviewSection(`Deleted: "${fromSide.name}"`, fromSide),
            this.buildPreviewSection(`Kept: "${toSide.name}"`, toSide)
        );

        if (this.reverseToggle) this.reverseToggle.checked = this.pendingReverse;
    }
```

This is exactly the case the fixplan calls out (Trigram 0.769, one side a "Kfz-Versicherungspolice", the other an "Arbeitsvertrag"): both sides' example titles are now visible in the same modal the user is about to confirm in, no second click required.

- [ ] **Step 2: Make the Judge's reasoning visible text, not a hover title**

`views/review.ejs:125`, replace:

```html
<td<% if (entry.llm_reason) { %> title="<%= entry.llm_reason %>" class="cursor-help underline decoration-dotted"<% } %>><%= entry.llm_verdict || '-' %></td>
```

with:

```html
<td>
    <div class="judge-verdict"><%= entry.llm_verdict || '-' %></div>
    <% if (entry.llm_reason) { %><div class="judge-reason text-xs text-gray-400"><%= entry.llm_reason %></div><% } %>
</td>
```

(The `-` fallback here is superseded by Task 4's "nicht bewertet (Altbestands-Scan)" text — Task 4 changes this same line again; this step only removes the hover-only reasoning, Task 4 handles the dash. The `judge-verdict`/`judge-reason` classes are added now because Task 4's "Ask judge" button needs stable selectors to update this cell without a page reload.)

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. Open `/review`, click "Merge" on an entry whose candidate/proposed both have example documents (or run a backfill scan first to get such entries). Confirm: the modal shows two labeled sections ("Deleted: ..." / "Kept: ...") each listing up to 3 document titles as links, without opening the separate preview modal. Confirm the Judge column in the table now shows the reasoning as plain text under the verdict, for any live-scan entry that has one.

Run: `npm test && npm run lint`
Expected: unchanged (this task touches no service/model code) — both green.

- [ ] **Step 4: Commit**

```bash
git add views/review.ejs public/js/review.js
git commit -m "feat: show document counts, example titles, and visible judge reasoning in the merge dialog (3.2/B-4)"
```

---

### Task 3: Alias-Ansicht mit Löschfunktion, Statusfilter für die Queue (3.3, A-6, B-8)

**Files:**
- Modify: `models/entityStore.js:149-158` (new methods after `deleteAlias`), `:297-356` (`listOpenQueueEntries`/`countOpenQueueEntries`)
- Modify: `routes/review.js:40-78` (status whitelist, `GET /review`), new routes for aliases
- Modify: `views/review.ejs` (status filter control, tab link to aliases)
- Create: `views/review-aliases.ejs`
- Create: `public/js/review-aliases.js`
- Test: `test/entityStore.test.js`

**Interfaces:**
- Consumes: `paperlessService.getDocumentCountForEntity(type, id)` from Task 1.
- Produces: `EntityStore.listAliases({entityType})`, `EntityStore.deleteAliasById(id)` — used only by the new routes in this task, no other task depends on them.

**Why this is the smallest reversible-decision fix (E-5-style argument from the fixplan):** `entity_aliases` (22 rows), completed queue entries (27), and `entity_merge_log` (23, 5 `failed`) exist only in the database today — `EntityStore.deleteAlias` (`models/entityStore.js:149-158`) already exists but is only ever called internally when an alias's target no longer exists (`services/entityResolver.js:26-35`, dead-alias cleanup). This is also explicitly where the fixplan deferred the four leftover dead aliases from Paket 1 (fixplan lines 518-531): `invoice contract` → `contract`, `personal nr <Nr>` → "Personal-Nr. …", two `herrn <inhaber>` aliases → "Herr <Inhaber>" — all now point at deleted entities.

- [ ] **Step 1: Add `listAliases`/`deleteAliasById` to `EntityStore`**

Insert after `deleteAlias` (`models/entityStore.js:149-158`):

```js
  listAliases({ entityType = null } = {}) {
    try {
      const params = [];
      let sql = `SELECT * FROM entity_aliases`;
      if (entityType) {
        sql += ` WHERE entity_type = ?`;
        params.push(entityType);
      }
      sql += ` ORDER BY entity_type ASC, alias_normalized ASC`;
      return this.db.prepare(sql).all(...params);
    } catch (error) {
      console.error('[ERROR] entityStore.listAliases:', error.message);
      return [];
    }
  }

  deleteAliasById(id) {
    try {
      const result = this.db.prepare(`DELETE FROM entity_aliases WHERE id = ?`).run(id);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] entityStore.deleteAliasById:', error.message);
      return false;
    }
  }
```

- [ ] **Step 2: Write the failing tests**

Add to `test/entityStore.test.js` (matching the existing `freshStore()`/`test(...)` pattern at the top of the file):

```js
test('listAliases liefert alle Aliase sortiert nach Typ und Name', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'zeugniss', canonicalName: 'Zeugnis', canonicalId: 20, source: 'user' });
  store.insertAlias({ entityType: 'correspondent', aliasNormalized: 'herrn inhaber', canonicalName: 'Herr Inhaber', canonicalId: 5, source: 'auto' });

  const result = store.listAliases();
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].entity_type, 'correspondent');
  assert.strictEqual(result[1].entity_type, 'tag');
});

test('listAliases filtert nach entityType', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'zeugniss', canonicalName: 'Zeugnis', canonicalId: 20, source: 'user' });
  store.insertAlias({ entityType: 'correspondent', aliasNormalized: 'herrn inhaber', canonicalName: 'Herr Inhaber', canonicalId: 5, source: 'auto' });

  const result = store.listAliases({ entityType: 'tag' });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].alias_normalized, 'zeugniss');
});

test('deleteAliasById entfernt genau die passende Zeile und liefert true', () => {
  const store = freshStore();
  store.insertAlias({ entityType: 'tag', aliasNormalized: 'zeugniss', canonicalName: 'Zeugnis', canonicalId: 20, source: 'user' });
  const [row] = store.listAliases();

  const deleted = store.deleteAliasById(row.id);

  assert.strictEqual(deleted, true);
  assert.strictEqual(store.listAliases().length, 0);
});

test('deleteAliasById liefert false fuer eine unbekannte id', () => {
  const store = freshStore();
  assert.strictEqual(store.deleteAliasById(9999), false);
});
```

- [ ] **Step 3: Run, confirm pass**

Run: `node --test test/entityStore.test.js`
Expected: all pass, including the four new ones.

- [ ] **Step 4: Generalize the queue status filter in `EntityStore`**

`models/entityStore.js:297-316`, replace `listOpenQueueEntries`:

```js
  // Der Name ist historisch (urspruenglich nur fuer status='open') - die Methode filtert seit
  // 3.3 nach einem beliebigen, vom Aufrufer als Whitelist geprueften Status (siehe QUEUE_STATUSES
  // in routes/review.js), der Default bleibt aus Kompatibilitaetsgruenden 'open'.
  listOpenQueueEntries({ entityType = null, status = 'open', sort = 'created_at_asc', limit = null, offset = 0 } = {}) {
    try {
      const orderBy = QUEUE_SORT_COLUMNS[sort] || QUEUE_SORT_COLUMNS.created_at_asc;
      const params = [status];
      let sql = `SELECT * FROM entity_review_queue WHERE status = ?`;
      if (entityType) {
        sql += ` AND entity_type = ?`;
        params.push(entityType);
      }
      sql += ` ORDER BY ${orderBy}`;
      if (limit != null) {
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limit, offset);
      }
      return this.db.prepare(sql).all(...params);
    } catch (error) {
      console.error('[ERROR] entityStore.listOpenQueueEntries:', error.message);
      return [];
    }
  }
```

`models/entityStore.js:343-356`, replace `countOpenQueueEntries`:

```js
  countOpenQueueEntries({ entityType = null, status = 'open' } = {}) {
    try {
      const params = [status];
      let sql = `SELECT COUNT(*) as count FROM entity_review_queue WHERE status = ?`;
      if (entityType) {
        sql += ` AND entity_type = ?`;
        params.push(entityType);
      }
      return this.db.prepare(sql).get(...params).count;
    } catch (error) {
      console.error('[ERROR] entityStore.countOpenQueueEntries:', error.message);
      return 0;
    }
  }
```

`services/reviewQueueService.js:7-13` (`listOpen`/`countOpen`) already forward `options` verbatim to the store — no change needed there.

- [ ] **Step 5: Write the failing tests for the status filter**

Add to `test/entityStore.test.js`:

```js
test('listOpenQueueEntries mit status="merged" liefert nur merged-Eintraege', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'A', proposedId: 1, candidateName: 'B', candidateId: 2, similarity: 0.9, status: 'open' });
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'C', proposedId: 3, candidateName: 'D', candidateId: 4, similarity: 0.9, status: 'merged' });

  const result = store.listOpenQueueEntries({ status: 'merged' });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].proposed_name, 'C');
});

test('listOpenQueueEntries ohne status-Option verhaelt sich wie bisher (nur open)', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'A', proposedId: 1, candidateName: 'B', candidateId: 2, similarity: 0.9, status: 'open' });
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'C', proposedId: 3, candidateName: 'D', candidateId: 4, similarity: 0.9, status: 'rejected' });

  const result = store.listOpenQueueEntries();
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].proposed_name, 'A');
});

test('countOpenQueueEntries mit status="rejected" zaehlt nur rejected-Eintraege', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'A', proposedId: 1, candidateName: 'B', candidateId: 2, similarity: 0.9, status: 'open' });
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'C', proposedId: 3, candidateName: 'D', candidateId: 4, similarity: 0.9, status: 'rejected' });

  assert.strictEqual(store.countOpenQueueEntries({ status: 'rejected' }), 1);
});
```

- [ ] **Step 6: Run, confirm pass, run full suite**

Run: `node --test test/entityStore.test.js`
Expected: all pass.

Run: `npm test`
Expected: green (this changes shared methods — confirm nothing else regressed).

- [ ] **Step 7: Wire the status filter and the alias routes into `routes/review.js`**

`routes/review.js:1-9`, add the alias service is already available via `store` — no new import needed beyond what's there.

`routes/review.js:40-42`, add the whitelist next to `QUEUE_SORTS`:

```js
const QUEUE_SORTS = ['created_at_asc', 'created_at_desc', 'similarity_asc', 'similarity_desc'];
const QUEUE_STATUSES = ['open', 'merged', 'rejected'];
const REVIEW_PAGE_SIZE = 25;
```

`routes/review.js:44-78`, replace `GET /review`:

```js
router.get('/review', isAuthenticated, (req, res) => {
  const { reviewQueueService } = getServices();

  const entityType = ENTITY_TYPES.includes(req.query.entityType) ? req.query.entityType : null;
  const status = QUEUE_STATUSES.includes(req.query.status) ? req.query.status : 'open';
  const sort = QUEUE_SORTS.includes(req.query.sort) ? req.query.sort : 'created_at_asc';
  const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);

  const total = reviewQueueService.countOpen({ entityType, status });
  const totalPages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);

  const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
  const queue = reviewQueueService.listOpen({
    entityType, status, sort, limit: REVIEW_PAGE_SIZE, offset: (currentPage - 1) * REVIEW_PAGE_SIZE
  }).map(entry => ({
    ...entry,
    documentLink: entry.document_id ? `${baseURL}/documents/${entry.document_id}/` : null
  }));

  const pageUrl = (targetPage) => {
    const params = new URLSearchParams();
    if (entityType) params.set('entityType', entityType);
    if (status !== 'open') params.set('status', status);
    if (sort !== 'created_at_asc') params.set('sort', sort);
    params.set('page', targetPage);
    return `/review?${params.toString()}`;
  };

  res.render('review', {
    queue, version: config.PAPERLESS_AI_VERSION || ' ',
    entityType, status, sort, entityTypes: ENTITY_TYPES, statuses: QUEUE_STATUSES,
    currentPage, totalPages, total,
    prevPageUrl: pageUrl(Math.max(1, currentPage - 1)),
    nextPageUrl: pageUrl(Math.min(totalPages, currentPage + 1))
  });
});
```

`routes/review.js`, add two new routes (after the existing `POST /api/review/bulk-reject`, before `module.exports`):

```js
router.get('/review/aliases', isAuthenticated, async (req, res) => {
  const { store } = getServices();
  const aliases = store.listAliases();

  const counts = await Promise.all(
    aliases.map(alias => paperlessService.getDocumentCountForEntity(alias.entity_type, alias.canonical_id).catch(() => null))
  );

  res.render('review-aliases', {
    version: config.PAPERLESS_AI_VERSION || ' ',
    aliases: aliases.map((alias, i) => ({ ...alias, targetDocumentCount: counts[i] }))
  });
});

router.delete('/api/review/aliases/:id', authenticateJWT, (req, res) => {
  const { store } = getServices();
  const id = Number(req.params.id);

  const deleted = store.deleteAliasById(id);
  if (!deleted) {
    return res.status(404).json({ message: `No alias with id=${id}` });
  }
  res.json({ id, deleted: true });
});
```

`counts.map(... .catch(() => null))`: an alias whose `canonical_id` was deleted by a later Paperless-side operation (exactly the four dead aliases from fixplan lines 518-531) must not break the whole page — `targetDocumentCount: null` renders as "unknown" in the view (Step 8), which is itself useful signal that the alias is dead and should be deleted.

- [ ] **Step 8: Add the status filter control and an "Aliases" tab link to `views/review.ejs`**

`views/review.ejs:44-50`, add a nav entry (in the existing `<nav class="sidebar-nav">` list, right after the Review Queue link):

```html
                    <li><a href="/review" class="sidebar-link active"><i class="fa-solid fa-code-compare"></i><span>Review Queue</span></a></li>
                    <li><a href="/review/aliases" class="sidebar-link"><i class="fa-solid fa-link"></i><span>Aliases</span></a></li>
```

`views/review.ejs:68-89`, add a status `<select>` to the filter form and use `statuses`/`status`:

```html
                <div class="material-card mb-6">
                    <form method="GET" action="/review" class="flex flex-wrap items-end gap-4 p-4">
                        <div>
                            <label class="block text-sm mb-1" for="entityType">Type</label>
                            <select name="entityType" id="entityType" class="border rounded px-2 py-1">
                                <option value="">All</option>
                                <% entityTypes.forEach(function(type) { %>
                                <option value="<%= type %>" <%= entityType === type ? 'selected' : '' %>><%= type %></option>
                                <% }); %>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm mb-1" for="status">Status</label>
                            <select name="status" id="status" class="border rounded px-2 py-1">
                                <% statuses.forEach(function(s) { %>
                                <option value="<%= s %>" <%= status === s ? 'selected' : '' %>><%= s %></option>
                                <% }); %>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm mb-1" for="sort">Sort</label>
                            <select name="sort" id="sort" class="border rounded px-2 py-1">
                                <option value="created_at_asc" <%= sort === 'created_at_asc' ? 'selected' : '' %>>Oldest first</option>
                                <option value="created_at_desc" <%= sort === 'created_at_desc' ? 'selected' : '' %>>Newest first</option>
                                <option value="similarity_asc" <%= sort === 'similarity_asc' ? 'selected' : '' %>>Similarity: low to high</option>
                                <option value="similarity_desc" <%= sort === 'similarity_desc' ? 'selected' : '' %>>Similarity: high to low</option>
                            </select>
                        </div>
                        <button type="submit" class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">Apply</button>
                        <span id="openEntriesCount" class="text-sm text-gray-400" data-status="<%= status %>"><%= total %> <%= status %> entries</span>
                    </form>
                </div>
```

`views/review.ejs:133-141`, the actions column only makes sense for `status === 'open'` rows — replace:

```html
                                    <td>
                                        <% if (entry.status === 'open') { %>
                                        <div class="flex gap-2">
                                            <button class="preview-btn px-3 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors" data-id="<%= entry.id %>" title="Preview">
                                                <i class="fa-solid fa-eye"></i>
                                                <span class="hidden sm:inline ml-1">Preview</span>
                                            </button>
                                            <button class="merge-btn px-3 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors" data-id="<%= entry.id %>">Merge</button>
                                            <button class="reject-btn px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors" data-id="<%= entry.id %>">Not a duplicate</button>
                                        </div>
                                        <% } else { %>
                                        <span class="text-gray-400 text-sm"><%= entry.status %><% if (entry.resolved_at) { %> (<%= entry.resolved_at.slice(0, 10) %>)<% } %></span>
                                        <% } %>
                                    </td>
```

- [ ] **Step 9: Create `views/review-aliases.ejs`**

Copy the sidebar/layout boilerplate from `views/review.ejs:1-53` verbatim (same `<head>`, sidebar nav — mark the Aliases link `active` instead of Review Queue this time), then:

```html
        <main class="main-content">
            <div class="content-wrapper">
                <div class="content-header flex justify-between items-center mb-6">
                    <h1 class="content-title">Aliases</h1>
                </div>

                <div class="material-card">
                    <div class="overflow-x-auto">
                        <table class="w-full" id="aliasTable">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Alias (source)</th>
                                    <th>Canonical (target)</th>
                                    <th>Target document count</th>
                                    <th>Source</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <% aliases.forEach(function(alias) { %>
                                <tr data-alias-id="<%= alias.id %>">
                                    <td><%= alias.entity_type %></td>
                                    <td><%= alias.alias_normalized %></td>
                                    <td><%= alias.canonical_name %></td>
                                    <td><%= alias.targetDocumentCount === null ? 'unknown (target deleted?)' : alias.targetDocumentCount %></td>
                                    <td><%= alias.source %></td>
                                    <td>
                                        <button class="delete-alias-btn px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors" data-id="<%= alias.id %>">Delete</button>
                                    </td>
                                </tr>
                                <% }); %>
                                <% if (aliases.length === 0) { %>
                                <tr><td colspan="6" class="text-center text-gray-400 py-6">No aliases</td></tr>
                                <% } %>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </main>
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
    <script src="js/csrf.js"></script>
    <script src="js/review-aliases.js"></script>
</body>
</html>
```

- [ ] **Step 10: Create `public/js/review-aliases.js`**

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

async function extractErrorMessage(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return body.message || fallback;
}

class AliasManager {
    constructor() {
        document.querySelectorAll('.delete-alias-btn').forEach(btn => {
            btn.addEventListener('click', () => this.deleteAlias(btn.dataset.id, btn));
        });
    }

    async deleteAlias(id, button) {
        const row = document.querySelector(`tr[data-alias-id="${id}"]`);
        const canonicalName = row?.children[2]?.textContent || 'this alias';
        if (!confirm(`Delete the alias pointing to "${canonicalName}"? The next matching pair will go through resolution again.`)) {
            return;
        }

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Deleting...';
        try {
            const response = await fetch(`/api/review/aliases/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Delete failed'));

            row?.remove();
        } catch (error) {
            console.error('Delete alias failed:', error);
            alert(error.message || 'Delete failed. Please try again.');
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.aliasManager = new AliasManager();
});
```

- [ ] **Step 11: Manual verification**

Run: `npm run dev`. Open `/review`, confirm the Status dropdown works (switch to "merged"/"rejected" and back, confirm the action buttons disappear for non-open rows and a status+date badge shows instead). Open `/review/aliases` from the sidebar, confirm it lists the current `entity_aliases` rows with a live target document count, and that "Delete" asks for confirmation and removes the row on success.

Run: `npm test && npm run lint`
Expected: both green.

- [ ] **Step 12: Commit**

```bash
git add models/entityStore.js routes/review.js views/review.ejs views/review-aliases.ejs public/js/review-aliases.js test/entityStore.test.js
git commit -m "feat: add an alias view with delete, and a status filter for the review queue (3.3/A-6, B-8)"
```

---

### Task 4: Erklären, warum ein Eintrag da ist (3.4, B-1, B-2)

**Files:**
- Modify: `routes/review.js` (thresholds in `GET /review`, doc-count columns, new `POST /api/review/:id/ask-judge`)
- Modify: `models/entityStore.js` (new `updateQueueJudgment`)
- Modify: `views/review.ejs` (threshold header, Documents column, Origin column, dash replacement, Ask-judge button)
- Modify: `public/js/review.js` (Ask-judge handler)
- Test: `test/entityStore.test.js`

**Interfaces:**
- Consumes: `paperlessService.getDocumentCountForEntity` (Task 1), `services/entityJudge.js` `judge(entityType, nameA, nameB): Promise<{verdict, reason}>` (`services/entityJudge.js:50`).
- Produces: `EntityStore.updateQueueJudgment(id, {verdict, reason})` — used only by the new route in this task.

- [ ] **Step 1: Add `EntityStore.updateQueueJudgment`**

Insert after `updateQueueStatus` (`models/entityStore.js:334-341`):

```js
  updateQueueJudgment(id, { verdict, reason }) {
    try {
      const result = this.db.prepare(`
        UPDATE entity_review_queue SET llm_verdict = ?, llm_reason = ? WHERE id = ?
      `).run(verdict, reason, id);
      return result.changes > 0;
    } catch (error) {
      console.error('[ERROR] entityStore.updateQueueJudgment:', error.message);
      return false;
    }
  }
```

- [ ] **Step 2: Write the failing test**

Add to `test/entityStore.test.js`:

```js
test('updateQueueJudgment schreibt verdict und reason und liefert true', () => {
  const store = freshStore();
  store.insertQueueEntry({ entityType: 'tag', proposedName: 'A', proposedId: 1, candidateName: 'B', candidateId: 2, similarity: 0.9, status: 'open' });
  const [entry] = store.listOpenQueueEntries();

  const ok = store.updateQueueJudgment(entry.id, { verdict: 'different', reason: 'unterschiedliche Begriffe' });

  assert.strictEqual(ok, true);
  const updated = store.getQueueEntryById(entry.id);
  assert.strictEqual(updated.llm_verdict, 'different');
  assert.strictEqual(updated.llm_reason, 'unterschiedliche Begriffe');
});

test('updateQueueJudgment liefert false fuer eine unbekannte id', () => {
  const store = freshStore();
  assert.strictEqual(store.updateQueueJudgment(9999, { verdict: 'same', reason: 'x' }), false);
});
```

- [ ] **Step 3: Run, confirm pass**

Run: `node --test test/entityStore.test.js`
Expected: all pass.

- [ ] **Step 4: Add the `/ask-judge` route**

`routes/review.js:1-9`, add the import:

```js
const entityJudge = require('../services/entityJudge');
```

`routes/review.js`, add after `POST /api/review/:id/reject` (before `POST /api/review/backfill/:entityType`):

```js
router.post('/api/review/:id/ask-judge', authenticateJWT, async (req, res) => {
  const { store } = getServices();
  const id = Number(req.params.id);
  const entry = store.getQueueEntryById(id);
  if (!entry) {
    return res.status(404).json({ message: `No queue entry with id=${id}` });
  }

  // Dieselbe Fehler-zu-'unavailable'-Abbildung wie entityResolver._askJudge (1.1.c) - ein
  // ausgefallener Judge ist keine Modellunsicherheit.
  let verdict;
  try {
    const result = await entityJudge.judge(entry.entity_type, entry.proposed_name, entry.candidate_name);
    verdict = (result && ['same', 'different', 'unsure'].includes(result.verdict))
      ? result
      : { verdict: 'unsure', reason: 'ungueltige oder leere Judge-Antwort' };
  } catch (error) {
    verdict = { verdict: 'unavailable', reason: `judge nicht erreichbar: ${error.message}` };
  }

  const updated = store.updateQueueJudgment(id, verdict);
  if (!updated) {
    return res.status(500).json({ message: 'Judge verdict could not be saved' });
  }
  res.json({ id, ...verdict });
});
```

- [ ] **Step 5: Add thresholds and per-row document counts to `GET /review`**

`routes/review.js`, `GET /review` becomes `async` (it now awaits per-row document counts) — replace the whole handler body from Task 3's Step 7 version:

```js
router.get('/review', isAuthenticated, async (req, res) => {
  const { reviewQueueService } = getServices();

  const entityType = ENTITY_TYPES.includes(req.query.entityType) ? req.query.entityType : null;
  const status = QUEUE_STATUSES.includes(req.query.status) ? req.query.status : 'open';
  const sort = QUEUE_SORTS.includes(req.query.sort) ? req.query.sort : 'created_at_asc';
  const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);

  const total = reviewQueueService.countOpen({ entityType, status });
  const totalPages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);

  const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
  const rawQueue = reviewQueueService.listOpen({
    entityType, status, sort, limit: REVIEW_PAGE_SIZE, offset: (currentPage - 1) * REVIEW_PAGE_SIZE
  });
  // Ein Live-Aufruf pro Seite und Entitaet (bis zu 2 * REVIEW_PAGE_SIZE Paperless-Requests) -
  // bei der aktuellen Bestandsgroesse (siehe Fixplan, 64 Dokumente) unkritisch. Sollte die
  // Instanz deutlich wachsen, ist das der erste Ort, an dem sich ein Cache lohnt.
  const queue = await Promise.all(rawQueue.map(async entry => ({
    ...entry,
    documentLink: entry.document_id ? `${baseURL}/documents/${entry.document_id}/` : null,
    proposedDocumentCount: entry.proposed_id
      ? await paperlessService.getDocumentCountForEntity(entry.entity_type, entry.proposed_id).catch(() => null)
      : 0,
    candidateDocumentCount: await paperlessService.getDocumentCountForEntity(entry.entity_type, entry.candidate_id).catch(() => null)
  })));

  const pageUrl = (targetPage) => {
    const params = new URLSearchParams();
    if (entityType) params.set('entityType', entityType);
    if (status !== 'open') params.set('status', status);
    if (sort !== 'created_at_asc') params.set('sort', sort);
    params.set('page', targetPage);
    return `/review?${params.toString()}`;
  };

  res.render('review', {
    queue, version: config.PAPERLESS_AI_VERSION || ' ',
    entityType, status, sort, entityTypes: ENTITY_TYPES, statuses: QUEUE_STATUSES,
    currentPage, totalPages, total,
    prevPageUrl: pageUrl(Math.max(1, currentPage - 1)),
    nextPageUrl: pageUrl(Math.min(totalPages, currentPage + 1)),
    thresholds: {
      autoThreshold: config.entityResolver.autoThreshold,
      judgeMin: config.entityResolver.judgeMin,
      embedJudgeMin: config.embedding.judgeMin
    },
    embeddingEnabled: config.embedding.enabled
  });
});
```

- [ ] **Step 6: Add the explanation header, Documents/Origin columns, and dash replacement to `views/review.ejs`**

`views/review.ejs`, insert a header block right after the `content-header` div (before the backfill-buttons row, `:61`):

```html
                <div class="material-card mb-6 p-4 text-sm">
                    <p class="mb-1"><strong>Trigram</strong> (0-1, string similarity): below <%= thresholds.judgeMin.toFixed(2) %> a pair never reaches the Judge; at or above <%= thresholds.autoThreshold.toFixed(2) %> it is merged automatically and never appears here.</p>
                    <p class="mb-1"><strong>Embedding</strong> (0-1, meaning similarity): only computed while embeddings are enabled (currently <%= embeddingEnabled ? 'on' : 'off' %>); feeds the Judge at or above <%= thresholds.embedJudgeMin.toFixed(2) %>.</p>
                    <p><strong>Judge</strong>: an LLM verdict (same/different/unsure/unavailable) requested for pairs that reach either threshold above. "unavailable" means the Judge could not be reached, not that it is unsure.</p>
                </div>
```

`views/review.ejs:104-116`, add two columns to the table header:

```html
                        <table class="w-full" id="reviewTable">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Proposed</th>
                                    <th>Candidate</th>
                                    <th>Documents</th>
                                    <th>Trigram</th>
                                    <th>Embedding</th>
                                    <th>Judge</th>
                                    <th>Origin</th>
                                    <th>Document</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
```

`views/review.ejs:118-132`, add the corresponding cells (Documents, Origin) and finish the dash replacement started in Task 2 (`views/review.ejs:125`):

```html
                                <% queue.forEach(function(entry) { %>
                                <tr data-queue-id="<%= entry.id %>">
                                    <td><%= entry.entity_type %></td>
                                    <td><%= entry.proposed_name %></td>
                                    <td><%= entry.candidate_name %></td>
                                    <td><%= entry.proposedDocumentCount == null ? '?' : entry.proposedDocumentCount %> / <%= entry.candidateDocumentCount == null ? '?' : entry.candidateDocumentCount %></td>
                                    <td><%= entry.trigram_similarity != null ? entry.trigram_similarity.toFixed(2) : (entry.embedding_similarity == null ? entry.similarity.toFixed(2) : '-') %></td>
                                    <td><%= entry.embedding_similarity != null ? entry.embedding_similarity.toFixed(2) : '-' %></td>
                                    <td>
                                        <div class="judge-verdict"><%= entry.llm_verdict || 'nicht bewertet (Altbestands-Scan)' %></div>
                                        <% if (entry.llm_reason) { %><div class="judge-reason text-xs text-gray-400"><%= entry.llm_reason %></div><% } %>
                                        <% if (!entry.llm_verdict) { %>
                                        <button class="ask-judge-btn text-xs text-blue-500 hover:underline mt-1" data-id="<%= entry.id %>">Ask judge</button>
                                        <% } %>
                                    </td>
                                    <td><%= entry.document_id ? 'Live scan' : 'Backfill' %></td>
```

(Leave the `Document`/`Actions` `<td>`s that follow unchanged — they are the ones already edited in Task 3 Step 8.)

- [ ] **Step 7: Wire the "Ask judge" button in `public/js/review.js`**

`public/js/review.js:35-48`, add the listener inside `initialize()`:

```js
        document.querySelectorAll('.ask-judge-btn').forEach(btn => {
            btn.addEventListener('click', () => this.askJudge(btn.dataset.id, btn));
        });
```

Add the method (near `backfill`, e.g. right after it):

```js
    async askJudge(id, button) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Asking...';
        try {
            const response = await fetch(`/api/review/${id}/ask-judge`, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Ask judge failed'));
            const result = await response.json();

            const row = document.querySelector(`tr[data-queue-id="${id}"]`);
            const verdictCell = row?.querySelector('.judge-verdict');
            const reasonCell = row?.querySelector('.judge-reason');
            if (verdictCell) verdictCell.textContent = result.verdict;
            if (reasonCell) reasonCell.textContent = result.reason || '';
            button.remove();
        } catch (error) {
            console.error('Ask judge failed:', error);
            alert(error.message || 'Ask judge failed. Please try again.');
            button.disabled = false;
            button.textContent = originalText;
        }
    }
```

- [ ] **Step 8: Manual verification**

Run: `npm run dev`. Open `/review`: confirm the threshold explanation block renders with the configured numbers, the Documents column shows two counts per row, the Origin column says "Live scan" or "Backfill" correctly (cross-check against `document_id` being set), and any backfill-origin row (no verdict) shows "nicht bewertet (Altbestands-Scan)" plus an "Ask judge" button. Click "Ask judge" on one such row (requires a reachable Ollama instance) and confirm the cell updates in place without a page reload.

Run: `npm test && npm run lint`
Expected: both green.

- [ ] **Step 9: Commit**

```bash
git add models/entityStore.js routes/review.js views/review.ejs public/js/review.js test/entityStore.test.js
git commit -m "feat: explain review queue entries - thresholds, document counts, origin, and a non-empty label for unscored backfill rows (3.4/B-1, B-2)"
```

---

### Task 5: Rückfrage vor Einzelablehnung und vor dem Altbestands-Scan (B-5, B-9)

**Files:**
- Modify: `public/js/review.js:164-193` (`reject`, `backfill`)

**Interfaces:** none — purely adds a `confirm()` gate in front of two already-existing calls.

**Why bundled:** both are the same shape of fix (a client-side action has a real, hard-to-undo cost and currently fires with zero confirmation) and touch adjacent lines in the same file.

- [ ] **Step 1: Confirm before a single "Not a duplicate"**

`views/review.ejs`, `reject-btn` today wires `.reject(id)` with no button reference — change `public/js/review.js:42-44` (inside `initialize()`) to pass the button (needed for Task 7's loading state too, do it now to avoid touching this line twice):

```js
        document.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', () => this.reject(btn.dataset.id, btn));
        });
```

`public/js/review.js:164-174`, replace `reject`:

```js
    async reject(id, button) {
        // B-5: heute keine Rueckfrage, obwohl die Ablehnung dauerhaft wirkt (Negativ-Cache) -
        // Bulk-Reject fragt bereits nach, die Einzelablehnung bisher nicht.
        if (!confirm('Mark this pair as "not a duplicate"? This is remembered permanently and will not be suggested again.')) {
            return;
        }
        try {
            const response = await fetch(`/api/review/${id}/reject`, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Reject failed'));

            document.querySelector(`tr[data-queue-id="${id}"]`)?.remove();
        } catch (error) {
            console.error('Reject failed:', error);
            alert(error.message || 'Reject failed. Please try again.');
        }
    }
```

- [ ] **Step 2: Confirm before triggering a backfill scan, with the O(n²) cost explained**

`public/js/review.js:176-193`, replace `backfill`:

```js
    async backfill(entityType, button) {
        // B-9: der Knopf erklaert heute nicht, dass er alle Paare vergleicht (quadratisch in
        // der Entitaetenzahl) und im Test 16 Eintraege auf einmal erzeugt hat.
        if (!confirm(`Compare every existing ${entityType} pair for near-duplicates? This checks all pairs (quadratic in the entity count) and can add many entries to the review queue.`)) {
            return;
        }
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Running...';
        try {
            const response = await fetch(`/api/review/backfill/${entityType}`, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Backfill scan failed'));
            const result = await response.json();
            alert(`${result.inserted} new entries found.`);
            if (result.inserted > 0) window.location.reload();
        } catch (error) {
            console.error('Backfill scan failed:', error);
            alert('Backfill scan failed. Please try again.');
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. Click "Not a duplicate" on an open entry — confirm a browser confirm dialog appears first, and canceling leaves the row untouched. Click one of the "Scan existing ..." buttons — confirm a confirm dialog appears explaining the quadratic cost, and canceling does not send a request (check devtools network tab).

Run: `npm test && npm run lint`
Expected: both green (no server-side code changed).

- [ ] **Step 4: Commit**

```bash
git add public/js/review.js
git commit -m "fix: confirm before a permanent single reject and before an O(n²) backfill scan (B-5, B-9)"
```

---

### Task 6: Gemeinsame Fehlermeldungs-Hilfsfunktion für alle sechs Client-Aufrufe (B-6)

**Files:**
- Modify: `public/js/review.js:59-75` (`showDocumentPreview`), `:195-227` (`bulkReject`) — `previewMerge`, `confirmMerge`, `reject`, `backfill`, and `askJudge` already use `extractErrorMessage` from Tasks 1, 4, and 5.

**Interfaces:** none — this task only finishes migrating the last two call sites onto the `extractErrorMessage` helper Task 1 introduced.

**Why last:** it depends on the helper existing (Task 1) and touches the two call sites Tasks 1/4/5 did not already have a reason to rewrite.

- [ ] **Step 1: `showDocumentPreview` shows the server's message**

`public/js/review.js:59-75`, replace:

```js
    async showDocumentPreview(id) {
        try {
            const response = await fetch(`/api/review/${id}/documents`);
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Failed to load example documents'));
            const data = await response.json();

            this.docPreviewContent.replaceChildren(
                this.buildPreviewSection('Proposed', data.proposed),
                this.buildPreviewSection('Candidate', data.candidate)
            );
            this.docPreviewModal?.classList.remove('hidden');
            this.docPreviewModal?.classList.add('show');
        } catch (error) {
            console.error('Failed to load example documents:', error);
            alert(error.message || 'Failed to load example documents. Please try again.');
        }
    }
```

- [ ] **Step 2: `bulkReject` reuses the shared helper instead of its own inline duplicate**

`public/js/review.js:195-227`, replace the body-parsing line inside the `try` block:

```js
            const response = await fetch('/api/review/bulk-reject', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ entityType, maxSimilarity })
            });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Bulk reject failed'));
            const result = await response.json();
```

(leave the rest of `bulkReject` — the `confirm()` call above it and the success `alert`/`reload` below — unchanged.)

- [ ] **Step 3: Manual verification**

Run: `npm run dev`. Trigger each of the six flows once against a stopped/unreachable backend condition if practical (e.g. temporarily stop the Paperless connection, or just inspect the code path), or at minimum confirm via a quick `grep -n "extractErrorMessage" public/js/review.js` that all six methods (`showDocumentPreview`, `previewMerge`, `confirmMerge`, `reject`, `backfill`, `bulkReject`) now call it — matching Paket 3's acceptance criterion 5.

Run: `npm test && npm run lint`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add public/js/review.js
git commit -m "fix: show the server's actual error message for all six review-page client calls (B-6)"
```

---

### Task 7: Ladezustände bei Merge/Reject und ein lebender Zähler (B-7)

**Files:**
- Modify: `public/js/review.js` (`confirmMerge`, `reject`)

**Interfaces:** none.

- [ ] **Step 1: Add a `decrementCounter` helper and call it after a successful reject/merge**

Add the method to `ReviewManager` (e.g. right after `hideModal`):

```js
    decrementCounter() {
        // Nur der offene Zaehler ist nach einem Merge/Reject noch gueltig - bei einem anderen
        // Statusfilter (3.3) veraendert eine dieser Aktionen die angezeigte Menge gar nicht.
        const counter = document.getElementById('openEntriesCount');
        if (!counter || counter.dataset.status !== 'open') return;
        const match = counter.textContent.match(/^(\d+)/);
        if (!match) return;
        const remaining = Math.max(0, parseInt(match[1], 10) - 1);
        counter.textContent = counter.textContent.replace(/^\d+/, String(remaining));
    }
```

- [ ] **Step 2: Loading state and counter update for `confirmMerge`**

Replace `confirmMerge` (as it stands after Task 1/2):

```js
    async confirmMerge() {
        if (!this.pendingMergeId) return;
        const originalText = this.confirmBtn.textContent;
        this.confirmBtn.disabled = true;
        this.confirmBtn.textContent = 'Merging...';
        try {
            const response = await fetch(`/api/review/${this.pendingMergeId}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ dryRun: false, documentIds: this.pendingDocumentIds, reverse: this.pendingReverse })
            });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Merge failed'));

            document.querySelector(`tr[data-queue-id="${this.pendingMergeId}"]`)?.remove();
            this.decrementCounter();
            this.hideModal();
        } catch (error) {
            console.error('Merge failed:', error);
            alert(error.message || 'Merge failed. Please try again.');
            this.hideModal();
        } finally {
            this.confirmBtn.disabled = false;
            this.confirmBtn.textContent = originalText;
        }
    }
```

- [ ] **Step 3: Loading state and counter update for `reject`**

Replace `reject` (as it stands after Task 5):

```js
    async reject(id, button) {
        if (!confirm('Mark this pair as "not a duplicate"? This is remembered permanently and will not be suggested again.')) {
            return;
        }
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Rejecting...';
        try {
            const response = await fetch(`/api/review/${id}/reject`, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Reject failed'));

            document.querySelector(`tr[data-queue-id="${id}"]`)?.remove();
            this.decrementCounter();
        } catch (error) {
            console.error('Reject failed:', error);
            alert(error.message || 'Reject failed. Please try again.');
            button.disabled = false;
            button.textContent = originalText;
        }
    }
```

(`button.disabled`/`textContent` are only reset in the `catch` branch here, not a `finally` — on success the row is removed from the DOM entirely, so there is no button left to re-enable.)

- [ ] **Step 4: Manual verification**

Run: `npm run dev`. Open `/review` with at least 2 open entries, note the "N open entries" count. Reject one — confirm the button showed "Rejecting..." briefly, the row disappeared, and the counter decremented by exactly one without a page reload. Merge another — confirm the "Merge permanently" button showed "Merging..." while the request was in flight, and the counter decremented again.

Run: `npm test && npm run lint`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add public/js/review.js
git commit -m "feat: add loading states to merge/reject and keep the entry counter live (B-7)"
```

---

## Out of scope for this plan

The fixplan's "Kleinere Punkte" table (3.5, lines 682-693) lists four more findings this plan deliberately does **not** implement, because none of them touch the three review-UI files this package is scoped to, and none are part of Paket 3's five acceptance criteria (fixplan lines 695-705):

- **B-10** (`USE_EXISTING_DATA` label/help text) and **B-11** (unset thresholds rendered as real values; `EMBEDDING_EXCLUDED_TYPES`/`DOCUMENT_FINGERPRINT_MODE`/`FINGERPRINT_SIMILARITY_THRESHOLD` missing from `routes/settingsFormMapping.js`) and **B-12** (stale fingerprint warning text) all live in `views/settings.ejs` / `routes/settingsFormMapping.js` — a different page, a different concern (global configuration, not the review queue), with its own risk profile (B-11 in particular needs to decide what an "unset" threshold should render as, which is a small design decision of its own, not a mechanical fix).
- **B-13** (all twelve views load Tailwind/Font Awesome from a CDN) touches every view in the app, not just the three review-UI files, and is an infrastructure change (self-hosting or bundling frontend assets) orthogonal to the review/merge workflow this package fixes.

These four are good candidates for a small follow-up package once Paket 3 is accepted, but bundling them here would violate this plan's own scope boundary (`views/review.ejs`, `public/js/review.js`, `routes/review.js` and direct collaborators only) for no shared benefit — B-10/B-11/B-12/B-13 do not depend on anything in Tasks 1-7, and Tasks 1-7 do not depend on them.

## Self-review against the fixplan's five acceptance criteria (lines 695-705)

1. *"Ein Merge lässt sich in beiden Richtungen auslösen; die Vorbelegung folgt der Dokumentzahl."* → Task 1 (reverse toggle + default from live document counts) + Task 1 Step 2 (backfill's own canonical selection now also follows document count, not just the UI default).
2. *"Der Bestätigungsdialog nennt die Dokumentzahl beider Seiten und zeigt Beispieltitel, ohne dass ein zweites Modal nötig ist."* → Task 1 Step 8 (counts in the text) + Task 2 (example titles via reused `buildPreviewSection`, same modal).
3. *"Ein Alias lässt sich in der Oberfläche einsehen und löschen; die Wirkung ist an einem Testfall belegt."* → Task 3 (`/review/aliases`, `deleteAliasById`, tested in `test/entityStore.test.js`).
4. *"Ein Altbestands-Eintrag ist als 'nicht bewertet' erkennbar, nicht als leeres Ergebnis."* → Task 4 Step 6 (`entry.llm_verdict || 'nicht bewertet (Altbestands-Scan)'`).
5. *"Alle sechs Client-Aufrufe zeigen die Servermeldung."* → Tasks 1, 4, 5, 6 collectively migrate `previewMerge`, `confirmMerge`, `askJudge`, `reject`, `backfill`, `showDocumentPreview`, `bulkReject` onto `extractErrorMessage` (seven methods total, six of which are the fixplan's named six client calls — `askJudge` is new in this plan and gets the same treatment for consistency, not because it's one of the original six).

No task references a type, method, or field not defined by an earlier task in this plan or already present in the codebase as read during planning (verified: `mergeEntity`, `getExampleDocumentsForEntity`, `listDocumentTypesWithCounts`, `config.entityResolver.*`, `config.embedding.*`, `entityJudge.judge`, and the `entity_aliases`/`entity_review_queue` schemas were all read directly from the current source, not assumed).
