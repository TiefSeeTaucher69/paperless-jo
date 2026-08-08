# Tiefenanalyse: Warum die Klassifikationsergebnisse noch nicht tragen

**Datum:** 2026-08-08
**Anlass:** Nach Abschluss der Pakete 1–3 aus dem
[Fixplan vom 2026-08-06](2026-08-06-fixplan-konsistenz-und-review-ui.md) sind die
Ergebnisse weiterhin unbefriedigend. Ziel des Betreibers: Dokument hochladen,
korrekt getaggt, keine Nacharbeit.
**Art:** Befundbericht mit eigenen Messungen am Live-Bestand und am Modell.
Enthält keine Umsetzung.

**Namenskonvention:** wie in den vorangegangenen Berichten sind Namen natürlicher
Personen, Firmen und Anschriften durch Platzhalter ersetzt. Der Fork ist
öffentlich.

| Platzhalter | Bedeutung |
|---|---|
| `<Inhaber>` | Dokumentinhaber |
| `<AG-A>`, `<AG-B>`, `<AG-C>` | die drei Arbeitgeber im Bestand |
| `<Payroll>` | Hersteller der Entgeltabrechnungs-Software (Marke im Briefkopf) |
| `<Versicherer>` | Kfz-Versicherer |
| `<Krankenkasse>` | gesetzliche Krankenkasse |
| `<Ort>`, `<PLZ>`, `<Strasse>` | Anschriftsbestandteile |
| `<Datum>`, `<Versicherungsnummer>`, `<Berufsbezeichnung>` | sonstige personenbezogene Werte |

---

## Leitbefund

Alle bisherigen Audits, Tests und Pakete haben **Konsistenz** gemessen —
Dubletten, Schwellwerte, Timeouts, Stabilität zwischen Läufen. **Korrektheit
wurde nie gemessen.** Es existiert kein einziger Datensatz im Projekt, der
festhält, welcher Korrespondent, welche Dokumentart und welche Tags für ein
konkretes Dokument *richtig* wären. `data/eval/entity-labels.json` labelt
ausschließlich Entitäten*paare* für die Dedup-Kaskade, nicht Dokumente.

Die Folge ist an einer Zahl ablesbar: **35 der 64 Dokumente (55 %) tragen einen
nachweislich falschen Korrespondenten** — und zwar seit dem ersten Lauf, ohne
dass eine der drei Ausbaustufen das je bemerkt hätte. Die Kette wurde auf
Reproduzierbarkeit einer falschen Antwort optimiert.

Daraus folgt die Reihenfolge dieses Berichts: erst die Befunde, die die
*Antwort* falsch machen (B-1 bis B-4), dann die, die sie *nicht durchsetzbar*
machen (B-5 bis B-8), dann die Infrastruktur (B-9, B-10).

---

## Messgrundlage

Alle Zahlen wurden am 2026-08-08 gegen die laufende Instanz erhoben.

| Prüfung | Ergebnis |
|---|---|
| `npm test` | 512/512 grün |
| `npm run lint` | 0 problems |
| Paperless erreichbar | ja, 64 Dokumente |
| Ollama erreichbar | ja, `qwen2.5:7b`, `qwen2.5:14b`, `bge-m3` |
| Live-Klassifikationen für diesen Bericht | 10 (3 Dokumente A/B-Prompt, 2 Dokumente × 2 Modelle) |

Es wurde **nichts nach Paperless geschrieben** — ausschließlich
`analyzeDocument` (lesend), wie im Dry-Run-Harness.

---

## B-1 — Der häufigste Korrespondent im Archiv ist falsch (55 % der Dokumente)

- **Schweregrad:** Critical · **Bereich:** Klassifikationsqualität · **Neu**

**Beobachtung.** Der Korrespondent `<Payroll>` trägt 35 der 64 Dokumente. Eine
Prüfung des Volltexts aller 35 zeigt, dass in **jedem** dieser Dokumente ein
echter Absender mit Postanschrift im Briefkopf steht:

| tatsächlicher Absender laut Volltext | Dokumente |
|---|---|
| `<AG-B>` | 18 |
| `<AG-C>` | 16 |
| `<AG-A>` | 1 |

