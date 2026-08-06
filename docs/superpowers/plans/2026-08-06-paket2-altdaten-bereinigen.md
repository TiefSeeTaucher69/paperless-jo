# Paket 2 — Altdaten bereinigen: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute [docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md](../../audit/2026-08-06-fixplan-konsistenz-und-review-ui.md)'s Paket 2 ("Altdaten bereinigen", lines 411–523): reduce Paperless-ngx's data sprawl (28 document types → <15 with none empty, `contract` gone, correspondent names clean) as a scripted, dry-run-first, reversible tool, per [docs/superpowers/specs/2026-08-06-paket2-altdaten-bereinigen-design.md](../specs/2026-08-06-paket2-altdaten-bereinigen-design.md).

**Architecture:** Three small additions to `services/paperlessService.js` (`deleteEmptyEntity`, `clearAndDeleteEntity`, `listDocumentTypesWithCounts`), each unit-tested the same way the existing `mergeEntity` is. One new standalone script, `scripts/cleanup-legacy-vocabulary.js` (same convention as `scripts/measure-judge-latency.js`), that resolves a hardcoded mapping table against the live Paperless instance, prints a preview table, and only mutates data with `--apply`. No new subsystems, no server changes.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, `axios` (via `paperlessService`'s existing client), `better-sqlite3` (read-only, for the `entity_merge_log`/`entity_review_queue` lookup in Task 4).

## Global Constraints

- Test runner: `npm test` → `node --test test/*.test.js`. Baseline at plan start: all green (Paket 1 accepted, see fixplan line 39–65).
- Lint: `npm run lint` → `eslint . --max-warnings=0`. Baseline: `0 problems`.
- **Never print, log, or commit real values from `data/.env`.** It holds the live Paperless token and Ollama URL (`CLAUDE.md`). Where a task reads `data/.env`, use a targeted `grep`/`sed` on one known key, never a full read/cat.
- Every task that changes repo files ends with `npm test` and `npm run lint` both clean, then one commit for that task's changes. Tasks that only touch operational state outside the repo (backups, live Paperless data) have no commit — noted explicitly in the task.
- German inline comments in this codebase explain **why**, not what — match that style in any new comment.
- **This plan mutates production data** (the live Paperless-ngx instance backing this project) from Task 4 onward. Task 1's backups are a hard prerequisite — do not start Task 4 without them.

---

### Task 1: Vorbedingungen (2.0) — Sicherungen und Verarbeitungsstopp

**Files:** none inside the repo (operational step only).

**Interfaces:** none.

**Why:** the fixplan's own acceptance criterion 4 requires provable backups outside the project directory before any destructive step runs (line 462–464, 520–521).

- [ ] **Step 1: Confirm Paket 1 is accepted**

Read the fixplan's Paket-1 section (lines 36–65): confirm the checkbox is `[x]` and all five acceptance criteria are marked fulfilled. This plan must not start otherwise.

- [ ] **Step 2: Confirm the two SQLite databases exist**

Run (Bash):
```bash
ls -la data/documents.db data/entities.db
```
Expected: both files listed with a non-zero size.

- [ ] **Step 3: Create a dated backup directory outside the project**

Run (Bash):
```bash
mkdir -p ../paperless-jo-backups/2026-08-06
```

- [ ] **Step 4: Copy both databases there**

Run (Bash):
```bash
cp data/documents.db data/entities.db ../paperless-jo-backups/2026-08-06/
ls -la ../paperless-jo-backups/2026-08-06/
```
Expected: `documents.db` and `entities.db` listed, sizes matching Step 2's `data/` originals.

- [ ] **Step 5: Confirm automatic processing stays disabled**

Run (Bash):
```bash
grep '^DISABLE_AUTOMATIC_PROCESSING=' data/.env
```
Expected output: `DISABLE_AUTOMATIC_PROCESSING=yes`. (This is a feature toggle, not a credential — safe to display on its own, per the same convention Paket 1 Task 10 used for `USE_EXISTING_DATA`.) If it prints `no` or nothing, set it before continuing:
```bash
sed -i 's/^DISABLE_AUTOMATIC_PROCESSING=.*/DISABLE_AUTOMATIC_PROCESSING=yes/' data/.env
grep '^DISABLE_AUTOMATIC_PROCESSING=' data/.env
```
**Why this matters here:** every task below calls the live Paperless API through the running server process; if automatic processing were enabled, a server (re)start during this plan could kick off a scan concurrently with the cleanup script and race it.

No commit for this task — it changes nothing inside the repository (the backups intentionally live outside `data/`, which is itself gitignored).

---

### Task 2: `paperlessService`-Ergänzungen (`deleteEmptyEntity`, `clearAndDeleteEntity`, `listDocumentTypesWithCounts`)

**Files:**
- Modify: `services/paperlessService.js` (after `mergeEntity`, i.e. after line 1549; and after `listDocumentTypesNames`, i.e. after line 736)
- Test: `test/paperlessMergeEntity.test.js`, `test/paperlessListOrdering.test.js`

**Interfaces:**
- Consumes: `this._findDocumentsWithEntity(type, id)`, `this._bulkReassignDocuments(type, documentIds, fromId, toId)` (both existing, unchanged).
- Produces:
  - `deleteEmptyEntity(type, id): Promise<{ deleted: true }>` — throws if the entity still has documents.
  - `clearAndDeleteEntity(type, id): Promise<{ affectedCount: number, deleted: true }>` — `type` must be `'correspondent'` or `'document_type'`.
  - `listDocumentTypesWithCounts(): Promise<{ id, name, document_count }[]>`.

**Why these three and not more:** `mergeEntity` already covers every 2.1 case that reassigns documents onto a live target (the `contract`→`Entgeltabrechnung` merge, the DE/EN pairs). The two cases with no target — 7 zero-document document types (delete only) and correspondents to remove entirely (clear then delete, not merge) — have no existing method. `listDocumentTypesWithCounts` exists because `listDocumentTypesNames()` (line 695) deliberately strips `document_count` and is asserted verbatim by an existing test (`test/paperlessListOrdering.test.js:28`) — adding a field there would break that test's `deepStrictEqual`. Tags and correspondents don't need an equivalent addition: `getTags()` (line 555) already returns raw objects with `id`/`document_count`, and `listCorrespondentsNames()` (line 645) already includes `document_count` in its mapped output.

- [ ] **Step 1: Write the failing tests for `deleteEmptyEntity`**

In `test/paperlessMergeEntity.test.js`, add after the last `mergeEntity`-related test (after line 406, before the `getOpenReviewQueueCount` test):

```js
test('deleteEmptyEntity loescht eine Entitaet ohne Dokumente', async () => {
  const calls = [];
  const mockClient = {
    get: async (url) => {
      calls.push(url);
      return { data: { results: [], next: null } };
    },
    delete: async (url) => { calls.push('DELETE ' + url); return { data: {} }; }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.deleteEmptyEntity('document_type', 42)
  );

  assert.deepStrictEqual(result, { deleted: true });
  assert.deepStrictEqual(calls, ['/documents/', 'DELETE /document_types/42/']);
});

test('deleteEmptyEntity wirft, wenn die Entitaet noch Dokumente hat, und loescht nicht', async () => {
  const mockClient = {
    get: async () => ({ data: { results: [{ id: 1 }], next: null } }),
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.deleteEmptyEntity('tag', 7)),
    /hat noch 1 Dokument/
  );
});

test('deleteEmptyEntity behandelt 404 beim Loeschen als bereits erledigt', async () => {
  const mockClient = {
    get: async () => ({ data: { results: [], next: null } }),
    delete: async () => {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      throw error;
    }
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.deleteEmptyEntity('correspondent', 99)
  );
  assert.deepStrictEqual(result, { deleted: true });
});

test('deleteEmptyEntity wirft bei ungueltiger id, ohne HTTP-Request', async () => {
  const mockClient = {
    get: async () => { throw new Error('get haette nicht aufgerufen werden duerfen'); },
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.deleteEmptyEntity('tag', 0)),
    /ungueltige id/
  );
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: FAIL — `paperlessService.deleteEmptyEntity is not a function`.

- [ ] **Step 3: Implement `deleteEmptyEntity`**

In `services/paperlessService.js`, add after `mergeEntity` (after line 1549, before `getExampleDocumentsForEntity`):

```js
  // 2.1.2 (Fixplan Paket 2): sieben Dokumentarten ohne Dokumente sind reine
  // Merge-Rueckstaende vom 2026-08-05 - kein Reassignment noetig, nur eine verifizierte
  // Loeschung. Die Leer-Pruefung laeuft live gegen den Bestand (nicht gegen einen
  // zwischenzeitlich veralteten document_count-Wert), sonst koennte ein Dokument
  // mitgeloescht werden, das seither hinzukam.
  async deleteEmptyEntity(type, id) {
    this.initialize();
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`deleteEmptyEntity: ungueltige id (${id})`);
    }

    const remaining = await this._findDocumentsWithEntity(type, id);
    if (remaining.length > 0) {
      throw new Error(`deleteEmptyEntity: ${type} ${id} hat noch ${remaining.length} Dokument(e), keine Leerloeschung moeglich`);
    }

    try {
      await this.client.delete(`/${type}s/${id}/`);
    } catch (error) {
      if (error.response?.status !== 404) {
        throw error;
      }
      // bereits geloescht (z.B. durch einen frueheren Lauf) - kein Fehler.
    }

    return { deleted: true };
  }
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Write the failing tests for `clearAndDeleteEntity`**

