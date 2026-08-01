# Konsistenz der automatischen Dokumentklassifikation

**Datum:** 2026-08-01
**Projekt:** paperless-jo (Fork von clusterzx/paperless-ai)
**Status:** Entwurf freigegeben

## Problem

Die automatische Klassifikation läuft, liefert aber bei strukturell gleichen,
wiederkehrenden Dokumenten (etwa dieselbe Gehaltsabrechnung desselben Absenders
jeden Monat) uneinheitliche Ergebnisse. Statt bestehende Werte wiederzuverwenden
entstehen leicht abweichende Tags, Dokumentarten und Korrespondenten-
Schreibweisen. In Paperless-ngx sammeln sich dadurch Varianten desselben
Begriffs an.

## Umgebung

- Paperless-ngx auf eigener VM
- Ollama auf eigener VM, RTX 4060 mit 8 GB VRAM
- Modell `qwen2.5:7b-instruct-q4_K_M`
- Eigener deutscher System-Prompt, bereits getestet
- Dokumente überwiegend deutsch

## Getroffene Grundsatzentscheidungen

| Frage | Entscheidung |
|---|---|
| Vokabular | Offen. Neue Tags, Dokumentarten und Korrespondenten dürfen weiter entstehen. Konsistenz kommt allein aus Abgleich, nicht aus Beschränkung. |
| Unsichere Fälle | Dreistufige Kaskade: hohe Ähnlichkeit automatisch zusammenführen, mittlere vom LLM beurteilen lassen, unklares Urteil in eine Review-Queue. |
| Review | Neue Seite im bestehenden EJS-Web-UI. |
| Ursachen am LLM | Mit im Scope, als eigene erste Phase. |
| Matching-Verfahren | String-basiert (Normalisierung plus Trigram-Ähnlichkeit). Embeddings zurückgestellt. |
| Altbestand | Bleibt als Testdatensatz erhalten und wird vorher als Fixture exportiert. |
| Fingerprint für Wiederholungsdokumente | In der Roadmap, aber erst nach Phase 1 bis 3. |

## Befundlage im bestehenden Code

Ablauf heute: [server.js:184](../../../server.js) `processDocument` holt Inhalt
sowie alle bestehenden Tags, Korrespondenten und Dokumentarten →
[services/ollamaService.js:254](../../../services/ollamaService.js) `_buildPrompt`
→ Ollama → [server.js:223](../../../server.js) `buildUpdateData` →
`processTags` / `getOrCreateCorrespondent` / `getOrCreateDocumentType` in
[services/paperlessService.js](../../../services/paperlessService.js).

Gefundene Ursachen für Inkonsistenz:

1. **Nichtdeterministisches Sampling.** `temperature: 0.7`, `top_p: 0.9`,
   kein `seed` (`ollamaService.js:549`). Gleiches Dokument, andere Antwort.
2. **Ausschließlich exaktes Matching.** `findExistingTag` nutzt `name__iexact`
   (`paperlessService.js:255`); Korrespondent und Dokumentart suchen zwar mit
   `name__icontains`, akzeptieren aber nur exakte Treffer
   (`paperlessService.js:1006`, `:1101`). Keinerlei Normalisierungs- oder
   Ähnlichkeitsschicht.
3. **`%RESTRICTED_TAGS%` löst zu Leerstring auf.**
   `restrictionPromptService.js:55` filtert auf `tag.name`, `server.js:369`
   übergibt jedoch ein String-Array.
4. **Signaturfehler.** `processRestrictionsInPrompt` wird mit fünf Argumenten
   aufgerufen (`ollamaService.js:338`), ist mit vier deklariert. Dokumentarten
   fallen still auf den `config`-Parameter; einen Platzhalter für sie gibt es
   ohnehin nicht.
5. **Zu klein berechnetes `num_ctx`.** `ollamaService.js:138` zählt nur den
   User-Prompt, nicht den System-Prompt. Bei Überlauf kürzt Ollama still — und
   zwar am Anfang, also genau bei den Bestandslisten. `num_predict: 256` kann
   die Antwort abschneiden.
6. **Zwei konkurrierende System-Prompts.** Der deutsche `SYSTEM_PROMPT` landet
   im `prompt`-Feld, ein hartkodierter englischer Analyzer-Prompt im
   `system`-Feld (`ollamaService.js:428`). Beide enthalten eine eigene
   JSON-Vorlage.
