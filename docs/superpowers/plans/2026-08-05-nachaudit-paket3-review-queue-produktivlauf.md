# Nachaudit Paket 3 — Review-Queue abarbeiten und Fix-Welle produktiv verifizieren — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Abweichung von den bisherigen Nachaudit-Plänen:** Dieses Paket ist kein
> reiner Code-Task. NACHAUDIT-08 und NACHAUDIT-09 verlangen Aktionen auf der
> laufenden **Produktivinstanz** mit echten Paperless-ngx-Daten
> (`data/entities.db`: 1 Alias, 121 Queue-Zeilen/120 offen, 72 Embeddings,
> Stand Erstaudit). In diesem Arbeitsverzeichnis existiert **kein**
> `data/entities.db` (nur `data/documents.db`, geprüft 2026-08-05) — die
> Datei ist über `.gitignore` (`data/`) ohnehin nie versioniert und liegt nur
> auf der Zielmaschine. Tasks 2–7 können deshalb nicht aus diesem Checkout
> heraus ausgeführt werden; sie sind als Runbook für die Session formuliert,
> die tatsächlich auf der Produktivinstanz operiert (Zugriff auf `/review`
> als authentifizierter Nutzer, Shell-Zugriff auf `data/entities.db` und
> `POST /api/scan/now` mit einem gültigen API-Token). Task 1 und Task 8 sind
> aus diesem Checkout heraus prüf- bzw. committbar.

**Goal:** Die 120 offenen Review-Queue-Einträge aus dem Erstaudit
(AUDIT-030-Rest, NACHAUDIT-08) über die bestehende Review-UI abarbeiten und
anschließend einen echten Scan-Zyklus beobachten, um zu verifizieren, dass
die abgesenkten EntityResolver-Schwellwerte (`autoThreshold=0.8`,
`judgeMin=0.5`, vorher 0.90/0.65) unter echter Last wie erwartet arbeiten
(NACHAUDIT-09) — insbesondere ob `entity_merge_log` plausible,
korrekte Merges zeigt und ob 0.8 spürbar mehr Auto-Merges auslöst als die
ursprünglich geschätzten 0.90.

**Kontext:** Laut Nachaudit (`docs/audit/2026-08-04-nachaudit-offene-punkte.md`,
Paket 3) hängen beide Punkte an derselben Beobachtung: Die gesamte Fix-Welle
ist bisher ausschließlich durch Tests, nie durch einen produktiven Lauf
verifiziert. Eine ungelesene Queue ist keine wirksame Absicherung des
Resolvers. **Setzt Paket 1 voraus**, da `POST /api/scan/now` über dieselben
Routen läuft, deren Schutz Paket 1 (NACHAUDIT-01) herstellt — siehe Task 1.
Paket 1 ist in diesem Repo bereits gemergt (`git log`, Commit `f16b9bf` und
Vorgänger; `routes/setup.js` nutzt inzwischen exaktes Matching
(`PUBLIC_ROUTES.includes(req.path)`) statt `startsWith`, `/api/scan/now`
steht nicht in `PUBLIC_ROUTES`). Ob der Fix auch auf der **Produktivinstanz**
deployt ist, ist eine separate Frage — siehe Task 1.

**Tech Stack:** Node.js (CommonJS), `better-sqlite3` (`data/entities.db`),
Express-Routen `routes/review.js` / `routes/setup.js`, Review-UI
(`views/review.ejs`, `public/js/review.js`). Keine neue Dependency geplant;
Task 2 fügt optional ein kleines Read-only-Reportskript hinzu.

**Referenz:** [../../audit/2026-08-04-nachaudit-offene-punkte.md](../../audit/2026-08-04-nachaudit-offene-punkte.md), Abschnitt „Paket 3" (NACHAUDIT-08, NACHAUDIT-09)

## Ergebnis (2026-08-05, tatsächliche Durchführung)

