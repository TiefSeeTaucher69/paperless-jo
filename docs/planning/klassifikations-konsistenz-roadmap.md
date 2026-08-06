# Roadmap: Konsistenz der automatischen Dokumentklassifikation

**Angelegt:** 2026-08-01
**Entwurf:** [docs/superpowers/specs/2026-08-01-klassifikations-konsistenz-design.md](../superpowers/specs/2026-08-01-klassifikations-konsistenz-design.md)
**Branch:** `docs/klassifikations-konsistenz`

## Gewählter Ansatz

Varianz an zwei Stellen bekämpfen statt an einer: **am Eingang** durch
deterministisches Sampling und sauberen Kontext, **am Ausgang** durch eine
Resolver-Kaskade, die Vorschläge des Modells gegen den Bestand abgleicht, statt
sie blind anzulegen.

Das Vokabular bleibt offen — neue Tags, Dokumentarten und Korrespondenten dürfen
weiter entstehen. Konsistenz entsteht durch Abgleich, nicht durch Beschränkung.

Kaskade in Kurzform: Alias-Tabelle → exakt → normalisiert → Ähnlichkeit ≥ 0.90
automatisch → Negativ-Cache → LLM-Judge im Zweifelsband → Review-Queue bei
unklarem Urteil. Jedes Entscheidungspaar wird höchstens einmal befragt und
danach dauerhaft aus der Alias- beziehungsweise Reject-Tabelle beantwortet.

Zurückgestellt: Embeddings als zweiter Ähnlichkeitskanal. Die Entscheidung
darüber fällt anhand der Tuning-Messung aus Phase 2, nicht vorab.

## Phasen

| # | Inhalt | Abhängigkeit | Status |
|---|---|---|---|
| 0 | Dry-Run-Harness und Fixture-Export | — | gebaut, Baseline ausstehend |
| 1 | Determinismus, Prompt-Hygiene, Prompt-Härtung | — | erledigt |
| 2 | EntityResolver, Alias-Speicher, Schwellwert-Tuning | — | erledigt |
| 3 | Review-UI, Merge, Altbestands-Durchlauf | Phase 2 | erledigt |
| 4 | Embeddings-Ähnlichkeitskanal | Phase 2, Messung Task 11 | erledigt |
| 5 | Fingerprint für wiederkehrende Dokumente | Phase 1–4 | erledigt |

Phase 1 und 2 sind unabhängig voneinander wirksam. Jede Phase bekommt einen
eigenen Implementierungsplan und wird einzeln abgenommen.

## Befunde aus dem Umgebungscheck (2026-08-01)

Der Check gegen die laufende Instanz hat drei Dinge zutage gefördert, die den
Plan verändern.

**`USE_EXISTING_DATA=no` ist die dominante Ursache.** In `_buildPrompt` werden
die Bestandslisten ausschließlich im `if`-Zweig eingefügt. Bei `no` läuft der
`else`-Zweig, der sie gar nicht enthält — das Modell sieht die vorhandenen 40
Tags, 17 Dokumentarten und 16 Korrespondenten also überhaupt nicht und erfindet
jedes Mal frei. Der konfigurierte System-Prompt enthält auch keinen der
`%RESTRICTED_*%`-Platzhalter, über die sie alternativ hineinkämen. Empirisch
bestätigt: derselbe Aufruf liefert mit `yes` einen um 214 Zeichen längeren
Prompt, der die Bestandsnamen tatsächlich enthält.

**Ein Teil der „Inkonsistenz" ist gar keine.** Unter den Korrespondenten stehen
vier Varianten des Anwendernamens samt Postanschrift — das Modell trägt den
Empfänger statt des Absenders ein. Der System-Prompt nennt zwar den Absender,
stellt ihn aber nie dem Empfänger gegenüber, und regelt weder Anrede noch
Anschrift, Rechtsform, Tag-Anzahl noch Singular/Plural. Ein Tag lautet
schlicht `November 2025`. Das repariert keine Dedup-Schicht, sondern nur der
Prompt. Phase 1 wird deshalb um Prompt-Härtung erweitert.