In `test/paperlessMergeEntity.test.js`, add directly after the `deleteEmptyEntity` tests:

```js
test('clearAndDeleteEntity setzt den Korrespondenten der betroffenen Dokumente auf null und loescht ihn danach', async () => {
  let getCallCount = 0;
  const bulkEditCalls = [];
  const mockClient = {
    get: async () => {
      getCallCount++;
      return getCallCount === 1
        ? { data: { results: [{ id: 20 }], next: null } }
        : { data: { results: [], next: null } };
    },
    post: async (url, body) => { bulkEditCalls.push({ url, body }); return { data: {} }; },
    delete: async (url) => ({ data: {}, url })
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.clearAndDeleteEntity('correspondent', 15)
  );

  assert.deepStrictEqual(result, { affectedCount: 1, deleted: true });
  assert.strictEqual(bulkEditCalls.length, 1);
  assert.strictEqual(bulkEditCalls[0].url, '/documents/bulk_edit/');
  assert.deepStrictEqual(bulkEditCalls[0].body, {
    documents: [20],
    method: 'set_correspondent',
    parameters: { correspondent: null }
  });
});

test('clearAndDeleteEntity loescht ohne bulk_edit, wenn die Entitaet schon keine Dokumente hat', async () => {
  const mockClient = {
    get: async () => ({ data: { results: [], next: null } }),
    post: async () => { throw new Error('post haette nicht aufgerufen werden duerfen'); },
    delete: async () => ({ data: {} })
  };

  const result = await withMockClient(mockClient, () =>
    paperlessService.clearAndDeleteEntity('correspondent', 16)
  );
  assert.deepStrictEqual(result, { affectedCount: 0, deleted: true });
});

test('clearAndDeleteEntity wirft, wenn nach dem Leeren noch Dokumente uebrig sind', async () => {
  const mockClient = {
    get: async () => ({ data: { results: [{ id: 30 }], next: null } }), // bleibt bei jedem Aufruf gleich
    post: async () => ({ data: {} }),
    delete: async () => { throw new Error('delete haette nicht aufgerufen werden duerfen'); }
  };

  await assert.rejects(
    () => withMockClient(mockClient, () => paperlessService.clearAndDeleteEntity('correspondent', 17)),
    /noch 1 Dokument/
  );
});

test('clearAndDeleteEntity behandelt 404 beim Loeschen als bereits erledigt', async () => {
  const mockClient = {
    get: async () => ({ data: { results: [], next: null } }),
    delete: async () => {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      throw error;
    }
  };
  const result = await withMockClient(mockClient, () =>
    paperlessService.clearAndDeleteEntity('correspondent', 18)
  );
  assert.deepStrictEqual(result, { affectedCount: 0, deleted: true });
});

test('clearAndDeleteEntity wirft bei nicht unterstuetztem Typ "tag"', async () => {
  await assert.rejects(
    () => paperlessService.clearAndDeleteEntity('tag', 5),
    /nicht unterstuetzter Typ/
  );
});

test('clearAndDeleteEntity wirft bei ungueltiger id', async () => {
  await assert.rejects(
    () => paperlessService.clearAndDeleteEntity('correspondent', -1),
    /ungueltige id/
  );
});
```

