# Konsistenz- und Merge-/Review-UI-Test an der laufenden Instanz

**Datum:** 2026-08-06
**Commit / Branch:** `2d45211` auf `main` (Arbeitsverzeichnis sauber)
**Auditart:** unabhängiger, überwiegend lesender Funktionstest der laufenden
paperless-jo-Instanz gegen die als „vollständig umgesetzt" markierte
[Konsistenz-Roadmap](../planning/klassifikations-konsistenz-roadmap.md)
**Prüfer:** Claude Opus 5, beauftragter Test ohne Änderungsrechte am Produktivcode
**Bezug:** [Erstaudit 2026-08-02](paperless-jo-full-project-audit-2026-08-02.md) (35 Findings),
[Nachaudit 2026-08-04](2026-08-04-nachaudit-offene-punkte.md) (NACHAUDIT-01 bis -17)

---

## 1. Kurzfassung

Die Kernfrage des Auftrags lautete: liegt die im Alltag empfundene Inkonsistenz
an (a) Lücken der Umsetzung, (b) der Konfiguration oder (c) der Darstellung in
der UI? **Die Antwort ist: an allen dreien, und die drei verstärken sich
gegenseitig.** Die fünf Roadmap-Phasen sind als Code tatsächlich vorhanden und
in weiten Teilen gut gebaut — aber die Kette ist an vier Stellen faktisch
unterbrochen, und keine dieser Unterbrechungen ist im laufenden Betrieb
sichtbar.

Die vier Unterbrechungen, nach Wirkung sortiert:

1. **Der LLM-Judge antwortet praktisch nie.** Sein Timeout ist mit 15 000 ms
   fest verdrahtet, die gemessene Medianlatenz auf dieser Instanz liegt bei
   **16 035 ms** (Mittelwert warm 18 002 ms, 9 von 12 Messungen über dem
   Timeout). `EntityResolver._askJudge` deutet **jeden** Fehler — auch einen
   Timeout — in das Verdikt `unsure` um. Genau dieses Verdikt tragen **25 von
   27** Queue-Einträgen des Produktivlaufs vom 2026-08-05. Stufe 4c der
   Resolver-Kaskade, die zentrale Neuerung von Phase 2, war damit vermutlich
   nie in Betrieb. → **BEFUND A-3**
2. **`USE_EXISTING_DATA=no` steht wieder in der Live-`data/.env`.** Das ist
   exakt die Ursache, die der Umgebungscheck vom 2026-08-01 als „die dominante"
   benannt und die Phase 5 am 2026-08-02 als behoben vermerkt hat. Das Modell
   sieht die 85 Tags, 25 Korrespondenten und 28 Dokumentarten des Bestands
   nicht — obwohl der konfigurierte `SYSTEM_PROMPT` es ausdrücklich anweist,
   „Pre-existing tags/correspondents/document types" zuerst zu prüfen. Diese
   Anweisung verweist auf Listen, die nie im Prompt stehen. → **BEFUND A-1**
3. **Der Embedding-Kanal ist aus, und seine gemessenen Schwellwerte sind aus
   der `.env` verschwunden.** `entity_embeddings` enthält 0 Zeilen, alle 27
   Queue-Einträge haben `embedding_similarity = NULL`. Damit fehlt genau der
   Kanal, den die Phase-2-Messung als „nicht optional, sondern gebraucht"
   eingestuft hatte. → **BEFUND A-4**
4. **Der englische JSON-Vorlagentext aus `config.mustHavePrompt` wird als
   Ergebniswert übernommen.** Der Platzhalter `"document_type":
   "Invoice/Contract/..."` erscheint wörtlich als Klassifikationsergebnis —
   in diesem Test live reproduziert. Aus ihm ist die Dokumentart `contract`
   entstanden, die heute **20 der 64 Dokumente** trägt. → **BEFUND A-2**

Auf der UI-Seite ist der Befund gleichlautend: Die Review-Oberfläche ist
funktional vollständig, macht aber die Entscheidung, für die sie da ist,
sachlich nicht entscheidbar. Ein Eintrag aus dem Altbestands-Durchlauf zeigt
**Typ, zwei Namen und eine Zahl** — Judge-Spalte, Begründung und Dokumentlink
sind bei allen 39 im Test erzeugten Einträgen leer, konstruktionsbedingt und
nicht wegen eines Fehlers. Die Merge-Richtung ist fest vorgegeben und im UI
nicht umkehrbar; in belegten Fällen zeigt sie **von der korrekten auf die
falsche Schreibweise** (`Zeugnis`, 5 Dokumente → `Zeugniss`, 0 Dokumente).
→ **BEFUNDE B-1 bis B-4**

**Punkt 2 ist im laufenden System gemessen worden.** Dieselben drei
Gehaltsabrechnungen, die heute in Paperless drei verschiedene Dokumentarten
tragen (`contract`, `Entgeltabrechnung`, `Verdienstbescheinigung`), wurden je
zweimal mit `USE_EXISTING_DATA=no` und zweimal mit `yes` klassifiziert:

| | `no` (Ist-Zustand) | `yes` |
|---|---|---|
| Dokumente über zwei Läufe stabil | 1 von 3 | **3 von 3** |
| verschiedene Dokumentarten über alle Läufe | 4 | **1** |
| Läufe mit unbrauchbarem Ergebnis | 1 von 6 | 0 von 6 |

Die sechs `yes`-Läufe liefern über drei verschiedene Dokumente hinweg
**zwölfmal denselben Wert** — Dokumentart `Entgeltabrechnung`, Korrespondent
`<AG> GmbH`, Tags `Gehalt` und `Sozialversicherung`, alle bereits im Bestand
vorhanden. Es entsteht keine einzige neue Entität. → **BEFUND A-8**

Der wichtigste Einzelsatz des Berichts: **die 3 falschen Merges aus
NACHAUDIT-08 sind nicht Vergangenheit.** Sie leben als
`entity_aliases`-Einträge mit `source='user'` weiter und werden auf jedes
künftige Dokument angewendet — `Austrittsdatum` → `Eintrittsdatum`,
`September 2025` → `November 2025`, `Urlaubsvergütung` →
`Ausbildungsvergütung`. Es gibt in der gesamten Anwendung keinen Weg, einen
Alias anzusehen oder zurückzunehmen. → **BEFUND A-7 / B-8**

---

## 2. Methodik

### 2.0 Hinweis zu Namen in diesem Bericht

Der Fork ist öffentlich, `docs/` ist versioniert, und der reale Bestand
enthält Klarnamen, eine Wohnanschrift und eine Personalnummer — die Roadmap
hält diesen Grund für `data/`s gitignore-Status ausdrücklich fest, und die
beiden bestehenden Audit-Dokumente enthalten konsequent keinen einzigen
Klarnamen. Dieser Bericht hält sich daran: **Namen natürlicher Personen,
Firmennamen, Anschriften und Nummern sind durch Platzhalter ersetzt**
(`<Inhaber>`, `<Zweitperson>`, `<AG>`, `<FirmaD>`, `<FirmaW>`, `<KK>`,
`<Anschrift>`, `<Strasse>`, `<Nr>`), konsistent über den ganzen Text.

Die Struktur der Namen bleibt dabei erhalten, weil genau sie der Befund ist
(Anrede im Namen, Anschrift im Namen, Rechtsform-Varianten, OCR-Fragmente).
**Alle angegebenen Ähnlichkeitswerte wurden auf den echten Namen berechnet**
und lassen sich aus den Platzhaltern nicht nachrechnen. Zugangsdaten,
Paperless-URL, Steuer-IDs und Kontonummern kommen im Bericht nicht vor,
auch nicht maskiert.

### 2.1 Umgebung

Getestet wurde gegen die reale, laufende Installation, nicht gegen Fixtures.

| Komponente | Zustand |
|---|---|
| Paperless-ngx | erreichbar, HTTP 200, **64 Dokumente** |
| Ollama | erreichbar, Modelle `qwen2.5:7b-instruct-q4_K_M` und `bge-m3:latest` |
| Zugangsdaten | `PAPERLESS_API_TOKEN` vorhanden, `PAPERLESS_API_URL` endet korrekt auf `/api` |
| Node | v22.14.0 |
| Server | `node server.js`, Port 3000, gestartet für die UI-Prüfung |

Ein Blocker im Sinne des Auftrags (fehlende Zugangsdaten) lag **nicht** vor;
alle Tests konnten gegen echte Daten laufen.

### 2.2 Wirksame Konfiguration

Ausgelesen über `config/config.js` gegen die echte `data/.env`. Werte, keine
Geheimnisse:

| Schlüssel | Wert | Herkunft |
|---|---|---|
| `AI_PROVIDER` | `ollama` | `.env` |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | `.env` |
| `ollama.temperature` / `.seed` | `0` / `42` | Code-Default |
| `ollama.numPredict` / `.numCtxMax` | `512` / `8192` | Code-Default |
| **`USE_EXISTING_DATA`** | **`no`** | **`.env`** |
| `RESTRICT_TO_EXISTING_*` | `no` (alle drei) | Code-Default, Schlüssel fehlen |
| `ENTITY_RESOLVER_ENABLED` | `yes` | `.env` |
| `ENTITY_RESOLVER_AUTO_THRESHOLD` | `0.8` | `.env` (gemessen) |
| `ENTITY_RESOLVER_JUDGE_MIN` | `0.5` | `.env` (gemessen) |
| **`EMBEDDING_SIMILARITY_ENABLED`** | **`no`** | **Code-Default, Schlüssel fehlt** |
| `EMBED_AUTO_THRESHOLD` / `EMBED_JUDGE_MIN` | `0.90` / `0.65` | Code-Default, **ungemessen** |
| `EMBEDDING_EXCLUDED_TYPES` | `[]` (leer) | Code-Default, Schlüssel fehlt |
| `DOCUMENT_FINGERPRINT_ENABLED` | `no` | Code-Default, Schlüssel fehlt |
| `DOCUMENT_FINGERPRINT_MODE` | `observe` | Code-Default |
| `FINGERPRINT_SIMILARITY_THRESHOLD` | `0.90` | Code-Default, **ungemessen** |
| `PROMPT_LOGGING_ENABLED` | `no` | Code-Default |
| `DISABLE_AUTOMATIC_PROCESSING` | `yes` | `.env` |
| `ACTIVATE_TAGGING/CORRESPONDENTS/DOCUMENT_TYPE/TITLE` | `yes` | `.env` |
| `ADD_AI_PROCESSED_TAG` | `yes` (`ai-processed`) | `.env` |