**Embeddings sind wahrscheinlicher nötig als geschätzt.** Der Bestand enthält
`Entgeltabrechnung` / `Payroll Statement` / `Verdienstbescheinigung` sowie
`Meldebescheid` / `Meldebescheinigung` / `Meldebeschreibung`. Diese meinen
dasselbe, liegen orthografisch aber weit auseinander — genau der blinde Fleck
der reinen String-Ähnlichkeit. Die Entscheidung fällt weiterhin anhand der
Messung aus Phase 2, aber Ansatz B ist kein Randfall mehr.

**Konfigurationsfalle:** `paperlessService.initialize()` setzt `baseURL` direkt
auf `PAPERLESS_API_URL` und ruft dann `/documents/`. Der Wert muss deshalb auf
`/api` enden. Das Setup-UI zeigt ihn ohne `/api` und hängt es beim Speichern an
— wer `data/.env` von Hand bearbeitet, erzeugt einen stillen Totalausfall, der
sich nur als Parse-Fehler äußert. Kandidat für einen Robustheitsfix in Phase 1.
**Stand Vollaudit 2026-08-02: weiterhin offen** — bewusst zurückgestellt
("Kandidat", keine Zusage), kein vergessener Punkt (AUDIT-035).

## Phase 0 — Dry-Run-Harness

**Dateien**

- `scripts/export-entity-fixture.js` — exportiert die Namenslisten nach
  `data/eval/entities.json`
- `scripts/dry-run-eval.js` — klassifiziert Dokumente über die echte Kette,
  **ohne** nach Paperless zu schreiben, und wertet aus

**Warum unter `data/`:** Die Namen enthalten personenbezogene Daten, darunter
Klarnamen und eine Wohnanschrift. `data/` ist gitignored; der Fork ist
öffentlich. Committete Tests bekommen stattdessen eine synthetische Fixture mit
denselben Fehlermustern.

**Gemessen wird** je Lauf: Anzahl verschiedener Tags, Dokumentarten und
Korrespondenten; Gruppen von Schreibvarianten; Korrespondenten mit Anrede oder
Anschrift im Namen; Tags, die wie ein Datum aussehen; und bei `--repeat > 1` die
Stabilität zwischen Wiederholungen desselben Dokuments.

**Zweck:** ein Messinstrument, das jede Phase vorher/nachher vergleichbar macht,
ohne die Instanz zu verändern. Der Bestand in Paperless bleibt unangetastet.

## Phase 1 — Determinismus und Prompt-Hygiene

**Vollständiger Implementierungsplan (maßgeblich, TDD, 9 Tasks, exakte
Code-Blöcke):**
[docs/superpowers/plans/2026-08-01-phase1-determinismus-prompt-hygiene.md](../superpowers/plans/2026-08-01-phase1-determinismus-prompt-hygiene.md).
Die folgende Liste ist eine Kurzfassung zur Orientierung; bei Abweichungen
gilt der Plan.

**Betroffene Dateien**

- `services/ollamaService.js`
- `services/restrictionPromptService.js`
- `server.js`
- `config/config.js`

**Schritte**

1. Sampling deterministisch: `temperature: 0`, fester `seed`, `top_p: 1`,
   `top_k` entfernen. Neue Env-Variablen `OLLAMA_TEMPERATURE`, `OLLAMA_SEED`.
2. `num_ctx` aus System- **und** User-Prompt berechnen; Untergrenze 2048,
   Obergrenze über `OLLAMA_NUM_CTX_MAX` (Default 8192).
3. Kontrollierte Kürzung: bei Überlauf nur den Dokumententext kürzen,
   Bestandslisten und Formatvorgabe schützen. `num_predict` auf 512.
4. `_formatTagsList` für String- und Objekt-Arrays öffnen — behebt den leeren
   `%RESTRICTED_TAGS%`-Platzhalter.
5. `processRestrictionsInPrompt` um einen Parameter für Dokumentarten erweitern,
   Platzhalter `%RESTRICTED_DOCUMENT_TYPES%` ergänzen.