Abweichend von der ursprünglichen Annahme dieses Plans existierte der im
Erstaudit beschriebene 120-Eintrag-Bestand nicht mehr (anderes,
nicht mehr erreichbares Gerät). Stattdessen wurde `paperless-jo` auf dieser
Maschine frisch gegen die reale Paperless-ngx-VM aufgesetzt, EntityResolver
aktiviert (`autoThreshold=0.8`, `judgeMin=0.5`) und ein echter Scan über alle
64 vorhandenen Dokumente gefahren (62 neu verarbeitet, 0 Fehler). Die Details
inklusive zweier dabei gefundener und noch in derselben Session behobener
Bugs (fehlende Judge-Begründung in der Review-UI; nichtssagender 400er bei
bereits durch einen anderen Merge gelöschtem Ziel) stehen unter
NACHAUDIT-08/-09/-14/-15 in
[../../audit/2026-08-04-nachaudit-offene-punkte.md](../../audit/2026-08-04-nachaudit-offene-punkte.md).
Kurzfassung: 25 Queue-Einträge entstanden, 18 gemergt (3 davon inhaltlich
falsch — menschlicher Fehler, siehe NACHAUDIT-14 für die Ursache), 6 korrekt
abgelehnt, 1 durch NACHAUDIT-15 blockiert und rejected. Die 3 falschen
Merges bleiben auf Nutzerentscheidung unkorrigiert (kein Rollback-Pfad,
NACHAUDIT-12). `entity_merge_log`: 18 `completed`, 5 `failed` (alle
NACHAUDIT-15). Vollständige Testsuite nach beiden Fixes: 421/421 grün.

## Global Constraints

- `data/.env` und alle darin enthaltenen Zugangsdaten (Paperless-Token,
  Ollama-URL) dürfen nie in Commits, Logs, Doku-Beispielen oder
  Zusammenfassungen im Klartext auftauchen — nur Platzhalter.
- Jede Aktion, die Paperless-ngx-Daten ändert (Merge über
  `POST /api/review/:id/merge`, `bulkReject`, ein ausgelöster Scan über
  `POST /api/scan/now`), läuft gegen die **echte** Paperless-Instanz und ist
  **nicht** durch einen Dry-Run reversibel, sobald sie ausgeführt wurde
  (`mergeEntity` mit `dryRun:false` löscht die verdrängte Entität in
  Paperless und hängt ihre Dokumente um — siehe
  `services/reviewQueueService.js:34-43`). Vor jedem echten Merge zuerst
  `previewMerge` (Dry-Run, Standardverhalten des `merge-btn` in der UI)
  betrachten, nicht blind bestätigen.
- Kein Massen-Reject ohne vorherige Bestandsaufnahme (Task 2) — die
  bestehende `bulkRejectBelowSimilarity` filtert ausschließlich auf die
  Trigram-Spalte `similarity` (AUDIT-029-Skala, siehe
  `models/entityStore.js:358-360`), unabhängig von `llm_verdict` oder
  `embedding_similarity`. Für Einträge aus dem Live-Resolver-Pfad ist das
  unkritisch (`llm_verdict='same'` wird nie in die offene Queue geschrieben,
  siehe `services/entityResolver.js:165-198` — nur `'unsure'` landet offen).
  Für Einträge aus dem Altbestand-Backfill (`/api/review/backfill/:entityType`,
  `services/entityBackfillService.js`) existiert dagegen **kein**
  Judge-Aufruf und damit kein `llm_verdict`-Gegencheck — diese Einträge vor
  einem Bulk-Reject stichprobenartig ansehen, nicht blind nach Trigram-Wert
  wegwerfen.
- Ein laufender Scan blockiert `POST /api/scan/now` bereits serverseitig
  (`scanRunGuard`, AUDIT-014) — Task 6 muss das nicht selbst absichern, nur
  die 409-Antwort als „läuft bereits, abwarten" behandeln statt als Fehler.
