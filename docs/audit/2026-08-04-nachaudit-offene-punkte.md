# Nachaudit: offene Punkte nach der Fix-Welle

**Datum:** 2026-08-04
**Commit / Branch:** `ca5230c` auf `main`
**Auditart:** unabhängige, read-only Nachprüfung der Behebung von
[paperless-jo-full-project-audit-2026-08-02.md](../audit/paperless-jo-full-project-audit-2026-08-02.md)
(35 Findings) gegen die [Roadmap](../planning/klassifikations-konsistenz-roadmap.md)
**Prüfer:** Claude Opus 5, beauftragtes Nachaudit ohne Änderungsrechte am Produktivcode

## Ergebnis in Kürze

33 von 35 Findings aus dem Erstaudit sind sauber behoben (Tests: 403/403 grün,
vorher 217; Lint: 0 Errors/83 Warnings mit CI-Gate). Ein Finding ist bewusst
offen dokumentiert (AUDIT-035, `/api`-Suffix-Falle). Ein Finding ist nur
**teilweise** behoben und hat ein reales, ausnutzbares Loch behalten
(AUDIT-001 → NACHAUDIT-01). Dieses Dokument bündelt die verbleibende Arbeit —
den offenen Sicherheitsbefund plus die während der Nachprüfung gefundenen
Restposten — in Pakete, die jeweils in einer Session geplant und umgesetzt
werden können.

Vollständige Finding-für-Finding-Tabelle und Beleg je Punkt: siehe
Gesprächsprotokoll des Nachaudits vom 2026-08-04 (nicht Teil dieser Datei,
da rein deskriptiv und nicht abarbeitbar).

## Arbeitsplan

1. [x] **Setup-Route absichern** (NACHAUDIT-01, P0)
   → Muss zuerst, da unauthentifizierte Account-Übernahme.

2. [x] **Dokumentation und Altdaten bereinigen** (AUDIT-018-Altlast, AUDIT-031,
   AUDIT-019-Doku, Doku-Lücken)
   → Risikoarm, unabhängig von Paket 1, guter Lückenfüller.
   → **Vollständig umgesetzt** laut
   [2026-08-05-nachaudit-paket2-doku-altdaten.md](../superpowers/plans/2026-08-05-nachaudit-paket2-doku-altdaten.md):
   NACHAUDIT-02 (Hauptpunkt verifiziert: `logs/prompt.txt` existiert nicht;
   Nebenbefund behoben: Tests hängen nicht mehr an der echten Logdatei),
   NACHAUDIT-03 (Testanzahl aktualisiert, 416/416), NACHAUDIT-04, NACHAUDIT-05,
   NACHAUDIT-06 (verifiziert: Fix-Doku bereits versioniert) und NACHAUDIT-07
   (bewusst keine Änderung) sind erledigt. `npm test` 416/416 grün,
   `npm run lint` weiterhin exakt 83/83 Warnungen.

3. [ ] **Review-Queue abarbeiten und Fix-Welle produktiv verifizieren**
   (AUDIT-030-Rest, Produktivlauf)
   → Setzt Paket 1 voraus (Scan läuft über dieselben ungeschützten Routen).

4. [ ] **Fingerprint-Aktivierungsvoraussetzungen schließen** (Abschnitt 18.6,
   Punkt 1/5/6 aus dem Erstaudit)
   → Größtes Paket, aber unkritisch für den laufenden Betrieb, da Feature aus.
   Zeitlich nach hinten stellen, außer das Feature soll bald aktiviert werden.

Info-only bleibt AUDIT-035 (bewusst zurückgestellter Punkt, keine Aktion nötig,
in der Roadmap bereits korrekt als solcher markiert).

---

## Paket 1 — Setup-Route absichern (P0)

**Warum zusammen:** Ein einzelner, in sich geschlossener Fund an einer Stelle
(`routes/setup.js`), der die gesamte übrige Absicherung aus AUDIT-001/-002
aushebelt. Muss vor jeder weiteren Arbeit an diesem Router behoben werden.