6. Mutation von `config.mustHavePrompt` durch lokale Kopie ersetzen.
7. Prompt-Aufteilung korrigieren: `system` erhält den deutschen `SYSTEM_PROMPT`
   samt Formatvorgabe und Bestandslisten, `prompt` nur noch den Dokumententext.
   Hartkodierten englischen Analyzer-Prompt entfernen.
8. Tags defensiv filtern, die wie extrahierte Datenwerte statt Kategorien
   aussehen (Doppelpunkt, unplausible Länge) — ergänzt nach dem Baseline-Lauf.
9. `document_date` auf `YYYY-MM-DD` normieren oder verwerfen, statt ein
   abweichendes Format ungeprüft nach `updateData.created` durchzureichen —
   ergänzt nach dem Baseline-Lauf.

**Abnahmekriterium (präzisiert 2026-08-05, NACHAUDIT-04):** dasselbe
Dokument zweimal über `scripts/dry-run-eval.js --repeat 2` verarbeitet
liefert identische Ergebnisse **bei identischem Bestand** (Tags,
Korrespondenten, Dokumentarten unverändert zwischen den beiden Läufen), und
die Bestandslisten sind im tatsächlich gesendeten Prompt nachweisbar enthalten
(Prüfung über das bestehende Prompt-Log). Vollständiger Determinismus über
Läufe hinweg *unabhängig* vom Bestand ist mit diesem Design laut AUDIT-019
strukturell nicht erreichbar (wachsende Bestandslisten zwischen Läufen sind
eine legitime Rückkopplung, kein Bug) und ist **kein** Ziel dieses Kriteriums
— der Ausgang über den EntityResolver (Phase 2) ist der Hebel gegen
Inkonsistenz, nicht bitweise Prompt-Determinismus. Gemessene Baseline vor
Phase 1: 10 von 10 Dokumenten instabil; nach Phase 1–5 weiterhin 4 von 10
(Ursache: s. o., nicht durch Sampling behebbar).
Nicht über einen normalen Serverstart prüfen — `PROCESS_PREDEFINED_DOCUMENTS=yes`
und `DISABLE_AUTOMATIC_PROCESSING` ungesetzt bedeuten: ein Start verarbeitet
sofort Dokumente und schreibt nach Paperless.

## Phase 2 — EntityResolver

**Neue Dateien**

- `services/entityNormalizer.js`
- `services/entitySimilarity.js`
- `services/entityResolver.js`
- `models/entityStore.js`
- `scripts/export-entity-fixture.js`
- `scripts/tune-thresholds.js`
- `test/` mit `node:test`

**Geänderte Dateien**

- `services/paperlessService.js` — Einhängen in `processTags`,
  `getOrCreateCorrespondent`, `getOrCreateDocumentType`
- `package.json` — `npm test` wird `node --test`, bisheriges Verhalten nach
  `npm run dev`

**Schritte**

1. Fixture exportieren, **bevor** die Paperless-Instanz geleert wird. Nur Namen
   und IDs, keine Dokumentinhalte, keine Zugangsdaten.
2. Normalizer mit Tests: Kleinschreibung, NFKD, Umlaut- und ß-Faltung,
   Interpunktion, Whitespace; Rechtsform-Tokens nur bei Korrespondenten.
3. Trigram-Dice-Ähnlichkeit mit Tests.
4. SQLite-Tabellen `entity_aliases` und `entity_review_queue` anlegen.
5. Kaskade implementieren, Judge und Store injiziert; Tests über alle Pfade mit
   Fake-Judge.
6. Judge als kleiner Ollama-Call gegen dasselbe Modell, `temperature: 0`,
   Structured Output.
7. In `paperlessService` einhängen; Verhalten bei abgeschaltetem Resolver
   identisch zu heute.
8. Fixture labeln, `tune-thresholds.js` laufen lassen, `AUTO_THRESHOLD` und
   `JUDGE_MIN` auf gemessene Werte setzen.

