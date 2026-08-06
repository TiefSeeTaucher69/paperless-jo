# Paket 1 — Kette reparieren: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four breaks in the classification/entity-resolution chain identified in [docs/audit/2026-08-06-konsistenz-merge-ui-test.md](../../audit/2026-08-06-konsistenz-merge-ui-test.md) and specified in [docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md](../../audit/2026-08-06-fixplan-konsistenz-und-review-ui.md) ("Paket 1", lines 122–373): a silently-failing Judge, prompt placeholders leaking into classifications, a disabled inventory-matching setting, and three actively-wrong entity aliases — plus versioning the operational values that made these regressions invisible in the first place.

**Architecture:** No new subsystems. Every task is a small, targeted change to the existing chain (`ollamaService` → `entityResolver` → `entityJudge`) or its configuration (`config/config.js`, `data/.env`, `.env.example`), each independently testable and independently revertible. Two small tooling additions (a Judge-latency script, a `--ids` filter for the existing dry-run harness) exist solely to make the package's own acceptance criteria measurable — they are not new product surface.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert` (no test framework), `better-sqlite3`, `axios`, ESLint 9 flat config.

## Global Constraints

- Test runner: `npm test` → `node --test test/*.test.js`. Baseline at plan start: **458/460 passing** (2 known failures in `test/entityResolverHookIn.test.js`, fixed by Task 1).
- Lint: `npm run lint` → `eslint . --max-warnings=0`. Baseline at plan start: **0 problems** (the `.claude/worktrees/*` directories that caused 211 errors have already been removed; Task 2 still adds the `ignores` block per the audit so this can't regress).
- Every exported helper added for testability follows the existing pattern in `config/config.js` (`_parseEnvNumber`, `_maskUrl`): a plain function, exported under a `_`-prefixed key, unit-tested directly.
- Module-load-time config warnings are tested via `delete require.cache[require.resolve('../config/config')]` + re-`require` + `console.warn` capture, exactly as in `test/configEntityResolver.test.js`. Always restore `process.env` and clear the require cache again in a `finally` block.
- **Never print, log, or commit real values from `data/.env`.** It holds the live Paperless token and Ollama URL (see `CLAUDE.md`). Where a task touches `data/.env`, edit it with a targeted `sed`/in-place replace of one known key, never a full read/cat.
- Every task ends with `npm test` and `npm run lint` both clean, then one commit for that task's changes.
- German inline comments in this codebase explain **why**, not what — match that style in any new comment.

---

### Task 1: Testisolation für `ADD_AI_PROCESSED_TAG` (A-9)

**Files:**
- Modify: `test/entityResolverHookIn.test.js:106-123`, `:125-143`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Pure test-isolation fix.

**Root cause (verified by running the suite):** `paperlessService.processTags` (`services/paperlessService.js:527`) reads `process.env.ADD_AI_PROCESSED_TAG === 'yes'` directly. Whatever value happens to be set in the environment `data/.env` loads at test-run time leaks into these two tests, which append an extra tag the assertions don't expect. Confirmed: `ADD_AI_PROCESSED_TAG=no node --test test/entityResolverHookIn.test.js` → 31/0. The audit doc's wording ("config.addAIProcessedTag setzen") is imprecise — `config.addAIProcessedTag` is a separate, unused mirror value; the actual gate is `process.env.ADD_AI_PROCESSED_TAG`. Fix the real gate.

- [ ] **Step 1: Reproduce the failure in isolation**

Run: `node --test test/entityResolverHookIn.test.js`
Expected: `# pass 29`, `# fail 2` (tests `processTags: map-Entscheidung...` and `processTags: skip-Entscheidung...`).

- [ ] **Step 2: Isolate `process.env.ADD_AI_PROCESSED_TAG` in the failing tests**

In `test/entityResolverHookIn.test.js`, wrap both test bodies to pin the env var and restore it afterward. Replace lines 106–123:

```js
test('processTags: map-Entscheidung verwendet existierende Entity statt neu anzulegen', async () => {
  const savedAddAiTag = process.env.ADD_AI_PROCESSED_TAG;
  process.env.ADD_AI_PROCESSED_TAG = 'no';
  config.entityResolver.enabled = true;
  paperlessService.findExistingTag = async () => null;
  paperlessService.ensureTagCache = async () => {};
  paperlessService.createTagSafely = async () => { throw new Error('darf bei map nicht aufgerufen werden'); };
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'map', id: 77, canonicalName: 'Kanonischer Tag' })
  };

  try {
    const result = await paperlessService.processTags(['Irgendein Tag']);
    assert.deepStrictEqual(result.tagIds, [77]);
    assert.deepStrictEqual(result.errors, []);
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
    if (savedAddAiTag === undefined) delete process.env.ADD_AI_PROCESSED_TAG;
    else process.env.ADD_AI_PROCESSED_TAG = savedAddAiTag;
  }
});
```

And lines 125–143:

```js
test('processTags: skip-Entscheidung ueberspringt den Tag und vermerkt einen Fehler', async () => {
  const savedAddAiTag = process.env.ADD_AI_PROCESSED_TAG;
  process.env.ADD_AI_PROCESSED_TAG = 'no';
  config.entityResolver.enabled = true;
  paperlessService.findExistingTag = async () => null;
  paperlessService.ensureTagCache = async () => {};
  paperlessService.createTagSafely = async () => { throw new Error('darf bei skip nicht aufgerufen werden'); };
  paperlessService._entityResolverInstance = {
    resolve: async () => ({ action: 'skip' })
  };

  try {
    const result = await paperlessService.processTags(['Leerer Vorschlag']);
    assert.deepStrictEqual(result.tagIds, []);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].tagName, 'Leerer Vorschlag');
  } finally {
    config.entityResolver.enabled = false;
    paperlessService._entityResolverInstance = null;
    if (savedAddAiTag === undefined) delete process.env.ADD_AI_PROCESSED_TAG;
    else process.env.ADD_AI_PROCESSED_TAG = savedAddAiTag;
  }
});
```

- [ ] **Step 3: Run the file in isolation, confirm 31/0**

Run: `node --test test/entityResolverHookIn.test.js`
Expected: `# pass 31`, `# fail 0`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `# pass 460`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add test/entityResolverHookIn.test.js
git commit -m "test: isolate ADD_AI_PROCESSED_TAG in processTags hook-in tests (A-9)"
```

---

### Task 2: ESLint-`ignores`-Block ergänzen (A-10)

**Files:**
- Modify: `eslint.config.mjs`

**Interfaces:** none.

**Note:** the two worktrees the audit named (`.claude/worktrees/nachaudit-lint-cleanup`, `.claude/worktrees/nachaudit-paket4-fingerprint`) no longer exist (`git worktree list` shows only the main tree) and `npm run lint` already reports 0 problems. This task still adds the `ignores` block so a future worktree under `.claude/worktrees/` or a `data/` scratch file can't reintroduce the 211-error flood the audit measured.

- [ ] **Step 1: Confirm current lint baseline**

Run: `npm run lint`
Expected: exits 0, no output (already clean).

- [ ] **Step 2: Add the `ignores` block**

In `eslint.config.mjs`, insert a new first array entry before the `files: ["**/*.js"]` block:

```js
/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // .claude/worktrees/*: isolated git worktrees created during agent-driven
    // development, cleaned up after merge but not always immediately - their
    // contents are a separate checkout, not this project's source (A-10).
    // data/**: runtime state (SQLite DBs, cached thumbnails, eval output),
    // never source.
    ignores: ['.claude/**', 'data/**'],
  },
  {
    files: ["**/*.js"],
    ...
```

- [ ] **Step 3: Verify lint still passes**

Run: `npm run lint`
Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore: add eslint ignores for .claude/worktrees and data/ (A-10)"
```

---

### Task 3: `ENTITY_JUDGE_TIMEOUT_MS` konfigurierbar machen (1.1.a)

**Files:**
- Modify: `config/config.js`, `services/entityJudge.js`, `.env.example`
- Test: `test/configEntityJudge.test.js` (new), `test/entityJudge.test.js`

**Interfaces:**
- Produces: `config.entityJudge.timeoutMs` (number, default `60000`), read by `services/entityJudge.js`.

**Why 60000 and not 20000:** measured maximum judge-call latency was 32021 ms, and token-rate scatter is ~4.6× independent of response length (see Fixplan E-1). A tight timeout would repeat the exact failure this package fixes, just at a smaller scale.

- [ ] **Step 1: Write the failing config test**

Create `test/configEntityJudge.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('config.entityJudge.timeoutMs hat den Default 60000', () => {
  const saved = process.env.ENTITY_JUDGE_TIMEOUT_MS;
  try {
    process.env.ENTITY_JUDGE_TIMEOUT_MS = '';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.entityJudge.timeoutMs, 60000);
  } finally {
    if (saved === undefined) delete process.env.ENTITY_JUDGE_TIMEOUT_MS;
    else process.env.ENTITY_JUDGE_TIMEOUT_MS = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});

test('ENTITY_JUDGE_TIMEOUT_MS wird aus process.env gelesen', () => {
  const saved = process.env.ENTITY_JUDGE_TIMEOUT_MS;
  try {
    process.env.ENTITY_JUDGE_TIMEOUT_MS = '30000';
    delete require.cache[require.resolve('../config/config')];
    const config = require('../config/config');
    assert.strictEqual(config.entityJudge.timeoutMs, 30000);
  } finally {
    if (saved === undefined) delete process.env.ENTITY_JUDGE_TIMEOUT_MS;
    else process.env.ENTITY_JUDGE_TIMEOUT_MS = saved;
    delete require.cache[require.resolve('../config/config')];
  }
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test test/configEntityJudge.test.js`
Expected: FAIL — `config.entityJudge` is `undefined`.

- [ ] **Step 3: Add the config block**

In `config/config.js`, add a new top-level block to `module.exports`, right after the `entityResolver` block (after line 198, before `embedding:`):

```js
  entityJudge: {
    // 1.1.a: gemessenes Maximum 32021 ms, Token-Rate schwankt um Faktor 4.6
    // unabhaengig von der Antwortlaenge (Fixplan E-1) - ein knapper Timeout
    // wiederholt denselben Fehler nur in kleinerem Massstab.
    timeoutMs: parseEnvNumber(process.env.ENTITY_JUDGE_TIMEOUT_MS, 60000)
  },
```

- [ ] **Step 4: Run the config test, confirm it passes**

Run: `node --test test/configEntityJudge.test.js`
Expected: PASS, 2/2.

- [ ] **Step 5: Write the failing entityJudge test**

In `test/entityJudge.test.js`, add after the existing imports:

```js
test('Client-Timeout kommt aus config.entityJudge.timeoutMs (1.1.a)', () => {
  delete require.cache[require.resolve('../services/entityJudge')];
  const freshJudge = require('../services/entityJudge');
  assert.strictEqual(freshJudge.client.defaults.timeout, config.entityJudge.timeoutMs);
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `node --test test/entityJudge.test.js`
Expected: FAIL — `freshJudge.client.defaults.timeout` is `15000`, not `config.entityJudge.timeoutMs` (`60000`).

- [ ] **Step 7: Wire the config value into the client**

In `services/entityJudge.js:47`, replace:

```js
    this.client = axios.create({ timeout: 15000 });
```

with:

```js
    this.client = axios.create({ timeout: config.entityJudge.timeoutMs });
```

- [ ] **Step 8: Run the test, confirm it passes**

Run: `node --test test/entityJudge.test.js`
Expected: PASS, all tests green.

- [ ] **Step 9: Document the new variable in `.env.example`**

In `.env.example`, add after the `ENTITY_RESOLVER_DB_PATH` line (line 59):

```
# Timeout in milliseconds for a single LLM-judge call (default: 60000). Judge
# latency scatters by a factor of ~4.6 independent of response length
# (measured 2026-08-06) - a tight timeout produces false 'unavailable'
# verdicts, not faster failure.
ENTITY_JUDGE_TIMEOUT_MS=60000
```

- [ ] **Step 10: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: all tests pass, lint clean.

- [ ] **Step 11: Commit**

```bash
git add config/config.js services/entityJudge.js .env.example test/configEntityJudge.test.js test/entityJudge.test.js
git commit -m "feat: make entity-judge HTTP timeout configurable via ENTITY_JUDGE_TIMEOUT_MS (1.1.a)"
```

---

### Task 4: Judge-Begründung kappen (1.1.b)

**Files:**
- Modify: `services/entityJudge.js`
- Test: `test/entityJudge.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: no interface change — same `judge()` return shape.

**Why:** the judge spends ~80% of its time writing a free-text justification (measured E-1: 20424 ms → 8361 ms median, identical verdicts, `num_predict` 200→60 plus an explicit word limit in the prompt).

- [ ] **Step 1: Write the failing test**

In `test/entityJudge.test.js`, add:

```js
test('num_predict ist 60 und der Prompt verlangt eine kurze Begruendung (1.1.b)', async () => {
  const captured = captureRequest({ response: { verdict: 'same', reason: 'kurz' } });
  await entityJudge.judge('tag', 'A', 'B');
  assert.strictEqual(captured.body.options.num_predict, 60);
  assert.ok(captured.body.prompt.includes('hoechstens 8 Woerter'));
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test test/entityJudge.test.js`
Expected: FAIL — `captured.body.options.num_predict` is `200`.

- [ ] **Step 3: Cap the reasoning**

In `services/entityJudge.js`, change the prompt (lines 62-63) from:

```js
    const prompt = `Typ: ${entityType}\nName A: ${truncatedA}\nName B: ${truncatedB}\n\n`
      + 'Bezeichnen A und B dieselbe Sache? "same", "different" oder "unsure", falls unklar.';
```

to:

```js
    const prompt = `Typ: ${entityType}\nName A: ${truncatedA}\nName B: ${truncatedB}\n\n`
      + 'Bezeichnen A und B dieselbe Sache? "same", "different" oder "unsure", falls unklar.'
      + '\nBegruendung: hoechstens 8 Woerter.';
```

And `options.num_predict` (line 75) from `200` to `60`.

- [ ] **Step 4: Run the test, confirm it passes**

Run: `node --test test/entityJudge.test.js`
Expected: PASS, all tests green (existing tests still pass unchanged — none assert on `num_predict` or the exact prompt string beyond substring checks).

- [ ] **Step 5: Commit**

```bash
git add services/entityJudge.js test/entityJudge.test.js
git commit -m "perf: cap judge num_predict to 60 and ask for an 8-word justification (1.1.b, E-1: halves latency, identical verdicts)"
```

---

### Task 5: Timeout ≠ Modellunsicherheit — Verdict `'unavailable'` (1.1.c)

**Files:**
- Modify: `services/entityResolver.js:216-227`
- Test: `test/entityResolver.test.js:145-153`

**Interfaces:**
- Produces: `_askJudge`'s catch branch now returns `{ verdict: 'unavailable', reason: ... }` instead of `{ verdict: 'unsure', ... }`. No other function signature changes. The cascade in `resolve()` already treats any verdict other than `'same'`/`'different'` identically (falls through to `create_and_queue`), so `'unavailable'` needs no cascade change — verified by reading `resolve()`: only `verdict.verdict === 'same'` and `=== 'different'` are special-cased; everything else reaches the final `return { action: 'create_and_queue', ... }`.

**Root cause:** a failed/timed-out Judge call and a genuine "I don't know" from the model both currently produce `verdict: 'unsure'` — indistinguishable in the review queue. This is exactly how the 2026-08-05 production run failed unnoticed (25 of 27 queue entries were `unsure`, actually Judge-unreachable).

- [ ] **Step 1: Update the existing failing-judge test to expect the new verdict**

In `test/entityResolver.test.js`, replace lines 145–153:

```js
test('Fehlerverhalten: Judge wirft (nicht erreichbar) -> unsure statt Absturz', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => { throw new Error('ECONNREFUSED'); };
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.strictEqual(result.verdict, 'unsure');
});
```

with:

```js
test('Fehlerverhalten: Judge wirft (nicht erreichbar) -> unavailable, Kaskade behandelt es wie unsure (1.1.c)', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => { throw new Error('ECONNREFUSED'); };
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.strictEqual(result.verdict, 'unavailable');
});

test('Modellantwort mit "unavailable" im verdict-Feld wird weiterhin zu unsure normalisiert (1.1.c: nur der catch-Zweig darf unavailable liefern)', async () => {
  const store = new EntityStore(':memory:');
  const judge = async () => ({ verdict: 'unavailable', reason: 'Modell taeuscht einen Infrastrukturzustand vor' });
  const resolver = new EntityResolver({ store, judge, config: { autoThreshold: 0.99, judgeMin: 0.1 } });

  const result = await resolver.resolve('document_type', 'Verdienstbescheinigung', [{ id: 4, name: 'Meldebescheinigung' }]);
  assert.strictEqual(result.action, 'create_and_queue');
  assert.strictEqual(result.verdict, 'unsure');
});
```

(The test at lines 155–163, "Judge liefert unparsbares Urteil -> unsure", is unchanged — it already covers the "model response normalization must stay `unsure`" rule.)

- [ ] **Step 2: Run the tests, confirm the first fails**

Run: `node --test test/entityResolver.test.js`
Expected: the renamed/updated test FAILs (`result.verdict` is `'unsure'`, expected `'unavailable'`); the new normalization test PASSes already (catch branch not yet returning `'unavailable'`, so no model response can produce it yet — this second assertion is a regression guard, not currently exercising new behavior).

- [ ] **Step 3: Change the catch branch**

In `services/entityResolver.js`, replace lines 216–227:

```js
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
```

with:

```js
  async _askJudge(type, nameA, nameB) {
    try {
      const result = await this.judge(type, nameA, nameB);
      // Diese Pruefung betrifft ausschliesslich die Modellantwort und muss so bleiben:
      // 'unavailable' darf nur aus dem catch-Zweig unten kommen, nie vom Modell selbst
      // vorgetaeuscht werden (1.1.c).
      if (!result || !['same', 'different', 'unsure'].includes(result.verdict)) {
        return { verdict: 'unsure', reason: 'ungueltige oder leere Judge-Antwort' };
      }
      return result;
    } catch (error) {
      // 1.1.c: ein ausgefallener Judge ist keine Modellunsicherheit. Beide liefen bisher
      // unter 'unsure' und waren dadurch ununterscheidbar - genau daran ist der Produktivlauf
      // vom 2026-08-05 unbemerkt gescheitert (25 von 27 Eintraegen 'unsure'). Die Kaskade in
      // resolve() behandelt 'unavailable' identisch zu 'unsure' (create_and_queue) - nur die
      // Beschriftung aendert sich, nicht der Kontrollfluss.
      console.warn(`[WARNING] entityResolver: Judge nicht erreichbar fuer "${nameA}" vs "${nameB}", werte als unavailable:`, error.message);
      return { verdict: 'unavailable', reason: `judge nicht erreichbar: ${error.message}` };
    }
  }
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `node --test test/entityResolver.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green (no other test asserts on the literal `'unsure'` string from a judge failure — verified by the grep results used to plan this task).

- [ ] **Step 6: Commit**

```bash
git add services/entityResolver.js test/entityResolver.test.js
git commit -m "fix: distinguish judge-unavailable from model-unsure verdict (1.1.c, A-3)"
```

---

### Task 6: Langsame Judge-Aufrufe protokollieren (1.1.d)

**Files:**
- Modify: `services/entityJudge.js`
- Test: `test/entityJudge.test.js`

**Interfaces:** none new — logging only.

**Why:** cheaper and more informative than a startup probe call (which would cost ~8s of startup time), and would have surfaced A-3 (the silently-failing Judge) on its own.

- [ ] **Step 1: Write the failing test**

In `test/entityJudge.test.js`, add:

```js
test('warnt, wenn ein Aufruf laenger als 50% des konfigurierten Timeouts dauert (1.1.d)', async () => {
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };
  const savedTimeout = config.entityJudge.timeoutMs;
  config.entityJudge.timeoutMs = 100;
  entityJudge.client = {
    post: async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return { data: { response: { verdict: 'same', reason: 'langsam' } } };
    }
  };

  try {
    await entityJudge.judge('tag', 'A', 'B');
    assert.ok(warnMessages.some(m => m.includes('dauerte')), 'sollte eine Latenz-Warnung ausgeben');
  } finally {
    console.warn = savedWarn;
    config.entityJudge.timeoutMs = savedTimeout;
  }
});

test('warnt NICHT, wenn ein Aufruf unter 50% des konfigurierten Timeouts bleibt (1.1.d)', async () => {
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };
  const savedTimeout = config.entityJudge.timeoutMs;
  config.entityJudge.timeoutMs = 100000;
  captureRequest({ response: { verdict: 'same', reason: 'schnell' } });

  try {
    await entityJudge.judge('tag', 'A', 'B');
    assert.ok(!warnMessages.some(m => m.includes('dauerte')), 'sollte bei einem schnellen Aufruf nicht warnen');
  } finally {
    console.warn = savedWarn;
    config.entityJudge.timeoutMs = savedTimeout;
  }
});
```

- [ ] **Step 2: Run it, confirm the first fails**

Run: `node --test test/entityJudge.test.js`
Expected: FAIL — no warning is emitted yet for the slow call.

- [ ] **Step 3: Add duration tracking and the warning**

In `services/entityJudge.js`, in `judge()`, wrap the request/retry block with timing. Replace:

```js
    let response;
    try {
      response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, requestBody);
    } catch (firstError) {
      if (!isTransientError(firstError)) {
        throw firstError;
      }
      console.warn(`[WARNING] entityJudge: erster Versuch fehlgeschlagen (${firstError.message}), ein Retry folgt`);
      await delay(RETRY_DELAY_MS);
      response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, requestBody);
    }

    const raw = response.data.response;
```

with:

```js
    const startedAt = Date.now();
    let response;
    try {
      response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, requestBody);
    } catch (firstError) {
      if (!isTransientError(firstError)) {
        throw firstError;
      }
      console.warn(`[WARNING] entityJudge: erster Versuch fehlgeschlagen (${firstError.message}), ein Retry folgt`);
      await delay(RETRY_DELAY_MS);
      response = await this.client.post(`${config.ollama.apiUrl}/api/generate`, requestBody);
    }

    // 1.1.d: billiger und aussagekraeftiger als ein Probe-Aufruf beim Start (der 8s
    // Startzeit kosten wuerde) - haette den Befund A-3 (Judge antwortet nicht) von
    // selbst sichtbar gemacht.
    const durationMs = Date.now() - startedAt;
    if (durationMs > config.entityJudge.timeoutMs * 0.5) {
      console.warn(`[WARNING] entityJudge: Aufruf fuer ${entityType} ("${truncatedA}" vs "${truncatedB}") dauerte ${durationMs} ms - mehr als 50% von ENTITY_JUDGE_TIMEOUT_MS=${config.entityJudge.timeoutMs}`);
    }

    const raw = response.data.response;
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `node --test test/entityJudge.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: all pass, lint clean.

- [ ] **Step 6: Commit**

```bash
git add services/entityJudge.js test/entityJudge.test.js
git commit -m "feat: warn when a judge call exceeds 50% of its timeout (1.1.d)"
```

---

### Task 7: `mustHavePrompt`-Platzhalter neutralisieren (1.2.a)

**Files:**
- Modify: `config/config.js:274-285`
- Test: `test/ollamaPrompt.test.js`

**Interfaces:** none — `config.mustHavePrompt` stays a string with the same `%CUSTOMFIELDS%` placeholder, only its example values change.

**Root cause:** `"document_type": "Invoice/Contract/..."` was echoed back verbatim by the model — reproduced twice live in the audit test, and it's the direct origin of the `contract` document type now on 20 of 64 documents. `"tags": ["Tag1", "Tag2", ...]` and `"language": "en/de/es/..."` are the same fault pattern, just not yet observed causing damage.

- [ ] **Step 1: Write the failing tests**

In `test/ollamaPrompt.test.js`, add at the end of the file:

```js
test('mustHavePrompt enthaelt keine Beispielwerte, die das Modell woertlich uebernehmen koennte (1.2.a)', () => {
  const forbidden = ['Invoice', 'Contract', 'Tag1', 'en/de/es'];
  forbidden.forEach(value => {
    assert.ok(!config.mustHavePrompt.includes(value), `mustHavePrompt sollte "${value}" nicht mehr enthalten`);
  });
});

test('_buildPrompt enthaelt in beiden useExistingData-Zweigen keine Prompt-Platzhalter (1.2.a)', () => {
  const forbidden = ['Invoice', 'Contract', 'Tag1', 'en/de/es'];

  config.useExistingData = 'no';
  const withoutExisting = ollamaService._buildPrompt('Text', [], [], [], {});
  forbidden.forEach(value => assert.ok(!withoutExisting.system.includes(value), `useExistingData=no: "${value}" sollte nicht vorkommen`));

  config.useExistingData = 'yes';
  config.restrictToExistingTags = 'no';
  config.restrictToExistingCorrespondents = 'no';
  const withExisting = ollamaService._buildPrompt('Text', ['Rechnung'], ['Finanzamt'], ['Bescheid'], {});
  forbidden.forEach(value => assert.ok(!withExisting.system.includes(value), `useExistingData=yes: "${value}" sollte nicht vorkommen`));

  config.useExistingData = 'no';
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `node --test test/ollamaPrompt.test.js`
Expected: both new tests FAIL (the current template contains `Invoice/Contract/...`, `Tag1`, and `en/de/es/...`).

- [ ] **Step 3: Neutralize the template**

In `config/config.js`, replace `mustHavePrompt` (lines 274-285):

```js
  mustHavePrompt: `  Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
  IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
  Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
  {
    "title": "xxxxx",
    "correspondent": "xxxxxxxx",
    "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
    "document_type": "Invoice/Contract/...",
    "document_date": "YYYY-MM-DD",
    "language": "en/de/es/...",
    %CUSTOMFIELDS%
  }`,
```

with:

```js
  mustHavePrompt: `  Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
  IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
  Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
  {
    "title": "<short, concise title>",
    "correspondent": "<sender/institution, not the recipient>",
    "tags": ["<tag>", "<tag>", "..."],
    "document_type": "<the document's category, in the document's language>",
    "document_date": "YYYY-MM-DD",
    "language": "<ISO 639-1 code, e.g. de>",
    %CUSTOMFIELDS%
  }`,
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `node --test test/ollamaPrompt.test.js`
Expected: PASS, all tests green (the pre-existing test `system.includes('"document_date"')` still passes — that key name is unchanged).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add config/config.js test/ollamaPrompt.test.js
git commit -m "fix: neutralize mustHavePrompt example values so the model can't echo them as data (1.2.a, A-2)"
```

---

### Task 8: `custom_fields` nur im Schema wenn aktiviert (1.2.b)

**Files:**
- Modify: `services/ollamaService.js:19-45`
- Test: `test/ollamaServiceSchema.test.js` (new)

**Interfaces:**
- Produces: `ollamaService.documentAnalysisSchema` becomes a getter (was a plain constructed property) — same read-site usage (`this.documentAnalysisSchema` in `analyzeDocument`), but now recomputed on every access instead of fixed at construction time.

**Why a getter, not a one-time constructor value:** `config.limitFunctions.activateCustomFields` can change at runtime via the settings routes (`routes/setup.js`), so a value cached once at module load could go stale without a server restart.

- [ ] **Step 1: Write the failing test**

Create `test/ollamaServiceSchema.test.js`:

```js
process.env.CUSTOM_FIELDS = JSON.stringify({ custom_fields: [] });
process.env.SYSTEM_PROMPT = 'Du bist ein Dokumentenanalyst.';

const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config/config');
const ollamaService = require('../services/ollamaService');

test('documentAnalysisSchema enthaelt custom_fields nur bei activateCustomFields=yes (1.2.b)', () => {
  const saved = config.limitFunctions.activateCustomFields;
  try {
    config.limitFunctions.activateCustomFields = 'no';
    assert.strictEqual(ollamaService.documentAnalysisSchema.properties.custom_fields, undefined);

    config.limitFunctions.activateCustomFields = 'yes';
    assert.deepStrictEqual(
      ollamaService.documentAnalysisSchema.properties.custom_fields,
      { type: 'object', additionalProperties: true }
    );
  } finally {
    config.limitFunctions.activateCustomFields = saved;
  }
});

test('documentAnalysisSchema.required listet custom_fields nie als Pflichtfeld', () => {
  const saved = config.limitFunctions.activateCustomFields;
  try {
    config.limitFunctions.activateCustomFields = 'yes';
    assert.ok(!ollamaService.documentAnalysisSchema.required.includes('custom_fields'));
  } finally {
    config.limitFunctions.activateCustomFields = saved;
  }
});

test('playgroundSchema hat nie custom_fields, unabhaengig von activateCustomFields', () => {
  const saved = config.limitFunctions.activateCustomFields;
  try {
    config.limitFunctions.activateCustomFields = 'yes';
    assert.strictEqual(ollamaService.playgroundSchema.properties.custom_fields, undefined);
  } finally {
    config.limitFunctions.activateCustomFields = saved;
  }
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test test/ollamaServiceSchema.test.js`
Expected: FAIL — `custom_fields` is always present regardless of `activateCustomFields`.

- [ ] **Step 3: Turn `documentAnalysisSchema` into a getter**

In `services/ollamaService.js`, replace the constructor block (lines 19-45):

```js
    constructor() {
        this.apiUrl = config.ollama.apiUrl;
        this.model = config.ollama.model;
        this.client = axios.create({
            timeout: 1800000 // 30 minutes timeout
        });

        // JSON schema for document analysis output
        this.documentAnalysisSchema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" },
                custom_fields: {
                    type: "object",
                    additionalProperties: true
                }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };

        // Schema for playground analysis (simpler version)
        this.playgroundSchema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };
    }
```

with:

```js
    constructor() {
        this.apiUrl = config.ollama.apiUrl;
        this.model = config.ollama.model;
        this.client = axios.create({
            timeout: 1800000 // 30 minutes timeout
        });

        // Schema for playground analysis (simpler version) - never includes custom_fields,
        // the playground has no custom-fields UI.
        this.playgroundSchema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };
    }

    /**
     * JSON schema for document analysis output. A getter, not a fixed property: with
     * additionalProperties:true, custom_fields let the model fill the field with invented
     * keys (a tax ID and an IBAN were observed in the audit test) even while
     * ACTIVATE_CUSTOM_FIELDS=no - those values are discarded downstream but still burn
     * num_predict budget and can land in logs/prompt.txt (1.2.b). config.limitFunctions.
     * activateCustomFields can change at runtime via routes/setup.js, so this must be
     * recomputed on every access rather than cached once at construction time.
     * @returns {Object}
     */
    get documentAnalysisSchema() {
        const schema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };

        if (config.limitFunctions.activateCustomFields === 'yes') {
            schema.properties.custom_fields = { type: "object", additionalProperties: true };
        }

        return schema;
    }
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `node --test test/ollamaServiceSchema.test.js`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green (nothing else assigns to `ollamaService.documentAnalysisSchema` — a getter-only property would throw if something did; verified by grepping for `documentAnalysisSchema =` outside the constructor, no matches beyond the definition itself).

