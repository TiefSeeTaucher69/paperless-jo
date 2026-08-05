# Technisches Vollaudit paperless-jo

**Datum:** 2026-08-02
**Commit / Branch:** `f6d1784` auf `main`, Arbeitsverzeichnis vor Auditbeginn sauber
**Auditart:** unabhängige, read-only Bestandsaufnahme (Code, Konfiguration, Datenbank, Tests, Dokumentation)
**Prüfer:** Claude Opus 5, beauftragtes Audit ohne Änderungsrechte am Produktivcode

## Arbeitsplan

1. [x] Security-Fundament (muss zuerst, alles andere baut darauf auf)
AUDIT-001 (Auth fehlt in routes/setup.js), AUDIT-002 (Settings-Speichern löscht JWT_SECRET/neue Vars), AUDIT-027 (CORS/CSRF)
→ Ohne das ist jede spätere Konfigurationsänderung (Paket 2) hinfällig, weil sie beim nächsten Settings-Save wieder verschwindet.

2. [x] Konfiguration korrekt setzen
AUDIT-032 (Phase-2-Schwellwerte setzen), AUDIT-021 (neue Variablen ins Settings-UI)
→ Setzt voraus, dass Paket 1 erledigt ist, sonst wird's gleich wieder gelöscht.

3. [x] Merge-Sicherheit
AUDIT-005 (fromId=null → Massenänderung), AUDIT-013 (Dry-Run/Merge-Zeitpunkt, Chunking), AUDIT-012 (Negativ-Cache richtungsabhängig)
→ Alles am selben Codepfad (mergeEntity/reviewQueueService), lässt sich in einer Session gemeinsam anfassen.

4. [x] Schreibpfad-Integrität
AUDIT-004 (Dokument gilt als verarbeitet trotz fehlgeschlagenem PATCH), AUDIT-014 (vierfache Duplizierung + fehlender Scan-Guard), AUDIT-015 (DB-Fehler werden geschluckt)
→ Alle drei betreffen denselben saveDocumentChanges/Scan-Loop-Bereich in server.js/routes/setup.js.

5. [x] Resolver-Qualität
AUDIT-016 (Rechtsform-Kollisionen), AUDIT-017 (Paginierung bei Vorprüfung), AUDIT-019 (Ordering für Determinismus), AUDIT-008 (Temperature/Seed nur Ollama), AUDIT-007 (Judge/Embedding fest an Ollama)
→ Alles „Resolver liefert unter bestimmten Bedingungen ein falsches/inkonsistentes Ergebnis", gut als ein Themenblock.