**Abnahmekriterium:** die Tuning-Messung liegt vor und die Schwellwerte sind
begründet gesetzt. Aus derselben Messung folgt die Entscheidung über Embeddings.

## Befunde aus der Umsetzung von Phase 2 (2026-08-01)

Implementiert per `superpowers:subagent-driven-development`: 11 Tasks
task-weise per TDD, je mit eigenem Task-Review, plus ein finaler
Whole-Branch-Review über den gesamten Phase-2-Umfang. Vollständiger
Implementierungsplan:
[docs/superpowers/plans/2026-08-01-phase2-entityresolver.md](../superpowers/plans/2026-08-01-phase2-entityresolver.md).
129/129 Tests grün.

**Schwellwerte sind jetzt gemessen, nicht mehr geschätzt.** Reale Ähnlichkeit
der Beispielpaare: `Meldebescheid`/`Meldebescheinigung` = 0.71,
`Meldebeschreibung`/`Meldebescheinigung` = 0.63 — beide deutlich unter dem
ursprünglich geschätzten `AUTO_THRESHOLD` von 0.90, und `Meldebeschreibung`
läge mit dem geschätzten `JUDGE_MIN` von 0.65 sogar unterhalb des
Judge-Fensters. Gemessene Werte stehen in `data/.env` (nicht im Repository).

**Embeddings-Entscheidung gefallen: Ansatz B wird für Phase 3+ gebraucht,
nicht optional.** `Entgeltabrechnung`/`Verdienstbescheinigung` = 0.10,
`Entgeltabrechnung`/`Payroll Statement` = 0.06 — beide weit unter jeder
sinnvollen `JUDGE_MIN`. Das ist kein Schwellwert-Problem: Stufe 4 wählt je
Vorschlag nur den ähnlichsten Kandidaten für den Judge, und bei dieser
Ähnlichkeit wird das richtige Paar bei keiner Schwelle je ausgewählt — der
Judge bekommt es nie zu sehen. Reine String-Ähnlichkeit kann diese Klasse
von Synonym-Dubletten strukturell nicht auflösen. Näheres in
[docs/superpowers/specs/2026-08-01-klassifikations-konsistenz-design.md](../superpowers/specs/2026-08-01-klassifikations-konsistenz-design.md),
Abschnitt „Bewusst ausgeschlossen".

**Offener Punkt für Phase 3:** `document_id` in `entity_review_queue` wird
noch nicht befüllt — die drei Einhängepunkte in `paperlessService` kennen die
Dokument-ID nicht, nur `server.js` tut das, und dorthin reicht Phase 2 bewusst
nicht. Phase 3 muss das nachreichen, bevor die Review-Seite den „Link zum
auslösenden Dokument" anzeigen kann.

**Resolver bleibt deaktiviert (`ENTITY_RESOLVER_ENABLED=no` als Code-Default,
in der echten `data/.env` nicht gesetzt).** Aktivierung ist eine bewusste
Folgeentscheidung, kein Teil dieser Phase.

## Phase 3 — Review-UI, Merge, Altbestand

**Neue Dateien**

- `views/review.ejs`
- `routes/review.js`

**Geänderte Dateien**

- `services/paperlessService.js` — `mergeEntity(type, fromId, toId, { dryRun })`
- `server.js` — Route einhängen
- `views/dashboard.ejs` — Zähler offener Queue-Einträge

**Schritte**

1. Review-Seite mit Liste offener Paare, Ähnlichkeit, Judge-Urteil und
   Dokumentlink.
2. `mergeEntity`: Dokumente ermitteln → über `bulk_edit` umhängen →
   verifizieren, dass nichts mehr auf `fromId` zeigt → erst dann löschen.
   `dryRun` ist Default in allen programmatischen Aufrufen.
3. Aktionen verdrahten: Zusammenführen schreibt Alias `source='user'`,
   Verschieden setzt `status='rejected'`.
