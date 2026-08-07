# Fixplan: Konsistenz-Kette und Review-UI

**Datum:** 2026-08-06
**Grundlage:** [Konsistenz- und Merge-/Review-UI-Test vom 2026-08-06](2026-08-06-konsistenz-merge-ui-test.md)
(Befunde A-1 bis A-10, B-1 bis B-13)
**Art:** abarbeitbarer Umsetzungsplan, entstanden aus einer Planungsrunde nach
dem Test. Enthält keine Umsetzung — nur Aufgaben, Begründungen und
Abnahmekriterien.
**Stand:** noch nicht begonnen

**Namenskonvention:** wie im Testbericht sind Namen natürlicher Personen,
Firmen, Anschriften und Nummern durch Platzhalter ersetzt (`<Inhaber>`,
`<AG>`, `<FirmaD>` …). Der Fork ist öffentlich.

---

## Leitgedanke

Der Test hat gezeigt: die fünf Roadmap-Phasen sind als Code vorhanden, aber die
Kette ist an vier Stellen unterbrochen, und keine der Unterbrechungen ist im
Betrieb sichtbar. Daraus folgt die Reihenfolge dieses Plans:

> **Erst die Kette wieder schließen, dann die Altdaten, dann die Oberfläche.**

Die Begründung ist nicht Geschmack, sondern Abhängigkeit. Solange der Judge
nicht antwortet und das Modell den Bestand nicht sieht, produziert jeder
Durchgang neue Dubletten — eine aufgeräumte Datenbasis wäre binnen Tagen
wieder verschmutzt, und eine bessere Review-UI würde nur mehr Arbeit schöner
darstellen. Umgekehrt gilt: nach Paket 1 bekommt die Review-Queue **weniger
und bessere** Einträge, und erst dann lohnt der Umbau der Oberfläche.

---

## Arbeitsplan

1. [x] **Paket 1 — Kette reparieren** (A-9, A-10, A-3, A-2, A-1, A-6-Teil,
   plus Versionierung der gemessenen Betriebswerte)
   → Muss zuerst. Alles Weitere baut darauf auf.
   **Abgenommen am 2026-08-06.** Implementierungsplan:
   [docs/superpowers/plans/2026-08-06-paket1-kette-reparieren.md](../superpowers/plans/2026-08-06-paket1-kette-reparieren.md).
   Alle fünf Abnahmekriterien erfüllt:
   1. `npm test` 486/486 grün, `npm run lint` 0 problems.
   2. Judge-Messung über 27 reale Namenspaare (aus `entity_review_queue` dieser
      Instanz): **0 Timeouts**, Median 7606 ms, Max 14552 ms (Budget < 15 000 ms).
      Ein Aufruf (19223 ms) scheiterte nicht am Timeout, sondern an einem
      JSON-Parse-Fehler auf einem Korrespondenten-Vorschlag, der einen
      eingebetteten Zeilenumbruch enthielt (`"Winning Plastics Druckdatum
      . . : 16.02.2024\nDiepersdorf GmbH Erster Versand : 29.01.2024"` — klar
      Extraktionsmüll, kein echter Name). Die Resolver-Kaskade fängt genau
      diesen Fall bereits korrekt als `unavailable` ab (1.1.c) statt
      abzustürzen — kein neuer Befund an der Kette, aber ein Hinweis auf
      unsaubere Altdaten für Paket 2.
   3. Dry-Run über Dokumente 127, 129, 147 mit `--repeat 2`: **3 von 3
      stabil**, Dokumentart durchgehend „Entgeltabrechnung" (kein
      Platzhalter-Artefakt).
   4. `entity_aliases` enthält keine der drei falschen Zuordnungen mehr
      (geprüft nach Löschung, 0 verbleibend).
   5. Der Abschnitt „Gemessene Betriebswerte" existiert in
      [docs/planning/klassifikations-konsistenz-roadmap.md](../planning/klassifikations-konsistenz-roadmap.md)
      und ist committet (`4ab1003`, ergänzt um `USE_EXISTING_DATA` in `944656d`).

   **Zusätzlich bei der Abnahme erledigt:** `USE_EXISTING_DATA=yes` in
   `data/.env` gesetzt (1.3.a); die drei falschen Aliase per SQL entfernt,
   Sicherung von `data/entities.db` außerhalb des Projektverzeichnisses
   angelegt (1.4).

   **Für Paket 2 vorgemerkt (aus der Durchsicht der übrigen 19 Aliase,
   1.4-Zusatzschritt):** `invoice contract` → Dokumentart `contract` (durch
   1.2.a an der Quelle geschlossen, Alias besteht aber fort); `personal nr
   <Nr>` → Korrespondent „Personal-Nr. <Nr>" (`auto`-Quelle, 0 Dok); **zwei**
   `herrn <inhaber>`-Aliase (`auto`- und `user`-Quelle) → Korrespondent „Herr
   <Inhaber>" — beide zeigen auf den Empfänger statt den Absender, wie im
   Fixplan vorhergesagt.

2. [x] **Paket 2 — Altdaten bereinigen** (Folge von A-1/A-2, plus FIX-01)
   → Setzt Paket 1 voraus: vor der Reparatur aufzuräumen wäre verlorene Arbeit.

3. [ ] **Paket 3 — Review-/Merge-UI** (B-1 bis B-13, A-6-Rest)
   → Setzt Paket 1 voraus, damit die UI gegen realistische Datenmengen
   entworfen wird statt gegen die heutige Flut aus Timeout-Einträgen.

**Bewusst nicht in diesem Plan:** A-4 (Embedding-Kanal). Die Entscheidung
darüber wird vertagt, siehe „Vertagte Entscheidungen".

---

## Entscheidungen dieser Planungsrunde

Festgehalten mit Begründung, damit später nachvollziehbar ist, warum der Plan
so und nicht anders geschnitten ist.

### E-1 — Kein neues Judge-Modell. Timeout hoch und Begründung kappen.

Der Testbericht hatte als Möglichkeit genannt, für den Judge ein kleineres
Modell zuzulassen (`ENTITY_JUDGE_MODEL`). **Eine Nachmessung in der
Planungsrunde hat das widerlegt** — es braucht keine Infrastrukturänderung.