- Sprachkonvention: Dieser Plan sowie `docs/audit/`-Updates sind Deutsch,
  Code-Kommentare und neue Skripte (Task 2) folgen dem bestehenden Stil der
  jeweiligen Datei.

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `scripts/review-queue-report.js` | Read-only Verteilungsreport der offenen Queue (neu, optional) | Add (Task 2) |
| `data/entities.db` (nur auf Produktivinstanz) | Review-Queue-Status, Aliase, Merge-Log | Modify über UI/API (Task 3–4, 6), nie direkt |
| `docs/audit/2026-08-04-nachaudit-offene-punkte.md` | Arbeitsplan-Checkbox, Ergebnis-Vermerk | Modify (Task 8) |
| `docs/superpowers/plans/2026-08-05-nachaudit-paket3-review-queue-produktivlauf.md` | dieser Plan | Add |

---

### Task 1: Vorbedingung prüfen — Paket 1 ist auf der Zielinstanz aktiv

**Files:** keine Änderung — reine Verifikation, aus diesem Checkout heraus
teilweise möglich.

**Warum zuerst:** NACHAUDIT-09 löst `POST /api/scan/now` aus. Ist der
Produktivinstanz-Prozess noch auf einem Stand vor dem Setup-Route-Fix
(Commits laut Paket-2-Plan: `9af7a32`, `28ceec0`, ..., `70b455b`), bleibt das
kritische Loch aus NACHAUDIT-01 auf genau der Instanz offen, die dieses
Paket anfasst — dann zuerst dort deployen, nicht dieses Paket beginnen.

- [ ] **Step 1: Lokalen Stand bestätigen (aus diesem Checkout)**

```bash
git log --oneline -5 -- routes/setup.js
grep -n "PUBLIC_ROUTES.includes\|PUBLIC_ROUTES\[" routes/setup.js
```

Erwartet: `PUBLIC_ROUTES.includes(req.path)` (exaktes Matching, nicht
`startsWith`) und `POST /setup` prüft `isConfigured()`/Nutzeranzahl vor
jeder anderen Anweisung im Handler — beides bereits bestätigt für `main`
(Commit `f16b9bf` und Vorgänger).

- [ ] **Step 2: Deploy-Stand der Produktivinstanz prüfen**

Auf der Zielmaschine (nicht diesem Checkout): laufende Version/Commit-Hash
des Prozesses gegen `git log` auf `main` abgleichen (z. B. über die im
Deployment übliche Methode — `docker compose ps`/Image-Tag falls
containerisiert, sonst `git rev-parse HEAD` im dortigen Arbeitsverzeichnis).

- [ ] **Step 3: Falls die Instanz hinter `main` zurückliegt**

Erst regulären Deploy/Restart durchführen (außerhalb dieses Plans — hängt
vom bestehenden Deployment-Prozess des Projekts ab, hier nicht
dokumentiert), danach mit Task 2 fortfahren. Ohne diesen Schritt bleibt
NACHAUDIT-01 auf der Produktivinstanz ausnutzbar, während Task 6 dieses
Plans zusätzlichen Traffic auf genau die betroffene Route lenkt.

---

### Task 2: Bestandsaufnahme der offenen Queue vor jeder Aktion

**Files:**
- Add (optional, empfohlen): `scripts/review-queue-report.js`

**Warum:** 120 offene Einträge blind über die UI durchzuklicken ist
fehleranfällig und langsam. Eine Verteilung nach `entity_type`,
`llm_verdict` und Similarity-Bändern zeigt vorab, wie viele Einträge
eindeutig sind (niedrige Trigram-Similarity, `llm_verdict is null` aus dem
Backfill) versus grenzwertig (nahe an `judgeMin`/`autoThreshold`,
`llm_verdict='unsure'`) und macht Task 3/4 planbar statt ad-hoc.

- [ ] **Step 1: Report-Skript schreiben**

Neues Skript nach dem Muster von `scripts/tune-thresholds.js` (gleicher
`config.entityResolver.dbPath`, `better-sqlite3` direkt, read-only):