**Die `data/.env` hat 37 Schlüssel, keine Duplikate.** Auffällig ist, welche
Schlüssel *fehlen*: alle sieben, die `routes/settingsFormMapping.js` beim
Speichern der Settings unbedingt schreiben würde (`EMBEDDING_SIMILARITY_ENABLED`,
`DOCUMENT_FINGERPRINT_ENABLED`, `EMBED_*`), ebenso alle drei
`RESTRICT_TO_EXISTING_*`, die `routes/setup.js` beim Settings-Speichern
unbedingt setzt. Daraus folgt: **die Settings-Seite wurde auf dieser Instanz
seit dem Neuaufsetzen (2026-08-05) nie gespeichert**; die drei
`ENTITY_RESOLVER_*`-Zeilen sind von Hand eingetragen worden. Das erklärt
zwanglos, warum die am 2026-08-02 noch gesetzten Embedding-Werte
(inkl. `EMBEDDING_EXCLUDED_TYPES=tag`) heute fehlen: sie sind beim Neuaufsetzen
nicht mitgewandert, nicht durch einen Bug gelöscht worden.

### 2.3 Durchgeführte Tests

| # | Test | Schreibwirkung |
|---|---|---|
| 1 | Konfigurations- und Erreichbarkeitscheck | keine |
| 2 | Vollständiger Read-only-Dump von `data/entities.db` und `data/documents.db` | keine |
| 3 | Read-only-Bestandsaufnahme in Paperless (Tags/Korrespondenten/Dokumentarten inkl. Dokumentzahlen) und Berechnung aller Trigram-Paare ≥ 0.5 | keine |
| 4 | **Judge-Reproduktion:** echter `EntityJudge` über alle 27 historischen Queue-Paare, je zweimal (54 Ollama-Calls) | keine |
| 5 | **Judge-Latenzmessung:** 12 Paare direkt gegen `/api/generate` ohne das 15-s-Timeout | keine |
| 6 | **Embedding-Gegenprobe:** `bge-m3`-Kosinusähnlichkeit für 11 echte Dubletten und 9 Kontrollpaare aus dem realen Bestand, über `embed()` statt `getOrComputeEmbedding()` | keine |
| 7 | **A/B-Konsistenztest:** 3 Dokumente × 2 Wiederholungen × `USE_EXISTING_DATA` ∈ {`no`,`yes`}, nur `aiService.analyzeDocument` | keine |
| 8 | Review-UI: Altbestands-Durchlauf über alle drei Entitätstypen, gerenderte Seiten, Merge-**Preview** (`dryRun:true`), Fehler- und Randfälle der vier API-Routen | 39 Zeilen in `entity_review_queue` |
| 9 | `npm test`, `npm run lint` | keine |

**Bewusst nicht durchgeführt:** kein echter Merge (`dryRun:false`), kein
Scan-Lauf, keine Änderung an `data/.env`, kein Testdokument-Upload, keine
Änderung am Anwendungscode. Der A/B-Test schaltet `config.useExistingData` nur
im Speicher des Testprozesses um, nicht in der Datei.

---

## 3. Befunde Teil A — Konsistenz

### A-1 — `USE_EXISTING_DATA=no`: der Bestandsabgleich im Prompt ist abgeschaltet

- **Schweregrad:** Critical (für Konsistenz) · **Kategorie:** Konfiguration
- **Bezug:** Roadmap „Befunde aus dem Umgebungscheck (2026-08-01)", Absatz 1;
  Roadmap Phase 5, wo derselbe Punkt als vorab behoben vermerkt ist