Die Latenz wurde in Prompt-Verarbeitung und Generierung zerlegt (6 reale
Namenspaare, `qwen2.5:7b-instruct-q4_K_M`, jeweils über die
`/api/generate`-Felder `prompt_eval_duration`/`eval_duration`):

| Variante | Median gesamt | davon Generierung | davon Prompt | Verdikte |
|---|---|---|---|---|
| Ist (`num_predict=200`, freie Begründung) | **20 424 ms** | 16 152 ms / 57 Token | 1 376 ms / 142 Token | same, different, unsure, same, different, different |
| Begründung gekappt (`num_predict=60`, „höchstens 8 Wörter") | **8 361 ms** | 6 367 ms / 22 Token | 2 453 ms / 158 Token | **identisch** |

Der Judge verbringt rund 80 % seiner Zeit damit, eine Freitext-Begründung zu
schreiben. Kappen halbiert die Latenz **bei identischen Verdikten**, und die
Begründungen bleiben brauchbar (30–46 Zeichen statt 76–346).

Zweite Beobachtung aus derselben Messung: die Latenz streut stark und
**unabhängig von der Tokenzahl** — zwei der sechs gekappten Läufe brauchten
trotz nur 20 Token 26 s bzw. 30 s (Token-Rate schwankt um Faktor 4,6). Ein
Timeout muss deshalb großzügig bleiben, auch wenn die Antwort kurz ist.

### E-2 — Judge bleibt synchron im Scan-Pfad.

Ebenfalls im Testbericht als Option genannt (Judge asynchron, Urteil erst beim
Öffnen der Review-Seite holen). Bei ~0,4 Judge-Aufrufen je Dokument (28 Aufrufe
über 64 Dokumente im Produktivlauf) und 8 s Median nach E-1 kostet das rund
3 s je Dokument. Ein Umbau lohnt dafür nicht.

### E-3 — Drei Pakete, Verifikation als Abnahmekriterium statt als eigenes Paket.

Entspricht dem Aufbau von
[2026-08-04-nachaudit-offene-punkte.md](2026-08-04-nachaudit-offene-punkte.md).
Eine eigene Verifikationsrunde wäre Zeremonie: die Messung *ist* der Nachweis,
dass Paket 1 fertig ist, also gehört sie in dessen Abnahme.

### E-4 — Die drei falschen Aliase gehören in Paket 1, nicht zu den Altdaten.

Anders als die 59 Einmal-Tags, die inert herumliegen, verfälschen
`austrittsdatum → Eintrittsdatum`, `september 2025 → November 2025` und
`urlaubsverguetung → Ausbildungsvergütung` **jedes künftige Dokument**, bevor
irgendeine andere Stufe der Kaskade greift. Sie sind ein aktiver Fehler der
Kette, keine Altlast.

### E-5 — Altdaten: erst gezielte Handarbeit in Paperless, Rescan nur wenn danach noch nötig.

Ein Rescan ist teuer (~1 h) und schreibt das Archiv um. Die teuersten
Einzelfälle brauchen ihn gar nicht: `contract` mit 20 Dokumenten ist ein
Bulk-Edit in Paperless-ngx, die 7 leeren Dokumentarten sind ein Löschvorgang.
Hinzu kommt ein Reihenfolge-Argument: `USE_EXISTING_DATA=yes` zeigt dem Modell
den **aktuellen** Bestand — ein Rescan vor dem Aufräumen böte ihm weiterhin
`contract`, `Payroll Statement` und `Meldebeschreibung` zur Auswahl an.

### E-6 — Gemessene Betriebswerte gehören ins Repository, nicht nur in `data/.env`.

Die eigentliche Ursache von A-4 ist nicht, dass jemand einen Schalter
umgelegt hat, sondern dass die gemessenen Werte nirgends versioniert waren und
beim Neuaufsetzen am 2026-08-05 verloren gingen. `.env.example` kann das nicht
leisten — es ist der ausgelieferte Default, nicht die Konfiguration dieser
Instanz.

---

## Paket 1 — Kette reparieren

**Warum zusammen:** Alle Punkte betreffen denselben Pfad — vom Prompt über die
Modellantwort bis zur Resolver-Entscheidung. Einzeln umgesetzt müsste jeder für
sich verifiziert werden, und die Verifikation ist der teure Teil (Dry-Run-Läufe
dauern Stunden). Der A/B-Test aus dem Testbericht hat `USE_EXISTING_DATA`
bereits isoliert gemessen, eine erneute Einzelmessung bringt nichts.

### 1.0 — Hygiene: Testlauf und Lint wieder als Kontrolle brauchbar machen

- **Bezug:** A-9, A-10 · **Aufwand:** ~10 Zeilen · **Risiko:** keines
- **Warum zuerst:** Solange `npm test` 458/460 und `npm run lint` 211 Fehler
  meldet, sieht man während der folgenden Änderungen nicht, ob man etwas kaputt
  gemacht hat. Das ist der einzige Grund für die Reihenfolge.

**1.0.a — Testisolation (A-9).**
`test/entityResolverHookIn.test.js`, die beiden Tests bei Zeile 106 und 125:
`config.addAIProcessedTag` explizit auf `'no'` setzen und im `finally`
zurücksetzen. Das Muster steht in derselben Datei bereits für
`config.entityResolver.enabled`. Gegenprobe ist bereits erbracht:
`ADD_AI_PROCESSED_TAG=no node --test test/entityResolverHookIn.test.js`
liefert 31/0 statt 29/2.

**1.0.b — ESLint-Ausschlüsse (A-10).**
`eslint.config.mjs` hat keinen `ignores`-Block. Ergänzen:
`{ ignores: ['.claude/**', 'data/**'] }`. Zusätzlich die beiden fertigen
Worktrees entfernen (`git worktree remove .claude/worktrees/nachaudit-lint-cleanup`
und `…/nachaudit-paket4-fingerprint`). Alle 211 Meldungen stammen von dort;
der versionierte Quellcode ist sauber.

**Test:** `npm test` grün, `npm run lint` meldet `0 problems`.

### 1.1 — Den Judge zum Antworten bringen

- **Schweregrad des zugrunde liegenden Befunds:** Critical · **Bezug:** A-3,
  AUDIT-028
- **Dateien:** `services/entityJudge.js`, `services/entityResolver.js`,
  `config/config.js`, `.env.example`

**1.1.a — Timeout konfigurierbar, Default 60 000 ms.**
`services/entityJudge.js:47` hat `axios.create({ timeout: 15000 })` fest
verdrahtet. Neue Variable `ENTITY_JUDGE_TIMEOUT_MS` in `config/config.js`
(Default `60000`), von dort lesen.

*Warum 60 000 und nicht 20 000:* gemessenes Maximum 32 021 ms, und die
Token-Rate schwankt um Faktor 4,6 (siehe E-1). Ein knapp bemessener Timeout
würde denselben Fehler in kleinerem Maßstab wiederholen.

**1.1.b — Begründung kappen.**
`services/entityJudge.js:75`: `num_predict` von `200` auf `60`. Im Prompt
(`:62-63`) ergänzen: `\nBegruendung: hoechstens 8 Woerter.` Messung siehe E-1.

**1.1.c — Timeout ≠ Modellunsicherheit.**
`services/entityResolver.js:223-226` gibt bei **jedem** Fehler
`{ verdict: 'unsure', … }` zurück. Ein ausgefallener Judge ist damit von einem
echten „ich weiß es nicht" nicht unterscheidbar — genau daran ist der
Produktivlauf vom 2026-08-05 unbemerkt gescheitert (25 von 27 Einträgen
`unsure`).

*Erwartetes Verhalten:* Bei Fehler `{ verdict: 'unavailable', reason: … }`.
Die Kaskade behandelt `unavailable` **exakt wie** `unsure` (also
`create_and_queue`) — es ändert sich nur die Beschriftung, nicht der
Kontrollfluss. Kein Schema-Change nötig, `entity_review_queue.llm_verdict` ist
`TEXT`. Bestehende Zeilen bleiben unangetastet (alle 27 sind bereits
abgeschlossen).

*Zu beachten:* `_askJudge` prüft heute
`['same','different','unsure'].includes(result.verdict)` und wandelt alles
andere in `unsure` um. Diese Prüfung betrifft die **Modell**antwort und muss so
bleiben — `unavailable` darf nur aus dem `catch`-Zweig kommen, nie aus dem
Modell.

**1.1.d — Langsame Judge-Aufrufe sichtbar machen.**
Warnung ins Log, wenn ein Aufruf länger als 50 % des konfigurierten Timeouts
braucht. Billiger und aussagekräftiger als ein Probe-Aufruf beim Start (der
8 s Startzeit kosten würde) und hätte den Befund A-3 von selbst sichtbar
gemacht.

**Empfohlene Tests:**
- Judge liefert bei Timeout `verdict: 'unavailable'`, nicht `'unsure'`.
- Kaskade behandelt `unavailable` wie `unsure` (Ergebnis `create_and_queue`).
- Eine Modellantwort mit dem Wort `unavailable` im `verdict`-Feld wird
  weiterhin zu `unsure` normalisiert (kein Weg für das Modell, einen
  Infrastrukturzustand vorzutäuschen).
- `ENTITY_JUDGE_TIMEOUT_MS` wird gelesen; Default ist 60 000.

### 1.2 — Prompt-Platzhalter beseitigen

- **Schweregrad:** High · **Bezug:** A-2
- **Dateien:** `config/config.js:274-285`, `services/ollamaService.js`

**1.2.a — `mustHavePrompt` neutralisieren.**
Die Vorlage enthält `"document_type": "Invoice/Contract/..."`. Der Wert
erscheint wörtlich als Klassifikationsergebnis — im Test zweimal live
reproduziert, und aus ihm ist die Dokumentart `contract` entstanden, die heute
**20 von 64 Dokumenten** trägt.

Alle Platzhalter derselben Bauart mitnehmen, nicht nur den einen:
`"tags": ["Tag1", "Tag2", …]` und `"language": "en/de/es/..."` sind derselbe
Fehlertyp, bisher nur folgenlos geblieben. Konsequent neutralisieren ist
billiger, als je Platzhalter zu argumentieren, ob er gefährlich ist.

*Zu beachten:* `mustHavePrompt` wird in **beiden** Zweigen von `_buildPrompt`
angehängt (`services/ollamaService.js:240` und `:242`) — die Änderung wirkt
also unabhängig von `USE_EXISTING_DATA`.

**1.2.b — `custom_fields` nur im Schema, wenn aktiviert.**
`services/ollamaService.js:39-42` erlaubt `custom_fields` mit
`additionalProperties: true`, obwohl `ACTIVATE_CUSTOM_FIELDS=no` gesetzt ist.
Das Modell füllt das Feld ungefragt mit erfundenen Schlüsseln — im Testlauf
mit einer Steuer-ID und einer IBAN. Die Werte werden downstream verworfen,
verbrauchen aber vom `num_predict`-Budget und würden bei
`PROMPT_LOGGING_ENABLED=yes` in `logs/prompt.txt` landen.

*Erwartetes Verhalten:* `custom_fields` nur dann Teil von
`documentAnalysisSchema`, wenn `config.limitFunctions.activateCustomFields`
`'yes'` ist.

**1.2.c — `_isPlausibleDocumentType` ergänzen.**
`services/ollamaService.js:542` (`_normalizeParsedDocument`) filtert bereits
Tags über `_isPlausibleTag` (`:498`: Doppelpunkt, > 60 Zeichen). Für
`document_type` gibt es keine Entsprechung. Analoge Prüfung ergänzen und im
selben `_normalizeParsedDocument` anwenden: ein Wert mit `/` oder `...` oder
über 60 Zeichen ist erkennbar kein Kategoriename.

*Warum zusätzlich zu 1.2.a:* 1.2.a beseitigt die bekannte Quelle, 1.2.c fängt
die nächste ab. Der Filter für Tags existiert aus genau demselben Grund
(Phase 1, Schritt 8, nach dem Baseline-Lauf ergänzt).

**Empfohlene Tests:**
- `_buildPrompt` enthält in beiden Zweigen keinen Wert, der wie ein
  Beispieldatum aussieht (`Invoice`, `Contract`, `Tag1`, `en/de/es`).
- `documentAnalysisSchema` enthält `custom_fields` bei
  `activateCustomFields='no'` nicht und bei `'yes'` schon.
- `_isPlausibleDocumentType` verwirft `Invoice/Contract/...` und behält
  `Entgeltabrechnung`.
- `_normalizeParsedDocument` verwirft eine unplausible Dokumentart und
  protokolliert das (analog zur bestehenden Tag-Warnung).

### 1.3 — Bestandsabgleich einschalten

- **Schweregrad:** Critical (für Konsistenz) · **Bezug:** A-1, A-8
- **Dateien:** `data/.env`, `.env.example`, `server.js` oder `config/config.js`

**1.3.a — `USE_EXISTING_DATA=yes` in `data/.env`.**
Reine Konfiguration, jederzeit rücknehmbar. Der A/B-Test aus dem Testbericht
(A-8) hat den Effekt gemessen: 1 von 3 Dokumenten stabil → **3 von 3**,
4 verschiedene Dokumentarten → **1**, 1 unbrauchbarer Lauf → **0**. Die sechs
`yes`-Läufe lieferten über drei verschiedene Dokumente hinweg zwölfmal
denselben Wert, alle bereits im Bestand vorhanden.

*Token-Kosten sind unkritisch:* der System-Prompt wächst von 1 497 auf 2 180
Token bei `OLLAMA_NUM_CTX_MAX=8192`, und `_fitPromptToContext` kürzt bei Enge
ausschließlich den Dokumententext und meldet das laut.

**1.3.b — Widerspruch beim Start melden.**
Der konfigurierte `SYSTEM_PROMPT` weist das Modell an, „Pre-existing tags /
correspondents / document types" zuerst zu prüfen. Bei
`USE_EXISTING_DATA=no` stehen diese Listen nie im Prompt — die Regel läuft ins
Leere, unsichtbar. Warnung beim Start, wenn `SYSTEM_PROMPT` die Zeichenkette
`Pre-existing` enthält und `USE_EXISTING_DATA` nicht `yes` ist.

**1.3.c — `.env.example` auf `yes` umstellen.**
Betrifft den ausgelieferten Default des Forks, nicht nur diese Instanz.
Begründung: der gemessene Effekt ist groß, das Token-Risiko wird von
`_fitPromptToContext` sauber abgefangen und protokolliert, und die
Resolver-Kaskade darunter ergibt ohne diesen Schalter kaum Sinn. Den
README-Abschnitt „Entity Resolution & Similarity Matching" entsprechend
ergänzen.

**Empfohlene Tests:**
- Die Startup-Warnung erscheint bei `Pre-existing` im Prompt + `no`, und nicht
  bei `yes`.
- Der bestehende Test „bei `useExistingData=yes` stehen die Bestandslisten im
  system-Teil" (`test/ollamaPrompt.test.js:50`) bleibt grün.

### 1.4 — Die drei falschen Aliase entfernen

- **Schweregrad:** High · **Bezug:** A-6, NACHAUDIT-08 · **Siehe E-4**

Aktueller Zustand, gegen den echten Bestand aufgelöst:

| Alias (normalisiert) | zeigt auf | Quelle |
|---|---|---|
| `austrittsdatum` | Tag „Eintrittsdatum" (1 Dok) | `user` |
| `september 2025` | Tag „November 2025" (2 Dok) | `user` |
| `urlaubsverguetung` | Tag „Ausbildungsvergütung" (3 Dok) | `user` |

Der Judge bestätigt heute für alle drei Paare `different` — nachgemessen im
Testbericht, Abschnitt A-3.

**Vorgehen: dokumentierter SQL-Schritt, kein neues Skript.** Paket 3 bringt die
Alias-Verwaltung in der Oberfläche; ein Wegwerfskript wäre Ballast. Vor dem
Eingriff `data/entities.db` sichern.

```sql
-- data/entities.db, vorher sichern. Server gestoppt.
DELETE FROM entity_aliases
WHERE entity_type = 'tag'
  AND alias_normalized IN ('austrittsdatum', 'september 2025', 'urlaubsverguetung');
```

*Zu beachten:* Die zugehörigen Merges in Paperless werden dadurch **nicht**
rückgängig gemacht — die Dokumente tragen weiterhin die falschen Tags. Das ist
Gegenstand von Paket 2. Dieser Schritt sorgt nur dafür, dass der Fehler sich
nicht weiter fortpflanzt.

**Zusätzlich:** die übrigen 19 Aliase einmal durchsehen. Auffällig sind
mindestens `invoice contract` → Dokumentart `contract` (wird mit 1.2.a
gegenstandslos, der Alias bleibt aber bestehen) und die `auto`-Aliase
`personal nr <Nr>` → Korrespondent „Personal-Nr. <Nr>" (0 Dok) sowie
`herrn <inhaber>` → Korrespondent „Herr <Inhaber>" (3 Dok, Empfänger statt
Absender).