- [ ] **Step 6: Run them, confirm they fail**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: FAIL — `paperlessService.clearAndDeleteEntity is not a function`.

- [ ] **Step 7: Implement `clearAndDeleteEntity`**

In `services/paperlessService.js`, add directly after `deleteEmptyEntity`:

```js
  // 2.1.5 (Fixplan Paket 2): diese Korrespondenten-Varianten sollen entfernt werden,
  // nicht auf einen anderen Korrespondenten zusammengefuehrt - es gibt keinen
  // "richtigen" Zielwert, auf den die betroffenen Dokumente zeigen sollten (E-5,
  // Fixplan Zeile 490-494). type='tag' wird bewusst abgelehnt: _bulkReassignDocuments
  // haette dafuer add_tags:[null] gebaut, was kein "Tag entfernen" bedeutet.
  async clearAndDeleteEntity(type, id) {
    this.initialize();
    if (type !== 'correspondent' && type !== 'document_type') {
      throw new Error(`clearAndDeleteEntity: nicht unterstuetzter Typ "${type}" (nur correspondent/document_type)`);
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`clearAndDeleteEntity: ungueltige id (${id})`);
    }

    const affected = await this._findDocumentsWithEntity(type, id);

    if (affected.length > 0) {
      await this._bulkReassignDocuments(type, affected.map(d => d.id), id, null);
    }

    const remaining = await this._findDocumentsWithEntity(type, id);
    if (remaining.length > 0) {
      throw new Error(`clearAndDeleteEntity: ${type} ${id} hat nach dem Leeren noch ${remaining.length} Dokument(e)`);
    }

    try {
      await this.client.delete(`/${type}s/${id}/`);
    } catch (error) {
      if (error.response?.status !== 404) {
        throw error;
      }
    }

    return { affectedCount: affected.length, deleted: true };
  }
```

- [ ] **Step 8: Run the tests, confirm they pass**

Run: `node --test test/paperlessMergeEntity.test.js`
Expected: PASS, all tests green.

- [ ] **Step 9: Write the failing tests for `listDocumentTypesWithCounts`**

In `test/paperlessListOrdering.test.js`, add at the end of the file:

```js
test('listDocumentTypesWithCounts liefert id, name und document_count je Dokumentart', async () => {
  const mockClient = {
    get: async (url, requestConfig) => {
      assert.strictEqual(url, '/document_types/');
      assert.strictEqual(requestConfig.params.ordering, 'name');
      return {
        data: {
          results: [
            { id: 5, name: 'Meldebescheinigung', document_count: 0 },
            { id: 6, name: 'Entgeltabrechnung', document_count: 24 }
          ],
          next: null
        }
      };
    }
  };

  const result = await withMockClient(mockClient, () => paperlessService.listDocumentTypesWithCounts());
  assert.deepStrictEqual(result, [
    { id: 5, name: 'Meldebescheinigung', document_count: 0 },
    { id: 6, name: 'Entgeltabrechnung', document_count: 24 }
  ]);
});

test('listDocumentTypesWithCounts paginiert ueber mehrere Seiten', async () => {
  let call = 0;
  const mockClient = {
    get: async () => {
      call++;
      return call === 1
        ? { data: { results: [{ id: 1, name: 'A', document_count: 1 }], next: '/document_types/?page=2' } }
        : { data: { results: [{ id: 2, name: 'B', document_count: 0 }], next: null } };
    }
  };

  const result = await withMockClient(mockClient, () => paperlessService.listDocumentTypesWithCounts());
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[1].document_count, 0);
});
```