4. Queue-Zähler ins Dashboard.
5. Altbestands-Durchlauf als Route: dieselbe Kaskade paarweise über den
   Bestand, **ohne** Judge-Calls, alles über `JUDGE_MIN` in die Queue, keine
   automatischen Merges.

**Abnahmekriterium:** ein Merge ist an echten Daten durchgeführt, das gelöschte
Ziel war nachweislich leer, und kein Dokument hat einen Wert verloren.

## Präzisierungen aus der Planung von Phase 3 (2026-08-01)

Per `superpowers:brainstorming` geklärt, bevor der Implementierungsplan
entsteht. Vollständige Begründung im Design-Spec, Abschnitt „Phase 3".

- **Scope-Entscheidung:** Embeddings bleiben außerhalb von Phase 3 und werden
  zur neuen Phase 4 (siehe unten), damit UI/Merge-Infrastruktur nicht mit
  einem neuen, eigenständig zu tunenden Ähnlichkeitskanal vermischt wird.
- **`document_id`-Nachreichen:** über einen `options`-Parameter von
  `server.js` durch `processTags`/`getOrCreateCorrespondent`/
  `getOrCreateDocumentType` bis zu `_recordEntityQueue` durchgereicht. Kein
  Schema-Change — `recordCreatedAndQueued` und `insertQueueEntry` nehmen
  `documentId` bereits entgegen, nur kein Aufrufer hat ihn bisher gesetzt.
- **Auth für `routes/review.js`:** korrigiert gegenüber dem ersten
  Planungsstand — `routes/auth.js` exportiert bereits `isAuthenticated`
  (Redirect) und `authenticateJWT` (JSON 401/403), von `routes/setup.js`
  importiert, aber nie genutzt. `routes/review.js` importiert direkt von
  dort; keine neue `middleware/auth.js`, keine dritte Kopie derselben Logik.
- **Merge-Bestätigung:** zweistufig. Erster Klick ruft `mergeEntity` mit
  `dryRun: true` auf und zeigt die betroffenen Dokumente an, erst der zweite
  Klick löst den echten Merge aus.
- **Altbestands-Durchlauf:** synchroner Request pro Entity-Typ, ausgelöst über
  einen Button auf der Review-Seite — bei den gemessenen Bestandsgrößen
  (~40 Tags, 17 Dokumentarten, 16 Korrespondenten) wenige tausend
  Vergleichspaare ohne Netzwerk-Call, kein Hintergrund-Job nötig.

## Befunde aus der Umsetzung von Phase 3 (2026-08-02)

Implementiert per `superpowers:subagent-driven-development`: 8 Tasks
task-weise per TDD, je mit eigenem Task-Review, plus ein finaler
Whole-Branch-Review in zwei Runden (6 Fix-Commits über beide Runden hinweg,
bevor gemergt wurde). Vollständiger Implementierungsplan:
[docs/superpowers/plans/2026-08-01-phase3-review-ui-merge-altbestand.md](../superpowers/plans/2026-08-01-phase3-review-ui-merge-altbestand.md).
156/156 Tests grün bei Phase-3-Abschluss. **Nachtrag 2026-08-02 (Vollaudit):**
nach Phase 4 und 5 waren es 217/217 — die 156 war zum Zeitpunkt des Auftrags
bereits veraltet (AUDIT-031). **Nachtrag 2026-08-05 (Nachaudit, NACHAUDIT-03):**
416/416. Diese Zahl veraltet mit jeder neuen Testdatei erneut — als
Fortschrittsindikator lesen, nicht als exakten Sollwert; für den aktuellen
Stand `npm test` ausführen statt dieser Zeile zu vertrauen.

**Der Whole-Branch-Review fand vier reale Probleme vor dem Merge**, alle
behoben: ein Modul-Top-Level-DB-Open in `routes/review.js`, das den
Server-Start hätte crashen lassen können und bei deaktiviertem Resolver
nicht inert war (→ lazy Konstruktion); ein Merge-Dialog, der nicht zeigte,
welche Entität gelöscht wird; eine 404-Sackgasse in `mergeEntity`, wenn ein
Queue-Eintrag auf eine bereits durch einen früheren Merge gelöschte Entität
zeigte; und ein erneuter Altbestands-Lauf, der das LLM-Judge-Urteil auf noch
offenen Einträgen stillschweigend überschrieben hätte.