### 1.5 — Gemessene Betriebswerte versionieren

- **Schweregrad:** Medium · **Bezug:** Ursache von A-4 · **Siehe E-6**

Neuer Abschnitt „Gemessene Betriebswerte" in
[docs/planning/klassifikations-konsistenz-roadmap.md](../planning/klassifikations-konsistenz-roadmap.md):
je Wert **was gemessen wurde, wann, womit, und was daraus in `data/.env`
gehört**. Mindestens:

| Variable | gemessener Wert | Quelle |
|---|---|---|
| `ENTITY_RESOLVER_AUTO_THRESHOLD` | 0.8 | Phase-2-Tuning; im Test 2026-08-06 bestätigt (5 von 5 Auto-Merges korrekt, höchster Wert 0.848 — 0.90 hätte alle fünf verhindert) |
| `ENTITY_RESOLVER_JUDGE_MIN` | 0.5 | Phase-2-Tuning |
| `EMBEDDING_EXCLUDED_TYPES` | `tag` | Phase-5-Messung 2026-08-02 |
| `EMBED_AUTO_THRESHOLD` / `EMBED_JUDGE_MIN` | offen | siehe „Vertagte Entscheidungen" |
| `FINGERPRINT_SIMILARITY_THRESHOLD` | ungemessen | NACHAUDIT-10, weiterhin offen |
| `ENTITY_JUDGE_TIMEOUT_MS` | 60 000 | Messung E-1, 2026-08-06 |