**Beleg.** `data/.env` Zeile 16: `USE_EXISTING_DATA=no`. Im Laufzeitprotokoll
jedes Klassifikationsaufrufs: `[DEBUG] Use existing data: no, Restrictions
applied based on useExistingData setting`. In
[services/ollamaService.js:230-243](../../services/ollamaService.js#L230-L243)
hängt die Einfügung der Bestandslisten am `if`-Zweig; bei `no` läuft der
`else`-Zweig, der nur `basePrompt` + `mustHavePrompt` enthält.

**Warum das mehr wiegt als beim ersten Mal.** Der inzwischen konfigurierte,
sehr sorgfältige deutsche `SYSTEM_PROMPT` enthält einen eigenen Abschnitt:

> „VORHANDENE WERTE: Ganz oben stehen ggf. ‚Pre-existing tags', ‚Pre-existing
> correspondents' und ‚Pre-existing document types'. Prüfe diese Listen zuerst
> und übernimm einen passenden Eintrag in exakt derselben Schreibweise."

Bei `USE_EXISTING_DATA=no` stehen diese Listen nie im Prompt. Die Regel läuft
also ins Leere, und zwar unsichtbar — das Modell bekommt eine Anweisung, deren
Bezugsobjekt fehlt. Derselbe Prompt weist außerdem an, „niemals ein Synonym,
eine Übersetzung, eine Plural-/Singular- oder Schreibvariante eines bereits
vorhandenen Werts" anzulegen; ohne die Liste kann das Modell nicht wissen, was
bereits vorhanden ist. **Die gesamte Prompt-Härtung aus Phase 1 ist an ihrem
wichtigsten Punkt wirkungslos.**

**Messbare Folge (Bestandsaufnahme 2026-08-06, 64 Dokumente):**

| | Anzahl | pro Dokument |
|---|---|---|
| Tags | **85** | 1.33 |
| Korrespondenten | 25 | 0.39 |
| Dokumentarten | **28** | 0.44 |

Darunter, jeweils als eigenständige Entität nebeneinander:

- **Gehaltsabrechnung, fünffach:** `Entgeltabrechnung` (12 Dok),
  `Verdienstbescheinigung` (3), `Payroll Statement` (2), `Abrechnung` (1),
  `Lohnsteuerbescheinigung` (2) — plus `salary tax certificate` (1) und
  `Entgeltabrecknung` (Tippfehler, 0).
- **Meldebescheinigung, dreifach:** `Meldebescheid` (1), `Meldebescheinigung`
  (3), `Meldebeschreibung` (3) — exakt das Trio aus dem Umgebungscheck vom
  1. August, auf einer frisch aufgesetzten Instanz erneut entstanden.
- **Empfänger statt Absender, vierfach:** `<Inhaber>`,
  `<Inhaber vollstaendig>`, `Herr <Inhaber>` (3 Dok),
  `Herrn <Inhaber>, <Anschrift>` — die im Prompt ausdrücklich verbotene
  Kategorie, inklusive Wohnanschrift im Entitätsnamen.
- **Englische Tags** trotz „Ausschließlich deutsche Begriffe": `Electronic
  Document`, `Personal Data`, `Tax Document`, `Invoice`, `Curriculum Vitae`,
  `salary tax certificate`.
- **Datums-Tags** trotz „keine Jahreszahlen": `2023`, `2024`, `November 2025`.
- **OCR-Fragmente als Entitätsname:** Tag `Textim <Strasse>`; Korrespondent
  `Personal-Nr. <Nr>`; Korrespondent
  `<FirmaW> Druckdatum . . : 16.02.2024\n<FirmaD> GmbH Erster
  Versand : 29.01.2024`.

**Vorschlag (nicht umgesetzt).** `USE_EXISTING_DATA=yes` setzen — der A/B-Test
in A-8 quantifiziert den Effekt. Der Token-Kostenpunkt ist bei diesem Bestand
unkritisch: der System-Prompt wächst von 1 497 auf 2 180 Token bei
`OLLAMA_NUM_CTX_MAX=8192`, und `_fitPromptToContext` kürzt bei Enge nur den
Dokumententext und meldet das laut. Zusätzlich empfehlenswert: einen
Startup-Check ergänzen, der warnt, wenn der `SYSTEM_PROMPT` das Wort
„Pre-existing" enthält, `USE_EXISTING_DATA` aber `no` ist — dieser
Widerspruch ist heute nirgends sichtbar.

---

### A-2 — Der englische JSON-Platzhalter wird als Dokumentart übernommen

- **Schweregrad:** High · **Kategorie:** Implementierungslücke (Prompt-Aufbau)
- **Bezug:** neu; Phase 1, Schritt 7 („hartkodierten englischen
  Analyzer-Prompt entfernen") ist umgesetzt, `config.mustHavePrompt` blieb aber

**Beleg — live reproduziert.** In diesem Test, Dokument 127 (ein Dokument mit
Titel „Entgeltabrechnung"), Lauf 1 unter der Ist-Konfiguration:

```
"title": "Entgeltabrechnung",
"correspondent": "<AG> GmbH",
"tags": ["Verdienstbescheinigung", "Lohnabrechnung"],
"document_type": "Invoice/Contract/...",
"document_date": "2023-12-31",
"language": "de"
```

Lauf 2 desselben Dokuments, identische Konfiguration:
`"document_type": "Invoice/Contract/Entgeltabrechnung"`.

**Ursache.** [config/config.js:274-285](../../config/config.js#L274-L285)
definiert `mustHavePrompt` mit der Vorlage

```
"document_type": "Invoice/Contract/...",
```

`_buildPrompt` hängt diesen Block **in beiden Zweigen** an den System-Prompt an
([ollamaService.js:240 und :242](../../services/ollamaService.js#L240-L242)).
Das JSON-Schema (`documentAnalysisSchema`) erzwingt nur den Typ `string`,
nicht das Vokabular. Der deutsche `SYSTEM_PROMPT` sagt zwar „Dokumentart immer
deutsch, niemals englisch" und liefert eigene Beispiele — aber die englische
Vorlage steht danach und ist die formatnächste Vorlage, die das Modell sieht.

**Folgeschaden, in Zahlen.** Aus dieser Ausgabe ist die Entität
`Invoice/Contract/...` entstanden (Queue-Eintrag 10). Der Nutzer hat sie am
2026-08-05 nach `contract` gemergt (`entity_merge_log` id 6: `from_id 53 →
to_id 49`, **19 Dokumente umgehängt**). Heute trägt die Dokumentart `contract`
**20 der 64 Dokumente** — darunter die Dokumente 127, 130, 132, 133, alle vier
mit dem Titel „Entgeltabrechnung". Ein knappes Drittel des Archivs ist unter
einem Prompt-Platzhalter einsortiert.

Nebenbeobachtung derselben Stelle: `documentAnalysisSchema` erlaubt
`custom_fields` mit `additionalProperties: true`, obwohl
`ACTIVATE_CUSTOM_FIELDS=no` und `CUSTOM_FIELDS={"custom_fields":[]}` gesetzt
sind. Das Modell füllt dieses Feld ungefragt mit erfundenen Schlüsseln,
darunter im Testlauf eine Steuer-ID und eine IBAN (Werte hier bewusst nicht
zitiert). Die Daten werden downstream verworfen, verbrauchen aber vom
`num_predict`-Budget von 512 Token und würden bei
`PROMPT_LOGGING_ENABLED=yes` in `logs/prompt.txt` landen.

**Vorschlag (nicht umgesetzt).** `mustHavePrompt` sprachlich neutralisieren
(`"document_type": ""` oder `"<Dokumentart>"` statt konkreter englischer
Beispielwerte), und `custom_fields` nur dann ins Schema aufnehmen, wenn
`ACTIVATE_CUSTOM_FIELDS=yes` ist. Zusätzlich: eine `_isPlausibleDocumentType`-
Prüfung analog zum bereits existierenden `_isPlausibleTag` — ein Wert mit
`/` und `...` ist erkennbar kein Kategoriename.

---

### A-3 — Der LLM-Judge läuft in ein zu kurzes Timeout; jeder Timeout wird als „unsure" gebucht

- **Schweregrad:** Critical (für den Resolver) · **Kategorie:**
  Implementierungslücke + Konfiguration
- **Bezug:** AUDIT-028 (Judge: kein Seed, hartkodiertes `num_ctx`, kein Retry —
  Retry wurde ergänzt, das Timeout nicht); erklärt nachträglich NACHAUDIT-08
  und NACHAUDIT-14

**Der Mechanismus.** Drei Codestellen greifen ineinander:

1. [services/entityJudge.js:47](../../services/entityJudge.js#L47):
   `this.client = axios.create({ timeout: 15000 });` — fest verdrahtet, keine
   Env-Variable, kein Config-Bezug.
2. `EntityJudge.judge()` wertet einen Timeout als transienten Fehler und
   **wiederholt ihn genau einmal** nach 300 ms.
3. [services/entityResolver.js:223-226](../../services/entityResolver.js#L223-L226):
   ```js
   } catch (error) {
     console.warn(`[WARNING] entityResolver: Judge nicht erreichbar ...`);
     return { verdict: 'unsure', reason: `judge nicht erreichbar: ${error.message}` };
   }
   ```
   Ein Timeout ist damit vom echten Modellurteil „unsure" **nicht
   unterscheidbar** — außer am `reason`-Text, den NACHAUDIT-14 bis zum
   2026-08-05 fest auf `null` gesetzt hat.

**Die Messung.** 12 reale Namenspaare, sequenziell, direkt gegen
`POST /api/generate` mit denselben Optionen wie `EntityJudge`
(`temperature: 0`, `seed: 42`, `num_ctx: 1024`, `num_predict: 200`), aber mit
großzügigem Timeout:

| Kennzahl | Wert |
|---|---|
| Median | **16 035 ms** |
| Mittelwert (ohne kalten Erstaufruf) | **18 002 ms** |
| Minimum / Maximum | 11 620 ms / 27 760 ms |
| **Über dem 15 000-ms-Timeout** | **9 von 12** |

Einzelwerte, gekürzt: `Abschlusszeugnis↔Zeugnis` 15 667 ms · `<FirmaD>
Plastic GmbH↔<FirmaD> GmbH` 27 760 ms · `<KK> BKK↔BKK <KK>
Hamburg` 20 219 ms · `Lohnabrechnung↔Abrechnung` 22 877 ms ·
`<AG>® HR↔<AG> GmbH` 23 492 ms · `Austrittsdatum↔Eintrittsdatum` 13 364 ms.

**Die Bestätigung am Bestand.** `entity_review_queue`, alle 27 Einträge des
Produktivlaufs:

| `llm_verdict` | Anzahl |
|---|---|
| `unsure` | **25** |
| `different` | 2 |
| `same` | 0 |

Und beim erneuten Durchlaufen derselben 27 Paare mit dem echten
`EntityJudge` (je zweimal, 54 Calls) in diesem Test: **11 von 27 liefen in den
15-s-Timeout**, die übrigen 16 lieferten echte Verdikte — 8 × `same`,
8 × `different`, **kein einziges `unsure`**. Das Modell ist also durchaus
entscheidungsfreudig; es kommt nur nicht rechtzeitig zurück.

**Was das kostet.** Pro Namenspaar 15 s + 300 ms + 15 s ≈ **30 s reine
Timeout-Zeit**, bevor `unsure` gebucht wird. Ein Dokument kann 1 Korrespondent
+ 1 Dokumentart + bis zu 4 Tags in die Judge-Zone bringen — im ungünstigen
Fall drei Minuten pro Dokument, ohne ein einziges Urteil.

**Was das erklärt.** NACHAUDIT-08 hält fest, dass 3 von 18 bestätigten Merges
inhaltlich falsch waren, und benennt als Ursache „der Nutzer traf diese
Entscheidungen ohne jede KI-Begründung". Das ist richtig, greift aber zu kurz:
es fehlte nicht nur die *Begründung* (NACHAUDIT-14, behoben), es fehlte das
*Urteil*. Der Judge hatte zu keinem der drei Paare je geantwortet. Wäre er
durchgelaufen, hätte er nach der Messung dieses Tests bei allen dreien
`different` gesagt:

| Paar | Judge heute (2 Läufe) | Begründung des Modells (gekürzt) |
|---|---|---|
| `Austrittsdatum` ↔ `Eintrittsdatum` | `different`, `different` | „beziehen sich auf unterschiedliche Zeitpunkte in einem Prozess" |
| `September 2025` ↔ `November 2025` | `different`, `different` | „beziehen sich auf verschiedene Monate" |
| `Urlaubsvergütung` ↔ `Ausbildungsvergütung` | `different`, `different` | „unterschiedliche Arten von Vergütungen" |

**Alle drei Fehlentscheidungen wären durch ein funktionierendes Timeout
vermieden worden.**

**Vorschlag (nicht umgesetzt).**
1. Timeout konfigurierbar machen (`ENTITY_JUDGE_TIMEOUT_MS`) und den Default
   an der realen Latenz orientieren — auf dieser Hardware wären 60 000 ms
   angemessen, nicht 15 000 ms.
2. **Timeout und Modellurteil trennen.** Ein nicht erreichbarer Judge ist kein
   `unsure`, sondern ein eigener Zustand (z. B. `llm_verdict='unavailable'`).
   Solange beides denselben Wert schreibt, ist ein Ausfall dieser Stufe im
   Betrieb unsichtbar — genau das ist hier über einen ganzen Produktivlauf
   hinweg passiert.
3. Beim Start oder beim ersten Judge-Call einmal die Latenz messen und warnen,
   wenn sie über dem konfigurierten Timeout liegt.
4. Optional: für den Judge ein kleineres, schnelleres Modell zulassen
   (`ENTITY_JUDGE_MODEL`) — die Aufgabe „sind diese zwei Namen dasselbe" ist
   deutlich leichter als die Dokumentklassifikation und braucht kein 7B-Modell.

---

### A-4 — Der Embedding-Kanal ist aus; seine gemessenen Schwellwerte fehlen

- **Schweregrad:** High · **Kategorie:** Konfiguration
- **Bezug:** Roadmap „Befunde aus der Umsetzung von Phase 2" — dort ausdrücklich
  „Ansatz B wird für Phase 3+ gebraucht, **nicht optional**"; Phase 5 nennt
  `EMBEDDING_EXCLUDED_TYPES=tag` als gemessenes Ergebnis

**Beleg.** `EMBEDDING_SIMILARITY_ENABLED` fehlt in `data/.env`, der Code-Default
`no` greift. Bestätigung an den Daten: `entity_embeddings` enthält **0 Zeilen**;
alle 27 Queue-Einträge haben `embedding_similarity = NULL` und
`similarity == trigram_similarity`. Das Modell `bge-m3:latest` ist auf der
Ollama-Instanz **vorhanden** — die Voraussetzung ist also erfüllt, der Schalter
steht nur auf aus. Ebenfalls verschwunden: die gemessenen `EMBED_*`-Werte
(es greifen die ungemessenen Defaults 0.90/0.65) und `EMBEDDING_EXCLUDED_TYPES`
(heute leer statt `tag`).

**Warum das die spürbare Inkonsistenz erklärt.** Von den 47 Namenspaaren des
realen Bestands mit Trigram ≥ 0.5 erreichen nur **5** den Auto-Merge-Schwellwert
0.8. Die eigentlich störenden Dubletten sind für Trigram unsichtbar:

| Paar (real im Bestand) | Trigram | in der Kaskade |
|---|---|---|
| `Entgeltabrechnung` ↔ `Verdienstbescheinigung` | 0.103 | wird nie betrachtet |
| `Entgeltabrechnung` ↔ `Payroll Statement` | 0.059 | wird nie betrachtet |
| `Verdienstbescheinigung` ↔ `Payroll Statement` | 0.000 | wird nie betrachtet |
| `Lohnsteuerbescheinigung` ↔ `salary tax certificate` | 0.000 | wird nie betrachtet |
| `Praktikumsbestätigung` ↔ `Practicum Confirmation` | 0.091 | wird nie betrachtet |
| `Persönliche Daten` ↔ `Personal Data` | 0.387 | wird nie betrachtet |

Das ist **kein Schwellwertproblem** — bei 0.0 hilft keine Schwelle. Die
Roadmap hat das 2026-08-01 korrekt so festgestellt und daraufhin Phase 4 gebaut.
Die Phase ist gebaut und abgeschaltet.

**Eigene Messung, was der Kanal leisten würde.** `bge-m3`-Kosinusähnlichkeit
für 11 echte Dubletten und 9 Kontrollpaare aus demselben Bestand (berechnet
über `embed()`, ohne Cache-Schreibzugriff):

| Schwelle | echte Dubletten getroffen | Kontrollpaare fälschlich getroffen |
|---|---|---|
| 0.90 | 2 / 11 | 0 / 9 |
| 0.85 | 3 / 11 | **1 / 9** |
| 0.80 | 4 / 11 | 1 / 9 |
| 0.75 | 6 / 11 | 2 / 9 |
| 0.70 | 8 / 11 | 4 / 9 |
| 0.65 | 9 / 11 | 7 / 9 |

Wertebereich echte Dubletten 0.597–0.938, Kontrollpaare 0.587–0.880 — **die
Klassen überlappen fast vollständig.** Das ist ein wichtiger Zusatzbefund
gegenüber der Roadmap-Erwartung:

- Als **Auto-Merge-Kanal ist Embedding auf diesen Daten nicht verantwortbar.**
  Beim Default 0.90 fängt er 2 von 11 Dubletten — also fast nichts. Senkt man
  auf 0.85, wird als erstes Kontrollpaar `Herrn <Inhaber>, <Anschrift>` ↔
  `<Zweitperson>, <Anschrift>` (0.880) getroffen: **zwei verschiedene Personen,
  automatisch zusammengeführt, weil sie unter derselben Adresse wohnen.**
- Als **Judge-Zulieferer ist er wertvoll.** `EMBED_JUDGE_MIN` um 0.65–0.70
  brächte 8–9 der 11 echten Dubletten überhaupt erst vor ein Urteil — die
  einzige Chance, `Entgeltabrechnung` ↔ `Payroll Statement` (0.680) je zu
  erkennen.

**Vorschlag (nicht umgesetzt).** In dieser Reihenfolge, nicht auf einmal:
zuerst A-3 beheben (ohne funktionierenden Judge macht ein zusätzlicher
Judge-Zulieferer die Queue nur voller), dann `EMBEDDING_SIMILARITY_ENABLED=yes`
mit `EMBED_AUTO_THRESHOLD=0.95` (praktisch aus) und `EMBED_JUDGE_MIN=0.70`,
und `EMBEDDING_EXCLUDED_TYPES=tag` wieder setzen. Die gemessenen Werte gehören
außerdem in eine versionierte Datei (`.env.example`-Kommentar oder
`docs/`-Tabelle), damit sie ein Neuaufsetzen überleben — dass sie es diesmal
nicht getan haben, ist der eigentliche Prozessfehler.

---

### A-5 — Die Kaskade repariert nur, was sie sieht: Auto-Merge ist präzise, die Judge-Zone ist es nicht

- **Schweregrad:** Medium · **Kategorie:** Konfiguration/Grenze des Verfahrens

Aus derselben Bestandsauswertung (47 Paare ≥ 0.5), die Verteilung über die
Bänder der Kaskade:

**Band ≥ 0.8 (Auto-Merge, ohne Rückfrage), 5 Paare — alle fünf korrekt:**
`Versicherung`↔`Versicherungen` (0.846) · `<Inhaber>`↔`Herr <Inhaber>`
(0.848) · `Vertragänderung`↔`Vertragsänderung` (0.848) ·
`Entgeltabrechnung`↔`Entgeltabrecknung` (0.824) · `Zeugnis`↔`Zeugniss` (0.800).
**Der gemessene Schwellwert 0.8 ist damit an diesen Daten bestätigt** — er
trifft ausschließlich Schreib- und Anredevarianten. Das ist eine positive
Feststellung und beantwortet die in NACHAUDIT-09 offen gebliebene Frage
(„löst 0.8 spürbar mehr Auto-Merges aus als 0.90 — und ist das gewünscht?")
für diesen Bestand mit ja und ja: der höchste dieser fünf Werte ist 0.848,
das ursprünglich geschätzte 0.90 hätte also **alle fünf** korrekten
Zusammenführungen verhindert und keine einzige Fehlzuordnung vermieden.

**Band 0.5–0.8 (Judge-Zone → Review-Queue), 42 Paare — inhaltlich gemischt.**
Hier stehen echte Dubletten neben Gegensatzpaaren, ohne dass die Zahl sie
trennt:

| Paar | Trigram | tatsächlich |
|---|---|---|
| `Herrn <Inhaber>, <Anschrift>` ↔ `<Zweitperson>, <Anschrift>` | 0.769 | **verschiedene Personen** |
| `<FirmaD> GmbH` ↔ `<FirmaD> Plastic GmbH` | 0.733 | vermutlich dasselbe |
| `Abschluss` ↔ `Schulabschluss` | 0.727 | vermutlich dasselbe |
| `<AG> GmbH` ↔ `<AG>® HR` | 0.727 | verschieden |
| `Eintrittsdatum` ↔ `Austrittsdatum` | 0.714 | **Gegenteil** |
| `Versicherungsablauf` ↔ `Versicherungsbeginn` | 0.632 | **Gegenteil** |
| `Meldebescheinigung` ↔ `Verdienstbescheinigung` | 0.600 | verschieden |
| `Kirchensteuer` ↔ `Lohnsteuer` | 0.522 | verschieden |
| `2023` ↔ `2024` | 0.500 | verschieden |

**Die Trigram-Zahl allein ist in diesem Band ohne Aussagekraft** — genau dafür
existiert die Judge-Stufe, die nach A-3 nie gelaufen ist. Der Nutzer bekam die
Zahl und sonst nichts (→ B-1).

**Vorschlag (nicht umgesetzt).** Keine Schwellwertänderung; 0.8/0.5 sind
richtig gewählt. Der Hebel ist A-3, nicht die Zahl.

---

### A-6 — Der Resolver zementiert Eingabefehler dauerhaft, ohne Rückweg

- **Schweregrad:** High · **Kategorie:** Implementierungslücke
- **Bezug:** NACHAUDIT-08, Schlussabsatz („der Resolver übernimmt Eingabefehler
  unkritisch statt sie zu erkennen — nicht weiter verfolgt")

Der Nachaudit-Befund ist bestätigt und hat eine Verschärfung, die dort nicht
festgehalten ist: **die falschen Zuordnungen sind nicht abgeschlossen, sondern
dauerhaft wirksam.** `entity_aliases` enthält 22 Zeilen, jede davon eine Regel,
die auf jedes künftige Dokument angewendet wird, bevor irgendeine andere Stufe
greift (Stufe 1 der Kaskade).

**Die 3 als falsch dokumentierten Merges aus NACHAUDIT-08, heute aufgelöst
gegen den echten Bestand:**

| Alias (normalisiert) | zeigt auf | Quelle |
|---|---|---|
| `austrittsdatum` | Tag **„Eintrittsdatum"** (1 Dok) | `user` |
| `september 2025` | Tag **„November 2025"** (2 Dok) | `user` |
| `urlaubsverguetung` | Tag **„Ausbildungsvergütung"** (3 Dok) | `user` |

Jedes künftige Dokument, dessen Klassifikation „Austrittsdatum" vorschlägt,
bekommt „Eintrittsdatum". Ohne Judge-Call, ohne Queue-Eintrag, ohne Hinweis.

**Vom Scan automatisch angelegte Aliase mit demselben Effekt:**

| Alias | zeigt auf | Quelle |
|---|---|---|
| `personal nr <Nr>` | Korrespondent „Personal-Nr. <Nr>" (0 Dok) | `auto` |
| `herrn <inhaber>` | Korrespondent „Herr <Inhaber>" (3 Dok) | `auto` |
| `invoice contract` | Dokumentart „contract" (20 Dok) | `user` |
| `<firmaw> druckdatum 16 02 2024 <firmad> gmbh erster versand 29 01 2024` | Korrespondent „<FirmaW> <FirmaD> GmbH" (0 Dok) | `user` |

Ein Alias auf eine Entität mit 0 Dokumenten bleibt aktiv, solange die Entität
in Paperless existiert.

**Es gibt keinen Rückweg.** `EntityStore.deleteAlias` existiert, wird aber
ausschließlich intern aufgerufen — wenn ein Alias auf eine gelöschte Entität
zeigt ([entityResolver.js:34](../../services/entityResolver.js#L34)). Kein
Route, keine View, kein Skript ruft es auf; `grep -rn "deleteAlias"` liefert
außerhalb von `models/`, `services/` und `test/` nichts. Auch die in
NACHAUDIT-12 ergänzte `restoreOriginalData(documentId)` hilft nicht: sie
stellt den Vorzustand *eines Dokuments* wieder her und rührt weder Alias noch
Merge an. Die einzige Möglichkeit, einen falschen Alias loszuwerden, ist,
die Zielentität in Paperless-ngx von Hand zu löschen — was nirgends
dokumentiert und für einen Nutzer nicht auffindbar ist.

**Vorschlag (nicht umgesetzt).** Eine Alias-Ansicht auf `/review` (zweiter
Tab): Liste aller Aliase mit Quelle, Ziel, Dokumentzahl des Ziels und einem
Löschen-Knopf. Das ist die kleinste Ergänzung, die eine Fehlentscheidung
reversibel macht — und billiger als jede zusätzliche Absicherung davor.

---

### A-7 — Determinismus ist auch bei `temperature=0`/`seed=42` nicht gegeben

- **Schweregrad:** Medium · **Kategorie:** grundsätzliche LLM-Varianz
- **Bezug:** AUDIT-019 / NACHAUDIT-04 — dort korrekt als strukturell
  unerreichbar begründet, allerdings mit *wachsenden Bestandslisten* als
  Ursache. Dieser Test zeigt eine zweite, davon unabhängige Quelle.

**Beleg 1 — Klassifikation.** Dokument 127, zwei aufeinanderfolgende Läufe,
identische Konfiguration, identischer Bestand, identischer Prompt
(`num_ctx=2591 (system=1497, user=582)` in beiden Läufen):

| Lauf | `document_type` |
|---|---|
| 1 | `Invoice/Contract/...` |
| 2 | `Invoice/Contract/Entgeltabrechnung` |

**Beleg 2 — Judge.** Von den 27 Paaren, die in diesem Test je zweimal mit
identischen Optionen (`temperature: 0`, `seed: 42`) an den Judge gingen,
lieferten 24 dasselbe Verdikt und 22 auch denselben Begründungstext. Diese
Zahlen sind allerdings geschönt: 11 der 27 liefen in beiden Läufen in den
Timeout (A-3) und zählen dadurch als „stabil". Die drei Paare mit
abweichendem Verdikt sind sämtlich Fälle, in denen ein Lauf antwortete und
der andere ins Timeout lief — ein echter Verdikt-Umschlag zwischen zwei
Antworten trat nicht auf. Zwei Paare lieferten dagegen dasselbe Verdikt mit
**unterschiedlichem Begründungstext** (`Entgeltabrechnung↔Abrechnung`,
`<FirmaW> Druckdatum…↔<FirmaW> <FirmaD> GmbH`) — und das
ist der eigentliche Beleg: dieselbe Anfrage, dieselben Optionen, andere
Ausgabe.

Das ist **keine Lücke der Umsetzung** — der Anwendungscode setzt alles
richtig. Ollama/llama.cpp ist bei GPU-Reduktionen und variabler Batchbildung
schlicht nicht bitgenau reproduzierbar. Die Konsequenz für die Doku ist aber
relevant: das Abnahmekriterium von Phase 1 („identische Ergebnisse bei
identischem Bestand", NACHAUDIT-04) ist auch in dieser präzisierten Form
**nicht erfüllbar**, weil schon zwei unmittelbar aufeinanderfolgende Läufe
gegen denselben Bestand abweichen können.

**Vorschlag (nicht umgesetzt).** Kriterium ein zweites Mal präzisieren: nicht
auf Identität, sondern auf eine Rate abstellen („bei N Wiederholungen
desselben Dokuments weicht höchstens X % der Felder ab"), und den
EntityResolver ausdrücklich als das Mittel benennen, das aus abweichenden
Vorschlägen dieselbe gespeicherte Entität macht. Das ist auch die Architektur,
die die Roadmap ohnehin gewählt hat — die Doku verspricht nur mehr, als der
Ansatz braucht.

---

### A-8 — A/B-Test: Wirkung von `USE_EXISTING_DATA` auf Stabilität und Korrektheit

- **Schweregrad:** — (Messung, kein eigener Befund) · **belegt A-1 und A-2**

**Aufbau.** Drei Dokumente, die inhaltlich derselben Klasse angehören
(Entgeltabrechnungen desselben Arbeitgebers) und in Paperless heute **drei
verschiedene Dokumentarten** tragen — genau das Bild, das im Alltag als
„inkonsistent" auffällt:

| Dokument | Titel in Paperless | heutige Dokumentart | heutiger Korrespondent |
|---|---|---|---|
| 127 | Entgeltabrechnung | `contract` | <AG> GmbH |
| 129 | Entgeltabrechnung | `Entgeltabrechnung` | <AG> GmbH |
| 147 | Entgeltabrechnung <AG>® HR | `Verdienstbescheinigung` | <AG> GmbH |

Jedes Dokument wurde viermal klassifiziert: zweimal mit
`USE_EXISTING_DATA=no` (Ist-Zustand) und zweimal mit `yes`, sonst identische
Konfiguration, alles über `aiService.analyzeDocument`, ohne Schreibzugriff.

**Ergebnis mit `USE_EXISTING_DATA=no` (Ist-Zustand):**

| Dok | Lauf | Dokumentart | Korrespondent | Tags |
|---|---|---|---|---|
| 127 | 1 | `Invoice/Contract/...` | <AG> GmbH | Verdienstbescheinigung, Lohnabrechnung |
| 127 | 2 | `Invoice/Contract/Entgeltabrechnung` | <AG> GmbH | Verdienstbescheinigung |
| 129 | 1 | `Entgeltabrechnung` | `<FirmaW> <FirmaD> GmbH` | Verdienstbescheinigung, Lohnabrechnung |
| 129 | 2 | *(undefined)* | *(null)* | *(leer)* |
| 147 | 1 | `Verdienstbescheinigung` | **`<Inhaber>`** | Ausbildungsvergütung, Einmalbezug |
| 147 | 2 | `Verdienstbescheinigung` | **`<Inhaber>`** | Ausbildungsvergütung, Einmalbezug |

**Ergebnis mit `USE_EXISTING_DATA=yes`:**

| Dok | Lauf | Dokumentart | Korrespondent | Tags |
|---|---|---|---|---|
| 127 | 1 | `Entgeltabrechnung` | <AG> GmbH | Gehalt, Sozialversicherung |
| 127 | 2 | `Entgeltabrechnung` | <AG> GmbH | Gehalt, Sozialversicherung |
| 129 | 1 | `Entgeltabrechnung` | <AG> GmbH | Gehalt, Sozialversicherung |
| 129 | 2 | `Entgeltabrechnung` | <AG> GmbH | Gehalt, Sozialversicherung |
| 147 | 1 | `Entgeltabrechnung` | <AG> GmbH | Gehalt, Sozialversicherung |
| 147 | 2 | `Entgeltabrechnung` | <AG> GmbH | Gehalt, Sozialversicherung |

**Auswertung:**

| | `no` | `yes` |
|---|---|---|
| Dokumente über 2 Läufe stabil | **1 von 3** | **3 von 3** |
| Verschiedene Dokumentarten über alle Läufe (ohne den Fehllauf) | **4** | **1** |
| Läufe, deren Dokumentart bereits im Bestand existiert | 3 von 6 | **6 von 6** |
| Läufe mit unbrauchbarem Ergebnis | 1 von 6 | 0 von 6 |
| Korrespondent stimmt mit dem in Paperless hinterlegten überein | 2 von 6 | **6 von 6** |
| Laufzeit je Klassifikation | 24–262 s | 24–97 s |

**Die sechs `yes`-Läufe liefern über drei verschiedene Dokumente hinweg
zwölfmal dasselbe Ergebnis** — Dokumentart `Entgeltabrechnung` (12 Dokumente
im Bestand), Korrespondent `<AG> GmbH` (35), Tags `Gehalt` (34) und
`Sozialversicherung` (41). Alle fünf Werte existieren bereits; es entsteht
keine einzige neue Entität. Genau das ist die Konsistenz, die die Roadmap
anstrebt, und sie stellt sich mit einer einzigen Konfigurationszeile ein.

**Drei Einzelbeobachtungen aus dem `no`-Zweig, die die anderen Befunde
belegen:**

- Lauf 127/1 und 127/2 liefern den Prompt-Platzhalter als Dokumentart —
  **A-2 live reproduziert**, und zwar zweimal in zwei verschiedenen
  Ausprägungen.
- Lauf 129/2 liefert **überhaupt kein verwertbares Ergebnis**
  (`document_type` undefined, kein Korrespondent, keine Tags), während
  Lauf 129/1 mit identischer Eingabe ein vollständiges Ergebnis lieferte.
- Lauf 147/1 und 147/2 tragen als Korrespondent **`<Inhaber>`** ein —
  den Empfänger, den der `SYSTEM_PROMPT` in einem eigenen Absatz ausdrücklich
  verbietet („niemals der Name der im Dokument als Empfänger, Arbeitnehmer
  oder Versicherter genannten Person"). Mit `yes` steht dort in beiden Läufen
  `<AG> GmbH` — derselbe Wert, der heute in Paperless hinterlegt ist.
  **Die Regel ist gut formuliert und wird trotzdem verletzt, solange das
  Modell den Bestand nicht sieht.**

**Ehrlichkeitshalber die Gegenrichtung:** Bei Dokument 127 lieferte der
`no`-Zweig ein `document_date` (`2023-12-31`), der `yes`-Zweig `null`. In den
anderen beiden Dokumenten war das Datum unter `yes` gleich gut (147) oder
besser (129: `2024-11-28` statt gar keinem brauchbaren Ergebnis). Der Titel
wurde unter `yes` durchweg besser und folgte dem im Prompt vorgegebenen
Schema (`<AG> GmbH - Entgeltabrechnung - 2024-11` statt bloß
`Entgeltabrechnung`). Ein Wechsel auf `yes` ist also keine reine Verbesserung
in jedem Einzelfeld — beim Datum ist er in einem von drei Fällen schlechter.

**Einschränkung:** drei Dokumente, sechs Läufe je Variante. Das belegt die
Richtung des Effekts deutlich, ist aber keine Quotenmessung (siehe
Abschnitt 8).

---

### A-9 — `npm test` ist auf der Produktivkonfiguration nicht grün (458/460)

- **Schweregrad:** Low · **Kategorie:** Testisolation
- **Bezug:** NACHAUDIT-03 (Testzahl-Drift), NACHAUDIT-02-Nebenbefund
  (Tests hingen an der echten Logdatei — dort behoben)

`npm test` auf dieser Maschine: **458 pass, 2 fail** von 460. Beide
Fehlschläge in
[test/entityResolverHookIn.test.js](../../test/entityResolverHookIn.test.js):

```
not ok 217 - processTags: map-Entscheidung verwendet existierende Entity statt neu anzulegen
not ok 218 - processTags: skip-Entscheidung ueberspringt den Tag und vermerkt einen Fehler
```

**Ursache verifiziert.** Beide Tests lesen über `config/config.js` die **echte
`data/.env`**. Dort steht `ADD_AI_PROCESSED_TAG=yes`, weshalb `processTags`
zusätzlich den Tag `ai-processed` verarbeitet und in den gestubbten
`createTagSafely` läuft, der wirft. Gegenprobe:

```
node --test test/entityResolverHookIn.test.js            -> 29 pass, 2 fail
ADD_AI_PROCESSED_TAG=no node --test ...                  -> 31 pass, 0 fail
```

Die in der Roadmap und im Nachaudit genannten „416/416" bzw. „421/421" waren
also auf einer Maschine mit `ADD_AI_PROCESSED_TAG=no` (oder ohne `data/.env`)
gemessen. Es ist dieselbe Klasse von Kopplung, die NACHAUDIT-02 für
`logs/prompt.txt` bereits als Nebenbefund behoben hat, hier nur für die
Konfiguration statt für eine Datei.

**Vorschlag (nicht umgesetzt).** In beiden Tests `config.addAIProcessedTag`
explizit setzen und im `finally` zurücksetzen — dasselbe Muster, das die
Datei für `config.entityResolver.enabled` schon verwendet.

---

### A-10 — `npm run lint` ist lokal rot (211 Fehler) durch liegengebliebene Worktrees

- **Schweregrad:** Low · **Kategorie:** CI/Werkzeug
- **Bezug:** NACHAUDIT-16 (alle 83 Warnungen behoben, `--max-warnings` auf 0)

`npm run lint` meldet **211 problems (211 errors, 0 warnings)**. Alle 211
stammen aus `.claude/worktrees/nachaudit-lint-cleanup/` und
`.claude/worktrees/nachaudit-paket4-fingerprint/` — zwei nach Abschluss der
jeweiligen Pakete liegengebliebenen Git-Worktrees. **Kein einziger Fehler
stammt aus dem versionierten Quellcode**; die Aufräumarbeit aus NACHAUDIT-16
ist vollständig und hält.

Die Worktrees sind über `.git/info/exclude` von Git ausgeschlossen, aber
[eslint.config.mjs](../../eslint.config.mjs) enthält **überhaupt keinen
`ignores`-Block**. Die CI ist deshalb grün, das lokale `npm run lint` rot —
die Ratsche, die NACHAUDIT-16 gerade erst eingebaut hat, ist lokal wertlos,
weil sie immer rot ist.

**Vorschlag (nicht umgesetzt).** `{ ignores: ['.claude/**', 'data/**'] }` in
`eslint.config.mjs` ergänzen und die beiden fertigen Worktrees entfernen.

---

## 4. Befunde Teil B — UX der Merge-/Review-WebUI

Bewertungsmaßstab laut Auftrag: Verständlichkeit für jemanden **ohne**
Kenntnis der Codebasis.

### B-1 — Die Tabelle sagt nicht, warum ein Eintrag da ist

- **Schweregrad:** High · **Kategorie:** UX/Nachvollziehbarkeit

Die Review-Tabelle
([views/review.ejs:104-149](../../views/review.ejs#L104-L149)) hat acht
Spalten: Type, Proposed, Candidate, Trigram, Embedding, Judge, Document,
Actions. Was fehlt, ist jede Einordnung:

- **Keine Schwellwerte.** Nirgends auf der Seite steht, dass ab 0.8
  automatisch zusammengeführt und ab 0.5 geprüft wird. Ohne diese zwei Zahlen
  ist „Trigram 0.63" eine Zahl ohne Skala. Der Nutzer kann nicht wissen, ob
  0.63 viel oder wenig ist.
- **Keine Legende für „Trigram" und „Embedding".** Zwei Fachbegriffe als
  Spaltenüberschrift, ohne Erklärung, was sie messen und warum es zwei sind.
- **Keine Herkunft.** Ein Eintrag aus dem laufenden Scan (mit Dokumentbezug)
  und ein Eintrag aus dem Altbestands-Durchlauf (ohne) sehen identisch aus,
  obwohl sie unterschiedlich zu bewerten sind.
- **Keine Dokumentzahlen.** Dass „Zeugnis" 5 Dokumente hat und „Zeugniss"
  keines, ist die für die Entscheidung wichtigste Information und steht nicht
  in der Tabelle (→ B-3, B-4).

**Vorschlag (nicht umgesetzt).** Einen erklärenden Kopfbereich mit den drei
aktiven Schwellwerten und einem Satz je Spalte; je Zeile einen Kurztext
„Landet hier, weil die Namensähnlichkeit zwischen der Prüf- (0.5) und der
Auto-Schwelle (0.8) liegt und der Judge nicht entschieden hat"; die
Dokumentzahl beider Seiten als eigene Spalte.

---

### B-2 — Altbestands-Einträge haben grundsätzlich weder Urteil noch Begründung noch Dokument

- **Schweregrad:** High · **Kategorie:** UX + Design
- **Bezug:** NACHAUDIT-14 (Judge-Begründung erreichte die Queue nie — behoben,
  greift hier aber konstruktionsbedingt nicht)

**Gemessen.** Der Altbestands-Durchlauf über alle drei Entitätstypen erzeugte
in diesem Test **39 offene Einträge** (16 Tags, 9 Korrespondenten, 14
Dokumentarten). Davon:

| Feld | befüllt |
|---|---|
| `llm_verdict` | **0 von 39** |
| `llm_reason` | **0 von 39** |
| `document_id` | **0 von 39** |
| `embedding_similarity` | 0 von 39 |

Das ist kein Fehler, sondern Absicht:
[entityBackfillService.js:72-75](../../services/entityBackfillService.js#L72-L75)
setzt `llmVerdict: null, llmReason: null, documentId: null` — der Durchlauf
verzichtet bewusst auf Judge-Calls (Roadmap Phase 3, Schritt 5).

**Die Folge für den Nutzer** ist aber genau die aus NACHAUDIT-14: eine Zeile
liest sich als

```
correspondent | <Inhaber> | Herr <Inhaber> | 0.85 | - | - | - | [Preview][Merge][Not a duplicate]
```

Drei von acht Spalten sind Bindestriche. Der Fix aus NACHAUDIT-14 („`reason`
wird durchgereicht und als Tooltip angezeigt") wirkt ausschließlich auf
Einträge aus dem Live-Pfad; für den Weg, der ausdrücklich zum Aufräumen des
Altbestands gedacht ist, ändert er nichts. **Die als behoben markierte Ursache
der 3 Fehl-Merges besteht auf diesem Pfad unverändert fort.**

**Vorschlag (nicht umgesetzt).** Entweder einen „Judge fragen"-Knopf je Zeile,
der das Urteil bei Bedarf nachträglich holt und speichert (bei
Judge-Latenzen um 16 s ist das interaktiv gerade noch zumutbar, ein Massenlauf
wäre es nicht) — oder, falls kein Urteil vorgesehen bleibt, die Spalte für
solche Zeilen sichtbar als „nicht bewertet (Altbestands-Scan)" beschriften,
statt einen Bindestrich zu zeigen, der wie ein leeres Ergebnis aussieht.

---

### B-3 — Die Merge-Richtung ist fest und im UI nicht umkehrbar

- **Schweregrad:** High · **Kategorie:** UX + Datenverlust-Risiko

`mergeEntity(type, proposed_id, candidate_id)` löscht immer die **Proposed**-
Seite. Die Richtung wird beim Anlegen des Queue-Eintrags festgelegt, im
Altbestands-Durchlauf nach einer rein technischen Regel:

```js
// Aeltere (kleinere) id gilt als kanonisch, die neuere als moeglicher Dublette-Kandidat
const [candidate, proposed] = a.id < b.id ? [a, b] : [b, a];
```
([entityBackfillService.js:40](../../services/entityBackfillService.js#L40))

Die Anlagereihenfolge in Paperless hat mit Richtigkeit nichts zu tun. Belege
aus den 39 erzeugten Einträgen:

| Queue-ID | wird gelöscht | bleibt bestehen | Bewertung |
|---|---|---|---|
| 66 | `Zeugnis` (**5 Dok**) | `Zeugniss` (**0 Dok**) | **Richtung falsch herum** |
| 64 | `Vertragsänderung` (1 Dok) | `Vertragänderung` (0 Dok) | **Richtung falsch herum** |
| 51 | `Herr <Inhaber>` (3 Dok) | `Herrn <Inhaber>, <Anschrift>` (1 Dok) | behält die Variante mit Wohnanschrift |
| 53 | `Abiturzeugnis` | `Zeugnis` | verliert Spezifik |
| 55 | `Gebührenbescheid` | `Bescheid` | verliert Spezifik |

In zwei von 23 Nicht-Tag-Paaren führt der einzig angebotene Weg dazu, die
korrekte Schreibweise zu löschen und den Tippfehler zu behalten. Der Nutzer
hat genau zwei Knöpfe: **Merge** (in der vorgegebenen Richtung) und **Not a
duplicate**. Es gibt keinen dritten.

**Vorschlag (nicht umgesetzt).** Zwei getrennte Knöpfe („← nach links
zusammenführen" / „nach rechts zusammenführen →") oder ein Richtungsschalter
im Bestätigungsdialog. Zusätzlich: als Vorbelegung nicht die kleinere ID,
sondern die Entität mit **mehr Dokumenten** als kanonisch wählen — das ist in
allen fünf Fällen oben die bessere Wahl.

---

### B-4 — Die Merge-Bestätigung zeigt Zahlen statt Sachverhalt

- **Schweregrad:** High · **Kategorie:** UX
- **Bezug:** Roadmap Phase 3, „Merge-Bestätigung: zweistufig" — umgesetzt,
  aber der zweite Schritt zeigt zu wenig

Der Bestätigungstext lautet vollständig
([public/js/review.js:134](../../public/js/review.js#L134)):

> `"Zeugnis" will be deleted. 5 document(s) will be reassigned to "Zeugniss". Continue?`

Was in dieser Meldung fehlt, obwohl es dem Server vorliegt:

1. **Der Dokumentbestand der Zielentität.** Dass „Zeugniss" **null** Dokumente
   hat — der eine Wert, der sofort zeigt, dass die Richtung verkehrt ist —
   steht nicht da. Die API kennt ihn.
2. **Die betroffenen Dokumente.** `previewMerge` bekommt vom Server
   `documentIds: [164,140,174,186,184]` und legt sie in
   `this.pendingDocumentIds` ab, **zeigt sie aber nicht an**. Die Titel liegen
   in einem *zweiten*, separaten Modal hinter einem *zweiten*, separaten Klick
   (dem Augen-Symbol), das obendrein nur je drei Beispiele je Seite lädt.
   Zwei Modals für eine Entscheidung.

**Der Fall, an dem das teuer wird**, aus diesem Test (Queue-ID 52,
Trigram 0.769). Der Bestätigungsdialog sagt:

> `"Herrn <Inhaber>, <Anschrift>" will be deleted. 1 document(s) will be reassigned to "<Zweitperson>, <Anschrift>". Continue?`

Erst das andere Modal verrät, dass auf der einen Seite ein Arbeitsvertrag und
auf der anderen eine Kfz-Versicherungspolice hängt — also **zwei verschiedene
Personen**, die nur dieselbe Adresse im Namen tragen. Ein Nutzer, der dem
Bestätigungsdialog folgt, führt hier zwei Menschen zusammen.

Ergänzend: Die **Judge-Begründung ist nur ein `title`-Attribut**
([views/review.ejs:125](../../views/review.ejs#L125)). Sie erscheint erst beim
Hovern, ist auf Touch-Geräten gar nicht erreichbar, bricht nicht um und ist
nur an einer gepunkteten Unterstreichung erkennbar. Für die Information, deren
Fehlen laut NACHAUDIT-14 die 3 Fehl-Merges begünstigt hat, ist das die
schwächste mögliche Darstellungsform.

**Vorschlag (nicht umgesetzt).** Den Bestätigungsdialog zu einer echten
Vorher-/Nachher-Ansicht ausbauen: beide Entitäten nebeneinander mit Name,
Dokumentzahl und je drei Beispieltiteln, die Judge-Begründung als sichtbarer
Fließtext, und die Richtung als umschaltbares Element. Die dafür nötigen
Daten liefern die bestehenden Routen bereits vollständig — es ist reine
Darstellung, kein neuer Backend-Aufwand.

---

### B-5 — „Not a duplicate" ist irreversibel, wirkt dauerhaft und fragt nicht nach

- **Schweregrad:** Medium · **Kategorie:** UX

Ein Klick auf **Not a duplicate** setzt sofort `status='rejected'`, entfernt
die Zeile und schreibt damit einen **permanenten Negativ-Cache-Eintrag**:
`findRejectedPair` verhindert danach, dass dieses Paar je wieder automatisch
zusammengeführt oder dem Judge vorgelegt wird — richtungsunabhängig und ohne
Verfallsdatum.

Es gibt weder eine Rückfrage noch einen Weg zurück. Zum Vergleich: die
**Massen**-Ablehnung fragt nach (`confirm(...)`, `public/js/review.js:206`),
die Einzelablehnung nicht — obwohl beide dieselbe dauerhafte Wirkung haben.

**Vorschlag (nicht umgesetzt).** Entweder Rückfrage auch bei der
Einzelablehnung, oder — besser, weil weniger Klickarbeit — eine
Undo-Möglichkeit in derselben Alias-/Entscheidungs-Ansicht, die B-8 vorschlägt.

---

### B-6 — Drei von fünf Client-Aufrufen verschlucken weiterhin die Servermeldung

- **Schweregrad:** Medium · **Kategorie:** UX/Fehlermeldungen
- **Bezug:** NACHAUDIT-15 — dort für `previewMerge` behoben, an den übrigen
  Stellen nicht

Die vier API-Routen liefern **präzise** Fehlermeldungen; das ist verifiziert:

```
GET  /api/review/999999/documents          -> 404 {"message":"No queue entry with id=999999"}
POST /api/review/999999/merge  (dryRun)    -> 400 {"message":"No queue entry with id=999999"}
POST /api/review/abc/merge     (dryRun)    -> 400 {"message":"No queue entry with id=NaN"}
POST /api/review/bulk-reject   (sim=2)     -> 400 {"message":"maxSimilarity must be a number between 0 and 1"}
POST /api/review/backfill/unbekannt        -> 400 {"message":"Unknown entity type \"unbekannt\""}
```

Im Client kommen sie nur teilweise an:

| Aufruf | liest `body.message`? | zeigt stattdessen |
|---|---|---|
| `previewMerge` | **ja** (NACHAUDIT-15-Fix) | — |
| `confirmMerge` | ja | — |
| `bulkReject` | ja | — |
| `showDocumentPreview` | **nein** | „Failed to load example documents. Please try again." |
| `reject` | **nein** | „Reject failed. Please try again." |
| `backfill` | **nein** | „Backfill scan failed. Please try again." |

Damit besteht genau das in NACHAUDIT-15 beschriebene Muster („Nutzer sah 5
identische, nichtssagende Fehlschläge") an drei von sechs Stellen fort — der
Fix wurde an der Stelle angebracht, an der der Fehler aufgefallen war, nicht
an der Klasse.

**Vorschlag (nicht umgesetzt).** Eine gemeinsame Hilfsfunktion
`async function apiCall(url, opts)`, die bei `!response.ok` konsequent
`body.message` wirft, und alle sechs Aufrufe darauf umstellen.

---

### B-7 — Keine Ladezustände, Rückmeldung ausschließlich über `alert()`

- **Schweregrad:** Medium · **Kategorie:** UX

**Merge**, **Not a duplicate** und **Preview** setzen den Knopf weder auf
deaktiviert noch zeigen sie einen Ladezustand; nur **Backfill** tut es
(`button.textContent = 'Running...'`). Ein zweiter Klick auf Merge während
des laufenden Requests ist damit möglich. In diesem Test antwortete der
Preview nach 144–167 ms — bei 64 Dokumenten unkritisch, bei einem größeren
Archiv (`getExampleDocumentsForEntity` fragt Paperless synchron ab) nicht mehr.

Jede Rückmeldung — Erfolg wie Fehler — läuft über Browser-`alert()` bzw.
`confirm()`. Es gibt keine Erfolgsmeldung nach einem Merge (die Zeile
verschwindet einfach), und der Zähler „39 open entries" im Filterbereich wird
nach Merge/Reject nicht aktualisiert; er stimmt erst nach einem Reload wieder.
Der Dashboard-Zähler „Open Review Entries" ist dagegen korrekt und live
geprüft (39 nach dem Backfill).

**Vorschlag (nicht umgesetzt).** Knöpfe während des Requests deaktivieren,
Zähler nach jeder Aktion dekrementieren, und die im Projekt bereits
vorhandene Toast-/Modal-Infrastruktur statt `alert()` verwenden.

---

### B-8 — Kein Ort, an dem gefällte Entscheidungen sichtbar oder korrigierbar sind

- **Schweregrad:** Medium · **Kategorie:** UX · **verwandt mit A-6**

Die Anwendung führt drei Entscheidungsspeicher — `entity_aliases` (22
Zeilen), `entity_review_queue` mit Status `merged`/`rejected` (27 Zeilen) und
`entity_merge_log` (23 Zeilen) —, und **keiner davon ist in der Oberfläche
sichtbar.** `/review` zeigt ausschließlich offene Einträge. Ein Nutzer kann
weder nachsehen, was er letzte Woche entschieden hat, noch welche Regeln der
Scan automatisch angelegt hat, noch ob ein Merge fehlgeschlagen ist —
`entity_merge_log` enthält 5 `failed`-Zeilen, die im UI nie erschienen sind.

**Vorschlag (nicht umgesetzt).** Ein Statusfilter auf `/review`
(`open`/`merged`/`rejected`) plus die in A-6 vorgeschlagene Alias-Ansicht mit
Löschfunktion. Beides sind Leseansichten auf bereits vorhandene Tabellen.

---

### B-9 — Die Altbestands-Knöpfe erklären sich nicht und fragen nicht nach

- **Schweregrad:** Medium · **Kategorie:** UX

Ganz oben auf `/review` stehen drei blaue Knöpfe: „Scan existing tags",
„Scan existing correspondents", „Scan existing document types". Kein
Begleittext, keine Rückfrage. In diesem Test erzeugte ein Klick auf den
ersten **16 Einträge**, alle drei zusammen **39**. Der Vergleich ist
quadratisch in der Zahl der Entitäten — bei 85 Tags sind das 3 570 Paare, bei
500 Tags über 124 000. Die einzige Rücknahme ist die Massen-Ablehnung, die
selbst irreversibel ist (B-5).

**Vorschlag (nicht umgesetzt).** Einen Satz Erklärung neben die Knöpfe, eine
Rückfrage mit der zu erwartenden Paarzahl, und das Ergebnis als Meldung
„16 neue Paare gefunden, 3 554 unterhalb der Prüfschwelle übersprungen" statt
nur „16 new entries found."

---

### B-10 — `USE_EXISTING_DATA` ist der wirksamste Konsistenzhebel und in den Settings am unauffälligsten platziert

- **Schweregrad:** Medium · **Kategorie:** UX/Settings · **verwandt mit A-1**

In [views/settings.ejs:452-458](../../views/settings.ejs#L452-L458) steht:

> **Use existing Correspondents and Tags?**  [ No | Yes ]

Das ist alles. Kein Hilfetext, keine Warnung, keine Verknüpfung zum Abschnitt
„Entity Resolution & Similarity Matching" weiter unten, und die Einstellung
liegt unter „Advanced Settings" zwischen Scan-Intervall und Token-Limit. Das
Label nennt außerdem nur Korrespondenten und Tags — die Einstellung steuert
aber ebenso die **Dokumentarten**, die auf dieser Instanz die größte
Dublettenquelle sind. (Das Setup-Wizard hat immerhin einen Erklärtext im
Shepherd-Tour-Schritt `existing-data`; auf der Settings-Seite fehlt er.)

Für einen Erstnutzer ist damit nicht erkennbar, dass diese eine Auswahl
darüber entscheidet, ob die gesamte darunter konfigurierte Resolver-Kaskade
etwas zu tun bekommt oder ob sie jedes Mal Neuerfindungen hinterherräumt.

**Vorschlag (nicht umgesetzt).** Die Einstellung in den Entity-Resolution-
Abschnitt hochziehen (oder dort spiegeln), umbenennen in „Show existing tags,
correspondents and document types to the AI", und einen Satz ergänzen: „Ohne
diese Option schlägt die KI Namen vor, ohne den vorhandenen Bestand zu kennen —
die Dublettenerkennung darunter muss dann alles nachträglich reparieren."

---

### B-11 — Die Settings zeigen ungemessene Defaults wie eingestellte Werte

- **Schweregrad:** Medium · **Kategorie:** UX/Settings
- **Bezug:** AUDIT-021/NACHAUDIT-05 (Variablen im UI ergänzt — vollständig
  umgesetzt), hier geht es um die *Darstellung* der Werte

Gerendert wurde auf dieser Instanz:

| Feld | angezeigter Wert | tatsächlich in `.env` |
|---|---|---|
| Auto-merge threshold (EntityResolver) | 0.8 | gesetzt (gemessen) |
| Judge threshold (EntityResolver) | 0.5 | gesetzt (gemessen) |
| Auto-merge threshold (Embedding) | **0.90** | **nicht gesetzt** |
| Judge threshold (Embedding) | **0.65** | **nicht gesetzt** |

Die beiden Embedding-Felder zeigen den EJS-Fallback (`|| '0.90'`), sind aber
optisch von einem gesetzten Wert nicht zu unterscheiden. Wer den Haken
„Enable Embedding Similarity" setzt und speichert, aktiviert damit den Kanal
mit **ungemessenen** Werten — und schreibt sie zugleich fest in die `.env`.
Nach der Messung in A-4 fängt 0.90 zwei von elf echten Dubletten; der Nutzer
bekäme also ein Feature, das aussieht, als liefe es, und praktisch nichts tut.

Der Hinweistext nennt als Bedingung nur `ollama pull bge-m3`. Das Werkzeug
für die eigentlich nötige Messung, `scripts/tune-thresholds.js`, wird in der
gesamten UI nicht erwähnt.

Weiterhin **gar nicht im UI vorhanden**, obwohl verhaltensrelevant und in
`routes/settingsFormMapping.js` nicht abgebildet:
`EMBEDDING_EXCLUDED_TYPES` (die gemessene `tag`-Ausnahme aus Phase 5),
`DOCUMENT_FINGERPRINT_MODE` (`observe`/`apply`) und
`FINGERPRINT_SIMILARITY_THRESHOLD`.

**Vorschlag (nicht umgesetzt).** Nicht gesetzte Werte als Platzhalter
(`placeholder="0.90 (Default, ungemessen)"`) statt als Wert rendern; einen
Hinweis auf `scripts/tune-thresholds.js` neben die Schwellwertfelder; die
drei fehlenden Variablen ergänzen.

---

### B-12 — Der Fingerprint-Warntext in den Settings beschreibt einen behobenen Zustand

- **Schweregrad:** Low · **Kategorie:** Doku im UI
- **Bezug:** AUDIT-003, NACHAUDIT-11, NACHAUDIT-12 — alle drei im Code behoben

[views/settings.ejs:772-778](../../views/settings.ejs#L772-L778) warnt:

> „**Not production-ready.** The feature currently reuses every classification
> immediately, including ones that were never reviewed or confirmed by a human,
> and errors can propagate to later documents in the same series."

Der zweite Halbsatz stimmt seit dem Herkunftsfeld `source: 'llm' | 'inherited'`
nicht mehr — ein geerbter Fehltreffer kann sich nicht weitervererben. Der
Default-Modus ist inzwischen `observe`, in dem gar nichts angewendet wird.
Ein Nutzer liest hier eine Warnung, die schärfer ist als der Ist-Zustand, und
erfährt zugleich nicht, dass es einen gefahrlosen Beobachtungsmodus gibt.
(Die noch offenen Punkte — Schwellwertmessung NACHAUDIT-10, 200-Dokumente-Lauf
NACHAUDIT-11 — rechtfertigen die Warnung als solche weiterhin.)

**Vorschlag (nicht umgesetzt).** Text auf den Ist-Stand bringen und den
`observe`-Modus als empfohlenen Einstieg benennen.

---

### B-13 — Alle Views laden Tailwind und Font Awesome vom CDN

- **Schweregrad:** Low · **Kategorie:** Robustheit/Datenschutz · **geerbt**

`views/review.ejs` lädt `https://cdn.tailwindcss.com/3.4.16` und
`https://cdnjs.cloudflare.com/.../font-awesome/6.7.0/...`. Das betrifft **alle
zwölf Views**, ist also aus Paperless-AI geerbt und keine Regression der
Phase-3-Arbeit. Für ein selbstgehostetes Homelab bedeutet es: ohne
Internetzugang bricht das Layout vollständig, und jeder Seitenaufruf meldet
sich bei zwei Drittanbietern.