**Nach dem Merge, direkt aus dem Testen in echter Nutzung nachgezogen**
(nicht Teil des ursprünglichen Plans):

- Sidebar-Navigationslink zur Review-Seite fehlte auf allen anderen Seiten
  außer der Review-Seite selbst — auf Dashboard, Manual, Chat, History,
  Settings ergänzt.
- Die gesamte Review-UI war deutsch trotz sonst englischer Hauptanwendung —
  Tabellenkopf, Buttons, Modal-Text, Alerts und die an den Client
  durchgereichten Fehlermeldungen auf Englisch umgestellt.
- Preview-Funktion ergänzt, die im ursprünglichen Plan fehlte: ein Button je
  Zeile zieht bis zu drei Beispieldokumente je Seite (Proposed/Candidate)
  direkt aus Paperless-ngx und verlinkt sie, damit vor einer
  Merge-Entscheidung nachschaubar ist, wofür eine Entität tatsächlich
  verwendet wird, statt zu raten. Augen-Symbol (Font Awesome, bereits im
  Projekt lizenziert und in der History-Ansicht genutzt) statt Text-Button.

**Abnahmekriterium erfüllt:** ein echter Merge wurde an echten Daten
durchgeführt und vom Nutzer in Paperless-ngx verifiziert (2026-08-02) — die
gelöschte Entität war weg, betroffene Dokumente zeigten die überlebende
Entität, sonst nichts verändert.

## Phase 4 — Embeddings-Ähnlichkeitskanal (2026-08-02)

Implementiert per `superpowers:subagent-driven-development`: 10 Tasks
task-weise per TDD, je mit eigenem Task-Review, plus ein finaler
Whole-Branch-Review. Vollständiger Implementierungsplan:
[docs/superpowers/plans/2026-08-02-phase4-embeddings.md](../superpowers/plans/2026-08-02-phase4-embeddings.md),
Design-Entwurf:
[docs/superpowers/specs/2026-08-02-phase4-embeddings-design.md](../superpowers/specs/2026-08-02-phase4-embeddings-design.md).

Der zweite Ähnlichkeitskanal (Ollama-Embeddings, Modell `bge-m3`) läuft
additiv neben dem Trigram-Kanal und ist per Default abgeschaltet
(`EMBEDDING_SIMILARITY_ENABLED=no`) — bestehendes Verhalten bleibt ohne
Konfigurationsänderung exakt gleich. Vor der Aktivierung sind `ollama pull
bge-m3` auf der Ollama-Instanz und ein Lauf von `scripts/tune-thresholds.js`
nötig, damit `EMBED_AUTO_THRESHOLD`/`EMBED_JUDGE_MIN` gemessen statt geraten
sind — genau so, wie schon die Schwellwerte aus Phase 2 hergeleitet wurden.

## Phase 5 — Fingerprint (2026-08-02)

**Gating-Messung nachgeholt, bevor entworfen wurde** (wie in der ursprünglichen
Skizze gefordert): `ENTITY_RESOLVER_ENABLED`/`EMBEDDING_SIMILARITY_ENABLED`
aktiviert, `bge-m3` gepullt, `EMBED_AUTO_THRESHOLD`/`EMBED_JUDGE_MIN` über
`scripts/tune-thresholds.js` gemessen. Ergebnis: `dry-run-eval.js --repeat 2`
über dieselben 10 Dokumente wie die Phase-1-Baseline zeigt weiterhin 4 von 10
Dokumenten instabil trotz `temperature=0`/`seed=42` — der EntityResolver wirkt
nur im Schreibpfad und ändert diese Zahl nicht. Derselbe Lauf deckte zwei
Nebenbefunde auf, die vorab behoben wurden: `USE_EXISTING_DATA=no` stand in
der echten `data/.env` seit dem Umgebungscheck vom 1. August unverändert
(Bestandslisten fehlten dem Modell live), und der Embedding-Kanal erzeugte bei
Tags überwiegend Rauschen statt echter Duplikate — behoben durch das neue
`EMBEDDING_EXCLUDED_TYPES=tag`.