Die Werte gehören in die Roadmap und nicht in `.env.example` — letzteres ist
der ausgelieferte Default für fremde Installationen, nicht die Konfiguration
dieser Instanz.

### Abnahmekriterium Paket 1

Alle fünf müssen erfüllt sein:

1. `npm test` grün, `npm run lint` meldet `0 problems`.
2. **Judge-Messung** über mindestens 12 reale Namenspaare: **0 Timeouts**,
   Median unter 15 000 ms. *Hinweis:* `scripts/dry-run-eval.js` kann das
   **nicht** leisten — es ruft ausschließlich `analyzeDocument` auf und
   berührt die Resolver-Kaskade nie (steht so im Kopfkommentar). Es braucht
   eine eigene, lesende Messung gegen `entityJudge`.
3. **Dry-Run** über dieselben drei Dokumente wie im Testbericht (127, 129, 147)
   mit `--repeat 2`: **3 von 3 stabil**, und **kein** Lauf mit einer
   Dokumentart, die einem Prompt-Platzhalter ähnelt.
4. `entity_aliases` enthält keine der drei falschen Zuordnungen mehr.
5. Der Abschnitt „Gemessene Betriebswerte" existiert und ist committet.

---

## Paket 2 — Altdaten bereinigen

**Warum zusammen:** Alle Punkte betreffen den bereits entstandenen Wildwuchs,
nicht den Mechanismus. **Setzt Paket 1 zwingend voraus** — vor der Reparatur
aufzuräumen hieße, dieselbe Arbeit nach dem nächsten Scan erneut zu machen.

