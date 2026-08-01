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
| 1 | Determinismus und Prompt-Hygiene | — | offen |
| 2 | EntityResolver, Alias-Speicher, Schwellwert-Tuning | — | offen |
| 3 | Review-UI, Merge, Altbestands-Durchlauf | Phase 2 | offen |
| 4 | Fingerprint für wiederkehrende Dokumente | Phase 1–3 | nur skizziert |

Phase 1 und 2 sind unabhängig voneinander wirksam. Jede Phase bekommt einen
eigenen Implementierungsplan und wird einzeln abgenommen.

## Phase 1 — Determinismus und Prompt-Hygiene

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

**Abnahmekriterium:** dasselbe Dokument zweimal verarbeitet liefert ein
identisches Ergebnis, und die Bestandslisten sind im tatsächlich gesendeten
Prompt nachweisbar enthalten (Prüfung über das bestehende Prompt-Log).

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