**Vorschlag (nicht umgesetzt).** Beide Bibliotheken lokal ablegen. Kein
eigenes Paket wert, aber bei Gelegenheit mitnehmen.

---

## 5. Abgleich mit den bekannten Punkten

### 5.1 Bestätigt behoben

| Punkt | Beleg aus diesem Test |
|---|---|
| **NACHAUDIT-16** (83 Lint-Warnungen) | `npm run lint` findet im versionierten Quellcode **0 Befunde**; alle 211 Meldungen stammen aus zwei Worktrees außerhalb (→ A-10) |
| **NACHAUDIT-15** (nichtssagender 400er beim Merge auf gelöschtes Ziel) | `mergeEntity._entityExists` vorhanden; Servermeldungen sind präzise und erreichen `previewMerge` — an drei anderen Stellen aber nicht (→ B-6) |
| **NACHAUDIT-12** (Rückabwicklung) | `restoreOriginalData` vorhanden und über `POST /api/documents/:id/restore-original` erreichbar — **ohne jeden Aufrufer in Views oder Client-JS** und für Merges/Aliase nicht zuständig (→ A-6) |
| **NACHAUDIT-11** (Beobachtungsmodus) | `DOCUMENT_FINGERPRINT_MODE` wirksam, Default `observe`, unbekannter Wert fällt sicher zurück |
| **AUDIT-012** (richtungsabhängiger Negativ-Cache) | `findRejectedPair` und `findQueueEntryPair` prüfen beide Richtungen |
| **AUDIT-029** (`similarity` mischt Skalen) | Neue Zeilen tragen den Trigram-Wert; `trigram_similarity`/`embedding_similarity` getrennt und in der View bevorzugt |
| **AUDIT-030** (Pagination/Filter/Sortierung/Massenaktion) | Alle vier vorhanden und funktionsfähig; 39 Einträge korrekt auf 2 Seiten à 25 |
| **AUDIT-032** (Schwellwerte nicht gesetzt) | Für den EntityResolver behoben: 0.8/0.5 stehen in der `.env` — für den Embedding-Kanal **nicht** (→ A-4) |
| Auth der Review-Routen | `isAuthenticated`/`authenticateJWT` greifen; alle Testzugriffe brauchten den API-Key |
| Merge-Transaktionslogik | `entity_merge_log` sauber geführt: 18 `completed`, 5 `failed`, jede `completed`-Zeile mit `affected_count` |

