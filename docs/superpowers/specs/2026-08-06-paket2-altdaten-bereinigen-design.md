# Paket 2 — Altdaten bereinigen: Design

**Datum:** 2026-08-06
**Projekt:** paperless-jo (Fork von clusterzx/paperless-ai)
**Status:** Entwurf freigegeben
**Grundlage:** [docs/audit/2026-08-06-fixplan-konsistenz-und-review-ui.md](../../audit/2026-08-06-fixplan-konsistenz-und-review-ui.md),
Abschnitt „Paket 2 — Altdaten bereinigen" (Zeilen 411–523) und „FIX-01"
(Zeilen 425–458).
**Vorgänger:** [docs/superpowers/plans/2026-08-06-paket1-kette-reparieren.md](../plans/2026-08-06-paket1-kette-reparieren.md)
(abgenommen).

## Ausgangslage

Der Fixplan beschreibt Paket 2 als überwiegend manuelle Handarbeit direkt in
der Paperless-ngx-Oberfläche („Diese Schritte laufen direkt in Paperless-ngx,
ohne die Review-UI und ohne Rescan", Zeile 470f). Bei der Durchsicht des
Codes zeigt sich, dass `services/paperlessService.js` dafür bereits fast
alles Nötige bereitstellt:

- `mergeEntity(type, fromId, toId, { dryRun, expectedDocumentIds })`
  (`paperlessService.js:1474`) — Dry-Run-Vorschau, verkettetes Bulk-Reassign
  in Chunks, erst nach verifiziert leerem `fromId` löschen, Fingerprint-
  Invalidierung. Genau das Muster, das 2.1.1 (`contract` → `Entgeltabrechnung`)
  und 2.1.3 (DE/EN-Paare) brauchen.
- `_bulkReassignDocuments` / `POST /documents/bulk_edit/` — für Einzelfälle
  wie 2.1.4 (drei falsch getaggte Dokumente korrigieren) direkt nutzbar.
- Die `scripts/`-Konvention (`measure-judge-latency.js`, `dry-run-eval.js`):
  eigenständige Skripte, die Services direkt requiren, ohne Serverstart.

Zwei der fünf 2.1-Fälle passen nicht in `mergeEntity`s Form (Umzug auf ein
lebendes Ziel), weil es dort keine Zielentität gibt:

- **2.1.2 — 7 leere Dokumentarten löschen.** Kein Reassignment nötig, nur
  eine verifizierte Lösch-Operation.
- **2.1.5 — 4 Empfänger-Korrespondenten entfernen.** Laut Fixplan (Zeile
  490–494) sollen diese **entfernt, nicht zusammengeführt** werden — es gibt
  keinen korrekten Zielkorrespondenten, auf den die Dokumente zeigen sollen.

**Entscheidung dieser Design-Runde:** Paket 2.1 wird als Skript ausgeführt,
nicht als manuelle Klick-Anleitung. Grund: reproduzierbar, dry-run-fähig,
nutzt bereits getestete Bausteine, und passt zum übrigen Projektstil (Paket 1,
`scripts/dry-run-eval.js`). Mehr Implementierungsaufwand jetzt, aber ein
prüfbares Ergebnis statt eines Vertrauens-in-Klicks.

## Grundsatzentscheidungen

**Ein Skript, zwei Modi.** `scripts/cleanup-legacy-vocabulary.js`:
Default = Dry-Run (löst jede Mapping-Zeile gegen die lebende Paperless-Instanz
auf, druckt eine Tabelle, ändert nichts). `--apply` löst jede Zeile **erneut**
auf (Schutz gegen Drift zwischen Vorschau und Ausführung, dasselbe Muster wie
`mergeEntity`s `expectedDocumentIds`) und führt aus. `--apply` ohne
vorangegangenen Dry-Run in demselben Lauf wird verweigert.

**Mapping-Tabelle ist Code, nicht Konfiguration.** Die Zuordnungen (Quelle →
Ziel bzw. Quelle → „löschen") stehen als Konstanten im Skript, nicht in einer
externen Config-Datei — es ist ein einmaliger Aufräumlauf, keine
wiederkehrende Funktion. Ambivalente Fälle (siehe unten) werden vor dem
Eintrag in die Tabelle einzeln nachgesehen, nicht blind nach Namen gemappt.

**`Notification` wird nicht blind gemappt.** Der Fixplan nennt zwei mögliche
deutsche Ziele (`Mitteilung`/`Bescheid`) ohne Entscheidung — das ist
dokumentinhaltsabhängig. Diese Zeile wird beim Ausführen des Skripts von Hand
aufgelöst (Dokumente ansehen, dann in die Mapping-Tabelle eintragen), nicht
im Design vorweggenommen.

**Neue `paperlessService`-Methoden statt Skript-lokaler API-Calls.** Analog zu
`mergeEntity`: Sicherheits-Invarianten (leer-vor-Löschen prüfen, 404-beim-
Löschen ist kein Fehler) gehören in den Service, nicht ins Skript, damit sie
unit-testbar sind und von einer künftigen UI (Paket 3) wiederverwendet werden
können.

**FIX-01 bleibt im Code unangetastet.** Der Fixplan entscheidet das
ausdrücklich (V-3, zurückgestellt). Dieses Paket fügt nur den dokumentierten
SQL-Workaround hinzu (`DELETE FROM processed_documents`, `original_documents`
bleibt stehen) — und nur als Schritt, der bei Bedarf für einen Rescan
ausgeführt wird, nicht automatisch.

**2.2 (Rescan) wird hier nicht vorentschieden.** Der Fixplan verlangt
ausdrücklich, erst nach 2.1 mit den dann bekannten Zahlen zu entscheiden
(Zeile 496–511). Der Implementierungsplan endet mit einer Aufgabe, die
Entscheidung **nach** Ausführung von 2.1 zu treffen und mit Begründung in den
Fixplan nachzutragen (Abnahmekriterium 5) — nicht mit einer vorweggenommenen
Antwort.

## Architektur

```
scripts/cleanup-legacy-vocabulary.js
  │
  ├─ DOCUMENT_TYPE_MERGES   [{from, to}, ...]     ─┐
  ├─ TAG_MERGES             [{from, to}, ...]      │  über mergeEntity(type, fromId, toId, {dryRun})
  │                                                 │  (bereits vorhanden, unveraendert)
  ├─ MISTAGGED_DOCUMENT_FIXES [{docId, remove, add}] ─ über bulk_edit modify_tags direkt (Einzeldokumente)
  │
  ├─ EMPTY_DOCUMENT_TYPES   (auto-erkannt: document_count === 0)
  │     └─ paperlessService.deleteEmptyEntity(type, id)         [NEU]
  │
  └─ CORRESPONDENTS_TO_REMOVE [id, ...]
        └─ paperlessService.clearAndDeleteEntity(type, id)      [NEU]
```

**Ablauf pro Lauf:**
1. Mapping-Zeilen gegen die API auflösen (Namen → IDs, Dokumentzahlen holen).
2. Tabelle drucken: Aktion, Quelle, Ziel, betroffene Dokumente.
3. Bei `--apply`: jede Zeile ausführen, Fortschritt pro Zeile loggen, bei
   Fehler einer Zeile mit den bereits erledigten Zeilen fortfahren (nicht
   abbrechen — ein leerer Dokumenttyp, der schon gelöscht ist, soll den Rest
   nicht blockieren) und am Ende eine Zusammenfassung (erfolgreich/
   fehlgeschlagen je Zeile) ausgeben.

### Neue `paperlessService`-Methoden

**`deleteEmptyEntity(type, id)`**
- Liest die Entität, prüft `document_count === 0` (bzw. per
  `_findDocumentsWithEntity` gegenprüft, falls das Listing-Feld fehlt).
- Wirft, wenn nicht leer.
- `DELETE /{type}s/{id}/`; 404 wird wie in `mergeEntity` als „bereits
  gelöscht" behandelt, kein Fehler.

**`clearAndDeleteEntity(type, id)`**
- Nur für `correspondent` vorgesehen (die einzige Verwendung in diesem
  Paket), aber generisch wie `mergeEntity` gebaut.
- `_findDocumentsWithEntity(type, id)`, dann `bulk_edit` mit
  `method: 'set_correspondent', parameters: { correspondent: null }` in
  Chunks (`_bulkReassignDocuments`-Muster, aber Ziel `null` statt `toId`).
- Nach verifiziert leerem Zustand: `DELETE`, gleiche 404-Behandlung.

Beide folgen den bestehenden Kommentar- und Fehlerbehandlungs-Konventionen
in `paperlessService.js` (`error.mergeProgress`-artiges Objekt bei
Teilfehlern, deutsche Inline-Kommentare für das „Warum").

## Datenfluss / Mapping-Inhalt

Bekannt aus dem Fixplan, wird beim Schreiben des Skripts direkt eingetragen:

```js
const DOCUMENT_TYPE_MERGES = [
  { from: 'contract', to: 'Entgeltabrechnung' },              // 2.1.1, 20 Dok
  { from: 'Payroll Statement', to: 'Entgeltabrechnung' },     // 2.1.3
  { from: 'salary tax certificate', to: 'Lohnsteuerbescheinigung' },
  { from: 'Practicum Confirmation', to: 'Praktikumsbestätigung' },
  // 'Notification' -> Mitteilung ODER Bescheid: vor Eintrag Dokumente pruefen.
];

const TAG_MERGES = [
  { from: 'Personal Data', to: 'Persönliche Daten' },
  // Electronic Document / elektronisch, Tax Document, Invoice,
  // Curriculum Vitae: deutsches Ziel-Tag beim Schreiben des Skripts anhand
  // des tatsaechlichen Bestands (nicht geraten) eintragen.
];
```

`EMPTY_DOCUMENT_TYPES_TO_DELETE` wird **nicht** hartcodiert, sondern zur
Laufzeit über `GET /document_types/` mit `document_count === 0` ermittelt —
die sieben betroffenen sind im Fixplan nicht namentlich aufgeführt.

`CORRESPONDENTS_TO_REMOVE` und `MISTAGGED_DOCUMENT_FIXES` (die drei
Dokumente aus den Fehl-Merges vom 2026-08-05, nachschlagbar über
`entity_merge_log` mit `entity_type='tag'` und den `to_id`-Werten der drei in
Paket 1 §1.4 gelöschten Aliase) werden ebenso beim Schreiben des Skripts aus
dem lebenden Bestand aufgelöst, nicht vorweg geraten.

## Fehlerbehandlung

Gleiche Haltung wie `mergeEntity`: Chunk-Fehler melden Teilfortschritt, ein
Ziel, das nach der Vorschau nicht mehr existiert, bricht die Zeile ab statt
blind weiterzumachen, ein 404 beim Löschen ist kein Fehler. Eine fehlgeschlagene
Zeile blockiert nicht die übrigen — am Ende steht eine Zusammenfassung, welche
Zeilen durch sind und welche nicht, damit ein zweiter `--apply`-Lauf gezielt
nur die Fehlschläge wiederholen kann (jede Zeile ist idempotent: bereits
durchgeführte Merges/Löschungen finden beim erneuten Auflösen keinen
`fromId`/keine leere Entität mehr und werden übersprungen).

## Testing

- `deleteEmptyEntity` und `clearAndDeleteEntity`: neue Unit-Tests (gleiche
  Datei/gleiches Muster wie die bestehenden `mergeEntity`-Tests), `axios`-
  Client gemockt: leer-Pruefung schlaegt bei non-empty fehl, 404-beim-Loeschen
  ist kein Fehler, Chunk-Fehler wird durchgereicht.
- Das Skript selbst: kein Unit-Test (operatives Werkzeug gegen eine lebende
  Instanz, wie `measure-judge-latency.js`) — verifiziert durch Dry-Run gegen
  die echte Instanz und Sichtprüfung der Tabelle vor `--apply`.
- Abnahmekriterien sind die fünf bereits im Fixplan genannten (Zeile
  513–522): Dokumentarten < 15 ohne leere, `contract` verschwunden,
  kein Korrespondent mit Anrede/Anschrift/Personalnummer im Namen, beide
  Datenbank-Sicherungen außerhalb des Projektverzeichnisses nachweisbar, die
  2.2-Entscheidung mit Begründung im Fixplan nachgetragen.

## Abgrenzung

- **FIX-01 im Code beheben:** nicht Teil dieses Pakets (V-3, zurückgestellt).
- **2.2 (Rescan ja/nein) vorentscheiden:** nicht Teil dieses Designs — der
  Implementierungsplan endet mit der Aufgabe, diese Entscheidung nach 2.1 zu
  treffen und zu dokumentieren, trifft sie aber nicht selbst.
- **Review-UI für Aliase/Merge-Log (Paket 3):** unverändert eigenes Paket.