`<Payroll>` ist die **Abrechnungssoftware**, deren Markenname in der Kopfzeile
jeder Entgeltabrechnung steht („Entgeltabrechnung `<Payroll>` Horizon Payroll").
Das Modell greift den prominentesten Markennamen ab statt den Absender mit
Anschrift.

**Warum das keine Dedup-Frage ist.** Die Resolver-Kaskade kann das nicht
reparieren — `<Payroll>` und `<AG-B>` sind zwei verschiedene, real existierende
Firmen. Trigram-Ähnlichkeit 0,333, also weit unter jeder Schwelle. Ein Merge
wäre sogar falsch. Der Fehler entsteht vor der Kaskade und ist für sie
unsichtbar.

**Der Fehler pflanzt sich in die Titel fort.** Die KI-erzeugten Titel lauten
durchgehend „Entgeltabrechnung `<Payroll>` Horizon" — der Markenname steht also
zusätzlich in einem zweiten Feld.

**Prompt-Gegenprobe (gemessen).** Der `SYSTEM_PROMPT` enthält die Regel bereits
(„ausschließlich der tatsächliche Absender oder Aussteller … niemals Empfänger,
Thema, Rolle"). Ich habe eine explizite Zusatzregel gegen genau diese Falle
ergänzt („im Briefkopf gedruckte Software-, Produkt-, Markennamen sind niemals
der correspondent; der correspondent ist die Firma mit Postanschrift") und beide
Modelle auf zwei Entgeltabrechnungen angesetzt:

| Dokument | echter Absender | 7b + Regel | 14b + Regel |
|---|---|---|---|
| 170 | `<AG-A>` | **`<AG-A>` ✓** | **`<AG-A>` ✓** |
| 178 | `<AG-B>` | Unsinn ✗ | `<Payroll>` ✗ |

Die Regel wirkt also — aber nicht überall. Der Unterschied zwischen 170 und 178
ist **nicht** das Modell, sondern der OCR-Text. Siehe B-2.

---

## B-2 — Die OCR zerlegt genau die Namen, die gebraucht werden

- **Schweregrad:** Critical · **Bereich:** Eingangsdaten · **Neu**

**Beobachtung 1 — Spaltenverschränkung.** Die Entgeltabrechnungen sind
zweispaltig. Die OCR liest zeilenweise über beide Spalten hinweg, wodurch der
Absendername durch Tabellenwerte zerrissen wird. Dokument 178 im Original:

```
Geburtsdatum Eintrittsdatum Austrittsdatum <AG-B, Teil 1> <Datum>
<Datum> <Datum> <AG-B, Teil 2> Steuerklasse Kinderfreibetrag …
<Strasse> 1 0,0 <PLZ> <Ort>
```

Der Firmenname existiert im Text nur noch als zwei durch Datumsangaben
getrennte Fragmente. Kein Modell kann daraus zuverlässig den Absender
rekonstruieren — es greift stattdessen auf den einzigen zusammenhängend
lesbaren Namen zurück: die Software-Marke oben. In Dokument 170 steht der
Absendername zufällig zusammenhängend, und beide Modelle antworten sofort
richtig.

**Das erklärt auch die Korrespondenten-Varianten** `<AG-B> Plastic
Manufacturing GmbH` (2 Dok), `<AG-B> Plastic GmbH` (3 Dok) und `<AG-B> GmbH`
(2 Dok): drei verschiedene Rekonstruktionsversuche desselben zerrissenen Namens.

**Beobachtung 2 — Sperrsatz.** 8 Dokumente enthalten die gesperrt gesetzte
Überschrift `M E L D E B E S C H E I N I G U N G`. Das Modell verliest sie
reproduzierbar:

| erzeugter Wert | wo er heute steht |
|---|---|
| „Meldebeschreibung" | Dokumentart (1 Dok) |
| „Meldebeweis" | Tag (1 Dok) und Paperless-Titel von Dokument 136 |
| „Meldebeschwerung" | in einem Dry-Run vom 2026-08-08 erzeugt |
| „Bescheid" | Dokumentart (2 Dok) — obwohl `Meldebescheinigung` mit 6 Dok im Prompt stand |

Eine Zeile Vorverarbeitung (Buchstabenketten wie `M E L D E …` zusammenziehen,
bevor der Text an das Modell geht) räumt eine ganze Dokumentklasse auf. Insgesamt
enthalten 46 der 64 Dokumente gesperrte Zeichenketten; 17 Fundstellen sind echte
Wörter, der Rest sind `X X X X`-Maskierungen von Kontonummern (harmlos).

**Einordnung.** B-1 und B-2 zusammen sind der eigentliche Grund, warum die
Ergebnisse nicht tragen. Sie liegen **vor** dem Modell und werden von keiner der
fünf Roadmap-Phasen berührt.

---

## B-3 — Der `SYSTEM_PROMPT` erreicht das Modell beschädigt

- **Schweregrad:** High · **Bereich:** Konfiguration · **Neu**

**Beobachtung.** Der sorgfältig formulierte, 5 265 Zeichen lange deutsche
Prompt kommt beim Modell als **eine einzige Zeile ohne einen einzigen
Zeilenumbruch** an, eingeleitet von zwei überzähligen Backticks. Alle 75
Absatzwechsel liegen als literale Zwei-Zeichen-Folge `\n` im Text.

Gemessen:

| Leser | Länge | echte Zeilenumbrüche | Anfang |
|---|---|---|---|
| `setupService.loadConfig()` — was die Einstellungsseite anzeigt | 5 264 | 0 | `` `Du klassifizierst `` |
| `dotenv` in `config/config.js` — **was das Modell bekommt** | 5 265 | 0 | ` ``Du klassifiziers ` |

Die beiden Werte sind nicht einmal identisch — ein Speichern über die
Oberfläche verändert den Prompt also erneut.

**Ursache.** `routes/setup.js:3749` und `:4194` schreiben den Prompt mit
`.replace(/\n/g, '\\n')` als Escape-Sequenz, und `setupService.saveConfig()`
klammert den Wert in **Backticks**. `dotenv` löst `\n` aber ausschließlich bei
**doppelt** gequoteten Werten auf, nicht bei Backticks. `setupService` hat einen
eigenen Parser, der das Format korrekt liest (`setupService.js:59-91`) — die
Laufzeit benutzt ihn nicht.

`routes/setup.js:3749` entfernt zusätzlich **alle `=`-Zeichen** aus dem Prompt
(`.replace(/=/g, '')`), und `:4194` schreibt den Prompt nur, wenn er nicht leer
ist — er lässt sich über die Oberfläche also nicht löschen.

**Wichtige Einschränkung, gemessen.** Die Reparatur allein verbessert die
Ergebnisse **nicht**. A/B über drei Dokumente, Variante A = Prompt wie heute,
Variante B = derselbe Text mit echten Zeilenumbrüchen und ohne Backticks:

| Dok | A | B | Bewertung |
|---|---|---|---|
| 178 | Dokumentart „Entgeltformular", Korr. `<Payroll>` | Dokumentart „Payroll Statement", Korr. `„<Inhaber>, <Berufsbezeichnung>, <Payroll>, <Ort>"` | B schlechter |
| 181 | „Vertragsänderung" ✓ | „Beitragsrechnung" ✗ | B schlechter |
| 139 | „Bescheid" ✗ | „Bescheid" ✗ | gleich |

Der Befund bleibt trotzdem High: Solange der Prompt beschädigt ankommt, ist er
als Steuerungsinstrument wertlos — jede künftige Prompt-Änderung wird gegen
Rauschen gemessen.

---

## B-4 — Das 7B-Modell ist mit diesem Prompt gesättigt

- **Schweregrad:** High · **Bereich:** Modellwahl · **Neu**

Der System-Prompt umfasst mit den Bestandslisten **9 375 Zeichen ≈ 2 340
Token** Anweisungen. Beim Versuch, die Absender-Regel aus B-1 zu ergänzen
(+ ~100 Token), kippte `qwen2.5:7b` auf Dokument 178 vollständig:

```
correspondent = "Herrn 1111 <Krankenkasse> <Versicherungsnummer>"
tags          = ["<Berufsbezeichnung>", "<Ort>"]
```

Das ist kein Klassifikationsfehler mehr, sondern Zusammenbruch der
Instruktionsbefolgung. `qwen2.5:14b` blieb im selben Test stabil und lieferte
durchgehend plausible Werte — auch im Dry-Run vom 2026-08-08 waren die
Korrespondenten des 14b sauber (6 verschiedene, keine Fragmentnamen), die des
7b nicht (8 verschiedene, darunter `<AG-A> GmbH, USt-IdNr. …` und ein
abgeschnittenes `<AG-B> Plastic`).

**Schlussfolgerung:** weitere Prompt-Arbeit am 7B ist verlorene Zeit. Die
Kapazitätsgrenze ist erreicht.

---

## B-5 — Der Prompt bittet, der Code setzt nichts durch

- **Schweregrad:** High · **Bereich:** Robustheit · **Neu**

Der `SYSTEM_PROMPT` formuliert präzise Regeln. Keine davon wird im Code
durchgesetzt. `_normalizeParsedDocument` (`services/ollamaService.js:573`)
prüft ausschließlich: Doppelpunkt im Tag, Länge > 60 Zeichen, `/` oder `...` in
der Dokumentart, Datumsformat. Gemessene Folgen im Live-Bestand:

| Prompt-Regel | Realität |
|---|---|
| „maximal 4 inhaltliche Tags" | Median **7** Tags je Dokument, Maximum 14. **50 von 64 Dokumenten** liegen über 4 + `ai-processed`. Ein einzelner Aufruf auf Dokument 179 lieferte 14 Tags — von *beiden* Modellen. |
| „keine Jahreszahlen" | Tags `2023`, `2024`, `November 2025`; im Dry-Run zusätzlich `Juni 2026` |
| „ausschließlich deutsche Begriffe" | Tags `Payroll` (7 Dok), `Invoice`, `Tax Document`, `Curriculum Vitae`, `salary tax certificate` |
| „keine Dokumentnummern" | Tags `Personal-Nr.` (3 Dok), `Geburtsdatum` (3 Dok) |
| „`language`: ISO-639-1 kleingeschrieben" | gemessene Werte `deutsch`, `de-DE` |
| „correspondent … nicht als Tag wiederholen" | Tag `<Payroll> Horizon Payroll` (5 Dok) |

Der Tag-Deckel ist dabei nicht nur Kosmetik: bei **0,85 Token/s** (B-9) kostet
jeder überzählige Tag messbare Laufzeit. Der 14-Tag-Lauf auf Dokument 179
brauchte 1 135 s gegenüber 200–280 s bei zwei Tags.

`scripts/dry-run-eval.js` **erkennt** datumsartige Tags bereits und meldet sie
unter `problems.dateLikeTags` — der Produktivpfad filtert sie nicht.

---

## B-6 — Der einzige echte Durchsetzungsmechanismus ist in beide Richtungen kaputt

- **Schweregrad:** High · **Bereich:** Konfiguration/Code · **Neu**

Das Projekt kennt drei Schalter für ein geschlossenes Vokabular. Gemessenes
Verhalten:

**a) `RESTRICT_TO_EXISTING_DOCUMENT_TYPES` ist wirkungslos.**
Die Variable wird in `config/config.js:35` gelesen, in `views/settings.ejs:558`
angeboten und in `routes/setup.js:4226` gespeichert. `getOrCreateDocumentType`
(`services/paperlessService.js:1301`) enthält **keine** Prüfung darauf und legt
immer an. Die Einstellung ist ein stiller No-Op — ausgerechnet bei der Dimension
mit dem schlechtesten Verhältnis (28 Dokumentarten auf 64 Dokumente, 17 davon
mit genau einem Dokument).

**b) `RESTRICT_TO_EXISTING_TAGS` / `_CORRESPONDENTS` entziehen dem Modell die
Bestandslisten.** Die Bedingung in `_buildPrompt`
(`services/ollamaService.js:244`) hängt die Listen nur an, wenn *beide*
Restriktionen `no` sind. Gemessen mit Markerwerten:

| Einstellung | Tag-Liste im Prompt | Korr.-Liste | Dokart-Liste |
|---|---|---|---|
| heute (alle `no`) | JA | JA | JA |
| `RESTRICT_TO_EXISTING_TAGS=yes` | **NEIN** | **NEIN** | **NEIN** |
| `RESTRICT_TO_EXISTING_CORRESPONDENTS=yes` | **NEIN** | **NEIN** | **NEIN** |

Wer die Restriktion einschaltet, bekommt also ein Modell, das den Bestand nicht
mehr sieht, frei erfindet — und dessen Erfindungen anschließend verworfen
werden. Ergebnis wären Dokumente fast ohne Tags. Der gedachte Ausweg
(`%RESTRICTED_TAGS%`-Platzhalter im Prompt) ist im konfigurierten
`SYSTEM_PROMPT` nicht vorhanden.

---

## B-7 — Der Bestandsabgleich verstärkt die Verschmutzung, die er verhindern soll

- **Schweregrad:** High · **Bereich:** Rückkopplung · **Neu**

`USE_EXISTING_DATA=yes` zeigt dem Modell den **vollständigen** Bestand und der
Prompt weist es an, einen passenden Eintrag „in exakt derselben Schreibweise" zu
übernehmen. Der Bestand enthält heute:

- **117 Tags**, davon **77 genau einmal benutzt** (Baseline 2026-08-06: 85 Tags,
  59 einmalig — also *schlechter* als vor den drei Paketen, siehe B-8)
- **28 Dokumentarten** auf 64 Dokumente, 17 mit genau einem Dokument, 3 ohne
  jedes Dokument
- darunter die reinen Prompt-Platzhalter-Artefakte `Invoice/Contract/...`,
  `Invoice/Contract`, `Invoice/Abrechnung`
- 8 Tags aus Gesetzesnamen (`… (BaySchO)`, `… (BayEUG)`, `… (BDSG)`), ein
  OCR-Trümmer-Tag, 5 englische Tags

Das Modell wird also aufgefordert, aus einer verschmutzten Liste zu wählen — und
tut es. Zwei Alias-Zeilen in `data/entities.db` zementieren das zusätzlich:
`payroll → <Payroll> Horizon Payroll` und `entgeltabrechnung → Abrechnung`
(beide Quelle `user`, also aus früheren Merge-Entscheidungen).

**Konsequenz für die Reihenfolge:** Eine Bestandsbereinigung ohne B-6 ist
verlorene Arbeit — genau das ist offenbar bereits passiert.

---

## B-8 — Die Bereinigung aus Paket 2 ist im Live-Bestand nicht mehr vorhanden

- **Schweregrad:** High · **Bereich:** Datenhaltung · **Klärungsbedarf**

Der Fixplan hält für Paket 2 (2026-08-07) fest: 14 Dokumentarten, keine mit 0
Dokumenten, `contract` gelöscht, Empfänger-Korrespondenten entfernt.

Live-Bestand am 2026-08-08:

| | Paket-2-Abnahme | heute |
|---|---|---|
| Dokumentarten | 14, keine leer | **28, 3 leer** |
| Tags | 83, 57 einmalig | **117, 77 einmalig** |
| Korrespondenten mit 0 Dokumenten | 0 | **6** |
| Korrespondenten mit Anrede/Rolle im Namen | 0 | `<Inhaber>, Auszubildender Fachinformatiker`; `<AG-A> GmbH, Geschäftsführer …` |
| Prompt-Platzhalter als Dokumentart | entfernt | `Invoice/Contract/...` u. a. wieder da |

Zusätzliche Beobachtungen:
- **Alle 64 Dokumente** wurden heute zwischen 11:21 und 12:55 Uhr geändert
  (≈ 88 s Abstand) — das ist kein Lauf dieser Anwendung, die pro Dokument
  200–650 s braucht.
- `data/documents.db` kennt als letzte Verarbeitung den **2026-08-05**;
  `data/entities.db` wurde seit **2026-08-06 21:22** nicht mehr geschrieben.
  Die Anwendung hat also seit Paket 2 nichts geschrieben.

**Offene Frage an den Betreiber:** Was ist heute Vormittag mit der
Paperless-Instanz passiert (Import/Restore/Neuverarbeitung)? Ohne diese Antwort
lässt sich nicht sagen, ob die Bereinigung zurückgerollt wurde oder ob sie eine
andere Instanz betraf. Solange das offen ist, ist jede weitere Bereinigung
riskant.

---

## B-9 — Der Ollama-Host ist der Flaschenhals für alles Weitere

- **Schweregrad:** Critical · **Bereich:** Infrastruktur · **Neu**

Gemessen, zweimal, mit unterschiedlicher Kontextgröße:

| Messung | Wert |
|---|---|
| Generierung `qwen2.5:7b-q4_K_M`, `num_ctx=8192` | **0,68 Token/s** |
| Generierung `qwen2.5:7b-q4_K_M`, `num_ctx=2048` | **0,85 Token/s** |
| Prompt-Verarbeitung | ~11–13 Token/s |
| `/api/ps` während der Generierung | leer (kein VRAM-Eintrag) |

Zum Vergleich: ein 7B-q4-Modell erreicht auf einer gewöhnlichen CPU 5–15 Tok/s,
auf einer GPU 40–80 Tok/s. **0,85 Tok/s liegt unterhalb eines Raspberry Pi 5.**
Die Kontextgröße ist nicht die Ursache — der Wert ändert sich bei einem Viertel
des Kontexts kaum.

Praktische Folgen, alle gemessen:

- 200–650 s je Dokument (7b), 370–1 135 s (14b)
- ein vollständiger Rescan über 64 Dokumente: **4–10 Stunden**
- die zehn Klassifikationen für diesen Bericht: **58 Minuten**
- die Latenzstreuung um Faktor 4,6, die der Fixplan unter E-1 als unerklärt
  festhielt, ist damit erklärt: ein derart überlasteter Host schwankt

**Das ist die eigentliche Blockade.** Nicht weil Geschwindigkeit an sich
wichtig wäre, sondern weil jede Verbesserungsschleife — Prompt ändern, messen,
bewerten — hier einen halben Tag kostet. Ein 14B-Modell, das nachweislich
bessere Korrespondenten liefert (B-4), ist auf dieser Hardware nicht
betreibbar.

---

## B-10 — Schreiben ist additiv, Korrekturen halten nicht

- **Schweregrad:** Medium · **Bereich:** Datenintegrität · **Neu**

`paperlessService.updateDocument` (`:1750-1765`):

- **Tags werden vereinigt**, nie ersetzt (`[...new Set([...currentDoc.tags,
  ...updates.tags])]`). Ein zweiter Lauf kann einen falschen Tag nicht
  entfernen, nur weitere hinzufügen. Das ist ein Teil der Erklärung für Median 7
  Tags bei einem Prompt-Limit von 4.
- **Ein vorhandener Korrespondent wird nie überschrieben.** Das schützt manuelle
  Korrekturen — bedeutet aber auch, dass die 35 falschen Zuordnungen aus B-1
  durch keinen Rescan verschwinden. Sie müssen in Paperless von Hand oder per
  Bulk-Edit korrigiert werden.

Ergänzend: Beim Anlegen setzt die Anwendung Dokumentarten auf
`matching_algorithm: 1` mit **leerem** `match`
(`services/paperlessService.js:1331-1335`), Tags und Korrespondenten ohne jede
Matching-Angabe. Paperless-ngx' eigene, deterministische Zuordnungsregeln
bleiben damit ungenutzt — obwohl sie für wiederkehrende Dokumente (21
Entgeltabrechnungen desselben Formulars) das Problem ohne LLM lösen würden.

---

## Ungenutzte Bausteine, die genau hier helfen würden

Beides ist gebaut, getestet und abgeschaltet:

**Fingerprint-Kanal** (`DOCUMENT_FINGERPRINT_ENABLED=no`, V-2 im Fixplan).
`documentFingerprintService.findMatch` vergleicht ein neues Dokument per
Embedding mit früheren Dokumenten **desselben Korrespondenten** und übernimmt
deren Tags und Dokumentart unverändert. Für 21 formgleiche Entgeltabrechnungen
ist das die Stelle, an der Konsistenz gratis zu haben ist — vorausgesetzt, der
Korrespondent stimmt (B-1). Der Schwellwert ist unvermessen; der
`observe`-Modus existiert genau dafür.

**Embedding-Kanal** (`EMBEDDING_SIMILARITY_ENABLED=no`, V-1 im Fixplan). Die im
Testbericht gemessenen echten Dubletten, die Trigram strukturell nie sieht,
sind genau die im heutigen Bestand vorhandenen: `Lohnabrechnung` ↔
`Entgeltabrechnung` (Trigram 0,581), `Meldebeweis` ↔ `Meldebescheinigung`
(0,414), `<Payroll> Horizon Payroll` ↔ `<Payroll>` (0,333).

---

## Empfohlene Reihenfolge

Begründet über Abhängigkeit, nicht über Aufwand.

**Stufe 0 — Messbarkeit herstellen. Ohne das ist alles Weitere Raten.**
1. **Goldstandard anlegen:** 20–25 Dokumente, die den Bestand abdecken, von Hand
   mit richtigem Korrespondent, richtiger Dokumentart und 2–4 Tags labeln
   (`data/eval/document-labels.json`).
2. `scripts/dry-run-eval.js` um eine Auswertung gegen diese Labels erweitern:
   Trefferquote je Feld statt nur Varianten-Cluster. Ab dann ist jede Änderung
   eine Zahl.
3. **B-8 klären**, bevor irgendetwas geschrieben wird.

**Stufe 1 — Eingangsdaten reparieren (B-2). Größter Hebel, kein Modellrisiko.**
4. Sperrsatz-Zusammenzug und Spaltenverschränkung im Volltext vor dem
   Modellaufruf entschärfen — ein eigener Normalisierungsschritt, testbar ohne
   LLM.
5. Für die wiederkehrenden Klassen zusätzlich Paperless-ngx' eigene
   Matching-Regeln setzen (Korrespondent über Betriebsnummer/Anschrift). Das
   nimmt dem Modell die fehleranfälligste Entscheidung ganz ab.

**Stufe 2 — Rechenleistung (B-9).**
6. GPU für den Ollama-Host, oder die Klassifikation auf ein gehostetes Modell
   umstellen (die Anwendung unterstützt OpenAI/Azure/Custom bereits). Bei
   ~100 Dokumenten im Jahr ist der zweite Weg in Cent-Beträgen zu rechnen — der
   Preis ist, dass Dokumentinhalte das Haus verlassen. Das ist eine
   Abwägungsentscheidung, keine technische.
7. Erst danach über das Modell entscheiden (B-4). Mit GPU ist 14B oder größer
   in Sekunden statt Minuten machbar.

**Stufe 3 — Steuerbarkeit (B-3, B-5, B-6).**
8. `SYSTEM_PROMPT` aus `data/.env` in eine eigene Datei verlagern
   (`data/system-prompt.md`) und von dort laden. Ein 5 000-Zeichen-Prompt in
   einer `.env`-Zeile ist konstruktionsbedingt fragil.
9. Harte Grenzen in `_normalizeParsedDocument`: Tag-Obergrenze, Jahres- und
   Monat/Jahr-Tags verwerfen, Tags verwerfen, die Korrespondent oder
   Dokumentart wiederholen, `language` auf ISO-639-1 normalisieren.
10. `RESTRICT_TO_EXISTING_DOCUMENT_TYPES` durchsetzen; `_buildPrompt` so
    ändern, dass Restriktionen die Bestandslisten **behalten**.
11. Besser als striktes Verwerfen: ein Vorschlagsmodus. Unbekannter Tag oder
    unbekannte Dokumentart wird nicht angelegt, sondern landet in der
    Review-Queue. Die Oberfläche dafür steht seit Paket 3.

**Stufe 4 — Bestand und Automatik.**
12. Vokabular einmal auf ~25–35 Tags und ~12–15 Dokumentarten zusammenführen,
    tote und falsche Aliase entfernen. **Erst nach Stufe 3**, sonst wiederholt
    sich B-8.
13. Die 35 falschen Korrespondenten per Bulk-Edit korrigieren (B-10: ein
    Rescan tut es nicht).
14. Fingerprint-Kanal in `observe` messen, dann scharf schalten.
15. Erst zum Schluss `DISABLE_AUTOMATIC_PROCESSING=no`.

---

## Was ausdrücklich in Ordnung ist

Damit der Bericht nicht schiefer wirkt, als die Lage ist:

- `npm test` 512/512, `npm run lint` sauber — die Hygiene aus Paket 1 hält.
- Die Fehlerbehandlung der Resolver-Kaskade ist sorgfältig: tote Aliase werden
  erkannt und verworfen, jeder Schreibfehler wird protokolliert, `unavailable`
  ist von `unsure` getrennt.
- Die Review-/Merge-Oberfläche aus Paket 3 ist vollständig, inklusive
  Alias-Ansicht mit Löschfunktion und nachträglichem Judge-Aufruf.
- Der Dry-Run-Harness schreibt nachweislich nichts nach Paperless — er war für
  diesen Bericht ohne Risiko benutzbar.

Die Kette ist gut gebaut. Sie misst nur die falsche Größe und bekommt zu
schlechte Eingangsdaten.