7. **Mutation der geteilten Config.** `ollamaService.js:320` überschreibt
   `config.mustHavePrompt`; der Platzhalter ist nach dem ersten Dokument
   dauerhaft verbraucht.
8. **Kein Gedächtnis über Dokumente hinweg.** Nichts verknüpft die
   Klassifikation von heute mit der desselben Dokumenttyps von letztem Monat.

Weitere relevante Randbedingungen: `buildUpdateData` existiert doppelt
(`server.js:223` und `routes/setup.js:1613`). `paperlessService` enthält heute
keinen einzigen DELETE- oder Bulk-Edit-Aufruf. Es gibt kein Test-Framework
(`npm test` startet `nodemon server.js`), keine String-Similarity-Bibliothek und
keine Embedding-Infrastruktur.

## Zuschnitt

Der Entwurf umfasst vier Phasen und ist damit zu groß für einen einzigen
Implementierungsplan. Jede Phase bekommt ihren eigenen Plan und wird einzeln
umgesetzt und abgenommen. Phase 1 ist von Phase 2 unabhängig wirksam; Phase 3
setzt Phase 2 voraus; Phase 4 ist hier nur skizziert und wird später gesondert
entworfen.

## Architektur

Zwei Angriffspunkte, klar getrennt und einzeln messbar: Varianz am Eingang
reduzieren (Phase 1), Varianz am Ausgang auflösen (Phase 2 und 3). Alles Neue
ist additiv — bei abgeschaltetem Resolver verhält sich die Anwendung exakt wie
heute.

```
Dokument → Ollama ──────────────────→ roher Vorschlag ("Stadtwerke München GmbH")
            ▲                                │
            │ Phase 1                        │ Phase 2
            │ deterministisch,               ▼
            │ sauberer Kontext        EntityResolver-Kaskade
                                            │
              ┌─────────────────────────────┼──────────────────────┐
              ▼                             ▼                      ▼
        auf Bestand mappen          neu anlegen           neu anlegen + Queue
                                                                   │ Phase 3
                                                                   ▼
                                                          Review-UI → Merge
```

## Phase 1 — Determinismus und Prompt-Hygiene

Betroffen: `services/ollamaService.js`, `services/restrictionPromptService.js`,
`server.js`, `config/config.js`

**Sampling.** `temperature: 0`, fester `seed`, `top_p: 1`; `top_k: 7` entfällt,
da bei greedy decoding wirkungslos. Konfigurierbar über `OLLAMA_TEMPERATURE` und
`OLLAMA_SEED`, Defaults deterministisch.

**Kontextfenster.** `num_ctx` zählt künftig System-Prompt und User-Prompt. Zwei
Grenzen: Untergrenze 2048 (Ollama-Default nicht unterschreiten), konfigurierbare
Obergrenze `OLLAMA_NUM_CTX_MAX` mit Default 8192. Das bisherige
`TOKEN_LIMIT: 128000` ist bei 8 GB VRAM unerreichbar und würde bei Wirksamkeit
eine CPU-Auslagerung erzwingen.

**Kontrollierte Kürzung.** Passt der Prompt nicht ins Fenster, kürzen wir selbst
und ausschließlich den Dokumententext. Bestandslisten und Formatvorgabe sind
geschützt. `num_predict` steigt auf konfigurierbare 512.

**Bugfixes.** Punkte 3, 4 und 7 der Befundlage: `_formatTagsList` behandelt
String- und Objekt-Arrays (analog zu `_formatCorrespondentsList`);
`processRestrictionsInPrompt` bekommt einen eigenen Parameter für Dokumentarten
plus Platzhalter `%RESTRICTED_DOCUMENT_TYPES%`; `config.mustHavePrompt` wird
nicht mehr mutiert, sondern in eine lokale Variable kopiert.

**Prompt-Aufteilung.** `system` enthält künftig den deutschen `SYSTEM_PROMPT`,
die Formatvorgabe und die Bestandslisten; `prompt` ausschließlich den
Dokumententext. Der hartkodierte englische Analyzer-Prompt entfällt. Das ist die
Aufteilung, für die `/api/generate` gebaut ist.