### 5.2 Trotz „erledigt"-Status fortbestehend

| Punkt | Status laut Doku | Ist-Zustand |
|---|---|---|
| **`USE_EXISTING_DATA=no`** | Roadmap Phase 5: als Nebenbefund „vorab behoben" (2026-08-02) | **Wieder `no`.** Nicht mitgewandert beim Neuaufsetzen am 2026-08-05 (→ A-1) |
| **`EMBEDDING_EXCLUDED_TYPES=tag`** | Roadmap Phase 5: gemessenes Ergebnis | **Verschwunden**, Kanal ganz aus (→ A-4) |
| **Gemessene `EMBED_*`-Schwellwerte** | Phase 4/5: gemessen statt geraten | **Verschwunden**, es greifen 0.90/0.65 (→ A-4) |
| **NACHAUDIT-14** (fehlende Judge-Begründung → Fehl-Merges) | behoben, „wirkt nur auf künftige Einträge" | Für den Live-Pfad behoben. Auf dem **Altbestands-Pfad strukturell unverändert**: 0 von 39 Einträgen haben Verdikt oder Begründung (→ B-2). Und die tiefere Ursache war nicht die fehlende Begründung, sondern das fehlende Urteil (→ A-3) |
| **NACHAUDIT-08**, 3 falsche Merges „bewusst nicht zurückgerollt" | als abgeschlossene Einzelentscheidung dokumentiert | **Wirken dauerhaft fort** als drei `source='user'`-Aliase; kein UI-Weg, sie zu sehen oder zu löschen (→ A-6) |
| **NACHAUDIT-09** (Schwellwerte unter Last) | „Stichprobe zu klein für eine belastbare Aussage" | Jetzt beantwortbar: 0.8 trifft auf diesem Bestand **5 von 5** korrekt; 0.90 hätte alle fünf verhindert (→ A-5) |
| **AUDIT-019/NACHAUDIT-04** (Determinismus) | Kriterium auf „identisch bei identischem Bestand" präzisiert | Auch das ist **nicht erfüllbar** — zwei unmittelbar aufeinanderfolgende Läufe gegen denselben Bestand weichen ab (→ A-7) |
| **NACHAUDIT-03** (Testzahl) | 416/416 bzw. 421/421 grün | **458/460** auf der Produktivkonfiguration; 2 Fehlschläge durch Kopplung an die echte `data/.env` (→ A-9) |
| **AUDIT-028** (Judge-Härtung) | Seed und Retry ergänzt | Das **Timeout** blieb bei 15 s und ist die eigentliche Schwachstelle (→ A-3) |
| **AUDIT-035** (`/api`-Suffix) | bewusst zurückgestellt | Unverändert offen; auf dieser Instanz korrekt konfiguriert, also nicht wirksam |

