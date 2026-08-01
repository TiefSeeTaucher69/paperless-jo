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
| 1 | Determinismus, Prompt-Hygiene, Prompt-Härtung | — | geplant |
| 2 | EntityResolver, Alias-Speicher, Schwellwert-Tuning | — | offen |
| 3 | Review-UI, Merge, Altbestands-Durchlauf | Phase 2 | offen |
| 4 | Fingerprint für wiederkehrende Dokumente | Phase 1–3 | nur skizziert |

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

## Phase 4 — Fingerprint (skizziert)

Fingerprint aus Korrespondent und Dokumentstruktur erkennt wiederkehrende
Dokumente; bei Treffer wird die frühere Klassifikation als starker Vorschlag
übernommen. Wird erst entworfen, wenn Phase 1 bis 3 laufen und gemessen ist,
wie viel Inkonsistenz dann überhaupt noch bleibt.

## Offene Risiken

- **Schwellwerte sind bis zur Messung geraten.** Größte Unsicherheit des
  Entwurfs. Mindert sich mit Phase 2, Schritt 8.
- **Merge ist der erste destruktive Pfad** in einem Service, der bisher nur
  liest, anlegt und patcht. Abgesichert durch Verifikation vor dem Löschen und
  `dryRun` als Default.
- **Aliase hängen an Paperless-IDs.** Manuelles Löschen in Paperless macht sie
  ungültig; der Resolver verwirft solche Aliase und entscheidet neu.