- [ ] **Step 10: Run them, confirm they fail**

Run: `node --test test/paperlessListOrdering.test.js`
Expected: FAIL — `paperlessService.listDocumentTypesWithCounts is not a function`.

- [ ] **Step 11: Implement `listDocumentTypesWithCounts`**

In `services/paperlessService.js`, add directly after `listDocumentTypesNames()` (after line 736):

```js
  // 2.1.2 (Fixplan Paket 2): listDocumentTypesNames() liefert bewusst kein
  // document_count (bestehender Test test/paperlessListOrdering.test.js:28 prueft die
  // exakte Form) - fuer die Erkennung leerer Dokumentarten braucht es aber genau
  // dieses Feld. Eigene Methode statt die bestehende zu erweitern.
  async listDocumentTypesWithCounts() {
    this.initialize();
    let allDocumentTypes = [];
    let page = 1;
    let hasNextPage = true;

    try {
      while (hasNextPage) {
        const response = await this.client.get('/document_types/', {
          params: { page, page_size: 100, ordering: 'name' }
        });

        const { results, next } = response.data;
        allDocumentTypes = allDocumentTypes.concat(
          results.map(docType => ({ id: docType.id, name: docType.name, document_count: docType.document_count }))
        );

        hasNextPage = next !== null;
        page++;
      }

      return allDocumentTypes;
    } catch (error) {
      console.error('[ERROR] fetching document types with counts:', error.message);
      return [];
    }
  }
```

- [ ] **Step 12: Run the tests, confirm they pass**

Run: `node --test test/paperlessListOrdering.test.js`
Expected: PASS, all tests green.

- [ ] **Step 13: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: all pass, lint clean.

- [ ] **Step 14: Commit**

```bash
git add services/paperlessService.js test/paperlessMergeEntity.test.js test/paperlessListOrdering.test.js
git commit -m "feat: add deleteEmptyEntity, clearAndDeleteEntity, listDocumentTypesWithCounts for Paket-2 cleanup (2.1.2, 2.1.5)"
```

---

### Task 3: `scripts/cleanup-legacy-vocabulary.js` — Skelett mit bekannten Zuordnungen

**Files:**
- Create: `scripts/cleanup-legacy-vocabulary.js`

**Interfaces:**
- Consumes: `paperlessService.mergeEntity`, `paperlessService.deleteEmptyEntity`, `paperlessService.clearAndDeleteEntity`, `paperlessService.listDocumentTypesWithCounts`, `paperlessService.getTags`, `paperlessService.listCorrespondentsNames`, `paperlessService.getDocument`, `paperlessService.overwriteDocumentFields` (all existing/Task 2).
- Produces: no new exports — this is a CLI entry point, not a module other code requires. `main()`/`buildPlan()`/`resolveMerge()` are exported anyway (`module.exports = { buildPlan, resolveMerge }`) so Task 4/5 can extend the mapping constants without touching the execution logic.

**Why no unit test for this file:** per the design doc, this is an operational tool against a live Paperless instance (same category as `scripts/measure-judge-latency.js`) — verified by running it, not by mocking. The logic it calls (`mergeEntity`, `deleteEmptyEntity`, `clearAndDeleteEntity`) is already unit-tested in `paperlessService`.

- [ ] **Step 1: Write the script**

Create `scripts/cleanup-legacy-vocabulary.js`:

```js
#!/usr/bin/env node
/**
 * Fixplan Paket 2, Abschnitt 2.1 ("Vokabular konsolidieren"): fuehrt die dort
 * aufgelisteten Merges/Loeschungen ueber die Paperless-API aus, statt sie von Hand in
 * der Paperless-ngx-Oberflaeche zu klicken - Vorschau (dry-run) per Default, --apply
 * fuehrt aus. Siehe docs/superpowers/specs/2026-08-06-paket2-altdaten-bereinigen-design.md.
 *
 * Aufruf:
 *   node scripts/cleanup-legacy-vocabulary.js          (Vorschau, aendert nichts)
 *   node scripts/cleanup-legacy-vocabulary.js --apply  (fuehrt aus)
 *
 * Die vier Konstanten unten sind teils schon aus dem Fixplan bekannt, teils erst nach
 * einer Bestandsdurchsicht befuellbar (siehe Implementierungsplan-Task 4). Ein leerer
 * Eintrag fuehrt zu keiner Aktion, nicht zu einem Fehler.
 */
const paperlessService = require('../services/paperlessService');

// Fixplan Zeile 473-474: contract ist der Prompt-Platzhalter aus A-2 (mit 1.2.a an der
// Quelle geschlossen, der Alias/die Dokumentart bestand aber fort). Zeile 480-483: die
// DE/EN-Paare, die Trigram strukturell nie sieht.
const DOCUMENT_TYPE_MERGES = [
  { from: 'contract', to: 'Entgeltabrechnung' },
  { from: 'Payroll Statement', to: 'Entgeltabrechnung' },
  { from: 'salary tax certificate', to: 'Lohnsteuerbescheinigung' },
  { from: 'Practicum Confirmation', to: 'Praktikumsbestätigung' }
  // 'Notification' -> 'Mitteilung' ODER 'Bescheid': im Fixplan (Zeile 483) bewusst
  // offen gelassen, dokumentinhaltsabhaengig. Wird in Task 4 anhand der betroffenen
  // Dokumente aufgeloest und hier ergaenzt.
];

// Fixplan Zeile 484-485.
const TAG_MERGES = [
  { from: 'Personal Data', to: 'Persönliche Daten' },
  { from: 'Electronic Document', to: 'elektronisch' }
  // Tax Document, Invoice, Curriculum Vitae: deutsches Ziel-Tag wird in Task 4 anhand
  // des tatsaechlichen Bestands ermittelt (moeglicherweise existiert noch keins) und
  // hier ergaenzt.
];

// Fixplan Zeile 490-494: vier Empfaenger-Varianten, die entfernt (nicht gemergt) werden
// sollen. Namen werden in Task 4 aus dem Bestand ermittelt.
const CORRESPONDENT_NAMES_TO_REMOVE = [];

// Fixplan Zeile 486-489 (2.1.4): je ein Dokument fuer die drei in Paket 1 §1.4
// geloeschten Fehl-Aliase. Wird in Task 4 ueber entity_merge_log + entity_review_queue
// ermittelt und hier ergaenzt: { documentId, removeTagId, removeTagName, addTagId, addTagName }.
const MISTAGGED_DOCUMENT_FIXES = [];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function resolveMergeRow(type, from, to, lookup) {
  const source = lookup.find(e => e.name === from);
  const target = lookup.find(e => e.name === to);
  if (!source) {
    return { action: 'merge', type, from, to, skip: `Quelle "${from}" nicht gefunden (evtl. bereits gemergt)` };
  }
  if (!target) {
    return { action: 'merge', type, from, to, skip: `Ziel "${to}" nicht gefunden` };
  }
  const preview = await paperlessService.mergeEntity(type, source.id, target.id, { dryRun: true });
  return {
    action: 'merge', type, from, to,
    fromId: source.id, toId: target.id,
    affectedCount: preview.affectedCount, documentIds: preview.documentIds
  };
}

async function buildPlan() {
  const documentTypes = await paperlessService.listDocumentTypesWithCounts();
  const tags = await paperlessService.getTags();
  const correspondents = await paperlessService.listCorrespondentsNames();

  const rows = [];

  for (const { from, to } of DOCUMENT_TYPE_MERGES) {
    rows.push(await resolveMergeRow('document_type', from, to, documentTypes));
  }
  for (const { from, to } of TAG_MERGES) {
    rows.push(await resolveMergeRow('tag', from, to, tags));
  }

  for (const t of documentTypes.filter(dt => dt.document_count === 0)) {
    rows.push({ action: 'delete-empty', type: 'document_type', name: t.name, id: t.id });
  }

  for (const name of CORRESPONDENT_NAMES_TO_REMOVE) {
    const c = correspondents.find(e => e.name === name);
    if (!c) {
      rows.push({ action: 'remove-correspondent', name, skip: 'nicht gefunden' });
      continue;
    }
    rows.push({ action: 'remove-correspondent', name, id: c.id, document_count: c.document_count });
  }

  for (const fix of MISTAGGED_DOCUMENT_FIXES) {
    rows.push({ action: 'fix-tag', ...fix });
  }

  return rows;
}

async function applyRow(row) {
  if (row.action === 'merge') {
    await paperlessService.mergeEntity(row.type, row.fromId, row.toId, { dryRun: false, expectedDocumentIds: row.documentIds });
  } else if (row.action === 'delete-empty') {
    await paperlessService.deleteEmptyEntity(row.type, row.id);
  } else if (row.action === 'remove-correspondent') {
    await paperlessService.clearAndDeleteEntity('correspondent', row.id);
  } else if (row.action === 'fix-tag') {
    const doc = await paperlessService.getDocument(row.documentId);
    const withoutWrong = doc.tags.filter(id => id !== row.removeTagId);
    const newTags = withoutWrong.includes(row.addTagId) ? withoutWrong : withoutWrong.concat(row.addTagId);
    await paperlessService.overwriteDocumentFields(row.documentId, { tags: newTags });
  } else {
    throw new Error(`unbekannte Aktion: ${row.action}`);
  }
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const rows = await buildPlan();

  console.table(rows.map(r => ({
    action: r.action,
    beschreibung: r.from ? `${r.from} -> ${r.to}` : (r.name || r.documentId),
    betroffen: r.affectedCount ?? r.document_count ?? '-',
    status: r.skip ? `UEBERSPRUNGEN: ${r.skip}` : 'bereit'
  })));

  if (!apply) {
    console.log(`\n${rows.length} Zeile(n) in der Vorschau. Mit --apply ausfuehren.`);
    return;
  }

  const results = [];
  for (const row of rows) {
    if (row.skip) {
      results.push({ ...row, status: 'skipped' });
      continue;
    }
    try {
      await applyRow(row);
      results.push({ ...row, status: 'done' });
    } catch (error) {
      results.push({ ...row, status: 'failed', error: error.message });
    }
  }

  console.table(results.map(r => ({ action: r.action, beschreibung: r.from ? `${r.from} -> ${r.to}` : (r.name || r.documentId), status: r.status, error: r.error || '' })));

  const failed = results.filter(r => r.status === 'failed');
  if (failed.length > 0) {
    console.error(`\n${failed.length} von ${results.length} Zeile(n) fehlgeschlagen - siehe Tabelle oben. Erneuter Lauf mit --apply wiederholt nur die fehlgeschlagenen (bereits erledigte Zeilen finden beim Neu-Aufloesen keinen fromId/keine leere Entitaet mehr und werden uebersprungen).`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[ERROR]', error.message);
    process.exit(1);
  });
}

module.exports = { buildPlan, resolveMergeRow, applyRow };
```