### 5.3 Neue Punkte ohne Vorläufer

A-2 (Prompt-Platzhalter als Dokumentart), A-3 (Judge-Timeout), A-9
(Testkopplung an `data/.env`), A-10 (Lint über Worktrees), B-3 (Merge-Richtung
nicht umkehrbar), B-9 (Altbestands-Knöpfe ohne Erklärung), B-13 (CDN).

---

## 6. Empfohlene Reihenfolge

Ohne Anspruch, die Priorisierung des Projekts zu ersetzen — aber die
Abhängigkeiten sind eindeutig:

1. **A-3 (Judge-Timeout).** Kleinster Eingriff, größte Wirkung. Solange
   der Judge nicht antwortet, verschiebt jede weitere Verbesserung nur mehr
   Arbeit in eine Queue, die der Nutzer nicht entscheiden kann.
2. **A-1 (`USE_EXISTING_DATA=yes`).** Eine Zeile. Wirkt am Eingang statt am
   Ausgang und verringert die Menge, die 1. überhaupt bewerten muss.
3. **A-2 (Prompt-Platzhalter).** Behebt die größte einzelne
   Fehlklassifikationsquelle (20 von 64 Dokumenten).
4. **B-3 + B-4 (Richtung und Bestätigungsdialog).** Macht die Review-Arbeit
   erst sicher; ohne das ist jeder Durchgang durch die Queue ein Risiko.
