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
| 4 | Embeddings-Ähnlichkeitskanal | Phase 2, Messung Task 11 | offen (neu) |
| 5 | Fingerprint für wiederkehrende Dokumente | Phase 1–4 | nur skizziert |

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

**Abnahmekriterium:** dasselbe Dokument zweimal über
`scripts/dry-run-eval.js --repeat 2` verarbeitet liefert ein identisches
Ergebnis (gemessene Baseline vor Phase 1: 10 von 10 Dokumenten instabil), und
die Bestandslisten sind im tatsächlich gesendeten Prompt nachweisbar enthalten
(Prüfung über das bestehende Prompt-Log). Nicht über einen normalen
Serverstart prüfen — `PROCESS_PREDEFINED_DOCUMENTS=yes` und
`DISABLE_AUTOMATIC_PROCESSING` ungesetzt bedeuten: ein Start verarbeitet sofort
Dokumente und schreibt nach Paperless.

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
156/156 Tests grün.

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

## Phase 4 — Embeddings-Ähnlichkeitskanal (skizziert)

Aus Phase 3 herausgelöst (Planungsentscheidung 2026-08-01), damit Review-UI/
Merge/Altbestand und ein neuer, eigenständig zu tunender Ähnlichkeitskanal
nicht in einem Plan vermischt werden — konsistent mit dem Prinzip, dass jede
Phase einzeln geplant und abgenommen wird.

Laut Messung aus Phase 2 (Task 11) strukturell nötig, nicht optional: reine
Trigram-Ähnlichkeit erkennt orthografisch ferne Synonyme wie
`Entgeltabrechnung`/`Verdienstbescheinigung` (0.10) oder
`Entgeltabrechnung`/`Payroll Statement` (0.06) bei keiner sinnvollen Schwelle.
Näheres in
[docs/superpowers/specs/2026-08-01-klassifikations-konsistenz-design.md](../superpowers/specs/2026-08-01-klassifikations-konsistenz-design.md),
Abschnitt „Bewusst ausgeschlossen". Noch nicht entworfen — eigener
Design-Durchlauf folgt nach Phase 3.

## Phase 5 — Fingerprint (skizziert)

Fingerprint aus Korrespondent und Dokumentstruktur erkennt wiederkehrende
Dokumente; bei Treffer wird die frühere Klassifikation als starker Vorschlag
übernommen. Wird erst entworfen, wenn Phase 1 bis 4 laufen und gemessen ist,
wie viel Inkonsistenz dann überhaupt noch bleibt.

## Offene Risiken

- **Schwellwerte sind bis zur Messung geraten.** Größte Unsicherheit des
  Entwurfs. Mindert sich mit Phase 2, Schritt 8.
- **Merge ist der erste destruktive Pfad** in einem Service, der bisher nur
  liest, anlegt und patcht. Abgesichert durch Verifikation vor dem Löschen und
  `dryRun` als Default.
- **Aliase hängen an Paperless-IDs.** Manuelles Löschen in Paperless macht sie
  ungültig; der Resolver verwirft solche Aliase und entscheidet neu.