6. [x] Fingerprint-Bereitschaft (bleibt deaktiviert, aber Vorarbeit)
AUDIT-003 (kein „bestätigt"-Begriff), AUDIT-006 (ungeprüfte IDs), AUDIT-010 (läuft zu spät), AUDIT-011 (Tag-Drift), AUDIT-025 (Tuning-Tool fehlt), AUDIT-020 (Performance), AUDIT-022 (Längenprüfung)
→ Größtes Einzelpaket, aber unkritisch für den laufenden Betrieb, da Feature aus ist. Würde ich zeitlich nach hinten stellen, außer du willst das Feature bald aktivieren.

7. [x] Aufräumen / Code-Qualität
AUDIT-023 (toter Code), AUDIT-024 (Lint-Gate), AUDIT-029 (similarity-Spalte), AUDIT-028 (Judge-Robustheit), AUDIT-026 (Float32-Doku)
→ Risikoarm, gut als Lückenfüller zwischen den anderen Paketen.

8. [x] Review-UI & Doku
AUDIT-030 (Pagination/Filter), AUDIT-009 (Dashboard-Guard), AUDIT-031/-033/-035 (Doku-Korrekturen)
→ Kleine, unabhängige Verbesserungen.

Info-only bleibt AUDIT-034 (positiv, keine Aktion nötig).



---

## 1. Executive Summary

Die fünf Phasen der Roadmap „Konsistenz der automatischen Dokumentklassifikation"
sind **substanziell implementiert**. Für jede Phase existiert der versprochene
Code, die versprochenen Datenbankstrukturen und eine belastbare Unit-Test-Basis
(217 Tests, alle grün, ~0,9 s). Die neuen Komponenten sind sauber gegeneinander
abgegrenzt, injizieren ihre Abhängigkeiten und fallen bei Fehlern auf das
bisherige Verhalten zurück. Das ist überdurchschnittlich diszipliniert gebaut
und deutlich besser als der Legacy-Bestand, in den es eingebettet ist.

Der Bericht kommt trotzdem zu einem **eingeschränkten Gesamturteil**. Vier
Punkte tragen das:

1. **Der gemeldete Ist-Zustand stimmt nicht.** Der Auftrag nennt alle drei
   Feature-Flags als deaktiviert. Tatsächlich sind in der laufenden
   `data/.env` **`ENTITY_RESOLVER_ENABLED` und `EMBEDDING_SIMILARITY_ENABLED`
   aktiv**; nur der Fingerprint ist aus. Die *Code-Defaults* sind korrekt `no`
   — die *Installation* läuft aber bereits scharf. Alles, was dieser Bericht
   zum Resolver und zum Embedding-Kanal sagt, betrifft damit den laufenden
   Betrieb, nicht einen hypothetischen Zukunftszustand. (AUDIT-032)

2. **Die gemessenen Phase-2-Schwellwerte sind nicht gesetzt.** Die Roadmap
   sagt „Gemessene Werte stehen in `data/.env`". In der aktuellen `data/.env`
   fehlen `ENTITY_RESOLVER_AUTO_THRESHOLD` und `ENTITY_RESOLVER_JUDGE_MIN`
   vollständig — es greifen die *geschätzten* Code-Defaults 0.90 / 0.65, also
   genau die Werte, die Phase 2 als widerlegt dokumentiert hat. (AUDIT-032)

3. **Eine Konfigurationsänderung über das Settings-UI löscht sämtliche neuen
   Variablen und `JWT_SECRET` aus `data/.env`.** Der Speicherpfad schreibt die
   Datei aus einer festen Whitelist neu. Danach fällt `JWT_SECRET` auf den
   hartkodierten Wert `'your-secret-key'` zurück — jeder kann dann gültige
   Sitzungstoken selbst signieren. Gleichzeitig verschwinden alle Resolver-,
   Embedding- und Fingerprint-Einstellungen lautlos. Das ist der schwerste
   Einzelbefund. (AUDIT-002)

4. **Der Dokument-Fingerprint übernimmt keine „bestätigten" Klassifikationen.**
   Roadmap und `.env.example` behaupten das; im Code wird für *jedes*
   verarbeitete Dokument unmittelbar nach der eigenen KI-Klassifikation ein
   Fingerprint mit genau dieser ungeprüften Klassifikation geschrieben. Ein
   Fehltreffer vererbt seine Tags an das nächste Dokument, das sich dann
   selbst als Fingerprint einträgt — ein selbstverstärkender Kreis ohne
   Korrekturinstanz. (AUDIT-003)

Zusätzlich zeigt das Audit eine **große Sicherheitslücke im Legacy-Teil**, die
nicht aus dieser Roadmap stammt, aber die neuen Features direkt gefährdet:
nahezu alle schreibenden Routen in `routes/setup.js` — darunter `POST /settings`,
`POST /setup`, `POST /manual/updateDocument`, `POST /api/reset-all-documents` —
sind **ohne jede Authentifizierung** erreichbar (AUDIT-001). Die neuen
Review-Routen sind demgegenüber vorbildlich abgesichert.

**Findings gesamt: 35** — 2 Critical, 6 High, 13 Medium, 9 Low, 5 Info.

**Feature-Readiness:** EntityResolver *Ready with conditions* (läuft bereits,
zwei Bedingungen offen), Embedding Similarity *Ready with conditions* (läuft
bereits), Document Fingerprint **Not ready**.

---

## 2. Auditumfang

Untersucht wurde das gesamte Repository `paperless-jo` im Zustand `f6d1784`:

| Bereich | Umfang |
|---|---|
| Einstiegspunkte | `server.js` (728 Z.), `routes/setup.js` (4473 Z.), `routes/review.js`, `routes/rag.js`, `routes/auth.js` |
| Neue Klassifikationskomponenten | `services/entityResolver.js`, `entityNormalizer.js`, `entitySimilarity.js`, `entityJudge.js`, `entityEmbeddingService.js`, `entityBackfillService.js`, `reviewQueueService.js`, `documentFingerprintService.js` |
| Persistenz | `models/entityStore.js`, `models/documentFingerprintStore.js`, `models/document.js`, Live-DB `data/entities.db` (read-only) |
| Konfiguration | `config/config.js`, `.env.example`, `data/.env` (nur Schlüsselnamen und abgeleitete Booleans, keine Werte), `docker-compose.yml`, `Dockerfile`, `ecosystem.config.js` |
| LLM-Pfade | `ollamaService.js`, `openaiService.js`, `azureService.js`, `customService.js`, `restrictionPromptService.js`, `serviceUtils.js`, `aiServiceFactory.js` |
| Paperless-Integration | `services/paperlessService.js` (1606 Z.) vollständig |
| RAG/Chat | `services/ragService.js`, `chatService.js`, `main.py` (Embedding-/Store-Abgrenzung) |
| Frontend | `views/review.ejs`, `views/dashboard.ejs`, `public/js/review.js` |
| Tests & Werkzeuge | 22 Testdateien, `scripts/tune-thresholds.js`, `dry-run-eval.js`, `export-entity-fixture.js` |
| Dokumentation | Roadmap, 5 Implementierungspläne, 3 Design-Specs, `README.md`, `.env.example` |

Nicht Gegenstand des Audits: der Python-RAG-Dienst `main.py` in seiner inneren
Logik (nur auf Abgrenzung zu den neuen Embeddings geprüft), Frontend-Ästhetik,
Upstream-Historie vor dem Fork.

---

## 3. Methodik und ausgeführte Befehle

Alle Schritte waren lesend. Es wurde kein Produktivdienst beschrieben, keine
Paperless-Entität verändert, keine Migration ausgeführt und keine Abhängigkeit
installiert.

```
git status --short
git branch --show-current
git log --oneline -40
wc -l services/*.js models/*.js routes/*.js config/*.js test/*.js server.js scripts/*.js
npm test                       # node --test test/*.test.js
npx eslint .                   # 169 Errors, ausschliesslich diagnostisch
npx eslint . -f json           # Aggregation nach Regel, no-undef/no-const-assign isoliert
node -e "<better-sqlite3 readonly>"   # Schema + Zeilenzahlen aus data/entities.db
node -e "<axios.getUri>"       # Verifikation der null-Parameter-Serialisierung
node -e "<config/config.js>"   # Aufloesung der Feature-Flags, ohne Geheimwerte auszugeben
grep -o '^[A-Z_][A-Z0-9_]*' data/.env   # nur Schluesselnamen, keine Werte
```

Zusätzlich: vollständiges Lesen der oben genannten Quelldateien, Abgleich jedes
Roadmap-Punktes gegen Implementierung, Verfolgung des kompletten
Klassifikationspfads von `scanDocuments` bis `updateDocument`.

**Belegtes Ergebnis des Testlaufs:**

```
1..217
# tests 217
# suites 0
# pass 217
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 901.9821
```

**Belegtes Ergebnis der Datenbankinspektion (`data/entities.db`, readonly):**

```
Tabellen: entity_aliases, entity_review_queue, entity_embeddings
          (document_fingerprints existiert NICHT)
entity_aliases        1 Zeile   (source=user)
entity_review_queue 121 Zeilen  (open=120, merged=1)
entity_embeddings    72 Zeilen  (model=bge-m3)
open-Eintraege mit proposed_id IS NULL: 0
```

**Belegte Auflösung der Feature-Flags aus der laufenden Konfiguration:**

```
resolverEnabled      true
embeddingEnabled     true
fingerprintEnabled   false
autoThreshold 0.9  judgeMin 0.65        <- Code-Defaults, nicht gemessen
embedAuto 0.9      embedJudge 0.5       <- gemessen, in data/.env gesetzt
excludedTypes ['tag']
fpThreshold 0.9                          <- ungemessener Platzhalter
useExistingData yes
jwtSecretIsDefault false                 <- aktuell gesetzt
```

**Abschlussprüfung:** `git status --short` liefert nach allen Schritten außer
diesem Bericht keine Ausgabe.

---

## 4. Einschränkungen des Audits

Ehrlich benannt, damit die Aussagekraft einschätzbar bleibt:

- **Keine Laufzeitprüfung gegen Paperless-ngx oder Ollama.** Alle Aussagen zum
  API-Verhalten von Paperless (Pagination, `bulk_edit`, 400/404-Semantik)
  beruhen auf Codeanalyse und der dokumentierten Paperless-API, nicht auf
  einem Testaufruf. Ein Serverstart war ausgeschlossen — er hätte laut
  Roadmap sofort Dokumente verarbeitet und nach Paperless geschrieben.
- **Kein End-to-End-Test des Fingerprint-Pfads.** Die Tabelle
  `document_fingerprints` existiert in der Live-DB nicht; das Feature ist nie
  gelaufen. Alle Aussagen dazu sind Codeanalyse.
- **Keine Coverage-Messung.** Es ist kein Coverage-Tool im Projekt
  konfiguriert; `node --test --experimental-test-coverage` hätte eine
  Werkzeugänderung bedeutet. Testlücken sind deshalb qualitativ, nicht
  quantitativ benannt.
- **Kein Flaky-Nachweis.** Der Testlauf wurde einmal ausgeführt. Bei 0,9 s
  Laufzeit und rein synchronen In-Memory-Fakes ist Flakiness
  unwahrscheinlich, aber nicht ausgeschlossen.
- **`data/.env` wurde nur auf Schlüsselnamen und abgeleitete Booleans
  geprüft.** Werte wurden gemäß `CLAUDE.md` nicht gelesen, ausgegeben oder
  zitiert. Aussagen wie „Wert X ist gesetzt/nicht gesetzt" beruhen auf
  Schlüsselpräsenz bzw. auf den vom Code abgeleiteten Booleans.
- **Keine Angriffe.** Die Sicherheitsbefunde sind statisch hergeleitet; es
  wurde kein Request gegen eine laufende Instanz gesendet.
- **Bekannte Grenze bei AUDIT-005:** die Erreichbarkeit des NULL-`fromId`-Pfads
  konnte nicht abschließend widerlegt werden, nur die Auswirkung im Fall des
  Eintretens.

---

## 5. Architekturüberblick

### 5.1 Prozesse

Ein einziger Node-Prozess (`ecosystem.config.js`: `instances: 1`) bedient
gleichzeitig Web-UI, REST-API und den Hintergrund-Scan. Daneben optional ein
separater Python-Dienst (`main.py`, Port 8000) für RAG, angesprochen über HTTP.
Kein Worker, keine Queue, kein zweiter Prozess auf derselben SQLite-Datei.

### 5.2 Datenfluss einer Klassifikation

```
cron(SCAN_INTERVAL) ──> scanDocuments()            [server.js:462]
POST /api/scan/now  ──> inline-Kopie derselben Schleife  [routes/setup.js:1493]
Webhook / Manual    ──> processQueue()             [routes/setup.js:2419]
scanInitial()       ──> Kopie derselben Schleife   [server.js:413]
        │
        ├─ paperlessService.getTags()/getAllDocuments()/listCorrespondentsNames()/listDocumentTypesNames()
        │
        └─ pro Dokument:
             processDocument()
               ├─ documentModel.isDocumentProcessed()   -> ueberspringen falls ja
               ├─ setProcessingStatus('processing')
               ├─ getPermissionOfDocument()
               ├─ getDocumentContent() + getDocument()
               ├─ content auf 50000 Zeichen kuerzen
               └─ aiService.analyzeDocument(...)        -> ollama|openai|azure|custom
             buildUpdateData(analysis, doc)
               ├─ processTags()            ──> _resolveEntity('tag', ...)
               ├─ getOrCreateDocumentType() ──> _resolveEntity('document_type', ...)
               ├─ getOrCreateCorrespondent()──> _resolveEntity('correspondent', ...)
               └─ custom_fields
             applyDocumentFingerprint()     ──> ueberschreibt updateData.tags/document_type
             saveDocumentChanges()
               ├─ documentModel.saveOriginalData()
               ├─ paperlessService.updateDocument()   <- einziger Schreibpfad nach Paperless
               ├─ documentModel.addProcessedDocument()
               ├─ documentModel.addOpenAIMetrics()
               └─ documentModel.addToHistory()
             recordDocumentFingerprint()
```

### 5.3 Resolver-Kaskade (`services/entityResolver.js`)

```
resolve(type, proposedName, existingEntities)
  0  leerer Name                         -> skip
  1  Alias-Tabelle (normalisiert)        -> map/alias      (Alias ins Leere -> loeschen, weiter)
  2  exakter Vergleich (lowercase)       -> map/exact
  3  normalisierter Vergleich            -> map/normalized + Alias schreiben
  4  Kandidatenwahl: combined = max(trigram, embedding) pro Bestandsentitaet
     4a trigram >= autoThreshold         -> map/similarity + Alias   (Vorrang vor Embedding)
        ausser Negativ-Cache-Treffer     -> create
     4b embedding >= embedAutoThreshold  -> map/embedding_similarity + Alias
     4c Judge-Zone: trigram >= judgeMin (Vorrang) sonst embedding >= embedJudgeMin
        Judge 'same'      -> map/llm + Alias
        Judge 'different' -> Queue-Eintrag status='rejected', Rueckgabe create
        Judge 'unsure'    -> create_and_queue (Aufrufer legt an, dann recordCreatedAndQueued)
  5  sonst                               -> create
```

### 5.4 Persistenz

| Datei | Tabellen | Zugriff |
|---|---|---|
| `data/documents.db` | `processed_documents`, `openai_metrics`, `history_documents`, `original_documents`, `users`, `processing_status` | `models/document.js` (sqlite3, async) |
| `data/entities.db` | `entity_aliases`, `entity_review_queue`, `entity_embeddings`, `document_fingerprints` | `models/entityStore.js` + `models/documentFingerprintStore.js` (better-sqlite3, synchron, WAL) |
| `data/chromadb` | ChromaDB-Collection | `main.py`, SentenceTransformer — vollständig getrennt |

`data/entities.db` wird von bis zu **vier** unabhängigen Verbindungen geöffnet:
`paperlessService._getEntityResolver()`, `routes/review.js#getServices()`,
`server.js#getDocumentFingerprintService()` und
`routes/setup.js#getDocumentFingerprintService()`. Alle lazy, alle WAL, alle im
selben Prozess und damit durch die Synchronität von better-sqlite3
serialisiert.

### 5.5 Abgrenzung Legacy vs. neu

Die neuen Module (`services/entity*.js`, `services/documentFingerprint*.js`,
`models/entityStore.js`, `models/documentFingerprintStore.js`,
`routes/review.js`) sind durchgängig mit Dependency Injection gebaut,
kommentiert, getestet und deutsch dokumentiert. Der Legacy-Teil
(`routes/setup.js`, `services/paperlessService.js`, `services/manualService.js`,
die vier LLM-Services) ist stark dupliziert, teilweise toter Code und ohne
Auth. **Die neuen Teile hängen sich sauber ein; sie erben aber die Schwächen
des Rahmens, in den sie sich einhängen** — insbesondere fehlende
Authentifizierung, in-place-Mutation von `updateData` und geschluckte Fehler.

---

## 6. Verifizierter Ist-Zustand

| Aussage aus dem Auftrag | Verifiziert? | Befund |
|---|---|---|
| Alle fünf Phasen laut Roadmap abgeschlossen | teilweise | Code für alle fünf Phasen vorhanden; Abweichungen siehe Abschnitt 7 |
| Merge an echten Daten getestet | plausibel | 1 Alias `source='user'` und 1 Queue-Eintrag `status='merged'` in der Live-DB — konsistent mit einem durchgeführten Merge |
| „Mindestens 156 Tests" erfolgreich | übertroffen | **217/217 grün**, 0 skipped, 901 ms |
| Branch ist `main`, Arbeitsverzeichnis sauber | ja | bestätigt |
| `ENTITY_RESOLVER_ENABLED=no` | **nein** | in `data/.env` gesetzt und **aktiv** |
| `EMBEDDING_SIMILARITY_ENABLED=no` | **nein** | in `data/.env` gesetzt und **aktiv**, `EMBEDDING_EXCLUDED_TYPES=tag` |
| `DOCUMENT_FINGERPRINT_ENABLED=no` | ja | Schlüssel fehlt in `data/.env`, Code-Default `no` greift; Tabelle `document_fingerprints` existiert nicht |
| „Bisheriges Verhalten ohne Aktivierung unverändert" | mit einer Ausnahme | siehe AUDIT-009 (Dashboard öffnet die DB auch bei deaktiviertem Resolver) |
| `FINGERPRINT_SIMILARITY_THRESHOLD=0.90` ungemessen | ja | bestätigt, Schlüssel nicht in `data/.env`, Code-Default greift |
| Phase-2-Schwellwerte gemessen und gesetzt | **nein** | `ENTITY_RESOLVER_AUTO_THRESHOLD`/`_JUDGE_MIN` fehlen in `data/.env`; es greifen die Defaults 0.90/0.65 |

---

## 7. Abgleich der fünf Roadmap-Phasen

### Phase 0 — Dry-Run-Harness

| Anforderung | Status | Beleg |
|---|---|---|
| `scripts/export-entity-fixture.js` | vollständig umgesetzt | 67 Zeilen, exportiert nach `data/eval/` |
| `scripts/dry-run-eval.js`, ohne Schreiben nach Paperless | vollständig umgesetzt | 369 Zeilen |
| Baseline-Messung | nur dokumentiert | Roadmap markiert selbst „Baseline ausstehend"; `data/eval/` existiert, Inhalt gitignored |

### Phase 1 — Determinismus und Prompt-Hygiene

| Anforderung | Status | Implementierung |
|---|---|---|
| 1. `temperature: 0`, fester Seed, `top_p: 1`, kein `top_k` | vollständig umgesetzt **für Ollama** | `ollamaService.js:476-483`; `config.js:158-161` |
| ... für alle Provider | **abweichend umgesetzt** | `openaiService.js:191,315` → `temperature: 0.3`, kein Seed; ebenso `azureService.js:182`, `customService.js:194`. → AUDIT-008 |
| 2. `num_ctx` aus System- und User-Prompt, Unter-/Obergrenze | vollständig umgesetzt | `_fitPromptToContext()` `ollamaService.js:391-424`, `MIN_CTX=2048`, `OLLAMA_NUM_CTX_MAX` |
| 3. Nur Dokumententext kürzen, `num_predict=512` | vollständig umgesetzt | ebd.; Systemhälfte nachweislich unangetastet |
| 4. `_formatTagsList` für String- und Objekt-Arrays | vollständig umgesetzt | `restrictionPromptService._formatNameList()` behandelt String, Objekt, gemischt, vorformatierten String |
| 5. `%RESTRICTED_DOCUMENT_TYPES%` | vollständig umgesetzt | `restrictionPromptService.js:38-43` |
| 6. Keine Mutation von `config.mustHavePrompt` | vollständig umgesetzt | `ollamaService.js:228` lokale Kopie via `.replace()` |
| 7. Prompt-Aufteilung system/user, Analyzer-Prompt entfernt | vollständig umgesetzt | `_buildPrompt()` liefert `{system, user}`; `_defaultAnalyzerPrompt()` trägt bewusst keine JSON-Vorlage mehr |
| 8. Defensiver Tag-Filter | vollständig umgesetzt | `_isPlausibleTag()` (Doppelpunkt, >60 Zeichen) |
| 9. `document_date` normieren oder verwerfen | vollständig umgesetzt | `_normalizeDocumentDate()`, ISO durchreichen, `DD.MM.YYYY` konvertieren, sonst `null` |
| Abnahme: identisches Ergebnis bei `--repeat 2` | **nicht erreicht, dokumentiert** | Roadmap Phase 5: weiterhin 4 von 10 Dokumenten instabil. Ursachenanalyse siehe AUDIT-019 |

**Zusatzbefund:** Die in Phase 1 identifizierte Konfigurationsfalle
(`PAPERLESS_API_URL` muss auf `/api` enden) ist **nicht** behoben —
`paperlessService.initialize()` setzt `baseURL` weiterhin unverändert.
Der Punkt war in der Roadmap als „Kandidat für einen Robustheitsfix"
formuliert, nicht als Zusage. → AUDIT-035

### Phase 2 — EntityResolver

| Anforderung | Status | Implementierung |
|---|---|---|
| Normalizer: Kleinschreibung, NFKD, Umlaut/ß, Interpunktion, Whitespace | vollständig umgesetzt | `entityNormalizer.js:1-23`, deutsche Faltung korrekt **vor** NFKD |
| Rechtsform-Tokens nur bei Korrespondenten | umgesetzt, aber fehleranfällig | `_stripLegalForm()`, siehe AUDIT-016 |
| Trigram-Dice mit Tests | vollständig umgesetzt | `entitySimilarity.js`, 5 Tests |
| Tabellen `entity_aliases`, `entity_review_queue` | vollständig umgesetzt | `entityStore._createTables()`, UNIQUE-Constraints vorhanden |
| Kaskade mit injiziertem Judge und Store | vollständig umgesetzt | `entityResolver.js`, 40 Tests über alle Pfade |
| Judge als Ollama-Call, `temperature: 0`, Structured Output | umgesetzt, aber fehleranfällig | `entityJudge.js`, fest an Ollama gebunden → AUDIT-007 |
| Einhängen in `paperlessService`, Verhalten bei aus identisch | vollständig umgesetzt | `_resolveEntity()` mit Fehlerbarriere, 30+ Hook-in-Tests, u.a. „ruft `ensureCorrespondentCache` NICHT auf, wenn deaktiviert" |
| `npm test` = `node --test` | vollständig umgesetzt | `package.json` |
| Schwellwert-Tuning und Setzen der Werte | **nur dokumentiert** | `tune-thresholds.js` existiert; die gemessenen Werte sind in der Live-`data/.env` **nicht gesetzt** → AUDIT-032 |
| Offener Punkt: `document_id` in der Queue | in Phase 3 nachgereicht | `options.documentId` durchgereicht bis `_recordEntityQueue` |

### Phase 3 — Review-UI, Merge, Altbestand

| Anforderung | Status | Implementierung |
|---|---|---|
| 1. Review-Seite: Paare, Ähnlichkeit, Judge-Urteil, Dokumentlink | vollständig umgesetzt | `views/review.ejs`, alle Ausgaben EJS-escaped (`<%= %>`) |
| 2. `mergeEntity`: ermitteln → `bulk_edit` → verifizieren → löschen | vollständig umgesetzt | `paperlessService.js:1407-1434`; Löschen erst nach nachweislich leerem `fromId` |
| `dryRun` als Default in programmatischen Aufrufen | vollständig umgesetzt | `mergeEntity(..., { dryRun = true } = {})`; Route invertiert bewusst mit `req.body?.dryRun !== false` |
| 3. Merge schreibt Alias `source='user'`, Reject setzt `rejected` | vollständig umgesetzt | `reviewQueueService.js:28-43` |
| 4. Queue-Zähler im Dashboard | vollständig umgesetzt | `views/dashboard.ejs:218`, `paperlessService.getOpenReviewQueueCount()` — mit Nebenwirkung, siehe AUDIT-009 |
| 5. Altbestands-Durchlauf ohne Judge, alles über `JUDGE_MIN` in die Queue | vollständig umgesetzt | `entityBackfillService.run()`, keine Judge-Calls, keine Auto-Merges |
| Auth für Review-Routen | vollständig umgesetzt | `isAuthenticated` für die Seite, `authenticateJWT` für alle vier API-Routen — **die einzigen korrekt geschützten Schreibrouten im Projekt** |
| Zweistufige Merge-Bestätigung | umgesetzt, aber fehleranfällig | Dry-Run und echter Merge sind zwei getrennte Abfragen zu verschiedenen Zeitpunkten → AUDIT-013 |
| Abnahme: echter Merge verifiziert | plausibel belegt | 1 Alias `source='user'`, 1 Eintrag `status='merged'` in der Live-DB |

### Phase 4 — Embeddings-Ähnlichkeitskanal

| Anforderung | Status | Implementierung |
|---|---|---|
| Ollama `/api/embed`-Client, Modell `bge-m3` | vollständig umgesetzt | `entityEmbeddingService.js`, Timeout 15 s, Vektorvalidierung |
| Cache-Tabelle `entity_embeddings` mit Modellspalte | vollständig umgesetzt | UNIQUE(entity_type, entity_id); `getOrComputeEmbedding` invalidiert bei Namens- **und** Modellwechsel |
| Additiv neben Trigram, Trigram behält Vorrang | vollständig umgesetzt | `entityResolver.js:91-108` und `:124-144`, jeweils mit ausführlicher Begründung im Code |
| Getrennte Schwellwerte je Kanal, kein gemeinsamer Schwellwert auf `max()` | vollständig umgesetzt | Entscheidung prüft Rohwert je Kanal gegen den eigenen Schwellwert |
| Negativ-Cache vor Auto-Merge und Judge | vollständig umgesetzt | inkl. getrennter Cache-Prüfung, wenn `best` und `bestTrigram` verschiedene Entitäten sind |
| `EMBEDDING_EXCLUDED_TYPES` | vollständig umgesetzt | `config.js:104-107`, im Resolver und im Backfill respektiert |
| Sichtbarkeit von Trigram/Embedding in der Review-Tabelle | vollständig umgesetzt | inkl. Rückwärtskompatibilität für Zeilen vor Phase 4 |
| `tune-thresholds.js` mit Embedding-Sweep | vollständig umgesetzt | inkl. sauberem Skip, wenn Ollama nicht erreichbar |
| Per Default aus | vollständig umgesetzt (Code) | in der Installation aber **eingeschaltet** |

### Phase 5 — Dokument-Fingerprint

| Anforderung | Status | Implementierung |
|---|---|---|
| Store mit `document_fingerprints`, Index auf `correspondent_id` | vollständig umgesetzt | `documentFingerprintStore.js`; abweichend BLOB statt TEXT für den Vektor (besser als spezifiziert) |
| `model`-Spalte, additive Migration | vollständig umgesetzt | `_ensureColumn()` mit `PRAGMA table_info`-Check, idempotent |
| Fremdmodell-Vektoren nehmen nicht am Vergleich teil | vollständig umgesetzt | `documentFingerprintService.js:54-56`, Test vorhanden |
| Ein-Slot-Memo gegen doppelte Embedding-Calls | vollständig umgesetzt | inhaltsgebundener Key, zwei Tests pinnen das Verhalten |
| Nur Tags und Dokumentart übernehmen, Titel/Datum frisch | vollständig umgesetzt | `applyDocumentFingerprint()` fasst nur `tags` und `document_type` an |
| Respektiert `activateTagging`/`activateDocumentType` | vollständig umgesetzt | `server.js:74-79` |
| Fehler brechen die Klassifikation nie ab | vollständig umgesetzt | drei Ebenen try/catch |
| Per Default aus, bei `no` kein neuer Codepfad | vollständig umgesetzt | verifiziert: Tabelle existiert in der Live-DB nicht |
| **„aus einer früheren, bereits bestätigten Klassifikation"** | **abweichend umgesetzt** | Es gibt keinen Begriff von „bestätigt". Jede KI-Klassifikation wird sofort als Fingerprint gespeichert → AUDIT-003 |
| Fingerprint verhindert Neuanlage von Entitäten | **nicht auffindbar** | Der Check läuft *nach* `buildUpdateData`; alle vorgeschlagenen Entitäten sind zu diesem Zeitpunkt bereits in Paperless angelegt → AUDIT-010 |
| Tuning von `FINGERPRINT_SIMILARITY_THRESHOLD` | **nur dokumentiert** | `tune-thresholds.js` kennt keinen Fingerprint-Modus → AUDIT-025 |
| Test für den `server.js`-Hook | **nicht auffindbar, bewusst** | Design: „Kein Test für den `server.js`-Hook selbst nötig". Genau dort fand die Fix-Welle 7 Integrationsprobleme → AUDIT-024 |

---

## 8. Kritische und hohe Findings

### AUDIT-001 — Nahezu alle schreibenden Routen ohne Authentifizierung

- **Schweregrad:** Critical · **Priorität:** P0 · **Bereich:** Sicherheit
- **Dateien:** `routes/setup.js:1341, 1493, 2577, 3111, 3229, 3355, 3671, 4080`; `routes/auth.js`
- **Beobachtetes Verhalten:** `routes/setup.js:20` importiert `authenticateJWT`
  und `isAuthenticated`, verwendet beides aber **nirgends**. Der lokale
  `protectApiRoute` (Z. 191) wird an genau einer Stelle eingesetzt:
  `GET /playground`. Ohne Middleware erreichbar sind unter anderem:
  `POST /settings` (schreibt `data/.env`), `POST /setup` (dito),
  `POST /manual/updateDocument` (ändert Paperless-Dokumente),
  `POST /api/reset-all-documents` (löscht die lokale Verarbeitungshistorie),
  `POST /api/scan/now` (startet einen Vollscan),
  `POST /api/webhook/document`, `GET /settings`, `GET /dashboard`,
  `GET /debug/*`.
- **Erwartetes Verhalten:** Jede zustandsändernde Route und jede Route, die
  Konfiguration oder Dokumentinhalte ausgibt, verlangt eine gültige Sitzung —
  so wie `routes/review.js` es korrekt tut.
- **Technische Ursache:** Historisch gewachsener Legacy-Code aus dem Upstream-Fork.
  Phase 3 hat die Middleware für die eigenen Routen korrekt verdrahtet, den
  Bestand aber nicht angefasst (bewusste Scope-Entscheidung).
- **Risikoszenario:** Jeder mit Netzwerkzugriff auf Port 3000 liest über
  `GET /settings` die Konfigurationsseite, ändert über `POST /settings` den
  `PAPERLESS_API_URL` auf einen eigenen Endpunkt und bekommt beim nächsten
  Scan den Paperless-Token mitgeliefert — oder ändert direkt über
  `POST /manual/updateDocument` beliebige Dokumente.
- **Wahrscheinlichkeit:** hoch, sobald der Port über das reine Loopback hinaus
  erreichbar ist. **Auswirkung:** vollständige Kompromittierung.
- **Beleg:** `grep -n "isAuthenticated\|authenticateJWT\|protectApiRoute" routes/setup.js`
  liefert nur Zeile 20 (Import), 191 (Definition) und 540 (einzige Nutzung).
- **Empfohlene Lösung:** `router.use(isAuthenticated)` bzw. `authenticateJWT`
  vor allen Routen außer `/login`, `/logout`, `/health` und dem
  Erst-Setup-Pfad. Erst-Setup zusätzlich gegen `PAPERLESS_AI_INITIAL_SETUP`
  gaten.
- **Empfohlene Tests:** je Route ein Test „ohne Cookie/Token → 401/302".
- **Unsicherheiten:** Falls die Instanz ausschließlich über einen
  authentifizierenden Reverse Proxy erreichbar ist, sinkt die praktische
  Wahrscheinlichkeit — das ändert die Bewertung des Codes nicht.

### AUDIT-002 — Settings-Speichern löscht `JWT_SECRET` und alle neuen Variablen aus `data/.env`

- **Schweregrad:** Critical · **Priorität:** P0 · **Bereich:** Konfiguration / Sicherheit
- **Dateien:** `routes/setup.js:4124-4171` (`currentConfig`), `:4329-4333` (`mergedConfig`), `services/setupService.js:209-248` (`saveConfig`), `routes/auth.js:5`
- **Beobachtetes Verhalten:** `saveConfig()` schreibt `data/.env` **komplett neu**
  aus dem übergebenen Objekt (`fs.writeFile`, kein Merge mit der Datei). Das
  Objekt entsteht aus `{...currentConfig, ...updatedConfig}`, und `currentConfig`
  ist eine **feste Whitelist von 42 Schlüsseln**. Nicht enthalten sind:
  `JWT_SECRET`, `PAPERLESS_AI_INITIAL_SETUP`, `ENTITY_RESOLVER_*`,
  `EMBEDDING_*`, `EMBED_*`, `DOCUMENT_FINGERPRINT_ENABLED`,
  `FINGERPRINT_SIMILARITY_THRESHOLD`, `OLLAMA_TEMPERATURE`, `OLLAMA_SEED`,
  `OLLAMA_NUM_PREDICT`, `OLLAMA_NUM_CTX_MAX`.
- **Erwartetes Verhalten:** Ein Settings-Speichervorgang ändert die
  angefassten Schlüssel und lässt alle übrigen Zeilen der Datei unberührt.
- **Technische Ursache:** Whitelist-basiertes Neuschreiben statt
  Read-Modify-Write. `setupService.loadConfig()` existiert und würde die
  vollständige Datei liefern — wird an dieser Stelle aber nicht verwendet.
- **Risikoszenario A (Sicherheit):** Nach einem Settings-Speichern fehlt
  `JWT_SECRET`. Beim nächsten Neustart greift `routes/auth.js:5`
  `process.env.JWT_SECRET || 'your-secret-key'`. Der Secret ist damit ein im
  öffentlichen Repository stehender Literalwert; jeder kann ein gültiges
  Sitzungstoken signieren und ist gegenüber `authenticateJWT` und
  `isAuthenticated` authentifiziert. Zusätzlich werden alle bestehenden
  Sitzungen ungültig — der sichtbare Symptomeffekt maskiert den
  Sicherheitseffekt nicht.
- **Risikoszenario B (Betrieb):** Nach demselben Speichervorgang laufen
  Resolver und Embedding-Kanal auf den Code-Defaults weiter, gemessene
  Schwellwerte und `EMBEDDING_EXCLUDED_TYPES=tag` sind weg. Der
  Embedding-Kanal erzeugt dann wieder genau das Tag-Rauschen, das Phase 5
  gemessen und abgestellt hat — ohne jede Meldung.
- **Wahrscheinlichkeit:** sehr hoch (jede Nutzung der Settings-Seite).
  **Auswirkung:** Auth-Bypass plus stille Rekonfiguration.
- **Beleg:** Whitelist in `routes/setup.js:4124-4171` enthält kein
  `JWT_SECRET`; `data/.env` enthält heute `JWT_SECRET`; `saveConfig` nutzt
  `fs.writeFile` ohne Merge.
- **Empfohlene Lösung:** `saveConfig` auf Read-Modify-Write umstellen
  (`loadConfig()` als Basis, dann Overrides), oder mindestens alle bekannten
  Schlüssel in `currentConfig` aufnehmen. Zusätzlich: Serverstart abbrechen
  oder laut warnen, wenn `JWT_SECRET` fehlt, statt auf ein Literal
  zurückzufallen.
- **Empfohlene Tests:** Testfall „`.env` mit Fremdschlüssel X → `saveConfig`
  mit unverwandtem Feld → X ist danach noch da"; Testfall „`JWT_SECRET` fehlt
  → Start schlägt fehl / warnt".

### AUDIT-003 — Fingerprint übernimmt unbestätigte Klassifikationen, Fehler propagieren zirkulär

- **Schweregrad:** High · **Priorität:** P0 · **Bereich:** Phase 5 / Datenintegrität
- **Dateien:** `server.js:62-100, 448-452, 500-504`; `routes/setup.js:2371-2409, 2465-2469, 1538-1542`; `services/documentFingerprintService.js:71-78`
- **Beobachtetes Verhalten:** `recordDocumentFingerprint()` wird für **jedes**
  verarbeitete Dokument aufgerufen, unmittelbar nach `saveDocumentChanges()`
  und mit genau der Klassifikation, die der LLM-Lauf soeben erzeugt hat. Es
  gibt keine Prüfung, ob diese Klassifikation von einem Menschen bestätigt,
  über die Review-Queue gelaufen oder auch nur erfolgreich nach Paperless
  geschrieben wurde. Wenn `applyDocumentFingerprint()` zuvor einen Treffer
  hatte, sind die gespeicherten Tags exakt die vom Treffer geerbten.
- **Erwartetes Verhalten:** Laut Roadmap Z. 356-360 und `.env.example`
  („reuses their already-confirmed tags/document type") stammen die
  übernommenen Werte aus einer *bestätigten* früheren Klassifikation.
- **Technische Ursache:** Der Begriff „bestätigt" existiert weder im
  Datenmodell (`document_fingerprints` hat keine Spalte dafür) noch im
  Code. Der Design-Spec ist an dieser Stelle ehrlicher als die Roadmap: er
  schließt Judge und Review-Queue explizit aus und benennt den Fehltreffer als
  „wird still angewendet".
- **Risikoszenario:** Dokument A der Serie „Stadtwerke" wird falsch als
  `Mahnung` statt `Rechnung` klassifiziert. Dokument B derselben Serie ist zu
  0.93 ähnlich → erbt `Mahnung` und schreibt sich selbst als Fingerprint mit
  `Mahnung`. Dokument C erbt von A oder B. Nach einem Jahr trägt die gesamte
  Serie eine falsche Dokumentart, und die einzige Fehlerquelle ist ein
  einziger Fehltreffer, der nie sichtbar wurde. Keine Review-Queue, kein
  Judge, keine Korrekturschleife — nur eine `console.log`-Zeile pro Treffer.
- **Wahrscheinlichkeit:** hoch bei aktiviertem Feature (LLM-Fehlklassifikationen
  sind die Ausgangslage der gesamten Roadmap). **Auswirkung:** systematische,
  schwer rückverfolgbare Fehletikettierung ganzer Dokumentserien.
- **Beleg:** `server.js:452` ruft `recordDocumentFingerprint` unbedingt auf;
  `documentFingerprintStore._createTables()` kennt keine Bestätigungsspalte;
  Design-Spec Z. 261 räumt „keine automatische Korrektur" ein.
- **Empfohlene Lösung, in absteigender Wirksamkeit:**
  1. Nur Fingerprints speichern, deren Quelldokument einen definierten
     Bestätigungszustand hat — z. B. Dokumente, die der Nutzer in Paperless
     nachträglich nicht verändert hat, oder ein explizites „als Serie
     bestätigen" in der UI.
  2. Ein Herkunftsfeld (`source: 'llm' | 'inherited' | 'confirmed'`) einführen
     und `inherited`-Einträge **nicht** als Kandidaten zulassen. Das bricht
     den Kreis mit minimalem Aufwand.
  3. Bis dahin: Roadmap und `.env.example` korrigieren, damit die Zusage nicht
     stärker ist als der Code.
- **Empfohlene Tests:** „Treffer geerbt → neuer Fingerprint wird nicht als
  Kandidat für ein drittes Dokument verwendet"; „Fingerprint wird nicht
  gespeichert, wenn `updateDocument` fehlgeschlagen ist".

### AUDIT-004 — Dokument gilt als verarbeitet, obwohl der Paperless-Schreibvorgang fehlschlug

- **Schweregrad:** High · **Priorität:** P1 · **Bereich:** Datenintegrität / Wiederanlauf
- **Dateien:** `server.js:395-410` (`saveDocumentChanges`), `services/paperlessService.js:1515-1602` (`updateDocument`)
- **Beobachtetes Verhalten:** `updateDocument()` fängt jeden Fehler ab, loggt
  ihn und gibt `null` zurück. `saveDocumentChanges()` startet
  `updateDocument`, `addProcessedDocument`, `addOpenAIMetrics`, `addToHistory`
  und `saveOriginalData` gemeinsam in einem `Promise.all` und wertet das
  Ergebnis von `updateDocument` nicht aus. Schlägt der PATCH fehl (400, 404,
  Timeout, Paperless nicht erreichbar), wird das Dokument trotzdem als
  verarbeitet markiert und in die History geschrieben.
- **Erwartetes Verhalten:** Ein fehlgeschlagener Schreibvorgang darf das
  Dokument nicht als erledigt markieren; der nächste Scan muss es erneut
  aufgreifen.
- **Technische Ursache:** Fehlerschluckung in `updateDocument` plus
  Parallelausführung statt Sequenz mit Erfolgsprüfung.
- **Risikoszenario:** Paperless ist während eines Scans 30 Sekunden nicht
  erreichbar. Alle in diesem Fenster verarbeiteten Dokumente sind für den
  LLM-Aufruf bezahlt, in der History vermerkt, in Paperless aber unverändert
  — und werden nie wieder angefasst, weil `isDocumentProcessed()` sie
  überspringt. Mit aktiviertem Fingerprint kommt hinzu, dass für diese
  Dokumente ein Fingerprint gespeichert wird, dessen Tag-IDs im echten
  Dokument nie angekommen sind.
- **Wahrscheinlichkeit:** mittel bis hoch über die Betriebsdauer.
  **Auswirkung:** stiller Datenverlust bezogen auf die Klassifikationsarbeit.
- **Beleg:** `paperlessService.js:1597-1601` `catch { ...; return null; }`;
  `server.js:398-409` `Promise.all([...])` ohne Auswertung.
- **Empfohlene Lösung:** `updateDocument` soll werfen oder ein Statusobjekt
  liefern; `saveDocumentChanges` erst nach bestätigtem PATCH
  `addProcessedDocument`/`addToHistory`/`recordFingerprint` aufrufen.
- **Empfohlene Tests:** „PATCH wirft → `addProcessedDocument` wird nicht
  aufgerufen, `setProcessingStatus` bleibt auf Fehler".

### AUDIT-005 — `mergeEntity` mit `fromId = null` würde alle Dokumente massenhaft ändern

- **Schweregrad:** High · **Priorität:** P0 · **Bereich:** Merge / Paperless-Datenintegrität
- **Dateien:** `services/paperlessService.js:1360-1434`, `services/reviewQueueService.js:19-38`, `models/entityStore.js:41` (`proposed_id INTEGER`, nullable)
- **Beobachtetes Verhalten:** `reviewQueueService.merge(id)` reicht
  `entry.proposed_id` ungeprüft als `fromId` an `mergeEntity` weiter.
  `proposed_id` ist im Schema **nullable**, und `routes/review.js:62` weist im
  Kommentar selbst darauf hin. Ist der Wert `null`, entfernt axios den
  Filterparameter vollständig aus der URL — verifiziert:

  ```
  axios.getUri({url:'/documents/', params:{tags__id:null, page:1, page_size:100}})
    -> /documents/?page=1&page_size=100
  ```

  `_findDocumentsWithEntity()` liefert dann **alle Dokumente des Archivs**, und
  `_bulkReassignDocuments()` schickt für sie alle ein `bulk_edit` mit
  `add_tags: [toId]` bzw. `set_correspondent: toId`.
- **Erwartetes Verhalten:** Ein Merge ohne gültige Quell-ID muss abgelehnt
  werden, bevor irgendein Request gestellt wird.
- **Technische Ursache:** Fehlende Validierung von `fromId`/`toId` in
  `mergeEntity` in Kombination mit der stillen Parameterunterdrückung durch
  axios.
- **Risikoszenario:** Ein einziger Klick auf „Merge" bei einem Queue-Eintrag
  ohne `proposed_id` setzt bei allen Dokumenten den Zielkorrespondenten bzw.
  hängt allen Dokumenten den Ziel-Tag an. Die anschließende Verifikation
  („nichts zeigt mehr auf `fromId`") schlägt in diesem Fall an, weil die
  Prüfabfrage denselben leeren Filter verwendet und weiterhin alle Dokumente
  zurückgibt — die Löschung unterbleibt also, die Massenänderung ist aber
  bereits geschrieben und nicht rückgängig zu machen.
- **Wahrscheinlichkeit:** **aktuell niedrig** — die Live-Datenbank enthält
  0 offene Einträge mit `proposed_id IS NULL`, und alle heutigen Schreibpfade
  (`recordCreatedAndQueued`, Backfill) setzen die ID. Erreichbar bleibt der
  Zustand, wenn Paperless beim Anlegen eines Korrespondenten oder
  Dokumenttyps eine Antwort ohne `id` liefert (`getOrCreateCorrespondent`
  prüft dort nicht, anders als `processTags`), oder wenn ein
  `ON CONFLICT DO UPDATE` `proposed_id = excluded.proposed_id` auf `NULL`
  setzt. **Auswirkung: katastrophal.**
- **Beleg:** siehe axios-Verifikation oben; `paperlessService.js:1376-1378`
  übergibt `[filterField]: id` ohne Prüfung; `paperlessService.js:1188` und
  `:1293` rufen `_recordEntityQueue` ohne `id`-Guard auf (im Unterschied zu
  `:484`).
- **Empfohlene Lösung:** Am Anfang von `mergeEntity` harte Prüfung:
  `Number.isInteger(fromId) && fromId > 0 && Number.isInteger(toId) && toId > 0
  && fromId !== toId`, sonst werfen. Zusätzlich Guard in
  `reviewQueueService.merge/previewMerge` und in `_findDocumentsWithEntity`.
- **Empfohlene Tests:** „`merge` auf Eintrag mit `proposed_id = null` wirft und
  stellt keinen einzigen HTTP-Request"; „`fromId === toId` wirft".

### AUDIT-006 — Fingerprint schreibt veraltete Tag-/Dokumenttyp-IDs ungeprüft zurück

- **Schweregrad:** High · **Priorität:** P0 · **Bereich:** Phase 5 / Paperless-Integration
- **Dateien:** `server.js:74-79`, `services/documentFingerprintService.js:68`, `models/documentFingerprintStore.js` (kein Löschpfad)
- **Beobachtetes Verhalten:** Ein Fingerprint speichert rohe Paperless-IDs
  (`tag_ids`, `document_type_id`). Beim Treffer werden diese IDs direkt in
  `updateData` gesetzt und an den PATCH weitergereicht. Es gibt keine Prüfung,
  ob die IDs noch existieren, und keinen Pfad, der Fingerprints löscht oder
  invalidiert, wenn ein Tag, eine Dokumentart oder ein Dokument in Paperless
  entfernt wird — auch der eigene Merge-Pfad (`mergeEntity`) räumt sie nicht auf.
- **Erwartetes Verhalten:** Übernommene IDs werden gegen den aktuellen
  Bestand validiert; unbekannte IDs werden verworfen, nicht gesendet.
- **Technische Ursache:** Fehlende Referenzintegrität zwischen einer lokalen
  SQLite-Tabelle und einem entfernten System, das die Wahrheit hält.
- **Risikoszenario:** Ein Tag wird in Paperless gelöscht oder über die
  Review-Queue in eine andere Entität gemergt. Ein Fingerprint zeigt weiterhin
  darauf. Beim nächsten Treffer antwortet Paperless mit HTTP 400 auf den PATCH.
  Zusammen mit AUDIT-004 heißt das: **das Dokument bekommt gar keine
  Aktualisierung** — nicht nur der Tag fehlt, sondern auch Titel, Datum,
  Korrespondent und Dokumentart —, und es gilt trotzdem als verarbeitet.
- **Wahrscheinlichkeit:** hoch, sobald Fingerprint und Merge gemeinsam genutzt
  werden. **Auswirkung:** vollständiger Verlust der Klassifikation für
  betroffene Dokumente, ohne Fehlermeldung an den Nutzer.
- **Beleg:** kein `deleteFingerprint`, kein `DELETE FROM document_fingerprints`
  im Repository; `mergeEntity` fasst nur `entity_aliases`/`entity_review_queue` an.
- **Empfohlene Lösung:** Vor dem Setzen gegen `tagCache`/`documentTypeCache`
  filtern; `mergeEntity` und ein periodischer Abgleich sollten betroffene
  Fingerprint-Zeilen aktualisieren oder löschen.
- **Empfohlene Tests:** „Treffer mit einer nicht mehr existierenden Tag-ID →
  ID wird verworfen, PATCH enthält sie nicht"; „nach Merge zeigt kein
  Fingerprint mehr auf die gelöschte ID".

### AUDIT-007 — Judge und Embedding-Kanal sind fest an Ollama gebunden, unabhängig vom konfigurierten Provider

- **Schweregrad:** High · **Priorität:** P1 · **Bereich:** LLM-Provider / Resolver
- **Dateien:** `services/entityJudge.js:27-38`, `services/entityEmbeddingService.js:11-14`, `config/config.js:170-172`
- **Beobachtetes Verhalten:** `entityJudge.judge()` postet unbedingt an
  `${config.ollama.apiUrl}/api/generate` mit `config.ollama.model`.
  `entityEmbeddingService.embed()` postet unbedingt an
  `${config.embedding.apiUrl}/api/embed`, wobei `config.embedding.apiUrl` fest
  aus `OLLAMA_API_URL` (Default `http://localhost:11434`) stammt. `AI_PROVIDER`
  wird an beiden Stellen ignoriert.
- **Erwartetes Verhalten:** Entweder folgen beide dem konfigurierten Provider,
  oder die Abhängigkeit von einer erreichbaren Ollama-Instanz wird beim
  Aktivieren geprüft und dokumentiert.
- **Technische Ursache:** Beide Dienste wurden für den Ollama-Fall gebaut; die
  Provider-Abstraktion (`aiServiceFactory`) wurde nicht mitgenutzt.
- **Risikoszenario:** Eine Installation mit `AI_PROVIDER=openai` (oder
  `azure`/`custom`) und `ENTITY_RESOLVER_ENABLED=yes` hat typischerweise kein
  Ollama. Jeder Judge-Call läuft in `ECONNREFUSED`, `_askJudge()` wertet das
  korrekt als `unsure` — mit der Folge, dass **jedes** Paar in der Judge-Zone
  zu `create_and_queue` führt. Die Review-Queue füllt sich mit Einträgen, die
  nie beurteilt wurden, und der Resolver liefert faktisch das Verhalten von
  vorher plus Rauschen. Der Embedding-Kanal ist in derselben Konstellation
  komplett wirkungslos, meldet das aber nur als `console.warn` pro Entität.
- **Wahrscheinlichkeit:** hoch für Nicht-Ollama-Installationen; **für diese
  Installation nicht relevant** (`AI_PROVIDER` ist Ollama).
  **Auswirkung:** Feature ohne Wirkung, Queue-Flut, verdeckt durch
  Fail-Open-Verhalten.
- **Beleg:** `entityJudge.js:27`, `entityEmbeddingService.js:11`,
  `config.js:171` (`apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434'`).
- **Empfohlene Lösung:** Beim Aktivieren einen Startup-Check gegen
  `/api/ps` bzw. `/api/embed` ausführen und bei Fehlschlag laut und einmalig
  warnen — oder Judge/Embedding über `aiServiceFactory` provider-fähig machen.
- **Empfohlene Tests:** „Provider ist openai und Ollama nicht erreichbar →
  Resolver protokolliert genau eine deutliche Warnung, nicht eine pro Entität".

### AUDIT-008 — Determinismus wirkt nur im Ollama-Pfad

- **Schweregrad:** High · **Priorität:** P1 · **Bereich:** Phase 1 / Determinismus
- **Dateien:** `services/openaiService.js:191, 315`; `services/azureService.js:182, 306`; `services/customService.js:194, 322`; zum Vergleich `services/ollamaService.js:476-483`
- **Beobachtetes Verhalten:** Ollama erhält `temperature: config.ollama.temperature`
  (Default 0), `seed: config.ollama.seed` (Default 42), `top_p: 1`.
  OpenAI, Azure und Custom erhalten hartkodiert `temperature: 0.3` und
  **keinen** `seed`, obwohl die OpenAI-Chat-Completions-API `seed` unterstützt.
- **Erwartetes Verhalten:** Klassifikation ist eine Etikettieraufgabe; dieselbe
  Eingabe soll bei jedem Provider dieselbe Ausgabe liefern.
- **Technische Ursache:** Phase 1 war laut Roadmap ausdrücklich auf
  `ollamaService.js` beschränkt. Die Zusage „Sampling deterministisch" wird in
  Roadmap und Auftrag aber providerunabhängig formuliert.
- **Risikoszenario:** Ein Wechsel von Ollama auf OpenAI hebt die gesamte
  Phase-1-Wirkung auf. Die Varianz kehrt zurück, die Ursache ist von außen nicht
  erkennbar, und der EntityResolver muss sie am Ausgang auffangen — mit
  entsprechend mehr Aliassen, Judge-Calls und Queue-Einträgen.
- **Wahrscheinlichkeit:** hoch bei Providerwechsel. **Auswirkung:** Verlust der
  Phase-1-Ergebnisse ohne Warnung.
- **Beleg:** `grep -n "temperature" services/*.js`.
- **Empfohlene Lösung:** `temperature`/`seed` aus einer providerneutralen
  Konfiguration speisen; für OpenAI `seed` mitsenden; `temperature: 0.3` als
  Default entfernen.
- **Empfohlene Tests:** je Provider ein Test, der die gesendeten
  Sampling-Parameter pinnt (analog `test/ollamaOptions.test.js`).

---

## 9. Weitere Findings nach Schweregrad

### Medium

#### AUDIT-009 — Dashboard öffnet `data/entities.db`, auch wenn der Resolver deaktiviert ist
`routes/setup.js:2665` ruft für jede Dashboard-Ansicht
`paperlessService.getOpenReviewQueueCount()` auf. Diese Methode
(`paperlessService.js:183-190`) prüft `config.entityResolver.enabled`
**nicht**, sondern ruft direkt `_getEntityResolver()` — und der konstruiert
`new EntityStore(config.entityResolver.dbPath)`, legt bei Bedarf das
Verzeichnis an, öffnet die Datei, aktiviert WAL und führt vier
`CREATE TABLE IF NOT EXISTS` plus zwei `ALTER TABLE`-Prüfungen aus. Damit ist
die Aussage „bei deaktiviertem Flag wird kein neuer Codepfad betreten" für den
Resolver **nicht** vollständig zutreffend: eine Installation, die den Resolver
nie einschaltet, bekommt trotzdem `data/entities.db` samt Schema angelegt,
ausgelöst durch einen unauthentifizierten `GET /dashboard`.
*Empfehlung:* frühes `if (!config.entityResolver.enabled) return 0;`.
*Test:* „Resolver deaktiviert → `getOpenReviewQueueCount()` konstruiert keinen
Store".

#### AUDIT-010 — Der Fingerprint verhindert keine Entitätsvermehrung, weil er zu spät läuft
`applyDocumentFingerprint()` wird **nach** `buildUpdateData()` aufgerufen. Zu
diesem Zeitpunkt haben `processTags()`, `getOrCreateDocumentType()` und
`getOrCreateCorrespondent()` alle vom Modell vorgeschlagenen Entitäten in
Paperless bereits **angelegt** (`createTagSafely`, `POST /document_types/`,
`POST /correspondents/`). Der Fingerprint überschreibt anschließend nur noch
`updateData.tags` und `updateData.document_type` — die neu angelegten Tags
bleiben als verwaiste Entitäten in Paperless zurück, ohne je einem Dokument
zugeordnet zu werden. Das Feature stabilisiert also die *Zuordnung*, nicht den
*Bestand*, und arbeitet damit dem Kernziel der Roadmap teilweise entgegen.
*Empfehlung:* Fingerprint-Check vor `buildUpdateData` ziehen und bei Treffer
die Tag-/Dokumenttyp-Erzeugung überspringen. *Test:* „Fingerprint-Treffer →
`createTagSafely` wird nicht aufgerufen".

#### AUDIT-011 — Gespeicherte Fingerprint-Tags weichen von den tatsächlichen Dokument-Tags ab
`server.js:449` friert `fingerprintTagIds = updateData.tags` **vor**
`saveDocumentChanges()` ein. `updateDocument()` vereinigt danach
(`paperlessService.js:1527`) diese Liste mit den bereits vorhandenen Tags des
Dokuments. Das Dokument trägt anschließend `bestehende ∪ neue` Tags, der
Fingerprint speichert nur `neue`. Ein späterer Treffer vererbt damit eine
Teilmenge dessen, was das Quelldokument wirklich hat — die „Serienerinnerung"
driftet systematisch von der Realität ab. Das Einfrieren ist bewusst und im
Code begründet (Schutz gegen die In-place-Mutation), löst aber nur die halbe
Frage. *Empfehlung:* das Ergebnis von `updateDocument()` (es liefert das frisch
geladene Dokument zurück) als Quelle für den Fingerprint nutzen.

#### AUDIT-012 — Negativ-Cache ist richtungsabhängig
`entity_review_queue` hat `UNIQUE(entity_type, proposed_normalized,
candidate_normalized)`, und `findRejectedPair()` sucht genau in dieser
Reihenfolge. Das Paar (A→B) und (B→A) sind zwei verschiedene Zeilen. Der
Altbestands-Scan legt die Richtung nach ID fest (`entityBackfillService.js:40`,
kleinere ID = Kandidat), der Live-Resolver dagegen nach der Rolle (LLM-Vorschlag
= proposed). Ein „Not a duplicate" aus dem Backfill unterdrückt deshalb einen
späteren Live-Treffer in der Gegenrichtung nicht — der Nutzer wird dieselbe
Entscheidung erneut vorgelegt bekommen, und im Auto-Merge-Band
(`trigram >= 0.90`) wird sie sogar ohne Rückfrage übergangen.
*Empfehlung:* `findRejectedPair` symmetrisch abfragen oder das Paar kanonisch
sortiert speichern. *Test:* „Reject für (B,A) verhindert Auto-Merge für (A,B)".

#### AUDIT-013 — Dry-Run und echter Merge sind zwei getrennte Zeitpunkte, `bulk_edit` ist ungechunkt
`previewMerge()` und `merge()` rufen jeweils `_findDocumentsWithEntity()` neu
auf. Der Bestätigungsdialog zeigt also den Stand von T1, ausgeführt wird auf dem
Stand von T2. Das ist die sichere Richtung (es wird auf dem Ist-Zustand
gearbeitet), aber die Entscheidungsgrundlage des Nutzers ist nicht die, auf der
gehandelt wird. Zusätzlich schickt `_bulkReassignDocuments()` **alle**
betroffenen Dokument-IDs in einem einzigen POST — bei einem Tag mit mehreren
tausend Dokumenten ist das eine sehr große Anfrage ohne Teilfortschritt; bricht
sie ab, ist unbekannt, wie viele Dokumente umgehängt wurden (die
Verifikationsabfrage fängt das ab und verhindert das Löschen, der Zustand ist
danach aber teil-migriert). Es gibt keine Wiederaufnahme und keine
Merge-Historie über den Queue-Status hinaus.
*Empfehlung:* Preview-Ergebnis (Dokument-IDs) an den echten Merge übergeben und
serverseitig gegen den aktuellen Stand abgleichen; `bulk_edit` in Blöcken zu
z. B. 100 IDs senden; Merge-Ergebnis persistieren.

#### AUDIT-014 — Vierfache Duplizierung der Fingerprint-Verdrahtung, zweite Serviceinstanz, fehlender Nebenläufigkeitsschutz
Der identische Block aus `applyDocumentFingerprint` / `fingerprintTagIds` /
`saveDocumentChanges` / `recordDocumentFingerprint` steht viermal wortgleich:
`server.js:441-452`, `server.js:493-504`, `routes/setup.js:1531-1542`,
`routes/setup.js:2456-2469`. `getDocumentFingerprintService()` existiert
ebenfalls zweimal (`server.js:45`, `routes/setup.js:2353`) und erzeugt damit
**zwei** Service-Singletons, zwei SQLite-Verbindungen auf dieselbe Datei und
zwei unabhängige Ein-Slot-Memo-Caches. Verschärfend: `POST /api/scan/now`
(`routes/setup.js:1493`) hat **keinen** Nebenläufigkeitsschutz — die Zeile
`runningTask = false` in Zeile 1550 referenziert eine in diesem Modul gar nicht
deklarierte Variable (ESLint: `'runningTask' is not defined`) und legt im
Non-Strict-CommonJS eine wirkungslose globale Variable an. Der Guard in
`server.js:463` schützt nur `scanDocuments()`. Ein Klick auf „Scan now" während
des Cron-Laufs startet also eine zweite vollständige Verarbeitungsschleife über
dieselben Dokumente.
*Empfehlung:* Verdrahtung in ein Modul ziehen, einen gemeinsamen
prozessweiten Lauf-Guard einführen.

#### AUDIT-015 — Keine Transaktionen, alle DB-Fehler werden geschluckt
Weder `entityStore` noch `documentFingerprintStore` verwenden
`db.transaction()` (`grep` über beide Dateien: kein Treffer). Jede Methode
fängt Fehler ab, loggt sie und liefert `false`/`null`/`[]`/`0`. Die Aufrufer
werten diese Rückgaben **nicht** aus: `entityResolver.js:103` und `:117`
ignorieren das Ergebnis von `insertAlias`, `:164` das von `insertQueueEntry`.
Konkrete Folge: Schlägt der Alias-Schreibvorgang fehl (Platte voll, DB
gesperrt), meldet der Resolver dennoch `action: 'map'` — die Zuordnung wird
angewendet, aber nie gelernt, und der nächste Lauf wiederholt Trigram-Vergleich
und ggf. Judge-Call. Bei `recordCreatedAndQueued` bedeutet ein stiller
Fehlschlag, dass eine neu angelegte Entität *nie* zur Prüfung erscheint.
Der Zustand ist zwischen Paperless (Entität angelegt) und SQLite (kein
Queue-Eintrag) dauerhaft inkonsistent.
*Empfehlung:* Rückgabewerte auswerten und bei `false` mindestens eine
`console.error`-Meldung mit Handlungshinweis erzeugen; zusammengehörige
Schreibvorgänge (Alias + Queue-Status beim Merge) in eine Transaktion fassen.

#### AUDIT-016 — Rechtsform-Stripping kann Korrespondenten fälschlich zusammenziehen
`LEGAL_FORM_TOKENS` (`entityNormalizer.js:25-28`) enthält unter anderem `co`,
`se`, `sa`, `ag`, `bv`, `inc`. Diese Tokens werden bei Korrespondenten
**positionsunabhängig** entfernt. Beispiele mit realem Kollisionspotenzial:
„AG Nürnberg" (Amtsgericht) → `nuernberg`; „SE Bank" → `bank`; „Co-Working
Nord" normalisiert über die Interpunktionsregel zu `co working nord` → wird zu
`working nord`. Zwei unterschiedliche Korrespondenten können so nach der
Normalisierung identisch werden und in Stufe 3 **ohne Judge und ohne
Review-Queue** automatisch zusammengelegt werden — Stufe 3 schreibt direkt
einen Alias. Der Fallback („besteht der Name nur aus Rechtsformen, ungestrippt
zurückgeben") fängt nur den Totalausfall ab, nicht die Teilkollision.
*Empfehlung:* Stripping auf die letzte Tokenposition beschränken und
`se`/`sa`/`co`/`ag` nur dann entfernen, wenn ein weiteres Nicht-Rechtsform-Token
mit mindestens 3 Zeichen verbleibt. *Test:* „AG Nürnberg" vs. „Nürnberg" →
kein Auto-Match.

#### AUDIT-017 — Vorprüfung auf existierende Entitäten sieht nur die erste Ergebnisseite
`searchForExistingCorrespondent()` (`paperlessService.js:1105`) und
`searchForExistingDocumentType()` (`:1221`) fragen mit `name__icontains` ab und
durchsuchen ausschließlich `response.data.results` der **ersten** Seite
(Paperless-Default 25 Einträge). Bei einem generischen Teilstring — etwa
„Versicherung" bei 40 Versicherungs-Korrespondenten — kann der exakte Treffer
jenseits von Seite 1 liegen und wird nicht gefunden. Die Kaskade läuft dann auf
`create` bzw. auf einen Ähnlichkeitstreffer, und es entsteht ein Duplikat genau
der Art, die die Roadmap beseitigen soll. Der EntityResolver mildert das ab
(Stufe 2 arbeitet auf dem vollständigen Cache), greift aber erst, wenn die
Vorprüfung nichts gefunden hat — und ist per Default aus.
*Empfehlung:* `name__iexact` verwenden (wie bei `findExistingTag`) oder
paginieren.

#### AUDIT-018 — Dokumentinhalte und Bestandslisten werden im Klartext protokolliert
`serviceUtils.writePromptToFile()` hängt bei **jeder** Analyse System-Prompt,
vollständigen Dokumententext und die geparste Antwort an `./logs/prompt.txt`
an, bis 10 MB erreicht sind. Der System-Prompt enthält bei
`USE_EXISTING_DATA=yes` (heute aktiv) die kompletten Korrespondentennamen — laut
Roadmap Z. 83-85 darunter Klarnamen und eine Wohnanschrift. `logs/*` ist
gitignored, die Datei liegt aber unverschlüsselt im Container-Volume und wird
von keiner Rotation gelöscht, sondern beim Überschreiten der Grenze komplett
entfernt (Sprünge in der Nachvollziehbarkeit). Zusätzlich schreibt
`ollamaService._handleThumbnailCaching()` Dokumentvorschaubilder nach
`./public/images/<id>.png` — in ein **statisch ausgeliefertes Verzeichnis**
(`express.static(path.join(__dirname, 'public'))`), das damit ohne
Authentifizierung abrufbar ist.
*Empfehlung:* Prompt-Logging hinter ein Flag legen (Default aus), Thumbnails
außerhalb von `public/` cachen oder über eine authentifizierte Route ausliefern.

#### AUDIT-019 — Determinismus zwischen Läufen ist strukturell nicht erreichbar
Die Roadmap dokumentiert ehrlich, dass trotz `temperature=0`/`seed=42` noch
4 von 10 Dokumenten instabil sind. Die Codeanalyse liefert dafür drei konkrete,
voneinander unabhängige Ursachen, die kein Sampling-Parameter beheben kann:
1. **Die Bestandslisten im System-Prompt ändern sich zwischen den Läufen.**
   Lauf 1 legt neue Tags/Korrespondenten an; Lauf 2 sieht eine längere Liste,
   also einen anderen Prompt und damit legitim ein anderes Ergebnis. Das ist
   eine Rückkopplung des Systems auf sich selbst.
2. **Die Sortierung ist nicht überall festgelegt.** `getTags()`
   (`paperlessService.js:546`) setzt `ordering: 'name'`.
   `listCorrespondentsNames()` (`:628`) und `listDocumentTypesNames()` (`:673`)
   setzen **kein** `ordering` und verlassen sich auf den Paperless-Default.
3. **`num_ctx` ist promptlängenabhängig** (`_fitPromptToContext`) und ändert
   sich mit den Listen — bei manchen Backends beeinflusst die Kontextgröße das
   Ergebnis auch bei identischem Seed.
Zusätzlich ist zu beachten: `seed` und `temperature` sind Ollama-Optionen,
deren Wirkung vom geladenen Modell und der Ollama-Version abhängt; bei
Batch-/Parallelverarbeitung ist bitweise Reproduzierbarkeit auch bei
`temperature=0` nicht garantiert. **Bewertung:** vollständiger Determinismus
über Läufe hinweg ist mit diesem Design nicht erreichbar und sollte nicht als
Ziel weiterverfolgt werden — der Ausgang (Resolver) ist der richtige Hebel.
*Empfehlung:* `ordering: 'name'` in allen drei Listenabfragen ergänzen; die
Abnahmedefinition von Phase 1 auf „identische Ergebnisse bei identischem
Bestand" präzisieren.

#### AUDIT-020 — Fingerprint-Suche und -Wachstum skalieren linear ohne Bremse
`findCandidates(correspondentId)` lädt **alle** Zeilen des Korrespondenten,
dekodiert jeden BLOB in ein JS-Array (`Array.from(new Float32Array(...))`) und
vergleicht anschließend in JavaScript. Bei `bge-m3` sind das 1024 Floats
à 4 Byte = 4 KB je Zeile. Für einen Korrespondenten mit 2000 Dokumenten
bedeutet jedes neue Dokument: 8 MB Rohdaten lesen, 2000 Arrays à 1024 Elemente
allozieren, 2 Mio. Multiplikationen. Das passiert **je Dokument** im Scan.
Die Tabelle wächst monoton, es gibt keinen Aufräumpfad und keine Obergrenze.
Bei 10 000 Dokumenten ist die Tabelle allein ~40 MB.
Der Altbestands-Scan ist mit O(n²) Paaren ebenfalls quadratisch, aber durch
das Embedding-Prefetch (`entityBackfillService.js:21-31`) korrekt auf
n Ollama-Calls statt n² begrenzt — das ist gut gelöst.
*Empfehlung:* Kandidaten auf die letzten N je Korrespondent begrenzen, Vektoren
als `Float32Array` ohne `Array.from` verarbeiten, Aufräumjob für Fingerprints
gelöschter Dokumente.

#### AUDIT-021 — Neue Konfiguration ist nur in `.env.example` dokumentiert, nicht im UI
Keine der 12 neuen Variablen erscheint in `views/settings.ejs`,
`views/setup.ejs` oder `routes/setup.js`. Sie sind ausschließlich über
manuelles Editieren von `data/.env` setzbar — und werden dort durch AUDIT-002
beim nächsten UI-Speichern gelöscht. `docker-compose.yml` und `README.md`
erwähnen sie nicht. Ein Betreiber, der die Features aktivieren will, hat keinen
unterstützten Weg dorthin und keine Rückmeldung, ob eine Aktivierung greift.
*Empfehlung:* mindestens die drei Enable-Flags und die vier Schwellwerte ins
Settings-UI aufnehmen; das löst gleichzeitig einen Teil von AUDIT-002.

### Low

#### AUDIT-022 — Fehlerhafte Mindestlängenprüfung für Dokumentinhalte
`server.js:267` und `routes/setup.js` (identische Kopien):
`if (!content || !content.length >= 10)`. Der zweite Operand wird als
`(!content.length) >= 10` ausgewertet, also `boolean >= 10`, immer `false`.
Die beabsichtigte Mindestlänge von 10 Zeichen wird nie geprüft; nur komplett
leerer Inhalt wird abgefangen. Für den Fingerprint ist das relevant: ein
Dokument mit 5 Zeichen OCR-Text erzeugt einen Embedding-Vektor auf fast keinem
Inhalt, und solche Vektoren liegen erfahrungsgemäß eng beieinander — ein
prädestinierter False-Positive-Erzeuger.

#### AUDIT-023 — Toter und defekter Code
- `services/manualService.js` (256 Zeilen) hat **keinen einzigen Aufrufer**
  (`grep -rn "manualService"` außerhalb der Datei: 0 Treffer) und enthält
  garantierte Laufzeitfehler: `const parsedResponse` wird in Z. 83 und 131
  neu zugewiesen (`TypeError`), `fs` (Z. 84, 132) und `os` (Z. 195, 196) sind
  nie importiert.
- `paperlessService.getAllDocumentIds()` (Z. 831-853) referenziert eine nicht
  definierte Variable `page` → `ReferenceError` bei jedem Aufruf. Ebenfalls
  ohne Aufrufer.
- `azureService.js:427`: doppelte Klassenmethode `checkStatus` — die erste
  Definition ist unerreichbar.
- `views/manual.ejs.bak` liegt im Repository.

#### AUDIT-024 — Keine Integrationstests für die Verdrahtung, kein Lint-Gate
`server.js` und `routes/setup.js` haben keinerlei Tests. Der Design-Spec zu
Phase 5 begründet das ausdrücklich („die Verdrahtung ist ein einfacher
Sequenzaufruf") — und die Roadmap dokumentiert im selben Atemzug, dass der
Whole-Branch-Review dort **7 Integrationsprobleme** fand, darunter die
In-place-Mutation von `updateData`, die Fingerprints mit falschem
Korrespondenten gespeichert hätte. Damit ist empirisch belegt, dass genau die
ungetestete Stelle die fehlerträchtigste ist. Die CI
(`.github/workflows/test.yml`) führt `npm test` aus, aber **kein** ESLint;
`package.json` hat kein `lint`-Skript. `npx eslint .` meldet 169 Errors,
darunter die realen Defekte aus AUDIT-023 und AUDIT-014.

#### AUDIT-025 — `tune-thresholds.js` unterstützt keinen Fingerprint-Modus
Das Skript wertet ausschließlich Entitäts-**Namenspaare** aus (Trigram-Sweep
und Embedding-Sweep über `data/eval/entity-clusters.json`). Für
`FINGERPRINT_SIMILARITY_THRESHOLD` bräuchte es gelabelte **Dokumentpaare** und
Inhalts-Embeddings mit derselben 3000-Zeichen-Kürzung wie
`documentFingerprintService`. Der als „Folgeschritt" bezeichnete Tuning-Lauf ist
mit dem vorhandenen Werkzeug **nicht durchführbar**; es fehlt Code, nicht nur
eine Messung.

#### AUDIT-026 — Float32-Speicherung und Puffer-Ausrichtung
`_vectorToBuffer` reduziert die von Ollama gelieferten Float64-Werte auf
Float32 (`Float32Array.from`). Für Cosinus-Ähnlichkeit ist der Präzisionsverlust
unkritisch (≈1e-7), aber die Zahlen sind nicht mehr bitidentisch mit dem
Original — ein Vergleich „frisch berechnet vs. aus Cache" liefert minimal
verschiedene Werte, was bei einem Schwellwert exakt an der Kante zu
inkonsistenten Entscheidungen führen kann. Zusätzlich setzt `_bufferToVector`
(`new Float32Array(buffer.buffer, buffer.byteOffset, ...)`) voraus, dass
`byteOffset` ein Vielfaches von 4 ist. Node richtet Pool-Allokationen auf
8 Byte aus, und 4096-Byte-Vektoren werden ohnehin außerhalb des Pools
alloziert — für `bge-m3` ist das also sicher. Für ein Modell mit
Dimension < 1024 (Puffer < 4096 Byte, also Pool-Allokation) bleibt die Annahme
korrekt, aber sie ist nirgends dokumentiert oder abgesichert.

#### AUDIT-027 — Pauschale CORS-Freigabe
`server.js:114-126` setzt zusätzlich zur `cors()`-Middleware manuell
`Access-Control-Allow-Origin: *` und `Access-Control-Allow-Private-Network: true`
für **jede** Antwort. `credentials: false` verhindert, dass Browser bei
CORS-Requests Cookies mitsenden; einfache Requests (Formular-POST, `no-cors`)
senden sie dennoch. In Kombination mit AUDIT-001 (Routen ohne Auth) und der
`SameSite=Lax`-Einstellung des JWT-Cookies (`routes/setup.js:359-364`) ist eine
CSRF-Ausnutzung für `POST` ohne Cookie-Bedarf ohnehin trivial. Es gibt keinen
CSRF-Token-Mechanismus im Projekt.

#### AUDIT-028 — Judge: kein Seed, eigenes Kontextlimit, kein Retry
`entityJudge.js:33-37` setzt `temperature: 0` bewusst fest (gut), aber keinen
`seed`. `num_ctx: 1024` ist hartkodiert; sehr lange Entitätsnamen könnten
theoretisch abgeschnitten werden. Bei Timeout (15 s) oder HTTP-Fehler gibt es
keinen Retry — der Fall wird korrekt als `unsure` gewertet, kostet aber einen
Queue-Eintrag. Bei einer temporär überlasteten Ollama-Instanz entsteht so eine
Welle von Queue-Einträgen, die nach dem Negativ-Cache-Prinzip **nicht** erneut
befragt werden.

#### AUDIT-029 — `similarity` mischt zwei nicht vergleichbare Skalen in einer Spalte
`entity_review_queue.similarity` wird als `Math.max(trigramSim, embeddingSim)`
befüllt (`entityResolver.js:152`, `entityBackfillService.js:69`). Dice-Koeffizient
und Cosinus-Ähnlichkeit liegen nicht auf derselben Skala — der Code sagt das an
anderer Stelle selbst (`entityResolver.js:56-59`) und leitet daraus korrekt ab,
dass die *Entscheidung* je Kanal getrennt fallen muss. Der gespeicherte
Mischwert bleibt trotzdem in der Datenbank und wird für Altzeilen in der
UI angezeigt. Für Auswertungen ist die Spalte damit nicht verwendbar.

#### AUDIT-030 — Review-UI ohne Pagination, Filter oder Sortierung
`listOpenQueueEntries()` lädt alle offenen Einträge (`ORDER BY created_at ASC`),
`views/review.ejs` rendert sie vollständig. Die Live-Datenbank enthält bereits
**120 offene Einträge**. Ein Altbestands-Scan über einen größeren Bestand
erzeugt schnell ein Vielfaches davon; die Seite wird dann unbenutzbar und es
gibt keine Möglichkeit, nach Entitätstyp oder Ähnlichkeit zu priorisieren.
Es fehlt außerdem eine Massenaktion („alle unter Ähnlichkeit X ablehnen").
Auf `entity_review_queue` existiert kein Index auf `status` — bei den aktuellen
Größenordnungen unkritisch.

### Info

#### AUDIT-031 — Testanzahl in der Roadmap veraltet
Roadmap Z. 281 nennt „156/156 Tests grün" (Stand Phase 3). Tatsächlich:
**217/217**. Kein Defekt, aber die Zahl im Auftrag stammt aus derselben
veralteten Quelle.

#### AUDIT-032 — Abweichung zwischen dokumentiertem und tatsächlichem Konfigurationsstand
Zwei Punkte, beide bereits in Abschnitt 1 und 6 belegt:
(a) Resolver und Embedding-Kanal sind in `data/.env` **aktiv**, entgegen der
Angabe im Auftrag; (b) die in Phase 2 gemessenen Schwellwerte sind in
`data/.env` **nicht gesetzt** — es greifen die Code-Defaults 0.90/0.65, also
genau die Werte, die die Roadmap Z. 190-195 als durch Messung widerlegt
bezeichnet. Die Phase-4-Werte (`EMBED_AUTO_THRESHOLD`, `EMBED_JUDGE_MIN` = 0.5,
`EMBEDDING_EXCLUDED_TYPES=tag`) sind dagegen gesetzt. Es ist nicht
rekonstruierbar, ob die Phase-2-Werte nie geschrieben oder durch ein
Settings-Speichern gemäß AUDIT-002 gelöscht wurden.

#### AUDIT-033 — Die letzten Test-Fixes verbessern nur die Isolation
Ausdrücklich geprüft, weil im Auftrag gefragt: `f6d1784` und `8ae3f22`
verbergen **keine** Produktfehler. `configEmbedding.test.js` sichert
`process.env` vor jedem Fall, setzt Leerwerte, leert den `require`-Cache von
`config/config.js` und stellt alles im `finally` wieder her — das ist die
korrekte Reaktion darauf, dass `config.js` beim Laden `data/.env` liest und der
Test sonst vom realen `EMBEDDING_EXCLUDED_TYPES` abhing. `8ae3f22` pinnt zwei
reale Verhaltensweisen zusätzlich fest (inhaltsgebundener Memo-Key,
`model = excluded.model` im `ON CONFLICT`). Beides sind Regressionsbremsen, kein
Kaschieren.

#### AUDIT-034 — Saubere Trennung der Embedding-Zwecke (positiv)
Ausdrücklich geprüft: Es gibt **keine** Vermischung von RAG- und
Entity-/Fingerprint-Embeddings. RAG läuft im separaten Python-Prozess über
`SentenceTransformer` und `chromadb.PersistentClient(path="./data/chromadb")`
(`main.py:20-21, 58, 253-267`). Entity- und Fingerprint-Vektoren liegen in
`data/entities.db` und stammen aus Ollama `/api/embed` mit `bge-m3`. Getrennte
Prozesse, getrennte Modelle, getrennte Speicher, keine gemeinsamen Cache-Keys.
Der Fingerprint-Vergleich filtert zusätzlich hart auf `candidate.model ===
this.model`, sodass auch innerhalb von `entities.db` keine Vektoren
unterschiedlicher Modelle verglichen werden können.

#### AUDIT-035 — Kleinere Abweichungen zwischen Design-Spec und Implementierung
Alle unkritisch, teils Verbesserungen: Vektorspeicherung als BLOB statt
JSON-TEXT (kompakter); `model`-Spalte erst nachträglich ergänzt (korrekt
additiv migriert); Korrespondentenquelle für den Fingerprint ist
`originalData.correspondent || updateData.correspondent` statt nur
`updateData.correspondent` (korrigiert die im Spec übersehene Vorrangregel von
`updateDocument`). Nicht umgesetzt: der in Phase 1 als „Kandidat" notierte
Robustheitsfix für `PAPERLESS_API_URL` ohne `/api`-Suffix — die stille
Totalausfall-Falle aus dem Umgebungscheck vom 1. August besteht fort.

---

## 10. Kompakte Finding-Tabelle

| ID | Schweregrad | Bereich | Kurzbeschreibung | Status |
|---|---|---|---|---|
| AUDIT-001 | Critical | Sicherheit | Schreibende Routen in `routes/setup.js` ohne Authentifizierung | bestätigt |
| AUDIT-002 | Critical | Konfiguration | Settings-Speichern löscht `JWT_SECRET` und alle neuen Variablen aus `data/.env` | bestätigt |
| AUDIT-003 | High | Phase 5 | Fingerprint übernimmt unbestätigte Klassifikationen, Fehler propagieren zirkulär | bestätigt |
| AUDIT-004 | High | Datenintegrität | Dokument gilt als verarbeitet trotz fehlgeschlagenem Paperless-PATCH | bestätigt |
| AUDIT-005 | High | Merge | `mergeEntity` mit `fromId=null` würde alle Dokumente ändern | Mechanismus bestätigt, Erreichbarkeit offen |
| AUDIT-006 | High | Phase 5 | Veraltete Tag-/Dokumenttyp-IDs werden ungeprüft zurückgeschrieben | bestätigt |
| AUDIT-007 | High | LLM-Provider | Judge und Embeddings fest an Ollama gebunden, `AI_PROVIDER` ignoriert | bestätigt |
| AUDIT-008 | High | Determinismus | `temperature=0`/Seed nur im Ollama-Pfad wirksam | bestätigt |
| AUDIT-009 | Medium | Feature-Flags | Dashboard öffnet `entities.db` trotz deaktiviertem Resolver | bestätigt |
| AUDIT-010 | Medium | Phase 5 | Fingerprint läuft zu spät, verhindert keine Entitätsvermehrung | bestätigt |
| AUDIT-011 | Medium | Phase 5 | Gespeicherte Fingerprint-Tags weichen von den echten Dokument-Tags ab | bestätigt |
| AUDIT-012 | Medium | Resolver | Negativ-Cache ist richtungsabhängig | bestätigt |
| AUDIT-013 | Medium | Merge | Dry-Run und echter Merge auf verschiedenen Ständen; `bulk_edit` ungechunkt | bestätigt |
| AUDIT-014 | Medium | Architektur | Vierfache Codeduplizierung, zwei Serviceinstanzen, kein Scan-Guard | bestätigt |
| AUDIT-015 | Medium | Datenbank | Keine Transaktionen, DB-Fehler werden geschluckt und ignoriert | bestätigt |
| AUDIT-016 | Medium | Normalisierung | Rechtsform-Stripping erzeugt Kollisionen (`AG`, `SE`, `CO`, `SA`) | sehr wahrscheinlich |
| AUDIT-017 | Medium | Paperless-API | Entitäts-Vorprüfung liest nur die erste Ergebnisseite | bestätigt |
| AUDIT-018 | Medium | Datenschutz | Dokumentinhalte in `logs/prompt.txt`, Thumbnails unter `public/` | bestätigt |
| AUDIT-019 | Medium | Determinismus | Determinismus zwischen Läufen strukturell nicht erreichbar | bestätigt |
| AUDIT-020 | Medium | Performance | Fingerprint-Suche O(n) je Dokument, unbegrenztes Wachstum | bestätigt |
| AUDIT-021 | Medium | Betrieb | Neue Variablen nicht im Setup-/Settings-UI | bestätigt |
| AUDIT-022 | Low | Robustheit | `!content.length >= 10` prüft nichts | bestätigt |
| AUDIT-023 | Low | Codequalität | Toter und defekter Code (`manualService`, `getAllDocumentIds`, Duplikatmethode) | bestätigt |
| AUDIT-024 | Low | Tests | Keine Tests für die Verdrahtung, kein Lint-Gate in der CI | bestätigt |
| AUDIT-025 | Low | Phase 5 | `tune-thresholds.js` kann den Fingerprint-Schwellwert nicht messen | bestätigt |
| AUDIT-026 | Low | Embeddings | Float32-Präzisionsverlust, undokumentierte Ausrichtungsannahme | bestätigt |
| AUDIT-027 | Low | Sicherheit | Pauschales `Access-Control-Allow-Origin: *`, kein CSRF-Schutz | bestätigt |
| AUDIT-028 | Low | Judge | Kein Seed, hartkodiertes `num_ctx`, kein Retry | bestätigt |
| AUDIT-029 | Low | Datenmodell | `similarity` mischt Dice- und Cosinus-Skala | bestätigt |
| AUDIT-030 | Low | Review-UI | Keine Pagination, Filter, Sortierung oder Massenaktion (120 offene Einträge) | bestätigt |
| AUDIT-031 | Info | Dokumentation | Testanzahl in der Roadmap veraltet (156 vs. 217) | bestätigt |
| AUDIT-032 | Info | Konfiguration | Ist-Zustand weicht vom gemeldeten ab; Phase-2-Schwellwerte nicht gesetzt | bestätigt |
| AUDIT-033 | Info | Tests | Letzte Test-Fixes verbessern nur die Isolation, kaschieren nichts | bestätigt |
| AUDIT-034 | Info | Architektur | RAG- und Entity-/Fingerprint-Embeddings sauber getrennt | positiv bestätigt |
| AUDIT-035 | Info | Dokumentation | Kleinere Abweichungen Design-Spec ↔ Implementierung | bestätigt |

---

## 11. Sicherheit und Datenschutz

| Prüfpunkt | Bewertung |
|---|---|
| Authentifizierung / Session | **mangelhaft** — AUDIT-001, AUDIT-002. JWT ohne Server-seitige Invalidierung; Logout löscht nur das Cookie |
| Autorisierung neuer Routen | **gut** — alle vier Review-Routen und die Review-Seite sind korrekt geschützt (AUDIT-001 betrifft ausschließlich Legacy-Routen) |
| CSRF | **fehlt vollständig** — kein Token, `SameSite=Lax` ist die einzige Schranke (AUDIT-027) |
| XSS | **keine Befunde** — `views/review.ejs` nutzt durchgängig `<%= %>`; `public/js/review.js` baut das DOM ausschließlich über `createElement`/`textContent` |
| SQL-Injection | **keine Befunde** — alle Abfragen in `entityStore`/`documentFingerprintStore` sind parametrisiert; die einzigen Interpolationen (`_ensureColumn`) verwenden hartkodierte Literale |
| Command Injection | **keine Befunde** — kein `exec`/`spawn` in den geprüften Pfaden |
| SSRF | **eingeschränkt** — `EXTERNAL_API_URL`, `OLLAMA_API_URL`, `PAPERLESS_API_URL` und `CUSTOM_BASE_URL` sind frei konfigurierbar und werden ungeprüft angefragt. In Verbindung mit AUDIT-001 (`POST /settings` ohne Auth) ist das ein vollwertiger SSRF-Primitive |
| Path Traversal | **theoretisch** — `_handleThumbnailCaching()` bildet `path.join('./public/images', `${id}.png`)`. Aus `POST /manual/analyze` stammt `id` direkt aus dem Request-Body und wird nicht auf numerisch geprüft. Ein `id` wie `../../data/x` würde außerhalb von `public/images` schreiben. Erreichbar nur über `AI_PROVIDER=ollama` und einen erfolgreichen Thumbnail-Abruf; praktisch begrenzt, aber nicht sauber |
| Unsichere Deserialisierung | **keine Befunde** — nur `JSON.parse` auf eigenen und LLM-Daten, jeweils in `try/catch` |
| Prompt-Injection | **nicht adressiert** — Dokumentinhalt geht als `JSON.stringify(content)` in die User-Hälfte (schwache Trennung), Entitätsnamen gehen roh in den System-Prompt. Ein Dokument oder ein Tagname mit Anweisungstext kann die Klassifikation beeinflussen. Abgemildert dadurch, dass die Ausgabe schemavalidiert ist (`format: schema`) und `_isPlausibleTag`/`_normalizeDocumentDate` nachfiltern. **Beim Fingerprint entfällt diese Abmilderung nicht, weil dort gar kein LLM beteiligt ist** |
| Geheimnisse in Logs | **teilweise** — `config.js` maskiert `PAPERLESS_API_URL` und `PAPERLESS_API_TOKEN` beim Start vorbildlich. Dokumentinhalte und Personennamen landen dagegen ungeschützt in `logs/prompt.txt` (AUDIT-018) |
| Dokumentvorschauen | **exponiert** — Thumbnails unter `public/images/` sind ohne Auth abrufbar |
| Fehlermeldungen | **akzeptabel** — Review-Routen geben `error.message` an den Client (kein Stack); `server.js:637-640` liefert generisch „Something broke!" |
| Abhängigkeiten | nicht geprüft (`npm audit` hätte Netzwerkzugriff bedeutet) — `express@4`, `axios@1.8`, `better-sqlite3@11`, `jsonwebtoken@9` sind aktuelle Hauptversionen |
| Sichere Standardkonfiguration | **gut für die neuen Features** (alle drei Flags `no` im Code), **schlecht im Rahmen** (`JWT_SECRET`-Fallback, keine Auth) |

---

## 12. Datenintegrität und Paperless-Risiken

Bewertung nach der Leitfrage „welche Operation kann bei einem Fehler
inkonsistente Paperless-Daten hinterlassen":

| Operation | Risiko | Bewertung |
|---|---|---|
| Tag/Korrespondent/Dokumentart anlegen | niedrig | 400-Behandlung mit Cache-Refresh und erneuter Suche; Race-Condition-Pfad vorhanden |
| Dokument aktualisieren (`updateDocument`) | **hoch** | Fehler wird geschluckt, Dokument gilt trotzdem als verarbeitet (AUDIT-004) |
| Tags entfernen (`removeUnusedTagsFromDocument`) | mittel | wird nur aus dem unauthentifizierten `/manual/updateDocument` aufgerufen (AUDIT-001) |
| Merge — Dokumente ermitteln | **hoch bei `fromId=null`** | AUDIT-005 |
| Merge — `bulk_edit` | mittel | ungechunkt, kein Teilfortschritt, keine Wiederaufnahme (AUDIT-013) |
| Merge — Verifikation vor dem Löschen | **gut** | Löschen erfolgt nur nach nachweislich leerem `fromId`; 404 wird korrekt als „bereits gelöscht" behandelt |
| Merge — Selbst-Merge (`fromId === toId`) | niedrig | Die Verifikation schlägt an und verhindert die Löschung. Es wird trotzdem ein wirkungsloses `bulk_edit` gesendet, und der Nutzer sieht nur „Merge incomplete" |
| Merge — Ziel später gelöscht | mittel | `bulk_edit` gegen eine nicht existierende `toId` liefert einen Fehler; der Zustand bleibt unverändert. Ein Alias auf die gelöschte ID kann bestehen bleiben — der Resolver verwirft ihn beim nächsten Treffer korrekt (`entityResolver.js:32-35`) |
| Merge — gleichzeitige Vorgänge | mittel | Kein Sperrmechanismus. Zwei parallele Merges auf dieselbe Quelle: der zweite findet 0 Dokumente, löscht und bekommt 404 → wird als Erfolg gewertet. Akzeptabel |
| Alias-Ketten | niedrig | Aliase zeigen immer auf eine konkrete Paperless-ID, nie auf einen anderen Alias — Ketten und Zyklen sind strukturell ausgeschlossen. **Gut gelöst** |
| Doppelte Aliase | ausgeschlossen | `UNIQUE(entity_type, alias_normalized)` mit `ON CONFLICT DO UPDATE` |
| Fingerprint schreibt veraltete IDs | **hoch** | AUDIT-006 |
| Fingerprint überschreibt Tags | mittel | `updateDocument` vereinigt mit den bestehenden Tags — es gehen nie Tags verloren, es kommen nur welche hinzu. Das begrenzt den Schaden eines Fehltreffers erheblich (positiv) |
| Wiederanlauf nach Neustart | mittel | `processing_status` wird auf `processing` gesetzt; ein Absturz dazwischen hinterlässt einen hängenden Status. `isDocumentProcessed()` prüft `processed_documents`, nicht `processing_status`, sodass das Dokument beim nächsten Lauf erneut aufgegriffen wird — das ist das gewünschte Verhalten |
| Idempotenz | überwiegend gegeben | `ON CONFLICT`-Upserts überall; `processTags` dedupliziert; `updateDocument` ist als PATCH idempotent bis auf die Tag-Vereinigung |

**Gesamtbild:** Der destruktive Pfad (Merge) ist mit Verifikation-vor-Löschung
und Dry-Run-Default sorgfältig abgesichert — mit der einen Lücke AUDIT-005.
Das größere Integritätsrisiko liegt nicht im Merge, sondern in der
geschluckten Fehlerbehandlung von `updateDocument` (AUDIT-004) und in den
nicht validierten Fingerprint-IDs (AUDIT-006).

---

## 13. Feature-Flags und Rückwärtskompatibilität

### 13.1 Parsing

`parseEnvBoolean(value, default)` (`config.js:8-11`):

| Eingabe | Ergebnis |
|---|---|
| nicht gesetzt / `''` / `'0'`-als-Leerwert | Default (`'no'` für alle drei neuen Flags) |
| `'yes'`, `'YES'`, `'Yes'`, `'true'`, `'TRUE'`, `'1'` | `'yes'` |
| `'no'`, `'false'`, alles andere | `'no'` |

Das Parsing ist robust, groß-/kleinschreibungsunabhängig und hat einen sicheren
Ausfallwert. Ein Tippfehler wie `ENTITY_RESOLVER_ENABLED=ja` ergibt `no` — fail
safe, aber **ohne Warnung**. Ein Betreiber merkt nicht, dass sein Flag nicht
greift. `parseEnvNumber` behandelt `undefined`, `null`, Leerstring und
nicht-numerische Werte korrekt und fällt jeweils auf den Default zurück.
`clampThreshold` begrenzt auf [0,1] und warnt.

### 13.2 Beweis für unverändertes Verhalten bei deaktivierten Flags

| Flag | Beweisführung |
|---|---|
| `ENTITY_RESOLVER_ENABLED=no` | `_resolveEntity()` (`paperlessService.js:193-204`) gibt **vor** jeder anderen Aktion `{action:'create'}` zurück. Kein Store, kein Judge, kein Embedding-Call. Zusätzlich prüfen `getOrCreateCorrespondent` (`:1162`) und `getOrCreateDocumentType` (`:1270`) das Flag, bevor sie den Cache füllen — dafür existiert ein expliziter Test („KRITISCH: ruft `ensureCorrespondentCache` NICHT auf"). **Ausnahme: AUDIT-009** — `getOpenReviewQueueCount()` umgeht diese Barriere und öffnet die DB |
| `EMBEDDING_SIMILARITY_ENABLED=no` | `_getEntityResolver()` (`:169`) injiziert `embeddingService: null`; `EntityResolver` setzt `this.embeddingEnabled = false` (`entityResolver.js:12`); `embeddingActiveForType` ist immer `false`; `_embeddingSimilarityFor` liefert immer `null`, weil `proposedVector` `null` bleibt. Der Kanal ist vollständig inert. `routes/review.js:24-27` verfährt für den Backfill genauso |
| `DOCUMENT_FINGERPRINT_ENABLED=no` | `applyDocumentFingerprint` und `recordDocumentFingerprint` prüfen das Flag als **erste** Anweisung und kehren zurück. `getDocumentFingerprintService()` wird dadurch nie aufgerufen, der Store nie konstruiert, die Tabelle nie angelegt. **Empirisch bestätigt:** `document_fingerprints` existiert in der Live-`entities.db` nicht, obwohl `entity_aliases` und `entity_review_queue` seit Wochen befüllt werden |

**Fazit:** Für zwei von drei Flags ist die Inertheit vollständig bewiesen, für
den Fingerprint sogar empirisch. Der Resolver hat mit AUDIT-009 eine
Nebenwirkung, die zwar keine Verhaltensänderung der Klassifikation bewirkt,
aber die Zusage „kein neuer Codepfad" verletzt.

### 13.3 Abhängigkeiten zwischen den Flags

| Kombination | Verhalten | Bewertung |
|---|---|---|
| Resolver `no`, Embedding `yes` | Embedding wird nie erreicht (Resolver ist die einzige Nutzung) | still wirkungslos, keine Warnung — **Lücke** |
| Resolver `yes`, Embedding `no` | Trigram-only, exakt Phase-3-Verhalten | korrekt |
| Fingerprint `yes`, Embedding `no` | **funktioniert trotzdem** — `documentFingerprintService` nutzt `entityEmbeddingService` direkt und liest nur `config.embedding.apiUrl`/`.model`, nicht `.enabled` | undokumentierte Abhängigkeit; funktional richtig, aber überraschend |
| Fingerprint `yes`, `bge-m3` nicht gepullt | Jeder `embed()` schlägt fehl → `findMatch` liefert `null`, `recordFingerprint` schreibt nichts. Eine `console.warn` je Dokument | fail safe, aber laut und ohne Startup-Check |
| `EMBED_JUDGE_MIN > EMBED_AUTO_THRESHOLD` | Warnung beim Start, keine Korrektur | korrekt (explizit getestet) |
| Neustart nach Flag-Änderung | **erforderlich** — `config.js` liest `data/.env` nur beim Modul-Load. Das UI meldet nach dem Speichern `restart: true`; für manuell editierte Variablen gibt es keinen Hinweis | dokumentationsbedürftig |

### 13.4 Rückwärtskompatibilität des Schemas

`_ensureColumn()` in beiden Stores prüft per `PRAGMA table_info` und fügt
fehlende Spalten per `ALTER TABLE` hinzu. Das ist idempotent, additiv und
funktioniert auf bestehenden Datenbanken — ein sauberer Migrationsansatz für
ein Projekt ohne Migrationsframework. Verifiziert an der Live-Datenbank: die
in Phase 4 nachgerüsteten Spalten `trigram_similarity` und
`embedding_similarity` sind in `entity_review_queue` vorhanden. Kein
Downgrade-Pfad, aber alle Änderungen sind additiv, sodass eine ältere
Codeversion die Datenbank weiter lesen kann.

---

## 14. Datenbank und Migrationen

| Prüfpunkt | Befund |
|---|---|
| Tabellen | 4 in `entities.db`, 6 in `documents.db`, alle mit `IF NOT EXISTS` |
| Primärschlüssel | überall `INTEGER PRIMARY KEY` (SQLite-Rowid-Alias) |
| Unique Constraints | `entity_aliases(entity_type, alias_normalized)`, `entity_review_queue(entity_type, proposed_normalized, candidate_normalized)`, `entity_embeddings(entity_type, entity_id)`, `document_fingerprints(document_id)` — alle sinnvoll gesetzt |
| Fremdschlüssel | **keine**, auch nicht innerhalb von `entities.db`. `PRAGMA foreign_keys` ist nicht aktiviert. Referenzen zeigen ohnehin auf Paperless-IDs, die SQLite nicht kennt — insofern konsistent |
| Indizes | `idx_document_fingerprints_correspondent` sinnvoll gesetzt. Kein Index auf `entity_review_queue(status)` — bei 121 Zeilen unkritisch |
| `ON CONFLICT`-Logik | Durchgängig `DO UPDATE`. `insertQueueEntry` setzt `resolved_at` per `CASE WHEN excluded.status != 'open'` korrekt nur bei abgeschlossenen Einträgen. `upsertEmbedding` und `upsertFingerprint` aktualisieren die `model`-Spalte mit — das war der Gegenstand von `8ae3f22` und ist korrekt: ohne dieses Feld bliebe nach einem Modellwechsel ein neuer Vektor mit altem Modellnamen stehen |
| Nullability | `proposed_id INTEGER` (nullable) ist die Grundlage von AUDIT-005; `document_type_id` und `model` in `document_fingerprints` sind bewusst nullable (Migration von Altzeilen) |
| Defaultwerte | Keine `DEFAULT`-Klauseln; alle Werte kommen aus dem Code |
| Transaktionen | **keine** (AUDIT-015) |
| Locking | WAL aktiviert; `instances: 1` in PM2; better-sqlite3 ist synchron → im Normalbetrieb keine Konkurrenz. Bis zu vier Verbindungen auf dieselbe Datei sind unschön, aber nicht gefährlich |
| Datenwachstum | `entity_embeddings`: 1 Zeile je Entität (heute 72) — begrenzt. `entity_review_queue`: wächst monoton, keine Archivierung (heute 121). `document_fingerprints`: 1 Zeile à ~4 KB je Dokument, unbegrenzt (AUDIT-020) |
| Bereinigungsstrategien | **keine** für alle drei neuen Tabellen |
| Personenbezogene Daten | `entity_aliases.canonical_name`, `entity_review_queue.proposed_name`/`candidate_name` und `entity_embeddings.entity_name` enthalten Korrespondentennamen im Klartext — laut Roadmap inklusive Klarnamen und Anschrift. `document_fingerprints.content_embedding` ist ein Vektor über bis zu 3000 Zeichen Dokumentinhalt; Embedding-Inversion ist ein bekanntes Forschungsthema, sodass der Vektor **nicht** als anonymisiert gelten sollte. `data/` ist gitignored — korrekt. Eine DSGVO-Löschroutine („Korrespondent X vollständig entfernen") existiert nicht |
| Fehler nur geloggt, vom Aufrufer ignoriert | **11 Fundstellen** — jede `catch`-Klausel in `entityStore.js` und `documentFingerprintStore.js`. Details in AUDIT-015 |

---

## 15. Tests und Testlücken

### 15.1 Gemessener Zustand

```
Tests:        217
Bestanden:    217
Fehlgeschlagen: 0
Übersprungen:   0
Todo:           0
Dauer:        901,98 ms
```

22 Testdateien, `node:test` ohne Framework-Abhängigkeit, ausschließlich
In-Memory-SQLite und Fakes. Die CI (`.github/workflows/test.yml`) führt
`npm test` bei jedem Push auf `main` und bei jedem Pull Request aus.

### 15.2 Was gut abgedeckt ist

- **Resolver-Kaskade** (`entityResolver.test.js`, 440 Zeilen): alle sechs
  Stufen, Alias-ins-Leere, Negativ-Cache in beiden Zweigen, Judge-Fehler,
  ungültige Judge-Antwort, Trigram-Vorrang vor Embedding im Auto-Merge **und**
  in der Judge-Zone, getrennte Cache-Prüfung bei divergierenden Kandidaten.
- **Einhängepunkte** (`entityResolverHookIn.test.js`, 612 Zeilen): für jeden
  der drei Einhängepunkte je ein Fall für deaktiviert / `map` / `skip` /
  `create_and_queue` / werfender Resolver. Der Test „ruft
  `ensureCorrespondentCache` NICHT auf, wenn Resolver deaktiviert" ist genau
  die Art Test, die Regressionen in der Inertheit verhindert.
- **Konfiguration**: drei eigene Dateien für Resolver-, Embedding- und
  Fingerprint-Block, jeweils mit Default-, Clamping- und Warnungsfällen und
  sauberer `process.env`-Isolation.
- **Merge** (`paperlessMergeEntity.test.js`): Dry-Run, echter Merge,
  404-als-Erfolg, „Merge incomplete" bei verbleibenden Referenzen.
- **Normalizer** und **Similarity**: Umlaute, ß, NFKD-Reihenfolge, Interpunktion,
  Rechtsformen, Leerstring-Fallback.

### 15.3 Blinde Flecken

| Lücke | Bewertung |
|---|---|
| **Kein Test für `server.js` und `routes/setup.js`** | Der schwerwiegendste Punkt. Genau hier fand die Phase-5-Fix-Welle 7 Integrationsprobleme. `applyDocumentFingerprint`, `recordDocumentFingerprint`, `buildUpdateData`, `saveDocumentChanges` und die Reihenfolge dieser Aufrufe sind vollständig ungetestet |
| **Keine Fehlerpfadtests für `saveDocumentChanges`** | AUDIT-004 wäre durch einen einzigen Test aufgefallen |
| **Keine Guard-Tests für `mergeEntity`-Argumente** | AUDIT-005: kein Test für `fromId = null`, `fromId === toId`, negative IDs |
| **Keine Race-Condition-Tests** | Zwei parallele Merges, Scan während Cron-Lauf, gleichzeitige Backfill-Läufe — nichts davon getestet. Bei einem einprozessigen, synchronen Store ist das teilweise verständlich, die Nebenläufigkeit auf HTTP-Ebene bleibt aber real |
| **Keine Migrations-/Rückwärtskompatibilitätstests** | `_ensureColumn` ist die kritischste Migrationslogik im Projekt und hat keinen Test „Alt-DB ohne Spalte → nach Konstruktion vorhanden, Daten erhalten" |
| **Kein Test für Modellwechsel-Invalidierung im Live-Pfad** | `getOrComputeEmbedding` prüft `cached.model === config.embedding.model` — es gibt einen Test dafür, aber keinen für den Gesamtfluss „Modell gewechselt → alle 72 Cachezeilen werden neu berechnet, keine Vermischung" |
| **Keine Fingerprint-Fehlzuordnungstests** | Kein Test für: Treffer mit gelöschter Tag-ID, Treffer bei leerem/sehr kurzem Dokument, Treffer bei zwei gleich ähnlichen Kandidaten (Gleichstand), Vererbung über mehrere Generationen |
| **Kein Test für teilweise fehlgeschlagene Merges** | `bulk_edit` schlägt nach der Hälfte fehl — was ist der Zustand? |
| **Kein Test für deaktivierte Flags auf Integrationsebene** | Die Config-Tests prüfen die Defaults, die Hook-in-Tests den Resolver. Für den Fingerprint gibt es **keinen** Test „Flag aus → `getDocumentFingerprintService` wird nie aufgerufen" |
| **Zu stark gemockte Paperless-Integration** | Alle Tests fakern `this.client`. Pagination, `bulk_edit`-Semantik, 400/404-Verhalten und `name__icontains`-Verhalten sind nie gegen eine echte oder simulierte API geprüft — AUDIT-017 konnte deshalb nie auffallen |
| **Keine Coverage-Messung** | siehe Einschränkungen |
| **Kein Lint-Gate** | 169 ESLint-Errors, darunter drei echte Defekte, sind unbemerkt geblieben (AUDIT-024) |

### 15.4 Bewertung der letzten Test-Fixes

Ausdrücklich geprüft, Ergebnis in AUDIT-033: `f6d1784` und `8ae3f22` sind
**reine Testisolation und Regressionsbremsen**, sie kaschieren keinen
Produktfehler. `f6d1784` behebt eine echte Testschwäche (Abhängigkeit vom realen
`EMBEDDING_EXCLUDED_TYPES` in `data/.env`), `8ae3f22` pinnt zwei bewusste
Designentscheidungen fest.

---

## 16. Performance und Skalierbarkeit

Konkrete Codepfade, die mit wachsendem Bestand problematisch werden, nach
Dringlichkeit:

1. **`documentFingerprintStore.findCandidates()` + Vergleichsschleife**
   (`documentFingerprintService.js:36-61`) — O(n) je Dokument über alle
   Fingerprints desselben Korrespondenten, mit vollständiger BLOB-Dekodierung
   in JS-Arrays. Details in AUDIT-020. **Der erste echte Engpass, sobald
   Phase 5 aktiviert wird.**

2. **`entityBackfillService.run()`** — O(n²) Paarvergleiche. Bei 40 Tags sind
   das 780 Paare (heute unkritisch); bei 500 Tags sind es 124 750 Paare mit je
   zwei `normalizeForType`-Aufrufen und einem `diceCoefficient`. Die Route ist
   **synchron** — der Request blockiert bis zum Ende, und Express hat kein
   Timeout dafür. Das Embedding-Prefetch ist dagegen vorbildlich gelöst
   (n Calls statt n²).

3. **`entityResolver.resolve()`** — je Vorschlag eine Schleife über alle
   Bestandsentitäten mit `normalizeForType(entity.name)` bei **jedem** Aufruf,
   ohne Memoisierung. Bei aktiviertem Embedding kommt je Entität ein
   `getOrComputeEmbedding` hinzu (Cachetreffer = eine SQLite-Abfrage, sonst ein
   HTTP-Call). Ein Dokument mit 4 Tags bei 500 Tags im Bestand: 2000
   Normalisierungen und bis zu 2000 SQLite-Abfragen — pro Dokument.

4. **Bestandslisten im Prompt** — `_buildPrompt` fügt alle Tag-,
   Korrespondenten- und Dokumenttypnamen in den System-Prompt ein.
   `_fitPromptToContext` schützt sie korrekt vor der Kürzung, kürzt stattdessen
   den **Dokumententext** und protokolliert bei Bedarf einen expliziten
   `[ERROR]`. Bei 500 Korrespondenten (~8000 Zeichen ≈ 2000 Token) bleiben von
   `OLLAMA_NUM_CTX_MAX=8192` nach Abzug von `num_predict` nur noch wenige
   tausend Token für das Dokument. Die Mechanik ist sauber, die Grenze wird
   aber ohne Gegenmaßnahme erreicht.

5. **`paperlessService.getAllDocuments()`** — lädt alle Dokumente in den
   Speicher, mit `setTimeout(100)` je Seite. Bei 10 000 Dokumenten sind das
   100 Seiten = 10 Sekunden reine Wartezeit plus das Array selbst.

6. **`refreshTagCache` / `CACHE_LIFETIME = 3000`** — der Cache verfällt nach
   3 Sekunden. In einer Verarbeitungsschleife bedeutet das für praktisch
   **jedes** Dokument einen kompletten paginierten Neuabruf aller Tags. Das ist
   der teuerste Einzelposten im laufenden Betrieb und war schon vor dieser
   Roadmap so.

7. **`listOpenQueueEntries()`** — vollständiger Tabellen-Scan ohne Limit;
   bei 120 Zeilen unkritisch, bei 10 000 nach einem großen Backfill nicht mehr
   (AUDIT-030).

8. **Speicherlecks:** keine gefunden. Alle Caches sind größenbeschränkt durch
   den Bestand oder werden geleert; das Ein-Slot-Memo im Fingerprint hält genau
   einen Vektor. `_lastEmbeddedText` hält allerdings dauerhaft bis zu 3000
   Zeichen Dokumenttext im Speicher — vernachlässigbar, aber personenbezogen.

---

## 17. Codequalität und Wartbarkeit

**Stark:**
- Die neuen Module haben klar geschnittene Verantwortlichkeiten: Normalisierung,
  Ähnlichkeit, Kaskade, Persistenz, Judge, Embedding, Backfill und
  Queue-Verwaltung sind jeweils eigene Dateien mit 30-230 Zeilen.
- Dependency Injection durchgängig — jede Klasse nimmt Store, Judge und
  Embedding-Service über den Konstruktor entgegen. Das ist der Grund, warum
  217 Tests in 0,9 s ohne Netzwerk laufen.
- Die Kommentare erklären **Entscheidungen**, nicht Mechanik. Beispiele:
  `entityResolver.js:54-59` (warum Max für die Auswahl, aber getrennte
  Schwellwerte für die Entscheidung), `entityResolver.js:91-96` (warum Trigram
  Vorrang hat), `entityStore.js:75-77` (warum `_ensureColumn` nötig ist),
  `server.js:442-446` (warum die Fingerprint-Werte eingefroren werden). Diese
  Kommentare sind aktuell und passen zum Code.
- Fail-Open ist konsequent: jeder neue Pfad fällt bei Fehlern auf das bisherige
  Verhalten zurück.

**Schwach:**
- **Duplizierung.** Vier identische Fingerprint-Blöcke (AUDIT-014); vier
  fast identische Dokumentverarbeitungsschleifen; vier LLM-Services mit
  weitgehend gleichem `analyzeDocument`; zweimal derselbe
  `next`-URL-Parsing-Block in `paperlessService` (Z. 86-110 und 324-348);
  drei Kopien der Auth-Middleware-Logik (`routes/auth.js` ×2, `protectApiRoute`).
- **`routes/setup.js` mit 4473 Zeilen** vereint Routing, Geschäftslogik,
  Dokumentverarbeitung, Konfigurationsverwaltung und Swagger-Dokumentation.
  Das ist die mit Abstand größte Wartbarkeitshypothek des Projekts.
- **Toter und defekter Code** (AUDIT-023).
- **Globale Zustände:** `paperlessService` ist ein Modul-Singleton mit fünf
  Caches und dem Resolver; `entityJudge` und `entityEmbeddingService` sind
  Singletons, die `config` direkt lesen — das erschwert genau die
  Provider-Erweiterbarkeit, die für AUDIT-007 nötig wäre.
- **Keine Typisierung.** Reines JavaScript ohne JSDoc-Typen in den neuen
  Modulen, obwohl `jsdoc_standards.md` im Repository liegt und ESLint
  `eslint-plugin-jsdoc` konfiguriert hat. Die alten Services haben JSDoc, die
  neuen nicht — inkonsistent.
- **Inkonsistente Sprache:** Kommentare und Logmeldungen der neuen Module sind
  deutsch, die UI ist englisch (bewusst in Phase 3 vereinheitlicht), der
  Legacy-Code mischt beides. Umlaute werden in Logmeldungen als `ae/oe/ue`
  geschrieben — offenbar eine bewusste Encoding-Vorsichtsmaßnahme, aber
  nirgends dokumentiert.
- **Keine TODO/FIXME-Marker** im Code — die offenen Punkte stehen
  ausschließlich in der Roadmap. Das ist sauber, macht sie im Code aber
  unsichtbar.

**Erweiterbarkeit um weitere Embedding-Provider:** derzeit schlecht.
`entityEmbeddingService` ist ein Singleton mit hartkodiertem Ollama-Endpunkt
und `/api/embed`-Antwortformat. Der Resolver konsumiert es aber bereits über
ein Interface (`embed`, `cosineSimilarity`, `getOrComputeEmbedding`) — der
Umbau auf eine Factory analog zu `aiServiceFactory` wäre lokal begrenzt.
`documentFingerprintService` bekommt den Service ebenfalls injiziert. Die
Struktur ist also da, nur die Instanziierung ist fest verdrahtet.

---

## 18. Bewertung des Fingerprint-Schwellwerts

`FINGERPRINT_SIMILARITY_THRESHOLD = 0.90` ist der Wert, gegen den die
Cosinus-Ähnlichkeit zweier `bge-m3`-Embeddings über je bis zu 3000 Zeichen
Dokumentinhalt verglichen wird.

### 18.1 Warum der Wert nicht einfach von Phase 4 übernommen werden kann

Der Wert stammt aus derselben Zahl wie `EMBED_AUTO_THRESHOLD`, misst aber etwas
grundsätzlich anderes:

| | Phase 4 (Entitätsnamen) | Phase 5 (Dokumentinhalt) |
|---|---|---|
| Eingabelänge | 1-5 Wörter | bis 3000 Zeichen |
| Typische Ähnlichkeitsverteilung | breit gestreut, 0.05-0.95 | **stark nach oben verschoben und eng** |
| Absicherung | Judge + Review-Queue | keine |
| Korrigierbarkeit | manuell über die UI | keine |

Der entscheidende Punkt: Bei langen Texten desselben Absenders und desselben
Layouts liegen Embedding-Ähnlichkeiten typischerweise **oberhalb von 0.90**,
und zwar unabhängig davon, ob es sich um dieselbe Dokumentserie handelt. Die
gemeinsamen Bestandteile — Briefkopf, Anschrift, Bankverbindung, Fußzeile,
Rechtsbehelfsbelehrung — dominieren den Vektor, und genau diese Bestandteile
sind bei allen Dokumenten desselben Korrespondenten gleich. Der Kandidatenkreis
ist ohnehin bereits auf `correspondent_id` eingeschränkt, wodurch die
diskriminierende Kraft weiter sinkt. **Die begründete Erwartung ist, dass 0.90
in dieser Konstellation deutlich zu niedrig ist.** Das ist eine Hypothese aus
der Codeanalyse, keine Messung — sie muss geprüft werden.

Verschärfend kommt die 3000-Zeichen-Kürzung hinzu: bei einem typischen
Geschäftsbrief entfallen die ersten 500-800 Zeichen auf Kopf und Anschrift, und
der eigentlich unterscheidende Teil (Positionen, Beträge, Zeitraum) steht
häufig weiter hinten. Die Kürzung schneidet also eher das Unterscheidende weg
als das Gemeinsame.

### 18.2 Mögliche False Positives

Nach Risiko geordnet:

1. **Gleiches Template, anderer Inhalt.** Rechnung über 12 € und Rechnung über
   12 000 € vom selben Absender. Zahlen tragen im Embedding wenig Gewicht.
   *Folge:* falsche Dokumentart und falsche Tags, still angewendet.
2. **Serienbrief vs. individuelle Mitteilung.** Jahresmitteilung und Kündigung
   derselben Versicherung teilen Kopf, Fuß und Rechtstexte.
   *Folge:* eine Kündigung erhält die Tags einer Routinemitteilung — potenziell
   fristrelevant.
3. **Behörden- und Versicherungspost.** Formularbriefe mit hohem Anteil an
   Standardtext (Rechtsbehelfsbelehrung, Datenschutzhinweis) sind die
   risikoreichste Klasse überhaupt.
4. **Sehr kurze oder OCR-arme Dokumente.** Ein Scan mit 40 Zeichen erkanntem
   Text ergibt einen wenig aussagekräftigen Vektor. AUDIT-022 zeigt, dass die
   Mindestlängenprüfung defekt ist, solche Dokumente also durchlaufen.
5. **Mehrseitige Dokumente mit wiederkehrenden Seitenköpfen.** Der wiederholte
   Kopf erhöht das Gewicht der gemeinsamen Bestandteile zusätzlich.
6. **Zwei gleich ähnliche Kandidaten.** `findMatch` nimmt bei
   `similarity > best.similarity` den ersten — bei einem Gleichstand
   entscheidet die SQLite-Zeilenreihenfolge (kein `ORDER BY` in
   `findCandidates`). Die Auswahl ist damit nicht deterministisch spezifiziert.

### 18.3 Mögliche False Negatives

Weit weniger gefährlich, weil die Folge nur „normale LLM-Klassifikation" ist:

- Layoutwechsel des Absenders (neues Briefpapier).
- Stark schwankende OCR-Qualität zwischen Scans.
- Sprachwechsel innerhalb einer Serie.
- Modellwechsel — Kandidaten mit anderem `model` werden korrekt übersprungen,
  wodurch **alle** bestehenden Fingerprints eines Korrespondenten auf einen
  Schlag unbrauchbar werden, bis sie neu aufgebaut sind. Ein Re-Embedding-Pfad
  existiert nicht.

### 18.4 Notwendige Messdaten

Mindestens **60 gelabelte Dokumentpaare** desselben Korrespondenten, verteilt
über die riskanten Klassen:

| Klasse | Label | Mindestanzahl |
|---|---|---|
| Dieselbe Serie, aufeinanderfolgende Perioden (Gehalt Juli/August) | `same` | 15 |
| Dieselbe Serie, weit auseinanderliegende Perioden (2023/2026) | `same` | 10 |
| Gleicher Absender, gleiches Template, **andere** Dokumentart | `different` | 15 |
| Gleicher Absender, Formularbrief vs. individuelle Mitteilung | `different` | 10 |
| Sehr kurze / OCR-arme Dokumente, beide Label | gemischt | 10 |

Ohne die `different`-Paare mit gleichem Template ist die Messung wertlos —
genau sie bestimmen die obere Grenze des Schwellwerts.

### 18.5 Sinnvolle Evaluationsmethodik

1. `scripts/tune-thresholds.js` um einen Fingerprint-Modus erweitern (AUDIT-025):
   Eingabe sind Dokument-ID-Paare mit Label, die Inhalte werden über
   `paperlessService.getDocumentContent()` geholt und **mit derselben
   3000-Zeichen-Kürzung** wie in `documentFingerprintService` eingebettet.
   Jede Abweichung von der Produktionskürzung macht die Messung ungültig.
2. Sweep über 0.80-0.99 in Schritten von 0.01, ausgeben: TP/FP/FN/TN,
   Precision, Recall.
3. **Nach Precision optimieren, nicht nach F1.** Ein False Positive ist hier
   unkorrigierbar und still; ein False Negative kostet nur einen LLM-Aufruf,
   der ohnehin bereits erfolgt ist. Zielgröße: **Precision = 1.00 auf der
   Testmenge**, dann den kleinsten Schwellwert wählen, der das noch erreicht,
   und darauf einen Sicherheitsaufschlag von +0.02 addieren.
4. Die fünf am schwersten trennbaren `different`-Paare namentlich ausgeben —
   analog zum bestehenden „Schwierigste same-Paare"-Block. Diese Paare sind der
   eigentliche Erkenntnisgewinn.
5. Die Messung je Korrespondententyp getrennt betrachten: Arbeitgeber,
   Versicherung, Behörde und Versorger verhalten sich unterschiedlich. Falls
   die Streuung groß ist, ist ein globaler Schwellwert die falsche Bauform und
   es braucht eine Ausschlussliste analog zu `EMBEDDING_EXCLUDED_TYPES`.

### 18.6 Sichere Bedingungen für eine spätere Aktivierung

Alle sechs Punkte müssen erfüllt sein:

1. Messung nach 18.4/18.5 liegt vor, `FINGERPRINT_SIMILARITY_THRESHOLD` ist auf
   den gemessenen Wert gesetzt.
2. AUDIT-003 ist behoben — es gibt einen Begriff von „bestätigt" oder mindestens
   ein Herkunftsfeld, das die zirkuläre Vererbung unterbricht.
3. AUDIT-006 ist behoben — übernommene IDs werden gegen den aktuellen
   Paperless-Bestand validiert.
4. AUDIT-004 ist behoben — ein fehlgeschlagener PATCH markiert das Dokument
   nicht als verarbeitet.
5. Ein Beobachtungsmodus existiert: Treffer werden protokolliert und in der
   Review-Queue oder einer Logdatei sichtbar gemacht, **ohne** angewendet zu
   werden. Mindestens 200 Dokumente in diesem Modus, Trefferquote und
   Stichprobenprüfung dokumentiert.
6. Ein Rückabwicklungspfad existiert: `original_documents` speichert bereits
   Tags, Korrespondent und Titel vor der Änderung — es gibt aber keine Funktion,
   die daraus wiederherstellt. Vor der Aktivierung eines still schreibenden
   Features sollte es sie geben.

**Der Wert wurde im Rahmen dieses Audits nicht geändert.**

---

## 19. Feature-Readiness

### EntityResolver — **Ready with conditions**

*Der Resolver läuft in dieser Installation bereits produktiv.* Die Bewertung
ist daher eher eine Fortführungs- als eine Aktivierungsempfehlung.

**Dafür:** Die Kaskade ist vollständig, sauber getestet (70+ Tests über
Resolver und Einhängepunkte), fail-open bei jedem Fehler, und die
Auswirkungen sind über die Review-Queue sichtbar und über den Merge-Pfad
korrigierbar. Falsch-positive Treffer sind gefährlicher als
falsch-negative — und der Code behandelt sie tatsächlich so: der Negativ-Cache
übersticht die Auto-Merge-Schwelle, der Trigram-Kanal hat Vorrang vor dem
semantischen, und im Zweifel wird angelegt statt zusammengeführt. Aliase können
keine Ketten bilden, und ein Alias ins Leere wird korrekt verworfen.

**Bedingungen:**
1. **`ENTITY_RESOLVER_AUTO_THRESHOLD` und `_JUDGE_MIN` in `data/.env` setzen.**
   Aktuell greifen die geschätzten Defaults 0.90/0.65 — die Werte, die die
   eigene Phase-2-Messung als untauglich ausgewiesen hat. Das ist die
   dringendste Einzelmaßnahme dieses Berichts nach den beiden Critical-Findings.
2. AUDIT-002 beheben, damit die Werte das nächste Settings-Speichern überleben.
3. AUDIT-016 (Rechtsform-Kollisionen) prüfen — Stufe 3 legt ohne Judge und
   ohne Queue-Eintrag einen Alias an.
4. Die 120 offenen Queue-Einträge abarbeiten. Eine ungelesene Queue ist keine
   Absicherung.

### Embedding Similarity — **Ready with conditions**

*Läuft ebenfalls bereits produktiv, mit gemessenen Schwellwerten
(`EMBED_AUTO_THRESHOLD`, `EMBED_JUDGE_MIN` = 0.5) und `EMBEDDING_EXCLUDED_TYPES=tag`.*

**Dafür:** Der Kanal ist strikt additiv. Der Trigram-Vorrang ist an beiden
Entscheidungspunkten explizit implementiert und begründet. Der Cache
invalidiert korrekt bei Namens- und bei Modellwechsel — der `ON CONFLICT`-Fix
aus `8ae3f22` schließt die letzte Lücke dort. Ein nicht erreichbares Ollama
degradiert sauber auf Trigram-only. Vektoren verschiedener Modelle können nicht
verglichen werden.

**Bedingungen:**
1. AUDIT-002 — `EMBEDDING_EXCLUDED_TYPES=tag` ist eine gemessene Erkenntnis und
   geht beim nächsten Settings-Speichern verloren. Das Ergebnis wäre die
   Rückkehr des Tag-Rauschens, das Phase 5 explizit abgestellt hat.
2. AUDIT-007 dokumentieren — der Kanal ist an Ollama gebunden. Für diese
   Installation unkritisch, für die Weitergabe des Forks nicht.
3. Bei wachsendem Bestand die Kosten je Dokument beobachten (Abschnitt 16,
   Punkt 3).

### Document Fingerprint — **Not ready**

**Begründung:** Vier voneinander unabhängige Gründe, von denen jeder einzelne
ausreicht:

1. **Der Schwellwert ist ungemessen** und mit begründeter Erwartung zu niedrig
   (Abschnitt 18.1). Das Werkzeug zur Messung existiert nicht (AUDIT-025).
2. **Es gibt keinen Begriff von „bestätigt"** (AUDIT-003). Ein Fehltreffer
   pflanzt sich unbegrenzt fort, ohne dass irgendein Mechanismus ihn stoppt
   oder sichtbar macht.
3. **Übernommene IDs werden nicht validiert** (AUDIT-006). In Verbindung mit
   AUDIT-004 kann ein einzelner gelöschter Tag dazu führen, dass Dokumente
   vollständig unklassifiziert bleiben und trotzdem als verarbeitet gelten.
4. **Es gibt keine Absicherung und keine Rückabwicklung.** Kein Judge, keine
   Review-Queue, kein Dry-Run, kein Beobachtungsmodus, keine
   Wiederherstellungsfunktion. Das ist der **einzige** der drei neuen
   Mechanismen, der still und unkorrigierbar in Produktivdaten schreibt — und
   ausgerechnet er hat als einziger keine Absicherung. Der Design-Spec begründet
   das mit Compute-Ersparnis; das Audit hält diese Abwägung angesichts von
   Punkt 2 und 3 für nicht tragfähig.

Positiv festzuhalten: Der Code selbst ist sauber, der Modellfilter greift, die
Fehlerbehandlung ist dreifach abgesichert, und das Feature ist standardmäßig
aus — die Tabelle existiert in der Live-Datenbank nachweislich nicht. **Die
Entscheidung, es deaktiviert zu lassen, war und ist richtig.**

---

## 20. Priorisierte Maßnahmenliste

### P0 — vor produktiver Aktivierung zwingend

| # | Maßnahme | Findings |
|---|---|---|
| 1 | Authentifizierung für alle schreibenden und konfigurationsanzeigenden Routen in `routes/setup.js` nachrüsten | AUDIT-001 |
| 2 | `saveConfig` auf Read-Modify-Write umstellen; `JWT_SECRET`-Fallback entfernen und Start ohne Secret verweigern | AUDIT-002 |
| 3 | `ENTITY_RESOLVER_AUTO_THRESHOLD` / `_JUDGE_MIN` auf die gemessenen Werte setzen — der Resolver läuft aktuell auf widerlegten Defaults | AUDIT-032 |
| 4 | Argumentprüfung in `mergeEntity` (`fromId`, `toId`: positive Ganzzahlen, ungleich) | AUDIT-005 |
| 5 | `updateDocument`-Fehler an den Aufrufer melden; `addProcessedDocument`/`addToHistory`/`recordFingerprint` erst nach Erfolg | AUDIT-004 |
| 6 | Fingerprint bleibt **aus**, bis 18.6 vollständig erfüllt ist | AUDIT-003, -006, -025 |
| 7 | Übernommene Fingerprint-IDs gegen den aktuellen Paperless-Bestand validieren | AUDIT-006 |

### P1 — kurzfristig

| # | Maßnahme | Findings |
|---|---|---|
| 8 | Zirkuläre Fingerprint-Vererbung unterbrechen (Herkunftsfeld `llm`/`inherited`/`confirmed`) | AUDIT-003 |
| 9 | `getOpenReviewQueueCount()` bei deaktiviertem Resolver früh beenden | AUDIT-009 |
| 10 | Rechtsform-Stripping auf die Endposition beschränken; `se`/`sa`/`co`/`ag` absichern | AUDIT-016 |
| 11 | `name__iexact` statt `name__icontains` in `searchForExistingCorrespondent`/`-DocumentType` | AUDIT-017 |
| 12 | Prompt-Logging hinter ein Flag (Default aus); Thumbnails aus `public/` herausnehmen | AUDIT-018 |
| 13 | Negativ-Cache symmetrisch abfragen | AUDIT-012 |
| 14 | Rückgabewerte der Store-Methoden auswerten statt verwerfen | AUDIT-015 |
| 15 | `temperature`/`seed` providerneutral konfigurieren, für OpenAI `seed` mitsenden | AUDIT-008 |
| 16 | Startup-Check für Ollama-Erreichbarkeit, wenn Resolver oder Embedding aktiv sind | AUDIT-007 |
| 17 | `ordering: 'name'` in `listCorrespondentsNames` und `listDocumentTypesNames` | AUDIT-019 |
| 18 | ESLint als CI-Gate; `lint`-Skript in `package.json`; die drei echten Defekte beheben | AUDIT-023, -024 |
| 19 | Die 120 offenen Queue-Einträge abarbeiten | AUDIT-030 |

### P2 — mittelfristig

| # | Maßnahme | Findings |
|---|---|---|
| 20 | Fingerprint-Verdrahtung in ein gemeinsames Modul; prozessweiter Scan-Guard | AUDIT-014 |
| 21 | `bulk_edit` chunken; Preview-Ergebnis an den echten Merge übergeben; Merge-Historie persistieren | AUDIT-013 |
| 22 | Fingerprint-Suche begrenzen (letzte N je Korrespondent) und Aufräumjob | AUDIT-020 |
| 23 | Neue Variablen ins Settings-UI aufnehmen | AUDIT-021 |
| 24 | Review-UI: Pagination, Filter nach Typ, Sortierung nach Ähnlichkeit, Massenaktion | AUDIT-030 |
| 25 | Integrationstests für `buildUpdateData`/`saveDocumentChanges`/Fingerprint-Verdrahtung | AUDIT-024 |
| 26 | `routes/setup.js` zerlegen (Routing / Dokumentverarbeitung / Konfiguration) | Abschnitt 17 |
| 27 | Transaktionen für zusammengehörige Schreibvorgänge (Merge: Alias + Status) | AUDIT-015 |
| 28 | `CACHE_LIFETIME` erhöhen oder Cache über eine Scan-Schleife hinweg halten | Abschnitt 16 |

### P3 — optional

| # | Maßnahme | Findings |
|---|---|---|
| 29 | `services/manualService.js`, `getAllDocumentIds()`, `views/manual.ejs.bak` entfernen | AUDIT-023 |
| 30 | `similarity`-Spalte in getrennte Kanäle auflösen | AUDIT-029 |
| 31 | Embedding-Provider über eine Factory austauschbar machen | Abschnitt 17 |
| 32 | Judge: `seed` setzen, `num_ctx` aus der Namenslänge ableiten, einmaliger Retry | AUDIT-028 |
| 33 | CSRF-Token für alle POST-Routen; `Access-Control-Allow-Origin` einschränken | AUDIT-027 |
| 34 | `!content.length >= 10` korrigieren und Mindestlänge auch für den Fingerprint erzwingen | AUDIT-022 |
| 35 | Roadmap aktualisieren: Testanzahl, „bestätigte Klassifikation", offener `/api`-Robustheitsfix | AUDIT-031, -003, -035 |
| 36 | JSDoc-Typen für die neuen Module ergänzen (Standard liegt im Repository) | Abschnitt 17 |

---

## 21. Empfohlene zusätzliche Tests

Priorisiert nach Verhältnis von Aufwand zu Erkenntnisgewinn:

**Sicherheitsnetz gegen die schwersten Findings**
1. Für jede Route in `routes/setup.js`: ohne Cookie/Token → 401 oder Redirect.
2. `.env` mit Fremdschlüssel → `saveConfig` mit unverwandtem Feld → Fremdschlüssel
   ist danach noch vorhanden.
3. Serverstart ohne `JWT_SECRET` → verweigert oder warnt laut.
4. `mergeEntity(type, null, 5)` → wirft, stellt keinen einzigen HTTP-Request.
5. `mergeEntity(type, 5, 5)` → wirft.
6. `updateDocument` wirft → `addProcessedDocument` wird **nicht** aufgerufen.

**Fingerprint (Voraussetzung für jede Aktivierung)**
7. Treffer, dessen `tagIds` eine in Paperless nicht mehr existierende ID
   enthalten → ID wird verworfen, PATCH enthält sie nicht.
8. Dokument A → Treffer bei B → C darf B **nicht** als Kandidaten sehen
   (Vererbungskette unterbrochen).
9. Zwei Kandidaten mit exakt gleicher Ähnlichkeit → deterministisch derselbe
   gewinnt (z. B. kleinste `document_id`).
10. Leerer und 20-Zeichen-Inhalt → kein Fingerprint, kein Treffer.
11. `DOCUMENT_FINGERPRINT_ENABLED=no` → `getDocumentFingerprintService()` wird
    nie aufgerufen, `document_fingerprints` wird nicht angelegt.
12. Modellwechsel → alle bestehenden Kandidaten werden übersprungen, keine
    Vermischung.

**Resolver und Merge**
13. Reject für (B,A) verhindert Auto-Merge für (A,B).
14. „AG Nürnberg" vs. „Nürnberg" → kein automatischer Treffer über Stufe 3.
15. `insertAlias` schlägt fehl → Resolver meldet das erkennbar, nicht still.
16. `bulk_edit` wirft nach dem ersten Chunk → `fromId` wird nicht gelöscht,
    Zustand ist beschrieben.
17. Zwei parallele `merge()`-Aufrufe auf dieselbe Queue-ID → genau ein Löschvorgang.

**Migration und Konfiguration**
18. Alt-DB ohne `trigram_similarity`/`model` → nach Konstruktion vorhanden,
    bestehende Zeilen unverändert.
19. Alle drei Flags in allen Schreibweisen (`yes`/`YES`/`true`/`1`/`ja`/leer)
    → erwartetes Boolean, ungültige Werte erzeugen eine Warnung.
20. Provider ist openai und Ollama nicht erreichbar → genau eine deutliche
    Warnung, nicht eine pro Entität.

**Provider**
21. Je Provider ein Test, der die gesendeten Sampling-Parameter pinnt
    (analog `test/ollamaOptions.test.js`, das für Ollama bereits existiert).

---

## 22. Positive Feststellungen

Ausdrücklich und ohne Relativierung:

1. **Die Fail-Open-Architektur ist konsequent durchgezogen.** `_resolveEntity`
   fängt jeden Fehler und liefert `{action:'create'}`. `_askJudge` wertet
   Ausfälle als `unsure`. `_embeddingSimilarityFor` ignoriert unberechenbare
   Vektoren. `applyDocumentFingerprint` und `recordDocumentFingerprint` haben je
   eigene `try/catch`. Kein einziger neuer Pfad kann die Klassifikation zum
   Absturz bringen. Das ist die richtige Grundentscheidung für ein Feature, das
   in einen laufenden Betrieb eingehängt wird.

2. **Der Merge-Pfad ist mit echter Sorgfalt gebaut.** Dokumente ermitteln →
   umhängen → **verifizieren, dass nichts mehr auf die Quelle zeigt** → erst
   dann löschen. `dryRun: true` ist der Parameter-Default, nicht nur die
   UI-Konvention. Ein 404 beim Löschen wird als „bereits erledigt" behandelt
   statt als Sackgasse. Für den einzigen destruktiven Pfad im Projekt ist das
   angemessen.

3. **Die Trigram-vor-Embedding-Vorrangregel ist an beiden Entscheidungspunkten
   implementiert und im Code begründet.** Der Kommentar in
   `entityResolver.js:91-96` erklärt präzise, warum ein semantisch naher
   „false friend" einen sicheren orthografischen Treffer nicht verdrängen darf.
   Das ist genau die Art von Überlegung, die in Ähnlichkeitssystemen sonst
   fehlt — und sie wurde nachträglich als Fix eingearbeitet (`a5ed634`,
   `3432f1d`), also aus einer Beobachtung heraus, nicht aus Theorie.

4. **Zwei Ähnlichkeitsskalen werden nicht vermischt.** Der Code wählt den
   Kandidaten über `max(trigram, embedding)`, entscheidet aber je Kanal gegen
   dessen eigenen Schwellwert — mit expliziter Begründung, dass Dice und
   Cosinus nicht auf derselben Skala liegen. Das ist statistisch korrekt und
   wird häufig falsch gemacht.

5. **Die Embedding-Zwecke sind sauber getrennt** (AUDIT-034). RAG, Entitäten
   und Fingerprints teilen sich weder Modell noch Speicher noch Cache-Key. Der
   Modellfilter im Fingerprint macht eine Vermischung auch innerhalb von
   `entities.db` unmöglich.

6. **Die additive Spaltenmigration `_ensureColumn` ist die richtige Lösung**
   für ein Projekt ohne Migrationsframework: idempotent, per `PRAGMA
   table_info` geprüft, in beiden Stores identisch, und an der Live-Datenbank
   nachweislich funktionierend.

7. **Die Testbasis ist für ein Projekt dieser Größe überdurchschnittlich.**
   217 Tests in 0,9 s ohne Netzwerk und ohne Framework. Der Test „ruft
   `ensureCorrespondentCache` NICHT auf, wenn Resolver deaktiviert ist" zeigt,
   dass die Inertheit bei deaktiviertem Flag als Eigenschaft verstanden und
   abgesichert wurde, nicht nur behauptet.

8. **Die Review-Routen sind die einzigen korrekt abgesicherten Schreibrouten
   im Projekt.** Phase 3 hat die vorhandene, aber ungenutzte Middleware
   gefunden und richtig eingesetzt, statt eine dritte Kopie zu bauen. Die
   Begründung dafür steht in der Roadmap.

9. **Kein XSS in der neuen UI.** EJS-Escaping durchgängig, Client-seitig
   ausschließlich `createElement`/`textContent`. Bei einer Seite, die
   LLM-generierte Entitätsnamen anzeigt, ist das keine Selbstverständlichkeit.

10. **Die Dokumentation ist ungewöhnlich ehrlich.** Roadmap und Design-Specs
    benennen offene Risiken, nicht gemessene Werte und bewusst ausgeschlossene
    Alternativen samt Begründung. Die Phase-5-Notiz „`dry-run-eval.js --repeat 2`
    zeigt weiterhin 4 von 10 Dokumenten instabil" ist ein negatives eigenes
    Messergebnis, das ohne Beschönigung dokumentiert wurde. Der Design-Spec zu
    Phase 5 ist an mehreren Stellen zurückhaltender als die Roadmap-Zusammenfassung
    — die Genauigkeit sitzt also dort, wo entschieden wird.

11. **Die Konfiguration schützt sich gegen unsinnige Werte:** Clamping auf
    [0,1] mit Warnung, Warnung bei unerreichbarer Judge-Zone, Maskierung der
    Paperless-Zugangsdaten in der Startausgabe.

12. **Die Fehlerbehandlung im Fingerprint verhindert Datenverlust in die
    richtige Richtung:** `updateDocument` vereinigt Tags, statt sie zu
    ersetzen. Ein Fingerprint-Fehltreffer kann Tags hinzufügen, aber keine
    entfernen. Das begrenzt den Schaden von AUDIT-003 erheblich und war
    vermutlich nicht einmal Absicht — es ist trotzdem die richtige Eigenschaft.

---

## 23. Abschließendes Gesamturteil

**Die Roadmap ist im Kern eingelöst.** Für alle fünf Phasen existiert
funktionierender, getesteter und in den produktiven Ablauf eingehängter Code.
Die Kernidee — Varianz am Eingang durch Determinismus und am Ausgang durch eine
Resolver-Kaskade zu bekämpfen — ist technisch sauber umgesetzt. Die neuen
Module sind in Zuschnitt, Testbarkeit und Kommentierung deutlich besser als der
Legacy-Bestand, in den sie sich einfügen, und die Entscheidungen dahinter sind
nachvollziehbar dokumentiert.

**Der gemeldete Zustand stimmt in drei Punkten nicht.** Resolver und
Embedding-Kanal sind in der laufenden Installation bereits aktiv, nicht
deaktiviert. Die in Phase 2 gemessenen Schwellwerte sind nicht gesetzt — es
greifen die Defaults, die dieselbe Messung als untauglich ausgewiesen hat. Und
der Fingerprint übernimmt keine „bestätigten" Klassifikationen, weil dieser
Begriff im System nicht existiert. Keine dieser Abweichungen wirkt bösgläubig;
alle drei sind typische Folgen davon, dass Dokumentation und Konfiguration in
schneller Folge auseinanderlaufen. Sie ändern aber die Grundlage, auf der
über eine Aktivierung entschieden wird.

**Zwei Befunde sind ernst und stammen nicht aus dieser Roadmap.** Die fehlende
Authentifizierung nahezu aller schreibenden Routen und das Löschen von
`JWT_SECRET` beim Settings-Speichern sind Legacy-Erblasten des Forks. Sie sind
trotzdem P0, weil sie die sorgfältige Absicherung der neuen Features aushebeln:
Eine Review-Queue nützt nichts, wenn jeder unauthentifiziert Dokumente ändern
kann, und gemessene Schwellwerte nützen nichts, wenn ein Klick auf „Speichern"
sie löscht.

**Der Dokument-Fingerprint sollte deaktiviert bleiben.** Nicht wegen des
ungemessenen Schwellwerts allein — das ist ein bekanntes und offen
kommuniziertes Risiko —, sondern weil er der einzige der drei Mechanismen ist,
der still, unkorrigierbar und selbstverstärkend in Produktivdaten schreibt.
Judge, Review-Queue und Merge-Verifikation existieren, weil das Projekt selbst
erkannt hat, dass automatische Entitätsentscheidungen eine Rückfallebene
brauchen. Dieselbe Begründung gilt für den Fingerprint, wurde dort aber
zugunsten der Einfachheit verworfen. Das Audit hält diese Abwägung für nicht
tragfähig, solange die zirkuläre Vererbung nicht unterbrochen und die
übernommenen IDs nicht validiert sind.

**Gesamturteil: Eingeschränkt betriebsbereit.** Zwei kritische Befunde sind
vor jeder Weiternutzung zu beheben, ein Schwellwert ist nachzuziehen, und ein
Feature bleibt aus. Die Substanz darunter ist gut — die Arbeit an den fünf
Phasen ist solide, und die Lücken liegen überwiegend an den Nahtstellen
zwischen neuem und altem Code, nicht in der neuen Logik selbst.

---

*Ende des Berichts. Es wurde keine Datei des Projekts verändert; die einzige
Neuanlage ist dieser Bericht.*