5. **A-6 / B-8 (Alias-Ansicht mit Löschfunktion).** Macht Fehlentscheidungen
   reversibel — auch rückwirkend für die drei aus NACHAUDIT-08.
6. **A-4 (Embedding als Judge-Zulieferer, nicht als Auto-Merge-Kanal).** Erst
   sinnvoll, wenn 1., 4. und 5. stehen.

---

## 7. Testartefakte

### 7.1 Aufgeräumt

| Artefakt | Menge | Zustand |
|---|---|---|
| Offene Queue-Einträge aus dem Altbestands-Durchlauf (`entity_review_queue`, `id` 28–66) | 39 | **gelöscht** |
| `OPENAPI/openapi.json` (beim Serverstart neu geschrieben, inhaltlich identisch, nur Zeilenenden) | 1 Datei | **zurückgesetzt** (`git checkout`) |
| Laufender Server auf Port 3000 | 1 Prozess | **beendet** |

Verifikation nach dem Aufräumen — `data/entities.db` steht wieder exakt auf
dem Stand vor dem Test:

| Tabelle | vor dem Test | nach dem Test |
|---|---|---|
| `entity_review_queue` | 27 (18 merged, 9 rejected, **0 offen**) | 27 (18 merged, 9 rejected, **0 offen**) |
| `entity_aliases` | 22 | 22 |
| `entity_merge_log` | 23 (18 completed, 5 failed) | 23 (18 completed, 5 failed) |
| `entity_embeddings` | 0 | 0 |