```js
#!/usr/bin/env node
// Read-only Verteilungsreport der offenen Review-Queue vor NACHAUDIT-08/-09.
// Aendert nichts - dient nur der Priorisierung vor dem manuellen Durchgang.
const Database = require('better-sqlite3');
const config = require('../config/config');

const db = new Database(config.entityResolver.dbPath, { readonly: true });

console.log(`Datenbank: ${config.entityResolver.dbPath}`);
console.log(`Aktive Schwellwerte: autoThreshold=${config.entityResolver.autoThreshold}, judgeMin=${config.entityResolver.judgeMin}`);

const total = db.prepare(`SELECT COUNT(*) AS n FROM entity_review_queue WHERE status = 'open'`).get();
console.log(`\nOffene Eintraege gesamt: ${total.n}`);

console.log('\nNach entity_type:');
for (const row of db.prepare(`
  SELECT entity_type, COUNT(*) AS n
  FROM entity_review_queue WHERE status = 'open'
  GROUP BY entity_type ORDER BY n DESC
`).all()) {
  console.log(`  ${row.entity_type}: ${row.n}`);
}

console.log('\nNach llm_verdict (NULL = Backfill ohne Judge-Aufruf):');
for (const row of db.prepare(`
  SELECT COALESCE(llm_verdict, '(null)') AS verdict, COUNT(*) AS n
  FROM entity_review_queue WHERE status = 'open'
  GROUP BY llm_verdict ORDER BY n DESC
`).all()) {
  console.log(`  ${row.verdict}: ${row.n}`);
}

console.log('\nTrigram-Similarity-Baender (Spalte "similarity", AUDIT-029-Skala):');
for (const row of db.prepare(`
  SELECT
    CASE
      WHEN similarity < 0.5 THEN '< 0.50'
      WHEN similarity < 0.65 THEN '0.50-0.65'
      WHEN similarity < 0.8 THEN '0.65-0.80'
      ELSE '>= 0.80'
    END AS band,
    COUNT(*) AS n
  FROM entity_review_queue WHERE status = 'open'
  GROUP BY band ORDER BY band
`).all()) {
  console.log(`  ${row.band}: ${row.n}`);
}

db.close();
```

- [ ] **Step 2: Ausführen (auf der Produktivinstanz)**

```bash
node scripts/review-queue-report.js
```

Ergebnis notieren (wird in Task 4/8 als Grundlage für die
Bulk-Reject-Schwelle und die Dokumentation gebraucht).

- [ ] **Step 3: Commit des Skripts (unabhängig vom Ergebnis, read-only)**