**Erwartete Wirkung.** Lauf-zu-Lauf-Varianz bei identischem Input verschwindet
vollständig. Das Modell erhält erstmals verlässlich die Bestandslisten.

## Phase 2 — EntityResolver

### Neue Module

- `services/entityNormalizer.js` — Normalisierung, reine Funktionen
- `services/entitySimilarity.js` — Trigram-Dice-Ähnlichkeit, reine Funktion
- `services/entityResolver.js` — die Kaskade
- `models/entityStore.js` — SQLite-Tabellen

### Trennung von Entscheidung und Ausführung

Der Resolver schreibt nichts nach Paperless. Er erhält Vorschlag und Bestand und
liefert eine Entscheidung:

```js
resolve(type, proposedName, existingEntities)
  → { action: 'map',              id, canonicalName, via: 'alias'|'exact'|'normalized'|'similarity'|'llm' }
  → { action: 'create' }
  → { action: 'create_and_queue', candidate: { id, name }, similarity, verdict }
  → { action: 'skip' }   // bei aktiver Restriction und keinem Treffer
```

`resolve` ist asynchron und bekommt seine beiden Abhängigkeiten bei der
Konstruktion injiziert: den `store` (Alias- und Queue-Zugriff) und den `judge`
(LLM-Aufruf). `paperlessService` ruft auf und führt aus. Die Entscheidungslogik
ist damit ohne Paperless und ohne Ollama testbar.

**Einhängepunkt** sind `getOrCreateCorrespondent`, `getOrCreateDocumentType` und
`processTags` in `paperlessService` — nicht `buildUpdateData`. Weil letzteres
doppelt existiert, profitieren so beide Pfade, ohne dass die Duplizierung
angefasst werden muss.

### Kaskade

Für Vorschlag `N` vom Typ `T`:

| Stufe | Prüfung | Kosten | Ergebnis |
|---|---|---|---|
| 0 | leer oder nur Whitespace | — | `skip` |
| 1 | Alias-Tabelle kennt `normalize(N)` | DB | `map`, ohne API- und LLM-Call |
| 2 | exakter Treffer im Bestand (heutiges Verhalten) | Cache | `map` |
| 3 | `normalize(N)` gleich `normalize(bestehend)` | Cache | `map`, Alias schreiben |
| 4a | Ähnlichkeit ≥ `AUTO_THRESHOLD` | DB | `map`, Alias `source='auto'` |
| 4b | Paar bereits als `rejected` bekannt | DB | `create`, ohne LLM-Call |
| 4c | `JUDGE_MIN` ≤ Ähnlichkeit < `AUTO_THRESHOLD` | LLM | Judge entscheidet |
| 4d | Ähnlichkeit < `JUDGE_MIN` | — | `create` |