- [ ] **Step 6: Commit**

```bash
git add services/ollamaService.js test/ollamaServiceSchema.test.js
git commit -m "fix: only expose custom_fields in the analysis schema when activateCustomFields=yes (1.2.b, A-2)"
```

---

### Task 9: `_isPlausibleDocumentType` ergänzen (1.2.c)

**Files:**
- Modify: `services/ollamaService.js` (near `_isPlausibleTag`, and in `_normalizeParsedDocument`)
- Test: `test/ollamaDocumentTypeFilter.test.js` (new)

**Interfaces:**
- Produces: `ollamaService._isPlausibleDocumentType(value): boolean`, used internally by `_normalizeParsedDocument`.

**Why in addition to Task 7:** Task 7 removes the known placeholder source; this catches the next one. The same reasoning already justified `_isPlausibleTag` for tags (Phase 1, step 8, added after the baseline run).

- [ ] **Step 1: Write the failing tests**

Create `test/ollamaDocumentTypeFilter.test.js` (mirrors `test/ollamaTagFilter.test.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const ollamaService = require('../services/ollamaService');

test('eine normale Dokumentart ist plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType('Entgeltabrechnung'), true);
});

test('der bekannte Prompt-Platzhalter wird verworfen', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType('Invoice/Contract/...'), false);
});

test('ein Wert mit Schraegstrich wird verworfen', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType('Rechnung/Mahnung'), false);
});

test('ein unplausibel langer Wert wird verworfen', () => {
  const long = 'x'.repeat(61);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(long), false);
});

test('ein Wert an der Laengengrenze von 60 Zeichen bleibt plausibel', () => {
  const atLimit = 'x'.repeat(60);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(atLimit), true);
});

test('ein leerer oder nicht-string Wert ist nicht plausibel', () => {
  assert.strictEqual(ollamaService._isPlausibleDocumentType(''), false);
  assert.strictEqual(ollamaService._isPlausibleDocumentType('   '), false);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(null), false);
  assert.strictEqual(ollamaService._isPlausibleDocumentType(undefined), false);
});

test('_normalizeParsedDocument verwirft eine unplausible Dokumentart und setzt sie auf null', () => {
  const doc = { document_type: 'Invoice/Contract/...', tags: [] };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_type, null);
});

test('_normalizeParsedDocument laesst eine plausible Dokumentart unangetastet', () => {
  const doc = { document_type: 'Entgeltabrechnung', tags: [] };
  ollamaService._normalizeParsedDocument(doc);
  assert.strictEqual(doc.document_type, 'Entgeltabrechnung');
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `node --test test/ollamaDocumentTypeFilter.test.js`
Expected: FAIL — `_isPlausibleDocumentType` is not a function.

- [ ] **Step 3: Add the method and wire it into `_normalizeParsedDocument`**

In `services/ollamaService.js`, add after `_isPlausibleTag` (after line 505):

```js
    /**
     * A document type is a category name, not a sentence or an unfilled prompt
     * template. Mirrors _isPlausibleTag's heuristics - the observed prompt-placeholder
     * leak was literally "Invoice/Contract/..." (1.2.c).
     * @param {*} value
     * @returns {boolean}
     */
    _isPlausibleDocumentType(value) {
        if (typeof value !== 'string') return false;
        const trimmed = value.trim();
        if (!trimmed) return false;
        if (trimmed.includes('/')) return false;
        if (trimmed.includes('...')) return false;
        if (trimmed.length > 60) return false;
        return true;
    }
```

In `_normalizeParsedDocument`, add after the tags-filtering block and before the `document_date` block:

```js
        if (doc.document_type && !this._isPlausibleDocumentType(doc.document_type)) {
            console.warn(`[WARNING] Dropped document_type "${doc.document_type}" - looked like a prompt placeholder rather than a category name`);
            doc.document_type = null;
        }
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `node --test test/ollamaDocumentTypeFilter.test.js`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: all pass, lint clean.

- [ ] **Step 6: Commit**

```bash
git add services/ollamaService.js test/ollamaDocumentTypeFilter.test.js
git commit -m "fix: drop implausible document_type values instead of using them as-is (1.2.c, A-2)"
```

---

### Task 10: Bestandsabgleich einschalten + Widerspruch-Warnung (1.3.a, 1.3.b)

**Files:**
- Modify: `data/.env` (not committed), `config/config.js`
- Test: `test/configPreExistingPrompt.test.js` (new)

**Interfaces:**
- Produces: `config._hasPreExistingPromptMismatch(systemPrompt, useExistingDataValue): boolean`, a pure predicate exported for testing (same pattern as `_parseEnvNumber`/`_maskUrl`), used at module-load time to emit a startup warning.

**Effect measured in the audit's A/B test:** with `USE_EXISTING_DATA=yes`, 1-of-3 stable documents → 3-of-3; 4 distinct document types on the same document → 1. Token cost is not a concern: `_fitPromptToContext` only ever trims the document text, never the system prompt, and logs when it does.

- [ ] **Step 1: Set `USE_EXISTING_DATA=yes` in `data/.env`**

This is a live config file with real credentials — do not read or print its contents. Edit only the one known line in place:

Run (Bash):
```bash
sed -i 's/^USE_EXISTING_DATA=.*/USE_EXISTING_DATA=yes/' data/.env
grep '^USE_EXISTING_DATA=' data/.env
```
Expected output: `USE_EXISTING_DATA=yes`. (This value is a feature toggle, not a credential — safe to display on its own.)

This is reversible at any time by flipping the value back to `no`; it is pure configuration, not committed to git (`data/.env` is gitignored).

- [ ] **Step 2: Write the failing warning test**

Create `test/configPreExistingPrompt.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('_hasPreExistingPromptMismatch: true wenn SYSTEM_PROMPT "Pre-existing" enthaelt und useExistingData != yes', () => {
  const config = require('../config/config');
  assert.strictEqual(config._hasPreExistingPromptMismatch('Check Pre-existing tags first.', 'no'), true);
  assert.strictEqual(config._hasPreExistingPromptMismatch('Check Pre-existing tags first.', undefined), true);
});

test('_hasPreExistingPromptMismatch: false wenn useExistingData=yes', () => {
  const config = require('../config/config');
  assert.strictEqual(config._hasPreExistingPromptMismatch('Check Pre-existing tags first.', 'yes'), false);
});

test('_hasPreExistingPromptMismatch: false wenn SYSTEM_PROMPT die Zeichenkette nicht enthaelt', () => {
  const config = require('../config/config');
  assert.strictEqual(config._hasPreExistingPromptMismatch('Ein normaler Prompt ohne Bezug.', 'no'), false);
  assert.strictEqual(config._hasPreExistingPromptMismatch(undefined, 'no'), false);
});

test('Startup warnt tatsaechlich, wenn SYSTEM_PROMPT+USE_EXISTING_DATA widersprechen', () => {
  const savedPrompt = process.env.SYSTEM_PROMPT;
  const savedUseExisting = process.env.USE_EXISTING_DATA;
  const savedWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => { warnMessages.push(args.join(' ')); };

  try {
    process.env.SYSTEM_PROMPT = 'Check Pre-existing tags / correspondents / document types first.';
    process.env.USE_EXISTING_DATA = 'no';
    delete require.cache[require.resolve('../config/config')];
    require('../config/config');

    assert.ok(warnMessages.some(m => m.includes('Pre-existing')), 'sollte beim Laden warnen');
  } finally {
    console.warn = savedWarn;
    if (savedPrompt === undefined) delete process.env.SYSTEM_PROMPT;
    else process.env.SYSTEM_PROMPT = savedPrompt;
    if (savedUseExisting === undefined) delete process.env.USE_EXISTING_DATA;
    else process.env.USE_EXISTING_DATA = savedUseExisting;
    delete require.cache[require.resolve('../config/config')];
  }
});
```

- [ ] **Step 3: Run it, confirm it fails**

Run: `node --test test/configPreExistingPrompt.test.js`
Expected: FAIL — `config._hasPreExistingPromptMismatch` is not a function.

- [ ] **Step 4: Add the predicate and the startup warning**

In `config/config.js`, replace the line `useExistingData: process.env.USE_EXISTING_DATA || 'no',` (line 245) — first extract it to a local constant just above `module.exports` (after the `allowedOrigins` block, before `console.log('Loaded environment variables:'...)`, around line 142):

```js
const useExistingData = process.env.USE_EXISTING_DATA || 'no';

// 1.3.b: SYSTEM_PROMPT can instruct the model to check "Pre-existing tags / correspondents /
// document types" first, but _buildPrompt only inserts those lists when useExistingData is
// 'yes' (see services/ollamaService.js:_buildPrompt) - otherwise the rule refers to lists the
// model never sees, silently and without any signal in normal operation.
function hasPreExistingPromptMismatch(systemPrompt, useExistingDataValue) {
  return (systemPrompt || '').includes('Pre-existing') && useExistingDataValue !== 'yes';
}

if (hasPreExistingPromptMismatch(process.env.SYSTEM_PROMPT, useExistingData)) {
  console.warn(
    '[WARNING] SYSTEM_PROMPT erwaehnt "Pre-existing tags/correspondents/document types", aber '
    + 'USE_EXISTING_DATA ist nicht "yes" - die Bestandslisten werden dem Modell nie gezeigt, '
    + 'die Regel im Prompt laeuft ins Leere. Siehe .env.example.'
  );
}
```

Then in `module.exports`, replace:

```js
  useExistingData: process.env.USE_EXISTING_DATA || 'no',
```

with:

```js
  useExistingData,
  // Exported for unit tests (same pattern as _parseEnvNumber/_maskUrl)
  _hasPreExistingPromptMismatch: hasPreExistingPromptMismatch,
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `node --test test/configPreExistingPrompt.test.js`
Expected: PASS, all 4 tests green.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green — in particular `test/ollamaPrompt.test.js:50` ("bei useExistingData=yes stehen die Bestandslisten im system-Teil") still passes unchanged.

- [ ] **Step 7: Commit**

```bash
git add config/config.js test/configPreExistingPrompt.test.js
git commit -m "feat: enable USE_EXISTING_DATA and warn at startup when SYSTEM_PROMPT references it without it being on (1.3.a, 1.3.b, A-1, A-8)"
```

Note: `data/.env` itself is not part of this commit (gitignored) — the toggle from Step 1 is a separate, local operational change.

---

### Task 11: `.env.example` und README aktualisieren (1.3.c)

**Files:**
- Modify: `.env.example`, `README.md`

**Interfaces:** none.

**Why:** this affects the shipped default of the public fork, not just this instance. The measured effect is large, the token risk is cleanly absorbed and logged by `_fitPromptToContext`, and the resolver cascade underneath barely makes sense without this switch on.

- [ ] **Step 1: Flip the default in `.env.example`**

In `.env.example`, line 40, change:

```
USE_EXISTING_DATA=no
```

to:

```
# Includes the current Paperless-ngx tag/correspondent/document-type inventory in the
# system prompt so the model reuses existing entities instead of always inventing new
# ones (default: yes). Measured effect (2026-08-06 A/B test): document-type stability
# went from 1-of-3 to 3-of-3 documents across repeated runs. Token cost is bounded by
# _fitPromptToContext, which only ever trims the document text, never this list.
USE_EXISTING_DATA=yes
```

- [ ] **Step 2: Extend the README section**

In `README.md`, in the "🔍 Entity Resolution & Similarity Matching" section (starting line 65), add a new bullet after the introductory paragraph (after line 70, before the `EntityResolver` bullet):

```markdown
- **`USE_EXISTING_DATA`** (default `yes`) — includes the current tag, correspondent,
  and **document type** inventory in the classification prompt so the model reuses
  what already exists instead of inventing near-duplicates. This is the single most
  effective consistency lever measured so far (2026-08-06 A/B test: document-type
  stability 1-of-3 → 3-of-3 across repeated runs) and is a prerequisite for the
  EntityResolver cascade below to have anything meaningful to match against.
```

- [ ] **Step 3: Verify no test references the old default**

Run: `npm test`
Expected: all green — `test/ollamaPrompt.test.js` sets `config.useExistingData` explicitly per test and does not depend on the `.env.example` default.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: default USE_EXISTING_DATA to yes in .env.example, document it in README (1.3.c)"
```

---

### Task 12: Judge-Latenzmessungs-Skript (Vorbereitung für Abnahmekriterium 2)

**Files:**
- Create: `scripts/measure-judge-latency.js`

**Interfaces:**
- Consumes: `services/entityJudge.js` (`judge(type, a, b)`), `data/eval/entity-labels.json` (same format `scripts/tune-thresholds.js` already uses: `{ "<type>": [["Name A", "Name B", ...], ...] }`).
- Produces: stdout report (per-pair latency + verdict, median/min/max, timeout count). No files written, no Paperless/database writes.

**Why this script needs to exist:** the package's acceptance criterion 2 ("Judge measurement over at least 12 real name pairs: 0 timeouts, median under 15000 ms") explicitly cannot be satisfied by `scripts/dry-run-eval.js`, which never calls `entityJudge` at all (per its own header comment) — it only exercises `analyzeDocument`. This script is scripts/-only (like `tune-thresholds.js`), not unit-tested, matching the existing convention in this codebase (no `scripts/*.test.js` files exist for any script).

- [ ] **Step 1: Write the script**

Create `scripts/measure-judge-latency.js`:

```js
#!/usr/bin/env node
/**
 * Ad-hoc Messung der Judge-Latenz gegen reale Namenspaare (Paket-1-Abnahme,
 * Fixplan-Kriterium 2). Ruft services/entityJudge.judge() direkt auf - beruehrt
 * weder Paperless noch die Resolver-Kaskade. scripts/dry-run-eval.js kann das
 * nicht leisten (ruft laut eigenem Kopfkommentar ausschliesslich analyzeDocument
 * auf).
 *
 * Aufruf:
 *   node scripts/measure-judge-latency.js
 *   node scripts/measure-judge-latency.js --pairs data/eval/entity-labels.json
 *
 * Paarquelle: data/eval/entity-labels.json, Format wie in scripts/tune-thresholds.js:
 *   { "<type>": [["Name A", "Name B", "Name C"], ...] }
 * Je Cluster wird ein Paar pro benachbartem Eintrag gebildet. Mindestens 12 Paare
 * fuer die Abnahme (Fixplan Paket 1, Kriterium 2).
 */
const fs = require('fs');
const path = require('path');
const entityJudge = require('../services/entityJudge');

function parseArgs(argv) {
  const args = { pairsFile: 'data/eval/entity-labels.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pairs') args.pairsFile = argv[++i];
  }
  return args;
}

function loadPairs(pairsFile) {
  const full = path.join(process.cwd(), pairsFile);
  if (!fs.existsSync(full)) {
    console.error(`[ERROR] ${pairsFile} fehlt. Format: { "<type>": [["Name A", "Name B", ...], ...] } - siehe scripts/tune-thresholds.js.`);
    process.exit(1);
  }
  const clustersByType = JSON.parse(fs.readFileSync(full, 'utf8'));
  const pairs = [];
  for (const [type, clusters] of Object.entries(clustersByType)) {
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.length - 1; i++) {
        pairs.push({ type, a: cluster[i], b: cluster[i + 1] });
      }
    }
  }
  return pairs;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  const { pairsFile } = parseArgs(process.argv.slice(2));
  const pairs = loadPairs(pairsFile);

  if (pairs.length < 12) {
    console.warn(`[WARNING] Nur ${pairs.length} Paare gefunden - die Paket-1-Abnahme verlangt mindestens 12.`);
  }

  const durations = [];
  let timeouts = 0;

  for (const { type, a, b } of pairs) {
    const startedAt = Date.now();
    try {
      const result = await entityJudge.judge(type, a, b);
      const durationMs = Date.now() - startedAt;
      durations.push(durationMs);
      console.log(`${String(durationMs).padStart(6)} ms  ${result.verdict.padEnd(9)}  ${type}: "${a}" vs "${b}"`);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      timeouts += 1;
      console.log(`${String(durationMs).padStart(6)} ms  TIMEOUT/FEHLER  ${type}: "${a}" vs "${b}" (${error.message})`);
    }
  }

  console.log(`\nPaare: ${pairs.length}, Timeouts/Fehler: ${timeouts}`);
  if (durations.length > 0) {
    console.log(`Median: ${median(durations).toFixed(0)} ms, Max: ${Math.max(...durations)} ms, Min: ${Math.min(...durations)} ms`);
  }
}

main();
```

- [ ] **Step 2: Sanity-check the script against a fabricated pairs file**

Create a throwaway fixture with a single pair:

```bash
mkdir -p data/eval
cat > data/eval/judge-latency-smoke-test.json <<'EOF'
{"tag": [["A", "B"]]}
EOF
```

Run: `node scripts/measure-judge-latency.js --pairs data/eval/judge-latency-smoke-test.json`
Expected: prints one line for the "A"/"B" pair, then a summary line. This is a real call to `config.ollama.apiUrl` — if Ollama is unreachable in this environment, expect one `TIMEOUT/FEHLER` line instead of a verdict; that confirms the script's error path works and is not itself a bug. Either outcome confirms `loadPairs` and the CLI parsing work. Remove the fixture afterward (`data/eval/` is gitignored, but no need to leave clutter):

```bash
rm data/eval/judge-latency-smoke-test.json
```

A full live run with ≥12 real pairs happens in Task 16 (final acceptance).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: `0 problems`.

- [ ] **Step 4: Commit**

```bash
git add scripts/measure-judge-latency.js
git commit -m "feat: add standalone judge-latency measurement script for Paket-1 acceptance"
```

---

### Task 13: `dry-run-eval.js`: `--ids`-Filter ergänzen (Vorbereitung für Abnahmekriterium 3)

**Files:**
- Modify: `scripts/dry-run-eval.js`

**Interfaces:**
- Produces: new CLI flag `--ids 127,129,147`, selects exactly those document IDs instead of (or in addition to) `--limit`.

**Why:** acceptance criterion 3 requires running the dry-run against the exact same three documents as the audit test (127, 129, 147) with `--repeat 2`. The script currently only supports `--limit N` (first N documents in fetch order), which cannot target specific IDs.

- [ ] **Step 1: Extend `parseArgs`**

In `scripts/dry-run-eval.js`, replace `parseArgs` (lines 36-46):

```js
function parseArgs(argv) {
  const args = { limit: null, repeat: 1, label: 'run' };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--repeat') args.repeat = parseInt(argv[++i], 10);
    else if (argv[i] === '--label') args.label = argv[++i];
  }

  return args;
}
```

with:

```js
function parseArgs(argv) {
  const args = { limit: null, repeat: 1, label: 'run', ids: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--repeat') args.repeat = parseInt(argv[++i], 10);
    else if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--ids') args.ids = argv[++i].split(',').map(id => parseInt(id.trim(), 10));
  }

  return args;
}
```

- [ ] **Step 2: Use it in the selection logic**

In `main()`, replace line 245:

```js
  const selected = args.limit ? documents.slice(0, args.limit) : documents;
```

with:

```js
  const selected = args.ids
    ? documents.filter(d => args.ids.includes(d.id))
    : (args.limit ? documents.slice(0, args.limit) : documents);
```

- [ ] **Step 3: Manual sanity check (no test file — matches existing convention, no `scripts/*.test.js` exists in this repo)**

Run:
```bash
node -e "
process.argv = ['node', 'dry-run-eval.js', '--ids', '127,129,147', '--repeat', '2'];
const args = (function() {
  const argv = process.argv.slice(2);
  const args = { limit: null, repeat: 1, label: 'run', ids: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--repeat') args.repeat = parseInt(argv[++i], 10);
    else if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--ids') args.ids = argv[++i].split(',').map(id => parseInt(id.trim(), 10));
  }
  return args;
})();
console.log(JSON.stringify(args));
"
```
Expected: `{"limit":null,"repeat":2,"label":"run","ids":[127,129,147]}`

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: `0 problems`.

- [ ] **Step 5: Commit**

```bash
git add scripts/dry-run-eval.js
git commit -m "feat: add --ids filter to dry-run-eval.js so specific documents can be re-tested (Paket-1 acceptance criterion 3)"
```

---

### Task 14: Drei falsche Aliase entfernen (1.4)

**Files:**
- Operational change to `data/entities.db` (gitignored, no code change)

**Interfaces:** none — this is a data-only operation, no code or test changes.

**Background:** the Judge (with Task 4/5's fixes now working) confirms `'different'` for all three pairs (see audit test, section A-3). These aliases actively corrupt every future document until removed — unlike the 59 one-off tags handled in Paket 2, this is an active fault in the chain, not stale data.

| Alias (normalized) | points to | source |
|---|---|---|
| `austrittsdatum` | Tag "Eintrittsdatum" (1 doc) | `user` |
| `september 2025` | Tag "November 2025" (2 docs) | `user` |
| `urlaubsverguetung` | Tag "Ausbildungsvergütung" (3 docs) | `user` |

**Note:** the Paperless-ngx merges these aliases caused are **not** undone by this step — affected documents keep the wrong tags until Paket 2. This step only stops the error from propagating further.

- [ ] **Step 1: Stop the server**

Confirm no scan is in progress (`DISABLE_AUTOMATIC_PROCESSING` should already be `yes` per project convention; verify before proceeding).

- [ ] **Step 2: Back up `data/entities.db` outside the project directory**

```bash
cp data/entities.db "$(dirname "$(pwd)")/entities.db.bak-2026-08-06"
```

- [ ] **Step 3: Confirm the three rows exist exactly as expected**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/entities.db', { readonly: true });
const rows = db.prepare(
  \"SELECT entity_type, alias_normalized, canonical_name, source FROM entity_aliases WHERE entity_type = 'tag' AND alias_normalized IN ('austrittsdatum', 'september 2025', 'urlaubsverguetung')\"
).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
"
```
Expected: 3 rows, matching the table above (canonical_name = "Eintrittsdatum" / "November 2025" / "Ausbildungsvergütung", source = "user").

- [ ] **Step 4: Delete the three aliases**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/entities.db');
const info = db.prepare(
  \"DELETE FROM entity_aliases WHERE entity_type = 'tag' AND alias_normalized IN ('austrittsdatum', 'september 2025', 'urlaubsverguetung')\"
).run();
console.log('Geloeschte Zeilen:', info.changes);
db.close();
"
```
Expected: `Geloeschte Zeilen: 3`.

- [ ] **Step 5: Verify removal**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/entities.db', { readonly: true });
const remaining = db.prepare(
  \"SELECT COUNT(*) AS n FROM entity_aliases WHERE entity_type = 'tag' AND alias_normalized IN ('austrittsdatum', 'september 2025', 'urlaubsverguetung')\"
).get();
console.log('Verbleibend:', remaining.n);
db.close();
"
```
Expected: `Verbleibend: 0`. This satisfies Paket-1 acceptance criterion 4.

- [ ] **Step 6: Review the remaining 19 aliases**

Run the same read-only query pattern as Step 3 with `SELECT * FROM entity_aliases` (no filter) and manually review. Per the audit, pay particular attention to:
- `invoice contract` → document type `contract` (becomes moot once Task 7 ships, but the alias itself is not auto-removed — leave a note in the Paket-2 handoff if it's still present).
- `personal nr <Nr>` → correspondent "Personal-Nr. <Nr>" (0 docs, `auto` source).
- `herrn <inhaber>` → correspondent "Herr <Inhaber>" (3 docs, recipient mistaken for sender).

No code change for this sub-step — it's a documented review, not an action. Record findings in the Paket-1 completion notes (Task 16) for Paket 2 to pick up.

- [ ] **Step 7: Restart the server if it was stopped, resume normal operation**

No git commit for this task — `data/entities.db` is gitignored and no source file changed.

---

### Task 15: Gemessene Betriebswerte versionieren (1.5)

**Files:**
- Modify: `docs/planning/klassifikations-konsistenz-roadmap.md`

**Interfaces:** none — documentation only.

**Why:** the actual root cause of A-4 wasn't someone flipping a switch — it's that the measured operational values were never versioned anywhere and were lost during the 2026-08-05 environment rebuild. `.env.example` can't serve this purpose: it's the shipped default for other installations, not this instance's configuration.

- [ ] **Step 1: Add the new section**

In `docs/planning/klassifikations-konsistenz-roadmap.md`, insert a new section immediately before `## Offene Risiken` (currently line 398):

```markdown
## Gemessene Betriebswerte

Diese Tabelle ist die Versionierung, die A-4 gefehlt hat: die eigentliche
Ursache war nicht ein umgelegter Schalter, sondern dass gemessene Werte
nirgends außerhalb von `data/.env` festgehalten waren und beim Neuaufsetzen
am 2026-08-05 verloren gingen. `.env.example` kann das nicht leisten — es ist
der ausgelieferte Default für fremde Installationen, nicht die Konfiguration
dieser Instanz. Werte gehören hierher, nicht ins Beispiel.

| Variable | gemessener Wert | Quelle |
|---|---|---|
| `ENTITY_RESOLVER_AUTO_THRESHOLD` | 0.8 | Phase-2-Tuning; im Test 2026-08-06 bestätigt (5 von 5 Auto-Merges korrekt, höchster Wert 0.848 — 0.90 hätte alle fünf verhindert) |
| `ENTITY_RESOLVER_JUDGE_MIN` | 0.5 | Phase-2-Tuning |
| `EMBEDDING_EXCLUDED_TYPES` | `tag` | Phase-5-Messung 2026-08-02 |
| `EMBED_AUTO_THRESHOLD` / `EMBED_JUDGE_MIN` | offen | siehe [Fixplan, "Vertagte Entscheidungen", V-1](../audit/2026-08-06-fixplan-konsistenz-und-review-ui.md#vertagte-entscheidungen) |
| `FINGERPRINT_SIMILARITY_THRESHOLD` | ungemessen | NACHAUDIT-10, weiterhin offen |
| `ENTITY_JUDGE_TIMEOUT_MS` | 60000 | Messung E-1, 2026-08-06 (siehe Fixplan Paket 1, Abschnitt 1.1.a) |

Bei jeder künftigen Neu- oder Nachmessung diese Tabelle aktualisieren, bevor
der Wert in `data/.env` geändert wird — nicht danach.
```

- [ ] **Step 2: Verify the doc renders sensibly**

Read the file back and confirm the new section sits between Phase 5 and "Offene Risiken", and that the markdown table isn't malformed (no unescaped `|` inside cells).

- [ ] **Step 3: Commit**

```bash
git add docs/planning/klassifikations-konsistenz-roadmap.md
git commit -m "docs: version the measured operational values in the roadmap (1.5, E-6, root cause of A-4)"
```

---

### Task 16: Paket-1-Abnahme — alle fünf Kriterien verifizieren

**Files:** none modified — this task runs the verification, no code changes. If any criterion fails, fix the underlying task before re-running (do not weaken the criterion).

**Interfaces:** none.

This task is the acceptance gate from the Fixplan (lines 358-372). All five must pass.

- [ ] **Step 1: Criterion 1 — tests and lint clean**

Run: `npm test && npm run lint`
Expected: `# pass 460+` (460 plus any tests added in Tasks 1–13), `# fail 0`; lint `0 problems`.

- [ ] **Step 2: Criterion 2 — Judge measurement, ≥12 real pairs, 0 timeouts, median < 15000 ms**

Requires a real `data/eval/entity-labels.json` with at least 12 real name pairs across types (build it from the current Paperless tag/correspondent/document-type inventory, same format `scripts/tune-thresholds.js` uses — do not commit this file, it contains real names).

Run: `node scripts/measure-judge-latency.js`
Expected: `Timeouts/Fehler: 0` and the printed median is under `15000` ms. If not met, return to Task 3/4/6 — do not lower the bar here.

- [ ] **Step 3: Criterion 3 — dry-run over documents 127, 129, 147, `--repeat 2`, 3-of-3 stable, no placeholder-like document type**

Run: `node scripts/dry-run-eval.js --ids 127,129,147 --repeat 2`
Expected: `documentsUnstable: 0` in the summary output, and no `document_type` in any attempt resembling `Invoice/Contract/...` or similar. If a document ID from the original test no longer exists (e.g. deleted/renumbered since the audit), note the substitution and the reason in this plan file's completion notes before proceeding.

- [ ] **Step 4: Criterion 4 — `entity_aliases` no longer contains the three wrong mappings**

Already verified in Task 14, Step 5. Re-run the same read-only query here as a final gate:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/entities.db', { readonly: true });
const remaining = db.prepare(
  \"SELECT COUNT(*) AS n FROM entity_aliases WHERE entity_type = 'tag' AND alias_normalized IN ('austrittsdatum', 'september 2025', 'urlaubsverguetung')\"
).get();
console.log('Verbleibend:', remaining.n);
db.close();
"
```
Expected: `Verbleibend: 0`.

- [ ] **Step 5: Criterion 5 — "Gemessene Betriebswerte" section exists and is committed**

Run: `git log --oneline -- docs/planning/klassifikations-konsistenz-roadmap.md | head -1`
Expected: shows Task 15's commit. Confirm with `git show HEAD:docs/planning/klassifikations-konsistenz-roadmap.md | grep -A2 "## Gemessene Betriebswerte"` that it's present in the committed version, not just the working tree.

- [ ] **Step 6: Record completion**

Update the Fixplan's checkbox for Paket 1 (`docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md`, the `## Arbeitsplan` list near the top) from `1. [ ] **Paket 1 — Kette reparieren**...` to `1. [x] **Paket 1 — Kette reparieren**...`, and append a short "Abgenommen am <date>" note with the actual measured median/timeout numbers from Step 2 and the stability result from Step 3, plus any findings from Task 14 Step 6 (remaining-alias review) for Paket 2 to pick up.

- [ ] **Step 7: Commit**

```bash
git add docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md
git commit -m "docs: record Paket-1 acceptance results"
```

---

## Self-Review Notes

- **Spec coverage:** every sub-item from Fixplan section "Paket 1 — Kette reparieren" (1.0.a through 1.5, plus all 5 acceptance criteria) maps to a task above. E-1 through E-6 are reflected as rationale, not separate tasks (they're already-made decisions, not action items — matches the Fixplan's own framing).
- **Type consistency:** `config.entityJudge.timeoutMs` (Task 3) is the single source read by both the axios client timeout (Task 3) and the slow-call threshold (Task 6) — no duplicate constant. `_isPlausibleDocumentType` (Task 9) mirrors `_isPlausibleTag`'s exact signature (`(value) => boolean`). `_hasPreExistingPromptMismatch` (Task 10) and `_parseEnvNumber`/`_maskUrl` follow the same `_`-prefixed export convention.
- **Deliberately out of scope** (per the Fixplan): A-4 (embedding channel, "Vertagte Entscheidungen" V-1), Paket 2 (Altdaten), Paket 3 (Review-UI), and the FIX-01 code fix itself (only worked around via the documented SQL step in Paket 2, not in this plan).