```bash
git add scripts/review-queue-report.js
git commit -m "$(cat <<'EOF'
feat: Read-only Verteilungsreport fuer die Review-Queue (NACHAUDIT-08)

Zeigt offene Eintraege nach entity_type, llm_verdict und
Trigram-Similarity-Band, bevor die 120 offenen Eintraege aus dem Erstaudit
manuell abgearbeitet werden - Grundlage fuer eine geplante statt blinde
Bulk-Reject/Merge-Reihenfolge. Aendert keine Daten.

Nachaudit 2026-08-04, NACHAUDIT-08 (Vorbereitung).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Eindeutig unähnliche Paare per Bulk-Reject abräumen

**Files:** keine Code-Änderung — nutzt die bestehende UI (`/review`,
Feld „Reject all below trigram similarity") bzw. direkt
`POST /api/review/bulk-reject`.

**Voraussetzung:** Ergebnis aus Task 2 liegt vor.

- [ ] **Step 1: Schwelle je `entity_type` festlegen**

Anhand der Similarity-Bänder aus Task 2: alles im Band `< 0.50` ist per
Definition unter `judgeMin=0.5` und war nie durch den Judge bewertet, sofern
`llm_verdict` dort `(null)` ist — diese sind die sichersten
Bulk-Reject-Kandidaten. Vorschlag als Startpunkt: `maxSimilarity=0.5`, **pro
`entity_type` einzeln ausführen** (nicht global), damit ein Typ mit
grundsätzlich kürzeren Namen (z. B. `tag`) nicht dieselbe Schwelle wie
`correspondent` bekommt, ohne das separat betrachtet zu haben.

- [ ] **Step 2: Stichprobe vor dem Bulk-Reject ansehen**

In der `/review`-UI mit `sort=similarity_asc` und `entityType`-Filter die
untersten 5–10 Einträge des jeweiligen Typs durchsehen (Spalten Proposed/
Candidate/Judge). Erwartet: offensichtlich verschiedene Namen. Falls ein
Eintrag mit `llm_verdict='unsure'` in diesem Band aus dem Live-Pfad
auftaucht, das Band vorsichtiger wählen (niedriger ansetzen) statt die
Stichprobe zu ignorieren.

- [ ] **Step 3: Bulk-Reject ausführen (je `entity_type`)**

Über die UI (Feld + Button „Reject matches below threshold" in
`views/review.ejs:92-100`) oder äquivalent:

```bash
curl -X POST https://<produktivinstanz>/api/review/bulk-reject \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"entityType": "tag", "maxSimilarity": 0.5}'
```

Antwort `{ "rejected": <n> }` notieren.

- [ ] **Step 4: Verbleibende offene Anzahl gegen Task 2 gegenprüfen**

```bash
node scripts/review-queue-report.js
```

Erwartet: „Offene Eintraege gesamt" um genau die Summe der `rejected`-Werte
aus Step 3 gesunken.

---

### Task 4: Verbleibende Einträge manuell durchgehen

**Files:** keine Code-Änderung — UI-gesteuert
(`POST /api/review/:id/merge` mit `dryRun` erst `true`, dann `false`;
`POST /api/review/:id/reject`).

- [ ] **Step 1: Nach Similarity absteigend sortiert durchgehen**

`/review?sort=similarity_desc`, optional nach `entityType` gefiltert. Für
jeden Eintrag:
1. „Preview" (`preview-btn`) öffnen — zeigt Beispieldokumente zu Proposed
   und Candidate (`GET /api/review/:id/documents`) zur inhaltlichen
   Einordnung.
2. Bei klarer Übereinstimmung: „Merge" klickt zuerst intern den Dry-Run
   (`previewMerge`, `dryRun:true` per Default in
   `routes/review.js:114`); erst nach Bestätigung im
   `mergeConfirmModal` läuft der echte, irreversible Merge.
3. Bei klarer Nicht-Übereinstimmung: „Not a duplicate" (`reject-btn`).
4. Bei Unsicherheit: offen lassen, in Task 8 als bewusst zurückgestellt
   dokumentieren statt einer Rätsel-Entscheidung.

- [ ] **Step 2: Zähler mitführen**

Während des Durchgangs mitschreiben: Anzahl Merges, Anzahl Reject,
Anzahl bewusst offen gelassen (mit kurzer Begründung je offen gelassenem
Fall, z. B. „Namensvariante ohne eindeutige Beispieldokumente").

- [ ] **Step 3: Abschlussstand messen**

```bash
node scripts/review-queue-report.js
```

Erwartet: „Offene Eintraege gesamt" nahe 0 (oder exakt die Anzahl der
bewusst zurückgestellten Fälle aus Step 2).

---

### Task 5: `entity_aliases` und `entity_merge_log` nach dem manuellen Durchgang prüfen

**Files:** keine Änderung — Verifikation.

- [ ] **Step 1: Neue Aliase stichprobenartig ansehen**

```bash
sqlite3 data/entities.db "SELECT entity_type, alias_normalized, canonical_name, source FROM entity_aliases WHERE source = 'user' ORDER BY id DESC LIMIT 20;"
```

Erwartet: `source='user'` für jeden in Task 4 manuell bestätigten Merge
(`services/reviewQueueService.js:56`, `source: 'user'`), Name-Paare
plausibel.

- [ ] **Step 2: Merge-Log auf Fehlschläge prüfen**

```bash
sqlite3 data/entities.db "SELECT entity_type, from_id, to_id, status, error_message FROM entity_merge_log WHERE status != 'completed';"
```

Erwartet: leer. Falls nicht leer — vor Task 6 klären, ob ein
fehlgeschlagener Merge einen inkonsistenten Queue-Eintrag hinterlassen hat
(bekanntes Risiko, siehe Kommentar in
`services/reviewQueueService.js:44-49`, AUDIT-015).

---

### Task 6: Echten Scan-Zyklus auslösen und beobachten

**Files:** keine Code-Änderung.

**Voraussetzung:** Task 1 (Paket 1 live) und Task 3/4 (Queue soweit
sinnvoll geleert, damit neue Auto-Merges nicht in einer riesigen Restqueue
untergehen) abgeschlossen.

- [ ] **Step 1: `entity_merge_log`-Stand vor dem Scan festhalten**

```bash
sqlite3 data/entities.db "SELECT COUNT(*) FROM entity_merge_log;"
```

- [ ] **Step 2: Scan auslösen**

```bash
curl -X POST https://<produktivinstanz>/api/scan/now \
  -H "Authorization: Bearer <token>"