- [ ] **Step 2: Confirm it loads without syntax errors**

Run: `node -e "require('./scripts/cleanup-legacy-vocabulary.js')"`
Expected: no output, exit code 0 (the `require.main === module` guard means `main()` doesn't run on require).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: `0 problems`.

- [ ] **Step 4: Commit**

```bash
git add scripts/cleanup-legacy-vocabulary.js
git commit -m "feat: add cleanup-legacy-vocabulary script skeleton with known Paket-2 mappings (2.1.1, 2.1.3)"
```

---

### Task 4: Bestandsdurchsicht — verbleibende Zuordnungen ermitteln und eintragen

**Files:**
- Modify: `scripts/cleanup-legacy-vocabulary.js` (only the four mapping constants from Task 3)

**Interfaces:** none — this task only changes data inside the constants Task 3 already defined.

**Why this can't be written ahead of time:** the fixplan names the *kind* of gap for each remaining item but not the concrete value, because it depends on the live inventory (fixplan lines 483–494; design doc, section "Datenfluss"): the `Notification` merge target, the German tags for `Tax Document`/`Invoice`/`Curriculum Vitae` (if they even exist yet), the four correspondent-variant names, and the three mis-tagged document IDs.

- [ ] **Step 1: List all document types with counts, find `Notification`'s real target**

Run (Bash), from the project root, with the server able to reach Paperless (`data/.env` already configured):
```bash
node -e "
const p = require('./services/paperlessService');
p.listDocumentTypesWithCounts().then(types => {
  console.table(types.filter(t => /notification/i.test(t.name) || t.document_count === 0));
});
"
```
Find the `Notification` document type's `id`, then read 2–3 of its documents in the Paperless-ngx web UI (`/documents/?document_type__id=<id>`) to decide `Mitteilung` or `Bescheid` based on actual content. If the group is mixed, split it: some documents may need a manual per-document edit in Paperless-ngx *before* running this script (out of scope for the script itself — note any such split in this step's outcome for Task 6's verification).

Add the resolved line to `DOCUMENT_TYPE_MERGES` in `scripts/cleanup-legacy-vocabulary.js`, e.g.:
```js
  { from: 'Notification', to: 'Mitteilung' },
```

Also record the full `document_count === 0` list from this same query — cross-check against Task 6 (should be exactly 7 per the fixplan's inventory, line 421).

- [ ] **Step 2: List all tags, find German targets for `Tax Document`, `Invoice`, `Curriculum Vitae`**

Run (Bash):
```bash
node -e "
const p = require('./services/paperlessService');
p.getTags().then(tags => {
  console.table(tags.map(t => ({ id: t.id, name: t.name, document_count: t.document_count })));
});
"
```
For each of `Tax Document`, `Invoice`, `Curriculum Vitae`: look for an existing German tag covering the same concept (e.g. `Steuerdokument`, `Rechnung`, `Lebenslauf`). If one exists, add a `{ from, to }` line to `TAG_MERGES`. If none exists, do **not** invent a merge — instead rename the English tag to German directly via `PATCH /tags/{id}/ {name: '<german>'}` as a one-off (not part of this script, since it's a rename, not a merge — note it in this step's outcome and do it manually via the Paperless-ngx UI's tag rename, which is a single safe field edit, not a bulk data operation).

- [ ] **Step 3: Find the four correspondent variants to remove**

Run (Bash):
```bash
node -e "
const p = require('./services/paperlessService');
p.listCorrespondentsNames().then(cs => {
  console.table(cs);
});
"
```
Per the fixplan's inventory (line 423: "4 Varianten des Empfängers") and the acceptance criterion (line 518–519: "kein Korrespondent trägt mehr eine Anrede, eine Anschrift oder eine Personalnummer im Namen"), identify the four names matching the document holder (`<Inhaber>`) with a salutation/address/personnel-number in the name — the Paket-1 acceptance notes (fixplan line 71–73) already name two of them: `Herr <Inhaber>` and `Herrn <Inhaber>, <Anschrift>`.

Add all four to `CORRESPONDENT_NAMES_TO_REMOVE` in the script:
```js
const CORRESPONDENT_NAMES_TO_REMOVE = [
  'Herr <Inhaber>',
  'Herrn <Inhaber>, <Anschrift>',
  // ... the other two, found from the printed list
];
```
(Replace `<Inhaber>`/`<Anschrift>` with the actual instance-specific names from the query output — this repository's docs use placeholders per its naming convention, see `CLAUDE.md`/fixplan line 11–13, but the live script and its output work with real names.)

- [ ] **Step 4: Find the three mis-tagged documents from the Paket-1 alias deletions**

Paket 1 §1.4 deleted three aliases (fixplan line 341–343): `austrittsdatum`→tag "Eintrittsdatum", `september 2025`→tag "November 2025", `urlaubsverguetung`→tag "Ausbildungsvergütung". Each bad merge logged one row in `entity_merge_log`, linked via `queue_entry_id` to the `entity_review_queue` row that has the affected `document_id`.

Run (Bash), read-only against `data/entities.db`:
```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/entities.db', { readonly: true });
const targets = ['Eintrittsdatum', 'November 2025', 'Ausbildungsvergütung'];
for (const targetName of targets) {
  const rows = db.prepare(\`
    SELECT m.from_id, m.to_id, m.affected_count, q.document_id, q.proposed_name, q.candidate_name
    FROM entity_merge_log m
    JOIN entity_review_queue q ON q.id = m.queue_entry_id
    WHERE m.entity_type = 'tag' AND q.candidate_name = ?
  \`).all(targetName);
  console.log(targetName, JSON.stringify(rows));
}
"
```
For each result row, note `document_id` (the affected document), `from_id` (the wrong tag that was merged away — no longer exists, so it can't be removed by id; instead use the *document's current tag list* to find which tag is wrong, since `from_id` was deleted), and the correct tag's id (`to_id` from the row is actually the tag the mistake pointed *to* — re-derive the *correct* tag from the document's actual content, matching the fixplan's description of the case, e.g. the `austrittsdatum` document should carry a tag for its real exit date, not "Eintrittsdatum").

**Note on document count:** the fixplan's Paket-1 table (line 341–343) lists the wrong tags as currently applied to **1, 2, and 3 documents respectively** (6 documents total, not 3) — while section 2.1.4's own summary says "je ein Dokument pro Fall" (one document per case). These two statements only agree if `entity_merge_log` recorded one merge *event* per case while the alias then kept auto-applying the wrong tag to further documents afterward (outside any further merge-log entry). Resolve this ambiguity from what the query above actually returns: if a target's `entity_merge_log` row has `affected_count` > 1, or the tag's current `document_count` (from Task 4 Step 2's tag listing) exceeds 1, treat **every** document currently carrying that wrong tag as in scope for `MISTAGGED_DOCUMENT_FIXES`, not just the one named by the query's `document_id`. If the query returns no rows for a target at all (the merge log entry predates `queue_entry_id` linkage, or was a direct user action outside the queue), fall back to listing documents by tag id directly (`getExampleDocumentsForEntity('tag', id, <document_count>)` or the Paperless-ngx UI filtered by that tag) to find all of them.

Add each finding to `MISTAGGED_DOCUMENT_FIXES` in the script:
```js
const MISTAGGED_DOCUMENT_FIXES = [
  { documentId: /* ... */, removeTagId: /* wrong tag id */, removeTagName: 'Eintrittsdatum', addTagId: /* correct tag id */, addTagName: /* correct tag name */ },
  // ... one entry per affected document
];
```

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: `0 problems` (only data literals changed, no logic).

```bash
git add scripts/cleanup-legacy-vocabulary.js
git commit -m "feat: fill in Paket-2 cleanup mappings from live inventory (2.1.2-2.1.5 discovery)"
```

---

### Task 5: Dry-Run-Verifikation gegen die Fixplan-Basiswerte

**Files:** none modified — read-only verification.

**Interfaces:** none.

- [ ] **Step 1: Run the dry-run**

Run (Bash):
```bash
node scripts/cleanup-legacy-vocabulary.js
```

- [ ] **Step 2: Check the printed table against the fixplan's known numbers**

Cross-check (fixplan lines 417–424, 473–494):
- `contract` → `Entgeltabrechnung`: `betroffen` column shows **20**.
- The `delete-empty` rows: exactly **7** entries, all `document_count: 0`.
- The `remove-correspondent` rows: exactly **4** entries, none marked `UEBERSPRUNGEN`.
- The `fix-tag` rows: as many entries as documents found in Task 4 Step 4.
- No row is `UEBERSPRUNGEN` for an unexpected reason (a `Ziel nicht gefunden` on one of the DE/EN merges usually means the German tag/document-type name in the script doesn't exactly match the live one — fix the spelling in `scripts/cleanup-legacy-vocabulary.js` and re-run this step, not Task 4 again).

If any number doesn't match, stop and investigate before proceeding to Task 6 — do not apply against an unverified plan.

- [ ] **Step 3: No commit**

This task is read-only verification; nothing changes in the repository or in Paperless.

---

### Task 6: Ausführen und die ersten drei Abnahmekriterien prüfen

**Files:** none modified in the repo — this task changes live Paperless data.

**Interfaces:** none.

- [ ] **Step 1: Apply**

Run (Bash):
```bash
node scripts/cleanup-legacy-vocabulary.js --apply
```
Expected: exit code 0, every row's `status` is `done` or (for anything already handled by a prior partial run) `skipped`. If any row is `failed`, read its `error`, fix the underlying issue (e.g. a since-changed document set — re-run Task 5's dry-run first to refresh `expectedDocumentIds`), and re-run `--apply`; already-`done` rows are idempotent and will no-op safely (their `fromId`/empty-check will no longer match, per `resolveMergeRow`'s "not found" path).

- [ ] **Step 2: Verify acceptance criterion 1 — document types**

Run (Bash):
```bash
node -e "
const p = require('./services/paperlessService');
p.listDocumentTypesWithCounts().then(types => {
  console.log('total:', types.length);
  console.log('empty:', types.filter(t => t.document_count === 0).length);
});
"
```
Expected: `total` < 15, `empty` is 0.

- [ ] **Step 3: Verify acceptance criterion 2 — `contract` is gone**

Run (Bash):
```bash
node -e "
const p = require('./services/paperlessService');
p.listDocumentTypesWithCounts().then(types => {
  console.log(types.some(t => t.name === 'contract') ? 'STILL PRESENT' : 'gone');
});
"
```
Expected: `gone`.

- [ ] **Step 4: Verify acceptance criterion 3 — correspondents are clean**

Run (Bash):
```bash
node -e "
const p = require('./services/paperlessService');
p.listCorrespondentsNames().then(cs => {
  console.table(cs.map(c => c.name));
});
"
```
Expected: manual read-through of the printed names — none contains a salutation (`Herr`/`Herrn`/`Frau`), a street/postal-code-shaped address fragment, or a personnel-number pattern.

- [ ] **Step 5: No commit for this task**

Data-only changes against the live Paperless instance; nothing in the repository changed.

---

### Task 7: 2.2-Entscheidung treffen, FIX-01-Workaround dokumentieren, Paket-2-Abnahme abschließen

**Files:**
- Modify: `docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md` (append the 2.2 decision under section "2.2 — Rescan: Entscheidung, keine Zusage", and check off the Paket-2 line in "Arbeitsplan")

**Interfaces:** none.

**Why this task can't be pre-written:** the fixplan requires the 2.2 decision to use the numbers Task 6 actually produced (line 496–498: "Erst nach 2.1 und mit den dann bekannten Zahlen entscheiden") — this task's first step is reading those real numbers, not assuming them.

- [ ] **Step 1: Gather the numbers the fixplan's pro/con list needs**

From the printed results of Task 6 Step 2 (total/empty document types) and a fresh count of the 59 single-use tags mentioned in the fixplan's baseline (line 421):
```bash
node -e "
const p = require('./services/paperlessService');
p.getTags().then(tags => {
  console.log('tags total:', tags.length);
  console.log('tags used exactly once:', tags.filter(t => t.document_count === 1).length);
});
"
```

- [ ] **Step 2: Decide, using the fixplan's own criteria**

Re-read fixplan lines 500–511 ("Dafür"/"Dagegen"/"Wenn ja, dann so"). Weigh: does the post-2.1 single-use-tag count still make a rescan worthwhile (fixplan's "Dafür" argument), against the ~1h runtime and re-review cost (fixplan's "Dagegen" argument)? This is a judgment call informed by the measured numbers, not a mechanical rule — make the call and write it down with the actual reasoning, matching the fixplan's own decision-documentation style (see "Entscheidungen dieser Planungsrunde", lines 87–153, for the expected tone: a short paragraph with the concrete numbers that drove it).

- [ ] **Step 3: Record the decision in the fixplan document**

In `docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md`, under section "### 2.2 — Rescan: Entscheidung, keine Zusage" (currently ending at line 511), append a new subsection:

```markdown

**Entscheidung (nachgetragen nach Ausführung von 2.1, <Datum>):** <Ja, Rescan wird
ausgelöst | Nein, kein Rescan> — <Begründung mit den unter Schritt 1 gemessenen
Zahlen: Dokumentarten vorher/nachher, verbleibende Einmal-Tags, etc.>
```

- [ ] **Step 4: If the decision is "yes, rescan" — run the FIX-01 workaround, then the scan**

Only if Step 2 decided in favor. Stop the server first, then (Bash):
```bash
sqlite3 data/documents.db "DELETE FROM processed_documents;"
```
This is the fixplan's documented FIX-01 workaround (line 454–458): `original_documents` and `history_documents` are deliberately left untouched, unlike the buggy `reset-all-documents` route. Restart the server with `DISABLE_AUTOMATIC_PROCESSING=no` set only long enough to trigger the scan, then set it back to `yes` afterward (Task 1 Step 5's grep command, with `sed` to flip the value both times). After the scan completes, delete any orphaned entities the resolver created during the run by re-running `node scripts/cleanup-legacy-vocabulary.js` (dry-run first) — new zero-document types/tags from the rescan follow the same shape Task 3's script already handles.

If the decision is "no" — skip this step entirely; the acceptance criterion only requires the decision and its reasoning to be recorded (Step 3), not a rescan.

- [ ] **Step 5: Check off Paket 2 in the fixplan's Arbeitsplan**

In `docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md`, change line 75 from:
```markdown
2. [ ] **Paket 2 — Altdaten bereinigen** (Folge von A-1/A-2, plus FIX-01)
```
to:
```markdown
2. [x] **Paket 2 — Altdaten bereinigen** (Folge von A-1/A-2, plus FIX-01)
```

- [ ] **Step 6: Final acceptance check against all five criteria (fixplan lines 513–522)**

1. Document types < 15, none empty — verified in Task 6 Step 2.
2. `contract` gone, its 20 documents carry a German document type — verified in Task 6 Step 3 (the merge target was `Entgeltabrechnung`, already German).
3. No correspondent has a salutation/address/personnel-number in its name — verified in Task 6 Step 4.
4. Both database backups exist outside the project directory — done in Task 1 Steps 3–4.
5. The 2.2 decision is recorded with reasoning — done in Step 3 above.

- [ ] **Step 7: Commit**

```bash
git add docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md
git commit -m "docs: record Paket-2 2.2 rescan decision and mark Paket 2 accepted"
```