Stufe 4b ist der Negativ-Cache und steht bewusst vor dem Judge: ein einmal als
verschieden entschiedenes Paar wird nie erneut befragt. Auch Stufe 4a prüft
zuvor den Negativ-Cache, damit eine ausdrückliche Nutzerentscheidung
(„sind verschieden") einen hohen Ähnlichkeitswert überstimmt.

Der Judge in Stufe 4c ist ein kleiner separater Ollama-Call gegen dasselbe
Modell — kein zusätzliches VRAM, qwen ist bereits geladen. `temperature: 0`,
Structured Output `{ verdict: "same"|"different"|"unsure", reason: string }`. Er
erhält nur die beiden Namen und den Entity-Typ, nicht das Dokument.
`same` → `map` plus Alias `source='llm'`; `different` → `create` plus
Negativ-Eintrag; `unsure` → `create_and_queue`.

Jedes Paar wird höchstens einmal befragt, dauerhaft. Positive Urteile landen in
`entity_aliases`, negative als `status='rejected'` in der Queue-Tabelle. Beim
nächsten Auftreten greift Stufe 1 beziehungsweise der Negativ-Cache. Das ist der
Kern des Wiederholungsfalls: die Gehaltsabrechnung im Februar kostet keinen
Judge-Call und kann nicht anders entschieden werden als im Januar.

### Normalisierung

Für alle Typen: Kleinschreibung, Unicode-NFKD, Faltung von Umlauten und ß
(`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`), Interpunktion zu Leerzeichen, Whitespace
kollabieren.

Zusätzlich nur für Korrespondenten: Entfernen von Rechtsform-Tokens (`gmbh`,
`ag`, `kg`, `ohg`, `gbr`, `mbh`, `ug`, `se`, `e v`, `co`, `kgaa`, `ltd`, `inc`,
`bv`, `sa`). Bei Tags und Dokumentarten wäre das falsch, dort können solche
Tokens bedeutungstragend sein.

Bewusst nicht enthalten: Plural- und Singular-Stemming. Deutsche Pluralbildung
ist zu unregelmäßig für Regeln, die nie danebengreifen. „Rechnung" gegen
„Rechnungen" behandelt die Ähnlichkeitsstufe.

### Schwellwerte

Startwerte `AUTO_THRESHOLD = 0.90` und `JUDGE_MIN = 0.65`, beide über Env
konfigurierbar. Diese Zahlen sind geschätzt, und geschätzte Schwellwerte sind
das wahrscheinlichste Scheitern dieses Entwurfs. Deshalb gehört
`scripts/tune-thresholds.js` in diese Phase: es läuft über die gelabelte Fixture
und gibt Precision und Recall über einen Schwellwertbereich aus. Danach sind die
Werte gemessen. Zugleich zeigt die Messung, ob reine String-Ähnlichkeit für
diese Daten ausreicht oder ob Embeddings doch nötig sind.

### Datenmodell

```sql
CREATE TABLE entity_aliases (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,        -- 'tag' | 'document_type' | 'correspondent'
  alias_normalized TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  canonical_id INTEGER NOT NULL,
  source TEXT NOT NULL,             -- 'auto' | 'llm' | 'user'
  created_at TEXT NOT NULL,
  UNIQUE(entity_type, alias_normalized)
);

CREATE TABLE entity_review_queue (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  proposed_name TEXT NOT NULL,
  proposed_normalized TEXT NOT NULL, -- fuer den Negativ-Cache-Lookup, siehe unten
  proposed_id INTEGER,              -- der neu angelegte Eintrag
  candidate_name TEXT NOT NULL,
  candidate_normalized TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  similarity REAL NOT NULL,
  llm_verdict TEXT,
  llm_reason TEXT,
  status TEXT NOT NULL,             -- 'open' | 'merged' | 'rejected'
  document_id INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(entity_type, proposed_normalized, candidate_normalized)
);
```

Eine Tabelle dient zugleich als Queue und als Negativ-Cache; `status='rejected'`
ist beides. Das `UNIQUE`-Constraint verhindert Mehrfacheinträge desselben Paars.

**Nachtrag aus der Implementierung (Task 11, finaler Review):** Der
Negativ-Cache-Lookup (`findRejectedPair`) muss auf normalisierten Namen
arbeiten, nicht auf den rohen — sonst verfehlt eine Schreibvariante
(Gross-/Kleinschreibung, Whitespace) eines bereits abgelehnten Paars den
Cache und löst einen unnötigen erneuten Judge-Call aus. Deshalb tragen
`proposed_normalized`/`candidate_normalized` das `UNIQUE`-Constraint;
`proposed_name`/`candidate_name` bleiben roh erhalten, für die
Review-UI in Phase 3 (Anzeige des tatsächlichen Vorschlags).

Bekannte Einschränkung: Ein Alias hängt an einer Paperless-ID. Wird der Eintrag
dort von Hand gelöscht, zeigt der Alias ins Leere. Der Resolver behandelt das
defensiv — ID nicht mehr im Bestand bedeutet: Alias verwerfen und neu
entscheiden.

## Phase 3 — Review-UI, Merge, Altbestand

### Präzisierungen aus der Planung (2026-08-01, `superpowers:brainstorming`)

**Scope:** Embeddings (Ansatz B) bleiben außerhalb dieser Phase, obwohl die
Messung sie für Synonym-Duplikate wie `Entgeltabrechnung`/
`Verdienstbescheinigung` als nötig zeigt (siehe „Bewusst ausgeschlossen").
Grund: Review-UI/Merge/Altbestand und ein neuer, eigenständig zu tunender
Ähnlichkeitskanal sind zwei unterschiedliche Bausteine — vermischt in einem
Plan wäre Phase 3 zu groß und schwer einzeln abzunehmen. Embeddings wird
eigene Phase 4 in der Roadmap, nach Phase 3 entworfen.

**`document_id`-Nachreichen:** kleine additive Signaturänderung statt
Herleitung im Nachhinein. `server.js` reicht die Dokument-ID über ein
`options`-Objekt an `processTags`, `getOrCreateCorrespondent` und
`getOrCreateDocumentType` durch; diese reichen es an
`_recordEntityQueue(type, name, id, decision, documentId)` weiter, das es an
den bereits vorhandenen `documentId`-Parameter von
`entityResolver.recordCreatedAndQueued` übergibt. Weder `entityStore` noch
das Datenbankschema ändern sich — beide akzeptieren `documentId` schon,
nur setzt ihn aktuell kein Aufrufer. Der doppelte `buildUpdateData`-Pfad in
`routes/setup.js` bekommt die ID auf demselben Weg mit, ohne dass die
Duplizierung angefasst wird.

**Auth:** Korrektur gegenüber dem ersten Planungsstand — `routes/auth.js`
exportiert bereits `isAuthenticated` (Redirect zu `/login`) und
`authenticateJWT` (JSON 401/403), funktional identisch zu dem, was eine neue
`middleware/auth.js` liefern würde, inklusive API-Key-Unterstützung.
`routes/setup.js` importiert beide bereits (`routes/setup.js:20`), nutzt sie
aber nicht — die inline definierte Middleware dort dupliziert dieselbe Logik
zusätzlich um den „ist die App konfiguriert"-Redirect. Statt eine weitere,
dritte Kopie in `middleware/auth.js` anzulegen, importiert `routes/review.js`
`isAuthenticated`/`authenticateJWT` direkt aus `routes/auth.js` — keine neue
Datei, keine Duplikation, `routes/setup.js` bleibt unangetastet.

**Endpunkte in `routes/review.js`:**

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/review` | `isAuthenticated` | Seite mit offenen Queue-Einträgen |
| POST | `/api/review/:id/merge` | `authenticateJWT` | Dry-Run-Vorschau oder echter Merge, per Body-Flag `dryRun` |
| POST | `/api/review/:id/reject` | `authenticateJWT` | Setzt `status='rejected'` |
| POST | `/api/review/backfill/:entityType` | `authenticateJWT` | Löst Altbestands-Durchlauf für einen Typ aus |

**Merge-Bestätigung ist zweistufig:** erster Klick ruft `mergeEntity` mit
`dryRun: true` auf, UI zeigt `affectedCount` und die betroffenen
Dokument-IDs in einem Bestätigungsdialog; erst der zweite Klick sendet
`dryRun: false` und löst Alias-Schreiben plus `status='merged'` aus. Schlägt
der echte Merge fehl, bleibt der Queue-Eintrag `open`, es wird nichts
gelöscht (siehe „Fehlerverhalten").

**Altbestands-Durchlauf läuft synchron,** ausgelöst über einen Button je
Entity-Typ auf der Review-Seite. Bei den gemessenen Bestandsgrößen (~40 Tags,
17 Dokumentarten, 16 Korrespondenten) sind das wenige tausend Vergleichspaare
ohne Netzwerk-Call — kein Hintergrund-Job-Mechanismus nötig, den es im
Projekt noch nicht gibt. Der Vergleich ruft dabei Normalisierung und
Ähnlichkeit direkt auf, nicht die volle Kaskade — Stufen 1–3 (Alias-Tabelle,
exakter Treffer, Normalisierung-gleich) sind sinnlos, wenn beide Seiten des
Paares bereits im Bestand existieren.

**`mergeEntity` nutzt den bestehenden Axios-Client** (`this.client` in
`paperlessService.js`, bereits mit `baseURL` und Token konfiguriert) statt
einer neuen Instanz — Muster wie alle bisherigen API-Aufrufe in dieser Datei.

**Dashboard-Zähler:** neue `.stat-box` im bestehenden `material-card`
(gleiches Muster wie die übrigen Kacheln in `views/dashboard.ejs`), zeigt
`COUNT(*) FROM entity_review_queue WHERE status='open'`, klickbar zu
`/review`.

### Review-Seite

Neu: `views/review.ejs` unter dem bestehenden `layout.ejs` sowie
`routes/review.js` als eigene Route, statt `routes/setup.js` weiter wachsen zu
lassen.

**Offener Punkt aus Phase 2:** `document_id` in `entity_review_queue` wird
bislang nie befüllt — `paperlessService`s drei Einhängepunkte kennen die
Dokument-ID nicht, nur `server.js`s `processDocument`/`buildUpdateData` tut
das, und dorthin reicht Phase 2 bewusst nicht (siehe „Bewusst
ausgeschlossen"). Phase 3 muss die ID entweder durch `options` bis zu
`_recordEntityQueue` durchreichen (kleine additive Signaturänderung in
`processTags`/`getOrCreateCorrespondent`/`getOrCreateDocumentType`) oder den
„Link zum auslösenden Dokument" der Review-Seite anders herleiten.

Die Seite listet offene Paare mit Typ, Vorschlag gegen Kandidat,
Ähnlichkeitswert, Judge-Urteil samt Begründung und Link zum auslösenden
Dokument. Zwei Aktionen je Zeile: **Zusammenführen** führt den Merge aus,
schreibt einen Alias mit `source='user'` und setzt `status='merged'`. Die
Richtung ist dabei festgelegt: der neu entstandene `proposed_id` wird in den
bereits bestehenden `candidate_id` überführt, der Kandidat bleibt also der
kanonische Wert. **Sind verschieden** setzt `status='rejected'` und wirkt ab
sofort als Negativ-Cache. Beide Entscheidungen sind dauerhaft.

Ein Zähler offener Einträge kommt ins bestehende Dashboard, damit die Queue
nicht unbemerkt vollläuft.

### Merge-Operation

Neu in `paperlessService`: `mergeEntity(type, fromId, toId, { dryRun })`.

1. Alle Dokumente mit `fromId` ermitteln
   (`/documents/?correspondent__id=`, `document_type__id=`, `tags__id=`)
2. Umhängen über `/api/documents/bulk_edit/` — bei Tags `modify_tags`
   (entfernen und hinzufügen), sonst `set_correspondent` beziehungsweise
   `set_document_type`
3. Verifizieren, dass kein Dokument mehr auf `fromId` zeigt
4. Erst dann `DELETE` auf `fromId`

Schritt 3 ist die Sicherung vor dem einzigen unumkehrbaren Schritt: gelöscht
wird ausschließlich ein nachweislich leerer Eintrag. Schlägt Schritt 2 teilweise
fehl, bleibt der Queue-Eintrag offen und es wird nichts gelöscht — der Zustand
ist dann inkonsistent, aber verlustfrei und beim nächsten Versuch reparierbar.

`dryRun` ist Default in allen programmatischen Aufrufen; nur die explizite
Bestätigung in der UI schaltet ihn ab.

### Altbestands-Durchlauf

Kein eigenes Feature, sondern eine Route, die dieselbe Kaskade paarweise über
alle bestehenden Einträge eines Typs laufen lässt und Ergebnisse in dieselbe
Queue schreibt. Auto-Merges werden hier nicht automatisch ausgeführt: auch der
Hochähnlichkeitsfall landet in der Queue. Im Live-Pfad entscheidet die Kaskade
über einen noch nicht existierenden Eintrag, beim Altbestand über zwei
bestehende mit womöglich hunderten Dokumenten daran. Der Schaden eines
Fehlgriffs ist ungleich größer.

Der Bulk-Lauf ruft zudem **keinen** Judge auf. Der paarweise Vergleich ist
quadratisch in der Anzahl der Einträge; ein LLM-Call je Paar oberhalb von
`JUDGE_MIN` wäre unkalkulierbar. Stattdessen landet dort schlicht jedes Paar
oberhalb von `JUDGE_MIN` in der Queue und wird von Hand entschieden. Der Judge
bleibt dem Live-Pfad vorbehalten, wo je Dokument höchstens wenige Vergleiche
anfallen.

## Phase 4 — Fingerprint für Wiederholungsdokumente

Nur skizziert, bewusst noch nicht ausentworfen. Idee: ein Fingerprint aus
Korrespondent und Dokumentstruktur erkennt wiederkehrende Dokumente; bei Treffer
wird die frühere Klassifikation als starker Vorschlag übernommen. Entworfen wird
das erst, wenn Phase 1 bis 3 laufen und gemessen ist, wie viel Inkonsistenz dann
überhaupt noch bleibt.

## Testing

`npm test` startet heute `nodemon server.js`; das wandert nach `npm run dev`,
`npm test` wird `node --test`. Node bringt `node:test` mit, es kommt keine
Dependency hinzu.

`scripts/export-entity-fixture.js` zieht die reinen Namenslisten aus der Instanz
nach `test/fixtures/entities.json` — nur Namen und IDs, keine Dokumentinhalte
und keine Zugangsdaten. Danach kann Paperless geleert werden; die echten
Schreibvarianten bleiben als Testdatensatz erhalten.

Getestet werden der Normalizer gegen deutsche Grenzfälle, die
Ähnlichkeitsfunktion gegen bekannte Paare und die Kaskade mit injiziertem
Fake-Judge über alle Pfade von `map` bis `create_and_queue`. Da die Kaskade
reine Entscheidungslogik ist, braucht keiner dieser Tests Netzwerk, Paperless
oder Ollama.

## Fehlerverhalten

Leitlinie: Die Klassifikation darf nie an der neuen Schicht scheitern. Jeder
Fehlerpfad fällt auf das heutige Verhalten zurück.

| Fehler | Verhalten |
|---|---|
| Judge nicht erreichbar oder Timeout | wie `unsure`: anlegen und in die Queue |
| Judge liefert unparsbares JSON | wie `unsure` |
| Resolver-Datenbank nicht schreibbar | Warnung, weiter mit exakt oder anlegen wie heute |
| Alias zeigt auf gelöschte ID | Alias verwerfen, neu entscheiden |
| Merge scheitert teilweise | nichts löschen, Queue-Eintrag bleibt offen |
| Resolver per Konfiguration aus | Verhalten identisch zum heutigen Stand |

## Bewusst ausgeschlossen

- **Embeddings als zweiter Ähnlichkeitskanal.** Zurückgestellt; die Entscheidung
  fällt anhand der Tuning-Ergebnisse aus Phase 2.

  **Ergebnis der Messung (Task 11, finaler Review):** Trigram-Ähnlichkeit
  erkennt orthografisch nahe Varianten zuverlässig (`Meldebescheid` /
  `Meldebescheinigung` = 0.71, `Meldebeschreibung` / `Meldebescheinigung` =
  0.63), scheitert aber strukturell an orthografisch fernen Synonymen
  (`Entgeltabrechnung` / `Verdienstbescheinigung` = 0.10,
  `Entgeltabrechnung` / `Payroll Statement` = 0.06). Das ist kein
  Schwellwert-Problem: Stufe 4 wählt je Vorschlag nur den
  ähnlichsten Kandidaten für den Judge aus, und bei einer Ähnlichkeit von
  0.06–0.10 wird dieses Paar bei keiner sinnvollen `JUDGE_MIN`-Einstellung
  je als Kandidat ausgewählt — der Judge bekommt das Paar also nie zu
  Gesicht. Reine String-Ähnlichkeit kann diese Klasse von Dubletten
  grundsätzlich nicht auflösen, unabhängig von der Schwellwert-Wahl.
  Ansatz B (Embeddings) ist für genau diesen Fall weiterhin nötig, nicht nur
  eine Option. Entscheidung aus der Phase-3-Planung (2026-08-01): eigene
  Phase 4, nicht Teil von Phase 3 — siehe Roadmap und Abschnitt
  „Präzisierungen aus der Planung" oben.

  Eine weitere Konsequenz der Messung: der ursprünglich geschätzte
  `JUDGE_MIN = 0.65` liegt oberhalb der gemessenen Ähnlichkeit für
  `Meldebeschreibung`/`Meldebescheinigung` (0.63) — mit dem geschätzten Wert
  hätte dieses Paar den Judge nie erreicht. Die gemessenen Werte aus Task 11
  stehen in `data/.env` (nicht im Repository, enthält Zugangsdaten).
- **Geschlossenes Vokabular per JSON-Schema-`enum`.** Widerspricht dem Wunsch
  nach offenem Vokabular und sprengt bei wachsender Liste den Kontext eines
  7B-Modells.
- **Auflösen der doppelten `buildUpdateData`.** Nicht nötig, weil der Resolver
  eine Ebene tiefer einhängt; wäre unbezogenes Refactoring.
- **Plural- und Singular-Stemming in der Normalisierung.** Zu fehleranfällig im
  Deutschen.