```

Bei `409 { "message": "A scan is already running" }`: ein bereits
laufender/geplanter Scan (`config.scanInterval`, `server.js:613`) blockiert
— abwarten und später erneut prüfen, kein Fehler.

- [ ] **Step 3: Verlauf beobachten**

Server-Log während des Laufs verfolgen (Ziel: `action: 'map'` via
`'similarity'`/`'embedding_similarity'`/`'llm'` in
`services/entityResolver.js:111/127/172` sind die drei Auto-Merge-Pfade).
Scan-Ende abwarten (Dauer abhängig von Dokumentanzahl).

---

### Task 7: Neue Auto-Merges gegen die abgesenkten Schwellwerte auswerten

**Files:** keine Code-Änderung.

**Kernfrage aus NACHAUDIT-09:** Löst `autoThreshold=0.8` (vorher 0.90)
spürbar mehr automatische Zusammenführungen aus, und sind die zusätzlichen
Merges korrekt (kein False Positive durch die gesenkte Schwelle)?

- [ ] **Step 1: Neue Merge-Log-Einträge zählen**

```bash
sqlite3 data/entities.db "SELECT COUNT(*), status FROM entity_merge_log GROUP BY status;"
```

Differenz zum Stand aus Task 6, Step 1 bilden.

- [ ] **Step 2: Auto-Merges (nicht user-bestätigt) stichprobenartig prüfen**

```bash
sqlite3 data/entities.db "SELECT entity_type, alias_normalized, canonical_name, source FROM entity_aliases WHERE source IN ('auto', 'auto_embedding', 'llm') ORDER BY id DESC LIMIT 20;"
```

Für jeden Eintrag: sind `alias_normalized`/`canonical_name` tatsächlich
dieselbe Entität? Bei `source='auto'`: Trigram-Similarity war `>= 0.8` —
plausibel bei Tippfehlern/Schreibvarianten, aber bei kurzen/generischen
Namen (z. B. Ein-Wort-Tags) steigt das False-Positive-Risiko bei 0.8
gegenüber 0.90 strukturell. Auffällige Fälle notieren.

- [ ] **Step 3: Rate gegen die AUDIT-025-Messung einordnen**

Vergleichen: Anteil `source='auto'` an allen neuen Aliasen aus Step 1/2
gegen die in `scripts/tune-thresholds.js`-Auswertung erwartete Rate bei
0.8 (falls diese Messung dokumentiert vorliegt — sonst als „erste
Beobachtung ohne historischen Vergleichswert" festhalten, nicht
nacherfinden).

---

### Task 8: Ergebnis dokumentieren, Nachaudit-Arbeitsplan aktualisieren

**Files:**
- Modify: `docs/audit/2026-08-04-nachaudit-offene-punkte.md` (Arbeitsplan-Checkbox Punkt 3, ggf. NACHAUDIT-08/-09-Abschnitte mit Ergebnis-Vermerk)

- [ ] **Step 1: Ergebnis zusammentragen**

Aus Task 2 (Ausgangsverteilung), Task 3/4 (Merge-/Reject-/Offen-Zähler),
Task 7 (Auto-Merge-Beobachtung) einen kurzen Ergebnis-Absatz analog zum
Muster in Paket 2 (siehe Zeilen 33-40 desselben Dokuments) formulieren —
faktisch, mit konkreten Zahlen, keine Bewertung ohne Beleg.

- [ ] **Step 2: Checkbox aktualisieren**

In `docs/audit/2026-08-04-nachaudit-offene-punkte.md`, Zeile 42-44:

```
3. [ ] **Review-Queue abarbeiten und Fix-Welle produktiv verifizieren**
   (AUDIT-030-Rest, Produktivlauf)
   → Setzt Paket 1 voraus (Scan läuft über dieselben ungeschützten Routen).