**Ausgangslage (Bestandsaufnahme 2026-08-06, 64 Dokumente):**

| | Anzahl | davon auffällig |
|---|---|---|
| Tags | 85 | **59 genau einmal benutzt**, 12 zweimal |
| Dokumentarten | 28 | **7 mit 0 Dokumenten**, 12 mit genau einem |
| Korrespondenten | 25 | 4 Varianten des Empfängers, 4 Varianten des Arbeitgebers |

### FIX-01 — `reset-all-documents` löscht den Rückweg mit (neuer Befund)

- **Schweregrad:** High · **Bereich:** Datenintegrität · **Gefunden bei:** dieser Planung
- **Dateien:** `models/document.js:329-342` (`deleteAllDocuments`),
  `routes/setup.js:1336` (`POST /api/reset-all-documents`),
  `models/document.js:344-379` (`deleteDocumentsIdList`, gleiches Muster)

**Beobachtetes Verhalten:** `deleteAllDocuments()` löscht neben
`processed_documents` und `history_documents` auch **`original_documents`**
(Zeile 335). Das ist der vor der KI-Verarbeitung gesicherte Zustand — die
einzige Grundlage für `restoreOriginalData` aus NACHAUDIT-12. Ein Reset
vernichtet also den Rückweg für alle 64 Dokumente, **bevor** der Rescan
beginnt, der ihn nötig machen würde. `POST /api/reset-documents`
(`deleteDocumentsIdList`) hat dasselbe Muster für einzelne IDs.

**Warum das nicht auffällt:** Die Leseseite ist bereits korrekt gebaut —
`getOriginalData` nimmt `ORDER BY id ASC LIMIT 1` (`models/document.js:277`),
also bewusst den ältesten Stand, mit passendem Kommentar. Ein erneuter Lauf
**ohne** Reset hängt lediglich eine zweite Zeile an, und der echte Vorzustand
überlebt. Der Datenverlust entsteht ausschließlich durch das Löschen.

**Erwartetes Verhalten:** „Verarbeitungsstatus zurücksetzen, damit erneut
verarbeitet werden kann" sollte den vor-KI-Zustand nicht wegwerfen.
`original_documents` von beiden Löschpfaden ausnehmen.

**Vorgehen in diesem Paket:** Der Code wird hier **nicht** geändert
(eigener Befund, eigener Fix). Für den Rescan wird der Reset stattdessen als
dokumentierter SQL-Schritt ausgeführt:

```sql
-- data/documents.db, vorher sichern. Server gestoppt.
DELETE FROM processed_documents;
-- original_documents und history_documents bleiben absichtlich stehen.
```

### 2.0 — Vorbedingungen

- Sicherung von `data/documents.db` **und** `data/entities.db` außerhalb des
  Projektverzeichnisses.
- Paket 1 abgenommen (alle fünf Kriterien).
- `DISABLE_AUTOMATIC_PROCESSING=yes` bleibt gesetzt, bis der Rescan bewusst
  ausgelöst wird — sonst startet ein Serverstart sofort einen Scan.

### 2.1 — Vokabular konsolidieren (vor jedem Rescan)

**Siehe E-5.** Diese Schritte laufen direkt in Paperless-ngx, ohne die
Review-UI und ohne Rescan:

1. **`contract` auflösen.** 20 Dokumente per Bulk-Edit auf `Entgeltabrechnung`
   umhängen, danach `contract` löschen. Herkunft: der Prompt-Platzhalter aus
   A-2, mit 1.2.a an der Quelle geschlossen.
2. **Die 7 leeren Dokumentarten löschen.** Rückstände aus den Merges vom
   2026-08-05 — sie erscheinen in jeder Bestandsliste und damit ab 1.3.a auch
   im Prompt.
3. **Deutsch/englische Paare zusammenführen**, die Trigram strukturell nie
   sieht: `Payroll Statement` → `Entgeltabrechnung`,
   `salary tax certificate` → `Lohnsteuerbescheinigung`,
   `Practicum Confirmation` → `Praktikumsbestätigung`,
   `Notification` → `Mitteilung`/`Bescheid`. Ebenso bei den Tags:
   `Personal Data` → `Persönliche Daten`, `Electronic Document` /
   `elektronisch`, `Tax Document`, `Invoice`, `Curriculum Vitae`.