Implementiert per `superpowers:subagent-driven-development`: 4 Tasks
task-weise per TDD, je mit eigenem Task-Review, plus ein finaler
Whole-Branch-Review und eine Fix-Welle für 7 dabei gefundene
Integrationsprobleme (u.a. dass `paperlessService.updateDocument` sein
`updates`-Argument in-place mutiert — der ursprüngliche Code hätte dadurch
Fingerprints mit falschem oder gar keinem Korrespondenten gespeichert).
Vollständiger Implementierungsplan:
[docs/superpowers/plans/2026-08-02-phase5-fingerprint.md](../superpowers/plans/2026-08-02-phase5-fingerprint.md),
Design-Entwurf:
[docs/superpowers/specs/2026-08-02-phase5-fingerprint-design.md](../superpowers/specs/2026-08-02-phase5-fingerprint-design.md).

Erkennt wiederkehrende Dokumente desselben Korrespondenten über
Inhalts-Ähnlichkeit (Embedding, dieselbe `bge-m3`-Infrastruktur wie Phase 4)
und übernimmt bei Treffer nur Tags und Dokumentart aus einer früheren
Klassifikation desselben Korrespondenten — Titel und Datum bleiben die frisch
extrahierten Werte, weil sie sich bei echten wiederkehrenden Dokumenten legitim
unterscheiden (anderer Monat, anderer Betrag).

**Korrektur (Vollaudit 2026-08-02, AUDIT-003):** „bestätigt" bedeutete
ursprünglich nicht menschlich geprüft, sondern nur „das Ergebnis einer eigenen
KI-Klassifikation dieses Dokuments" — ein einzelner LLM-Fehltreffer hätte sich
dadurch unbegrenzt durch eine ganze Dokumentserie fortpflanzen können, ohne
Review-Queue, Judge oder Korrekturschleife. Seit dem Nachaudit-Fix trägt jeder
Fingerprint seine Herkunft (`source: 'llm' | 'inherited'`, siehe
[Fingerprint-Bereitschaft-Plan](../superpowers/plans/2026-08-03-fingerprint-bereitschaft-audit-003-006-010-011-020-022-025.md)),
und nur `source='llm'`-Einträge kommen als Kandidat für ein drittes Dokument
infrage — ein geerbter Fehltreffer kann sich damit nicht mehr weitervererben.
Ein einzelner Fehler in der *Quell*-Klassifikation bleibt aber weiterhin
unentdeckt, bis ihn ein Mensch korrigiert; „bestätigt" heißt nach wie vor nicht
„von einem Menschen geprüft".

Läuft additiv neben dem bestehenden Resolver und ist per Default abgeschaltet
(`DOCUMENT_FINGERPRINT_ENABLED=no`) — bestehendes Verhalten bleibt ohne
Konfigurationsänderung exakt gleich. Vor der Aktivierung ist ein eigener
Tuning-Lauf nötig, damit `FINGERPRINT_SIMILARITY_THRESHOLD` (aktuell ein
ungemessener Platzhalter, `0.90`) gegen gelabelte Dokumentpaare gemessen statt
geschätzt ist — genau wie schon bei den Schwellwerten aus Phase 2 und 4.

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

## Offene Risiken

- **Schwellwerte sind bis zur Messung geraten.** Größte Unsicherheit des
  Entwurfs. Mindert sich mit Phase 2, Schritt 8.
- **Merge ist der erste destruktive Pfad** in einem Service, der bisher nur
  liest, anlegt und patcht. Abgesichert durch Verifikation vor dem Löschen und
  `dryRun` als Default.
- **Aliase hängen an Paperless-IDs.** Manuelles Löschen in Paperless macht sie
  ungültig; der Resolver verwirft solche Aliase und entscheidet neu.