```

durch:

```
3. [x] **Review-Queue abarbeiten und Fix-Welle produktiv verifizieren**
   (AUDIT-030-Rest, Produktivlauf)
   → Umgesetzt laut [2026-08-05-nachaudit-paket3-review-queue-produktivlauf.md](../superpowers/plans/2026-08-05-nachaudit-paket3-review-queue-produktivlauf.md).
```

(Falls Task 4 bewusst offene Fälle hinterlassen hat: `[x]` nur setzen, wenn
das im Ergebnis-Absatz aus Step 1 als akzeptierter Restzustand begründet
ist, sonst `[~]`-artigen Hinweis oder offen lassen — kein Status
vortäuschen, der nicht zutrifft.)

- [ ] **Step 3: Commit**

```bash
git add docs/audit/2026-08-04-nachaudit-offene-punkte.md
git commit -m "$(cat <<'EOF'
docs: Paket 3 des Nachaudits abgeschlossen (NACHAUDIT-08, NACHAUDIT-09)

Review-Queue der Produktivinstanz abgearbeitet (<N> Merges, <N> Rejects,
<N> bewusst offen gelassen) und ein echter Scan-Zyklus unter den
abgesenkten EntityResolver-Schwellwerten (0.8/0.5) beobachtet. Ergebnis in
docs/audit/2026-08-04-nachaudit-offene-punkte.md und der Plan-Datei
festgehalten.

Nachaudit 2026-08-04, Paket 3.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance Criteria

- Task 1 bestätigt: Die Produktivinstanz läuft auf einem Stand mit dem
  NACHAUDIT-01-Fix (exaktes `PUBLIC_ROUTES`-Matching, `POST /setup`-Guard),
  bevor `POST /api/scan/now` in Task 6 ausgelöst wird.
- Die Anzahl offener Review-Queue-Einträge (`entity_review_queue`,
  `status='open'`) ist gegenüber dem Erstaudit-Stand (120) auf einen
  dokumentierten, bewusst gewählten Wert reduziert — im Zielfall 0, ein
  Rest ist nur akzeptabel, wenn Task 8 begründet, warum.
- `entity_merge_log` enthält mindestens einen Eintrag mit `status='completed'`
  aus einem tatsächlichen Produktiv-Scan (nicht nur aus manuellen Merges in
  Task 4) — der Kern von NACHAUDIT-09.
- Kein Eintrag in `entity_merge_log` mit `status='failed'` bleibt
  unkommentiert; jeder Fehlschlag ist in Task 5/8 benannt.
- Die Stichprobe aus Task 7 zeigt keine offensichtlich falschen Auto-Merges
  bei der abgesenkten Trigram-Schwelle (0.8) — falls doch, ist das als
  Befund in Task 8 festgehalten statt stillschweigend übergangen.
- `docs/audit/2026-08-04-nachaudit-offene-punkte.md` spiegelt den
  tatsächlichen Abarbeitungsstand wider (kein `[x]` ohne Beleg).
- `data/.env`-Zugangsdaten tauchen an keiner Stelle dieses Plans, seiner
  Ausführung oder der Ergebnisdokumentation im Klartext auf.