`git status` ist sauber; die einzige neue Datei ist dieser Bericht.

### 7.2 Bleibt zurück

**In Paperless-ngx: nichts.** Es wurde kein Dokument hochgeladen, keine
Entität angelegt, umbenannt, gelöscht oder gemergt, und kein Dokument
verändert. Der Merge-Pfad lief ausschließlich als `dryRun`.

**In der Konfiguration: nichts.** `data/.env` ist unverändert; der A/B-Test
hat `config.useExistingData` nur im Speicher seines eigenen Prozesses
umgeschaltet.

**Außerhalb des Projektverzeichnisses** liegen die Rohdaten dieses Tests im
Scratchpad der Session (Konfigurations- und DB-Dumps, Bestandsaufnahme,
Judge- und Latenzmessungen, Embedding-Gegenprobe, A/B-Rohdaten, gerenderte
HTML-Seiten, eine Sicherungskopie von `data/entities.db` und `data/.env` von
vor dem Test). Sie enthalten personenbezogene Daten aus dem Bestand und sind
bewusst **nicht** ins Repository übernommen worden.

**Vorgefunden und unangetastet gelassen** (kein Testartefakt, aber
erwähnenswert, weil in 7.1 nicht enthalten): die beiden fertigen Git-Worktrees
unter `.claude/worktrees/` (`nachaudit-lint-cleanup`,
`nachaudit-paket4-fingerprint`), die A-10 auslösen.

---

## 8. Einschränkungen dieses Tests

- **Ein Bestand, eine Hardware.** Alle Messungen stammen von einer Instanz mit
  64 Dokumenten und einem `qwen2.5:7b-instruct-q4_K_M` auf dieser Maschine.
  Insbesondere die Judge-Latenz (A-3) und die Trennschärfe der
  Embedding-Schwellen (A-4) sind hardware- und modellabhängig; die
  *Schlussfolgerung* (Timeout unter Medianlatenz; Klassenüberlappung) ist es
  nicht, die konkreten Zahlen schon.
- **Kein echter Merge durchgeführt.** Der Merge-Pfad wurde ausschließlich als
  `dryRun` geprüft. Die Aussagen zu B-3/B-4 beruhen auf den Preview-Antworten
  und dem Client-Code, nicht auf einem vollzogenen Merge.
- **Die UI wurde als gerendertes HTML geprüft, nicht im Browser geklickt.**
  Aussagen zu Layout, Tastaturbedienung, Kontrast und Mobilansicht sind daher
  bewusst nicht enthalten; die Befunde in Teil B beziehen sich auf Inhalt,
  Informationsgehalt und Client-Logik.
- **Der A/B-Test umfasst 3 Dokumente.** Er belegt die Richtung des Effekts
  belastbar (Platzhalterausgabe verschwindet, Ergebnisse werden stabil), ist
  aber keine Quotenmessung. Für eine solche wäre
  `scripts/dry-run-eval.js --repeat` über den ganzen Bestand der richtige Weg —
  bei ~2–4 min je Klassifikation entspricht das mehreren Stunden Laufzeit.
- **Nicht geprüft:** RAG/Chat, die übrigen LLM-Provider (`AI_PROVIDER=ollama`
  war gesetzt), der Fingerprint-Pfad im Betrieb (Feature aus), Sicherheit
  (Gegenstand des Erst- und Nachaudits).