4. **Die drei fehlerhaft gemergten Tags korrigieren** (Gegenstück zu 1.4):
   die Dokumente, die durch die Fehl-Merges vom 2026-08-05 falsche Tags
   tragen, in Paperless zurückstellen. Betroffen sind laut `entity_merge_log`
   je ein Dokument pro Fall.
5. **Die Empfänger-Korrespondenten bereinigen.** Vier Varianten des
   Dokumentinhabers stehen als Korrespondent im Bestand, einer davon mit
   Wohnanschrift im Namen. Sie sind laut System-Prompt gar keine gültigen
   Korrespondenten und gehören entfernt, nicht zusammengeführt — sonst bietet
   der Prompt sie ab 1.3.a aktiv zur Wiederverwendung an.

### 2.2 — Rescan: Entscheidung, keine Zusage

Erst **nach** 2.1 und mit den dann bekannten Zahlen entscheiden.

**Dafür:** Die 59 Einmal-Tags sind das Ergebnis von 64 Einzelklassifikationen
ohne Bestandskenntnis. Nur eine Neuklassifikation gegen das aufgeräumte
Vokabular räumt sie strukturell weg; von Hand wäre das 59-mal dieselbe
Entscheidung.

**Dagegen:** ~1 h Laufzeit (nach A-8 24–97 s je Dokument mit
`USE_EXISTING_DATA=yes`), das Archiv wird einmal umgeschrieben, und der
Resolver legt dabei neue Aliase und Queue-Einträge an, die wieder durchgesehen
werden müssen — mit der Review-UI im Zustand vor Paket 3.

**Wenn ja, dann so:** Reset ausschließlich per SQL (siehe FIX-01), Scan bewusst
auslösen, danach die verwaisten Entitäten in Paperless löschen.

**Entscheidung (nachgetragen nach Ausführung von 2.1, 2026-08-07):** Nein, kein
Rescan — die Zahlen nach 2.1 bestätigen die Prognose der Planungsrunde: Tags
83 statt 85 (2 durch diesen Paket-Lauf zusammengeführt), davon weiterhin
**57 genau einmal benutzt** (Baseline: 59) — die Vokabularbereinigung allein
senkt die Einmal-Tag-Zahl kaum, weil diese 57 aus 64 unabhängigen
KI-Klassifikationen ohne Bestandskenntnis stammen, nicht aus
Vokabular-Duplikaten, die dieses Paket fassen konnte. Dokumentarten stehen bei
14 (vorher 28), keine mit 0 Dokumenten. Die ~1 h Laufzeit, die einmalige
Archiv-Umschreibung und die neue Review-Last, die ein Rescan erzeugt,
überwiegen den Nutzen gerade jetzt — zumal Paket 3 (die Review-/Merge-UI)
noch nicht gebaut ist: die Durchsicht der frischen Resolver-Ausgabe fände in
genau der rauen Review-UI statt, vor der das „Dagegen"-Argument oben (Zeile
505–508) warnt. Die 57 verbleibenden Einmal-Tags sind real, gemessen und
dokumentiert — Material für einen späteren Rescan, sobald Paket 3 die
Durchsicht sicher und angenehm statt riskant macht, keine Entscheidung gegen
einen Rescan für immer.

### Abnahmekriterium Paket 2

1. Dokumentarten von 28 auf unter 15 reduziert, **keine** mit 0 Dokumenten.
2. `contract` existiert nicht mehr; die 20 Dokumente tragen eine deutsche
   Dokumentart.
3. Kein Korrespondent trägt mehr eine Anrede, eine Anschrift oder eine
   Personalnummer im Namen.
4. Sicherungen beider Datenbanken nachweislich vorhanden und außerhalb des
   Projektverzeichnisses abgelegt.
5. Die Entscheidung zu 2.2 ist mit Begründung in diesem Dokument nachgetragen.

**Status (nachgetragen nach Ausführung, 2026-08-07):**

1. **Bestanden.** 14 Dokumentarten (vorher 28), keine mit 0 Dokumenten.
2. **Bestanden.** `contract` existiert nicht mehr; die 20 betroffenen
   Dokumente tragen `Entgeltabrechnung` — das Merge-Ziel war bereits deutsch.
3. **Bestanden, mit Einschränkung.** Der ursprünglich geplante Umfang (die
   vier Empfänger-Varianten aus 2.1 Punkt 5) hat für sich allein **nicht**
   gereicht. Eine vollständige manuelle Durchsicht nach der Ausführung fand
   drei weitere Korrespondenten außerhalb dieses geplanten Umfangs, die das
   Kriterium noch immer verletzten. Ein Nachlauf hat die Lücke geschlossen:
   zwei Korrespondenten ohne ein einziges Dokument wurden gelöscht, ein
   dritter — eine echte, eigenständige Person, ein Familienmitglied von
   `<Inhaber>` mit derselben Anschrift im Namen — wurde umbenannt, um die
   Anschrift aus dem Namen zu entfernen, statt gelöscht zu werden. Erst mit
   diesem Nachlauf ist das Kriterium über den gesamten Korrespondentenbestand
   hinweg erfüllt.