### NACHAUDIT-01 — `POST /setup` erlaubt unauthentifizierte Übernahme der Instanz

- **Schweregrad:** Critical · **Bereich:** Sicherheit · **Bezug:** AUDIT-001
  (unvollständig behoben — die Empfehlung „Erst-Setup zusätzlich gegen
  `PAPERLESS_AI_INITIAL_SETUP` gaten" wurde nicht umgesetzt)
- **Dateien:** `routes/setup.js:149-154` (`PUBLIC_ROUTES`), `routes/setup.js:3604`
  (Handler `POST /setup`)
- **Beobachtetes Verhalten:** `PUBLIC_ROUTES` enthält `'/setup'`, das Gate prüft
  `req.path.startsWith(route)`. Damit umgeht **jede** Methode auf `/setup`
  sowohl `isAuthenticated` als auch `csrfProtection`. `GET /setup` fängt das
  über eigene Logik ab (Redirect nach `/dashboard`, wenn konfiguriert **und**
  Nutzer existieren) — `POST /setup` hat keine solche Prüfung. Der Handler
  destrukturiert direkt `req.body`; im gesamten Block 3604–4012 gibt es keinen
  `isConfigured`-, User- oder `PAPERLESS_AI_INITIAL_SETUP`-Guard.
- **Empirisch verifiziert** (Probe mit gestubbtem `initializeWithCredentials`,
  `saveConfig`, `addUser`, `isConfigured()` auf `true`):
  ```
  POST /setup  (kein Cookie, kein CSRF-Header)
    status              : 400   <- aus dem Handler, nicht vom Auth-Gate
    handler was reached : true  {"url":"http://attacker.example/api", ...}
  ```
  Mit einem funktionierenden `paperlessUrl`/`paperlessToken` statt des Stubs
  läuft der Ablauf weiter bis `setupService.saveConfig()`
  (`PAPERLESS_API_URL`/`PAPERLESS_API_TOKEN` werden umgebogen) und
  `documentModel.addUser()` (**`DELETE FROM users`**, danach Insert eines
  neuen Accounts). Ergebnis: vollständiger Account-Takeover plus Umbiegen der
  Paperless-Anbindung, unauthentifiziert, mit einem einzigen Request.
- **Erwartetes Verhalten:** `POST /setup` verhält sich wie `GET /setup` —
  reagiert nur im First-Run-Fenster (nicht konfiguriert, oder konfiguriert
  ohne Nutzer bei `PAPERLESS_AI_INITIAL_SETUP=yes`), sonst 403/Redirect.
- **Empfohlene Lösung:**
  1. Im Handler `POST /setup` als erste Anweisung dieselbe Bedingung aus
     `GET /setup` prüfen (`isConfigured()` + Nutzeranzahl aus
     `documentModel.getUser`/vergleichbar) und bei bereits eingerichteter
     Instanz mit 403 abbrechen.
  2. `PUBLIC_ROUTES` von `startsWith`-Matching auf exakte Pfadgleichheit
     umstellen, damit ein zukünftiger Präfix-Konflikt (z. B. `/setup-wizard`)
     nicht denselben Fehler wiederholt.
- **Empfohlene Tests:**
  - `POST /setup` bei bereits konfigurierter Instanz mit existierendem Nutzer
    → 403, kein `saveConfig`-, kein `addUser`-Aufruf (Ergänzung zur
    bestehenden `PROTECTED_ROUTES`-Tabelle in `test/setupAuthMiddleware.test.js`).
  - `POST /setup` im echten First-Run-Fenster (kein `.env`, keine Nutzer)
    bleibt weiterhin erreichbar — Regressionsschutz gegen ein zu scharfes Gate.

**Kleine Zusatzaufgabe im selben Bereich (optional, gleiche Datei/Session):**
`GET /thumb/:documentId` (`routes/setup.js:593`) und
`services/ollamaService.js#_handleThumbnailCaching` bilden weiterhin
`path.join(cacheDir, id + '.png')` ohne Prüfung, dass `id` numerisch ist
(theoretischer Path-Traversal-Rest aus dem Erstaudit, Abschnitt 11). Durch das
Auth-Gate jetzt post-authentifiziert und damit stark entschärft — bei Gelegenheit
mit einer `Number.isInteger`-Prüfung schließen, kein eigenes Paket wert.

---

## Paket 2 — Dokumentation und Altdaten bereinigen

**Warum zusammen:** Reine Doku- und Datenhygiene ohne Codepfad-Änderung,
unabhängig voneinander und von Paket 1 durchführbar. Guter Lückenfüller.

### NACHAUDIT-02 — `logs/prompt.txt`-Altlast nicht bereinigt (AUDIT-018-Rest)
Der Code schreibt korrekt nur noch bei `PROMPT_LOGGING_ENABLED=yes` (aktuell
aus). Die bereits vorhandene Datei (**172 KB**, laut Erstaudit inklusive
Klarnamen und Wohnanschrift aus dem System-Prompt) liegt unverändert auf der
Platte, weil der Fix nur die Quelle schließt, nicht die Historie bereinigt.
*Maßnahme:* `logs/prompt.txt` löschen oder bewusst archivieren/rotieren.
`public/images/` ist bereits korrekt leer/weg — kein weiterer Handlungsbedarf
dort.

*Nebenbefund, gleiche Datei-Familie:* `test/promptLoggingResponseFile.test.js`
sichert und restauriert die **echte** `logs/prompt.txt` um die Tests herum.
Funktioniert, aber ein abgebrochener Testlauf könnte die Datei in einem
Zwischenstand hinterlassen. *Maßnahme (optional):* Test auf einen Temp-Pfad
umstellen statt der echten Logdatei.

### NACHAUDIT-03 — Testanzahl in der Roadmap erneut veraltet (AUDIT-031-Wiederholung)
Roadmap-Zeile 283 nennt „217/217" (Stand des Erstaudits). Tatsächlich:
**403/403**. Derselbe Mechanismus wie beim ursprünglichen AUDIT-031 — die Zahl
läuft der tatsächlichen Testbasis nach.
*Maßnahme:* Zahl in der Roadmap aktualisieren, idealerweise mit einem Hinweis,
dass sie bei künftigen Fix-Wellen wieder veraltet, statt sie erneut einzeln
nachzuziehen.

### NACHAUDIT-04 — Phase-1-Abnahmekriterium nicht präzisiert (AUDIT-019-Doku-Rest)
Der Code-Teil von AUDIT-019 ist umgesetzt (`ordering: 'name'` in allen drei
Listenabfragen). Der Doku-Teil der Empfehlung — „die Abnahmedefinition von
Phase 1 auf ‚identische Ergebnisse bei identischem Bestand' präzisieren" —
wurde nicht umgesetzt. Die Roadmap trägt in Phase 1 weiterhin das
unerfüllbare Kriterium „identisches Ergebnis bei `--repeat 2`", obwohl
AUDIT-019 selbst begründet, warum vollständiger Determinismus über Läufe
hinweg mit diesem Design nicht erreichbar ist.
*Maßnahme:* Abnahmekriterium in der Roadmap (Phase 1) umformulieren, damit es
nicht mehr etwas verspricht, das laut eigener Analyse strukturell
unerreichbar ist.

### NACHAUDIT-05 — Neue Variablen fehlen weiterhin in README/docker-compose
AUDIT-021 wurde für Settings-UI und `.env.example` korrekt umgesetzt
(`routes/settingsFormMapping.js`, 13 Stellen in `views/settings.ejs`).
`README.md` und `docker-compose.yml` erwähnen die drei Feature-Flags und
Schwellwerte weiterhin nicht.
*Maßnahme:* Kurzer Abschnitt in `README.md` (Feature-Flags, wofür sie sind,
wo sie stehen) und Beispieleinträge in `docker-compose.yml`, konsistent mit
`.env.example`.

### NACHAUDIT-06 — Fix-Dokumentation nicht versioniert
`docs/audit/` und alle neun Implementierungspläne der Fix-Welle
(`docs/superpowers/plans/2026-08-0{2,3,4}-*-audit-*.md`) sind laut
`git status` untracked. Die fünf Phasenpläne der ursprünglichen Roadmap sind
committet, die neun Behebungspläne nicht — die Nachvollziehbarkeit der
Fix-Welle existiert damit nur lokal.
*Maßnahme:* Die zehn Dateien (Erstaudit + 9 Pläne) in einem eigenen Commit
aufnehmen, sobald der Inhalt final ist (nach Abschluss der übrigen Pakete
dieses Dokuments, damit nicht mehrfach committet werden muss).

### NACHAUDIT-07 — Lint-Warnungsdeckel exakt auf Ist-Stand
`package.json`: `"lint": "eslint . --max-warnings=83"` sitzt exakt auf der
aktuellen Warnungszahl. Funktioniert als Ratsche (kein Anstieg unbemerkt),
erzwingt aber bei jeder neuen legitimen Warnung eine manuelle Anpassung der
Zahl selbst.
*Maßnahme (optional, niedrige Priorität):* nur mitziehen, falls das im Alltag
stört — kein Fehlverhalten, nur ein Reibungspunkt.

---

## Paket 3 — Review-Queue abarbeiten und Fix-Welle produktiv verifizieren

**Warum zusammen:** Beide Punkte hängen an derselben Beobachtung — die
gesamte Fix-Welle ist bisher ausschließlich durch Tests, nie durch einen
produktiven Lauf verifiziert. `data/entities.db` enthält unverändert den
Zustand des Erstaudits (1 Alias, 121 Queue-Zeilen/120 offen, 72 Embeddings,
kein `entity_merge_log`, obwohl die Tabelle seit der Merge-Log-Erweiterung
angelegt wird). **Setzt Paket 1 voraus**, da ein manuell ausgelöster Scan über
`POST /api/scan/now` läuft, dessen Schutz von Paket 1 abhängt.

### NACHAUDIT-08 — 120 offene Review-Queue-Einträge unbearbeitet (AUDIT-030-Rest)
Die Pagination/Filter/Bulk-Reject-Infrastruktur aus AUDIT-030 ist fertig
(`routes/review.js`), wurde aber noch nicht auf den realen Bestand angewendet.
Eine ungelesene Queue ist keine wirksame Absicherung des Resolvers.
*Maßnahme:* Die 120 offenen Einträge über die Review-UI durchgehen
(Merge/Reject/Bulk-Reject je nach Ähnlichkeit), Ergebnis dokumentieren.

### NACHAUDIT-09 — Merge-Log und aktive Schwellwerte nie unter echter Last beobachtet
Seit der Umstellung von den Defaults (0.90/0.65) auf die gemessenen Werte
(0.8/0.5, siehe `config.entityResolver.autoThreshold`/`.judgeMin`) lief noch
kein produktiver Scan — `entity_merge_log` ist leer, es gibt also noch keinen
über die neue Transaktionslogik (`completeMerge`) geloggten Merge.
*Maßnahme:* Nach Abschluss von Paket 1 einen regulären Scan-Zyklus beobachten
und stichprobenartig prüfen, dass Auto-Merges bei den neuen (niedrigeren)
Schwellwerten sich wie erwartet verhalten — insbesondere, ob die
Trigram-Auto-Merge-Schwelle 0.8 spürbar mehr automatische Zusammenführungen
auslöst als die ursprünglich geschätzten 0.90, und ob das gewünscht ist.

---

## Paket 4 — Fingerprint-Aktivierungsvoraussetzungen schließen

**Warum zusammen:** Alle Punkte betreffen ausschließlich das deaktivierte
Feature `DOCUMENT_FINGERPRINT_ENABLED`. Unkritisch für den laufenden Betrieb,
da das Feature aus bleibt — aber zusammen der einzige Weg zu einer
verantwortbaren Aktivierung. Von den sechs Bedingungen aus dem Erstaudit,
Abschnitt 18.6, sind 2/3/4 bereits erfüllt (AUDIT-003 Herkunftsfeld,
AUDIT-006 ID-Validierung, AUDIT-004 PATCH-vor-Markierung); dieses Paket
schließt die verbleibenden drei.

### NACHAUDIT-10 — Schwellwertmessung für `FINGERPRINT_SIMILARITY_THRESHOLD` fehlt (Bedingung 1)
Das Werkzeug existiert (`scripts/tune-thresholds.js --fingerprint` gegen
`data/eval/fingerprint-pairs.json`, AUDIT-025 behoben), die Messung selbst
wurde nie durchgeführt. `FINGERPRINT_SIMILARITY_THRESHOLD=0.90` ist weiterhin
ein ungemessener Platzhalter.
*Maßnahme:* Mindestens 60 gelabelte Dokumentpaare nach der Klassenverteilung
aus dem Erstaudit (Abschnitt 18.4) zusammenstellen, Sweep über 0.80–0.99 nach
Precision optimieren (nicht F1), Ergebnis in `data/.env` setzen.

### NACHAUDIT-11 — Kein Beobachtungsmodus (Bedingung 5)
Im Code nicht auffindbar: ein Modus, der Fingerprint-Treffer protokolliert
und sichtbar macht (Review-Queue oder Logdatei), **ohne** sie anzuwenden.
*Maßnahme:* `DOCUMENT_FINGERPRINT_MODE=observe|apply` (oder vergleichbar)
einführen; im Beobachtungsmodus `findFingerprintMatch`-Treffer loggen statt in
`updateData` zu übernehmen. Mindestens 200 Dokumente in diesem Modus fahren,
Trefferquote und Stichprobenqualität dokumentieren, bevor auf `apply`
umgeschaltet wird.

### NACHAUDIT-12 — Kein Rückabwicklungspfad (Bedingung 6)
`original_documents` speichert bereits Tags, Korrespondent und Titel vor der
Änderung (`documentModel.saveOriginalData`), aber es gibt keine Funktion, die
daraus wiederherstellt.
*Maßnahme:* Eine `restoreOriginalData(docId)`-Funktion (Route + Service),
die den gespeicherten Vorzustand über die Paperless-API zurückschreibt. Vor
der Aktivierung eines still schreibenden Features sollte ein Weg zurück
existieren.

### NACHAUDIT-13 — `usedFingerprint` zu konservativ bei deaktiviertem Tagging/Dokumenttyp
Kleinerer Nebenbefund aus derselben Codestelle: `usedFingerprint` in
`server.js`/`routes/setup.js` wird als `!!fingerprintMatch` gesetzt, auch wenn
`activateTagging`/`activateDocumentType` deaktiviert sind und der Treffer
faktisch nichts beeinflusst hat. Folge: Der Fingerprint wird als
`source='inherited'` gespeichert und scheidet dadurch fälschlich als
Kandidat für ein drittes Dokument aus — zu konservativ, nicht gefährlich.
*Maßnahme (niedrige Priorität, im selben Paket miterledigen):*
`usedFingerprint` nur setzen, wenn der Treffer tatsächlich in `updateData`
übernommen wurde.

---

## Nicht in ein Paket aufgenommen

- **AUDIT-035** (`/api`-Suffix-Falle, `PAPERLESS_API_URL` muss auf `/api`
  enden): bewusst zurückgestellter „Kandidat" laut Roadmap Z. 73-74, keine
  Zusage, keine Aktion nötig — nur bei Gelegenheit mit aufnehmen, falls
  `paperlessService.initialize()` ohnehin angefasst wird.
- **AUDIT-033/-034**: reine positive Feststellungen aus dem Erstaudit, weiterhin
  gültig, keine Aktion.