4. **Bestanden.** Sicherungen beider Datenbanken bestätigt unter
   `paperless-jo-backups\2026-08-06\` außerhalb des Projektverzeichnisses,
   Größen passend zu `data/documents.db`/`data/entities.db`.
5. **Bestanden.** Die Entscheidung zu 2.2 ist oben mit Begründung
   nachgetragen (siehe „Entscheidung (nachgetragen nach Ausführung von 2.1,
   2026-08-07)" unter 2.2).

---

## Paket 3 — Review-/Merge-UI

**Warum zusammen:** Alle Punkte betreffen `views/review.ejs`,
`public/js/review.js` und `routes/review.js`. **Setzt Paket 1 voraus**, damit
die Oberfläche gegen realistische Datenmengen entworfen wird und nicht gegen
die heutige Flut aus Timeout-Einträgen.

**Reihenfolge nach Risiko, nicht nach Aufwand.** Die ersten beiden Punkte
machen die Arbeit *sicher* — ohne sie ist jeder Durchgang durch die Queue ein
Risiko. Alles Weitere macht sie *angenehmer*.

### 3.1 — Merge-Richtung umkehrbar machen (B-3)

`services/entityBackfillService.js:40` legt die Richtung technisch fest:
„ältere (kleinere) ID gilt als kanonisch". Die Anlagereihenfolge in Paperless
hat mit Richtigkeit nichts zu tun. Belegt aus dem Test:

| gelöscht würde | erhalten bliebe | Bewertung |
|---|---|---|
| `Zeugnis` (**5 Dok**) | `Zeugniss` (**0 Dok**) | Richtung falsch herum |
| `Vertragsänderung` (1 Dok) | `Vertragänderung` (0 Dok) | Richtung falsch herum |
| `Herr <Inhaber>` (3 Dok) | `Herrn <Inhaber>, <Anschrift>` (1 Dok) | behält die Variante mit Anschrift |

*Zwei Änderungen:* Richtung im Bestätigungsdialog umschaltbar machen, **und**
die Vorbelegung von „kleinere ID" auf „mehr Dokumente" umstellen — das ist in
allen drei Fällen oben die bessere Wahl.

### 3.2 — Bestätigungsdialog zeigt den Sachverhalt (B-4)

Heute (`public/js/review.js:134`):
`"X" will be deleted. N document(s) will be reassigned to "Y". Continue?`

Es fehlen zwei Angaben, die dem Server bereits vorliegen:

- **Der Dokumentbestand der Zielseite.** Dass `Zeugniss` null Dokumente hat —
  der eine Wert, der die verkehrte Richtung sofort zeigt — steht nirgends.
- **Die betroffenen Dokumente.** `previewMerge` erhält `documentIds` vom
  Server und legt sie in `pendingDocumentIds` ab, **zeigt sie aber nicht an**.
  Die Titel stecken in einem *zweiten* Modal hinter einem *zweiten* Klick.

*Der Fall, an dem das teuer wird* (Test, Trigram 0.769): Der Dialog meldet nur
„1 document(s)". Erst das andere Modal verrät, dass auf der einen Seite ein
Arbeitsvertrag und auf der anderen eine Kfz-Versicherungspolice hängt — also
**zwei verschiedene Personen**, die nur dieselbe Adresse im Namen tragen.

*Ebenfalls hier:* Die Judge-Begründung ist heute nur ein `title`-Attribut
(`views/review.ejs:125`) — auf Touch-Geräten unerreichbar. Als sichtbaren Text
darstellen. Das ist die Information, deren Fehlen laut NACHAUDIT-14 die drei
Fehl-Merges begünstigt hat.

### 3.3 — Alias-Ansicht mit Löschfunktion (A-6, B-8)

Es gibt heute keinen Ort, an dem gefällte Entscheidungen sichtbar sind:
`entity_aliases` (22 Zeilen), abgeschlossene Queue-Einträge (27) und
`entity_merge_log` (23, davon 5 `failed`) sind allesamt nur in der Datenbank.
`EntityStore.deleteAlias` existiert, wird aber ausschließlich intern
aufgerufen, wenn ein Alias ins Leere zeigt.

*Umfang:* Zweiter Tab auf `/review` mit allen Aliasen (Quelle, Ziel,
Dokumentzahl des Ziels, Löschen-Knopf) und ein Statusfilter
`open`/`merged`/`rejected` für die Queue. Beides sind Leseansichten auf
vorhandene Tabellen plus ein Löschpfad. **Das ist die kleinste Ergänzung, die
eine Fehlentscheidung reversibel macht** — und billiger als jede zusätzliche
Absicherung davor.

### 3.4 — Erklären, warum ein Eintrag da ist (B-1, B-2)

- Kopfbereich mit den drei aktiven Schwellwerten und einem Satz je Spalte.
  Ohne sie ist „Trigram 0.63" eine Zahl ohne Skala.
- Dokumentzahl beider Seiten als eigene Spalte.
- Herkunft je Zeile: Live-Scan oder Altbestands-Durchlauf.
- **Bindestriche ersetzen.** Alle Einträge aus dem Altbestands-Durchlauf haben
  konstruktionsbedingt weder Verdikt noch Begründung noch Dokumentbezug
  (`entityBackfillService.js:72-75` setzt sie auf `null`) — im Test 39 von 39.
  Ein Bindestrich sieht aus wie ein leeres Ergebnis; „nicht bewertet
  (Altbestands-Scan)" sagt, was Sache ist. Optional ein „Judge fragen"-Knopf je
  Zeile, der das Urteil nachträglich holt (nach 1.1 rund 8 s, interaktiv
  vertretbar).

### 3.5 — Kleinere Punkte

| Befund | Inhalt |
|---|---|
| B-5 | „Not a duplicate" fragt nicht nach, wirkt aber dauerhaft (permanenter Negativ-Cache). Bulk-Reject fragt nach, Einzelablehnung nicht. |
| B-6 | `showDocumentPreview`, `reject` und `backfill` verwerfen die Servermeldung und zeigen generischen Text. Die Routen liefern präzise Meldungen. Gemeinsame Hilfsfunktion statt Einzelfix — NACHAUDIT-15 wurde nur an `previewMerge` behoben. |
| B-7 | Keine Ladezustände bei Merge/Reject/Preview (nur Backfill hat eines). Zähler „N open entries" veraltet nach jeder Aktion. Rückmeldung ausschließlich über `alert()`. |
| B-9 | Altbestands-Knöpfe ohne Erklärung und ohne Rückfrage. Ein Klick erzeugte im Test 16 Einträge; der Vergleich ist quadratisch (85 Tags = 3 570 Paare). |
| B-10 | `USE_EXISTING_DATA` steht als „Use existing Correspondents and Tags?" ohne Hilfetext unter „Advanced Settings" — obwohl es der wirksamste Konsistenzhebel ist und außerdem Dokumentarten steuert, was das Label verschweigt. |
| B-11 | Nicht gesetzte Schwellwerte werden als Wert gerendert (`0.90`/`0.65` statt Platzhalter) und beim ersten Speichern festgeschrieben. `EMBEDDING_EXCLUDED_TYPES`, `DOCUMENT_FINGERPRINT_MODE` und `FINGERPRINT_SIMILARITY_THRESHOLD` fehlen im UI ganz (`routes/settingsFormMapping.js` kennt sie nicht). |
| B-12 | Fingerprint-Warntext (`views/settings.ejs:772-778`) beschreibt einen seit AUDIT-003/NACHAUDIT-11 behobenen Zustand und erwähnt den gefahrlosen `observe`-Modus nicht. |
| B-13 | Alle zwölf Views laden Tailwind und Font Awesome vom CDN. Geerbt aus Paperless-AI, keine Regression — aber ohne Internet bricht das Layout. |

### Abnahmekriterium Paket 3

1. Ein Merge lässt sich in beiden Richtungen auslösen; die Vorbelegung folgt
   der Dokumentzahl.
2. Der Bestätigungsdialog nennt die Dokumentzahl **beider** Seiten und zeigt
   Beispieltitel, ohne dass ein zweites Modal nötig ist.
3. Ein Alias lässt sich in der Oberfläche einsehen und löschen; die Wirkung
   ist an einem Testfall belegt.
4. Ein Altbestands-Eintrag ist als „nicht bewertet" erkennbar, nicht als
   leeres Ergebnis.
5. Alle sechs Client-Aufrufe zeigen die Servermeldung.

---

## Vertagte Entscheidungen

### V-1 — Embedding-Kanal (A-4)

**Bewusst nicht in Paket 1.** Begründung: mit `USE_EXISTING_DATA=yes` schlägt
das Modell deutlich häufiger exakt vorhandene Namen vor — die werden auf Stufe
2 oder 3 der Kaskade erledigt und erreichen den Judge gar nicht. Wie viele
echte Grenzfälle danach überhaupt übrig bleiben, ist erst nach Paket 1
bekannt. Vorher zuzuschalten hieße, gegen eine Datenlage zu tunen, die es
danach nicht mehr gibt.

**Was bereits gemessen ist** (Testbericht A-4, `bge-m3`, 11 echte Dubletten
gegen 9 Kontrollpaare aus dem realen Bestand):

- Als **Auto-Merge-Kanal nicht verantwortbar.** Beim Default 0.90 werden 2 von
  11 Dubletten erkannt — fast nichts. Senkt man auf 0.85, wird als erstes
  Kontrollpaar `Herrn <Inhaber>, <Anschrift>` ↔ `<Zweitperson>, <Anschrift>`
  (0.880) getroffen: zwei verschiedene Personen, automatisch zusammengeführt,
  weil sie unter derselben Adresse wohnen.
- Als **Judge-Zulieferer wertvoll.** `EMBED_JUDGE_MIN` um 0.65–0.70 brächte
  8–9 der 11 echten Dubletten überhaupt erst vor ein Urteil — die einzige
  Chance, `Entgeltabrechnung` ↔ `Payroll Statement` (0.680) je zu erkennen.

**Empfehlung für die spätere Entscheidung:** `EMBEDDING_SIMILARITY_ENABLED=yes`
mit `EMBED_AUTO_THRESHOLD=0.95` (Auto-Merge praktisch aus),
`EMBED_JUDGE_MIN=0.70` und `EMBEDDING_EXCLUDED_TYPES=tag`. Sinnvoll erst,
wenn Paket 3 die Review-Arbeit sicher gemacht hat.

### V-2 — Fingerprint (NACHAUDIT-10, NACHAUDIT-11)

Unverändert offen und außerhalb dieses Plans: die Schwellwertmessung für
`FINGERPRINT_SIMILARITY_THRESHOLD` und der 200-Dokumente-Lauf im
Beobachtungsmodus. `DOCUMENT_FINGERPRINT_ENABLED` bleibt `no`.

### V-3 — FIX-01 im Code beheben

Der Befund ist oben dokumentiert; Paket 2 umgeht ihn per SQL. Der eigentliche
Fix (`original_documents` von beiden Löschpfaden ausnehmen) ist ein eigener,
kleiner Vorgang — sinnvoll zusammen mit dem nächsten Anlass, `models/document.js`
anzufassen.

### V-4 — AUDIT-035 (`/api`-Suffix-Falle)

Unverändert bewusst zurückgestellt. Auf dieser Instanz korrekt konfiguriert
und damit nicht wirksam.

---

## Bezug zu den Befunden des Testberichts

| Befund | behandelt in |
|---|---|
| A-1 `USE_EXISTING_DATA=no` | 1.3 |
| A-2 Prompt-Platzhalter | 1.2 |
| A-3 Judge-Timeout | 1.1 |
| A-4 Embedding-Kanal | V-1 (vertagt) |
| A-5 Schwellwerte bestätigt | 1.5 (dokumentiert, keine Änderung) |
| A-6 Aliase zementieren Fehler | 1.4 (die drei aktiven), 3.3 (Verwaltung) |
| A-7 Determinismus | keine Maßnahme — Ollama-seitig, nicht behebbar; Doku-Folge siehe unten |
| A-8 A/B-Messung | Begründung für 1.3, keine eigene Aufgabe |
| A-9 `npm test` 458/460 | 1.0.a |
| A-10 `npm run lint` rot | 1.0.b |
| B-1, B-2 | 3.4 |
| B-3 | 3.1 |
| B-4 | 3.2 |
| B-8 | 3.3 |
| B-5 bis B-7, B-9 bis B-13 | 3.5 |

**Zu A-7:** Zwei unmittelbar aufeinanderfolgende Läufe gegen denselben Bestand
können abweichen, auch bei `temperature=0`/`seed=42`. Das ist keine Lücke der
Umsetzung — der Anwendungscode setzt alles richtig. Folge für die
Dokumentation: das Abnahmekriterium von Phase 1 in der Roadmap sollte ein
zweites Mal präzisiert werden (auf eine Abweichungsrate statt auf Identität)
und den EntityResolver ausdrücklich als das Mittel benennen, das aus
abweichenden Vorschlägen dieselbe gespeicherte Entität macht. Sinnvoll
zusammen mit 1.5, da dieselbe Datei betroffen ist.
