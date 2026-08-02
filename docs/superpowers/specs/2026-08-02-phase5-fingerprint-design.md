# Phase 5 — Dokument-Fingerprint für wiederkehrende Dokumente

**Datum:** 2026-08-02
**Projekt:** paperless-jo (Fork von clusterzx/paperless-ai)
**Status:** Entwurf freigegeben
**Roadmap:** [docs/planning/klassifikations-konsistenz-roadmap.md](../../planning/klassifikations-konsistenz-roadmap.md)
**Vorgänger-Design:** [docs/superpowers/specs/2026-08-02-phase4-embeddings-design.md](2026-08-02-phase4-embeddings-design.md)

## Ausgangslage

Die Roadmap setzt für den Entwurf von Phase 5 voraus, dass Phase 1–4 laufen
und gemessen ist, wie viel Inkonsistenz danach überhaupt noch bleibt. Diese
Messung wurde am 2026-08-02 nachgeholt:

- `ENTITY_RESOLVER_ENABLED=yes`, `EMBEDDING_SIMILARITY_ENABLED=yes` aktiviert,
  `bge-m3` gepullt, `EMBED_AUTO_THRESHOLD=0.90`/`EMBED_JUDGE_MIN=0.50` über
  `scripts/tune-thresholds.js` gemessen.
- **Altbestands-Durchlauf:** der Embedding-Kanal trifft bei Dokumentarten und
  Korrespondenten genau die gesuchten Fälle (`Verdienstbescheinigung` /
  `Payroll Statement`, `Meldebeschreibung` / `Meldebescheinigung`). Bei Tags
  erzeugte er dagegen überwiegend Rauschen (thematisch verwandte, aber nicht
  duplizierte Tags) — behoben durch `EMBEDDING_EXCLUDED_TYPES=tag` (eigener
  Commit, nicht Teil dieses Designs).
- **Stabilitäts-Nachmessung** (`dry-run-eval.js --repeat 2`, dieselben 10
  Dokumente wie die Phase-1-Baseline): 4 von 10 Dokumenten instabil (Baseline
  nach Phase 1: 3 von 10). Der EntityResolver hängt ausschließlich im
  Schreibpfad (`processTags`/`getOrCreate*`) und wirkt auf diese Messung
  nicht — sie zeigt reine LLM-Instabilität trotz `temperature: 0`, `seed: 42`.
  Beispiel: dasselbe Gehaltsdokument bekommt bei Wiederholung einmal
  `Verdienstbescheinigung`/„Freibetrag, Jährlich", einmal `Lohnabrechnung`/
  dieselben Tags — unterschiedliche, sachlich gleichwertige Einordnung.

**Befund:** reine Prompt-Determinismus hält die Instabilität bei ~30–40 %,
unabhängig davon, wie viele nachgelagerte Phasen gebaut wurden. Phase 5 ist
damit weiterhin nötig — es gibt genau die Instabilitätsklasse zu beheben, für
die sie skizziert wurde: dasselbe wiederkehrende Dokument (z.B. monatliche
Gehaltsabrechnung desselben Arbeitgebers) bekommt bei jedem Lauf eine leicht
andere, aber inhaltlich gleichwertige Klassifikation.

## Grundsatzentscheidungen

**Reihenfolge: LLM zuerst, Fingerprint danach.** Der Korrespondent ist vor dem
LLM-Call meist nicht zuverlässig bekannt (das ist ja gerade Teil dessen, was
klassifiziert wird) — ein Fingerprint-Check, der den LLM-Call ersetzen soll,
bräuchte den Korrespondenten aber vorher. Deshalb läuft der Fingerprint-Check
nach der bestehenden Entity-Resolver-Auflösung in `buildUpdateData`, wenn
`updateData.correspondent` bereits eine kanonische Paperless-ID ist. Kein
Entfall des LLM-Calls (kein Compute-Vorteil), aber maximale Stabilität ohne
neue Mehrdeutigkeit beim Korrespondenten-Abgleich.

**Überschriebene Felder: nur Tags + Dokumentart.** Titel und Datum bleiben die
frisch vom LLM extrahierten Werte, weil sie sich bei echten wiederkehrenden
Dokumenten legitim unterscheiden (anderer Monat, anderer Betrag). Der
Korrespondent wird durch die Kandidatensuche bereits als Suchschlüssel
verwendet (siehe Architektur) — ein zusätzliches Überschreiben wäre an dieser
Stelle ein No-op, da Kandidaten ausschließlich mit identischer
`correspondent_id` gesucht werden. Die bereits vom Entity-Resolver geleistete
Korrespondenten-Kanonisierung (Phase 2–4) wird hier bewusst wiederverwendet
statt ein zweites Mal gelöst.

**Optional, additiv, per Default aus.** Wie `ENTITY_RESOLVER_ENABLED` und
`EMBEDDING_SIMILARITY_ENABLED`: `DOCUMENT_FINGERPRINT_ENABLED=no` als
Code-Default. Bei `no` verhält sich die Anwendung exakt wie nach Phase 4.

**Kein Judge, keine Review-Queue.** Anders als der EntityResolver gibt es
hier keine LLM-Judge-Stufe und keine Human-in-the-loop-Absicherung — ein
Treffer wird still angewendet. Das ist eine bewusste Vereinfachung (siehe
„Bewusst ausgeschlossen"), abgesichert durch einen konservativ hohen
Start-Schwellwert und vollständiges Logging jedes Treffers.

## Architektur

```
LLM-Analyse (analysis.document: tags, correspondent, document_type, title, date)
        │
        ▼
buildUpdateData: bestehende Entity-Resolver-Aufloesung
  (processTags / getOrCreateCorrespondent / getOrCreateDocumentType)
        │  updateData.correspondent ist jetzt eine kanonische Paperless-ID
        ▼
DOCUMENT_FINGERPRINT_ENABLED=yes und updateData.correspondent gesetzt?
        │ nein ──────────────────────────────────────────────────────► weiter wie bisher
        │ ja
        ▼
documentFingerprintService.findMatch(correspondentId, content)
  1. Kandidaten aus document_fingerprints mit gleicher correspondent_id
  2. kein Kandidat? -> null (erstes Dokument dieses Korrespondenten)
  3. content einbetten (entityEmbeddingService, gekuerzt)
  4. Cosine-Similarity gegen jeden Kandidaten, bester gewinnt
  5. bester >= FINGERPRINT_SIMILARITY_THRESHOLD? -> Treffer, sonst null
        │
        ▼ Treffer                                   ▼ kein Treffer
updateData.tags = Treffer.tag_ids            updateData.tags/document_type
updateData.document_type = Treffer.doc_type_id      unveraendert
        │                                            │
        └──────────────────┬─────────────────────────┘
                            ▼
              paperlessService.updateDocument (wie bisher)
                            │
                            ▼
        documentFingerprintService.recordFingerprint(...)
        (neuer Eintrag mit den TATSAECHLICH geschriebenen Werten)
```

## Neue/geänderte Module

### `models/documentFingerprintStore.js` (neu)

Gleiche Datenbank wie der EntityResolver (`config.entityResolver.dbPath`,
`data/entities.db`), gleiches Verbindungsmuster wie `entityStore.js` —
keine neue `.db`-Datei für eine eng verwandte, ebenfalls
resolver-adjazente Zustandsart.

```sql
CREATE TABLE IF NOT EXISTS document_fingerprints (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL UNIQUE,
  correspondent_id INTEGER NOT NULL,
  document_type_id INTEGER,
  tag_ids TEXT NOT NULL,        -- JSON-Array von Paperless-Tag-IDs
  content_embedding TEXT NOT NULL, -- JSON-Array (Float-Vektor)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_fingerprints_correspondent
  ON document_fingerprints(correspondent_id);
```

Methoden: `findCandidates(correspondentId)`, `upsertFingerprint({documentId,
correspondentId, documentTypeId, tagIds, embedding})`. `UNIQUE(document_id)`
mit `ON CONFLICT REPLACE`-Semantik, damit eine erneute Verarbeitung desselben
Dokuments (z.B. manueller Re-Scan) den alten Fingerprint-Eintrag ersetzt statt
zu duplizieren.

### `services/documentFingerprintService.js` (neu)

Analog zu `entityBackfillService.js`: Store und Embedding-Service injiziert,
keine eigene DB- oder Netzwerk-Logik in der Entscheidungsfunktion.

```js
class DocumentFingerprintService {
  constructor({ store, embeddingService, similarityThreshold }) { ... }

  // Gibt { tagIds, documentTypeId } zurueck oder null
  async findMatch(correspondentId, content) {
    const candidates = this.store.findCandidates(correspondentId);
    if (candidates.length === 0) return null;

    let vector;
    try {
      vector = await this.embeddingService.embed(truncate(content));
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Embedding fehlgeschlagen, kein Treffer:', error.message);
      return null;
    }

    let best = null;
    for (const candidate of candidates) {
      const sim = this.embeddingService.cosineSimilarity(vector, JSON.parse(candidate.content_embedding));
      if (Number.isFinite(sim) && (!best || sim > best.sim)) {
        best = { sim, candidate };
      }
    }

    if (!best || best.sim < this.similarityThreshold) return null;

    console.log(`[INFO] documentFingerprintService: Treffer fuer correspondent=${correspondentId}, similarity=${best.sim.toFixed(3)}, document_id=${best.candidate.document_id}`);
    return {
      tagIds: JSON.parse(best.candidate.tag_ids),
      documentTypeId: best.candidate.document_type_id
    };
  }

  async recordFingerprint({ documentId, correspondentId, documentTypeId, tagIds, content }) {
    try {
      const vector = await this.embeddingService.embed(truncate(content));
      this.store.upsertFingerprint({
        documentId, correspondentId, documentTypeId, tagIds,
        embedding: JSON.stringify(vector)
      });
    } catch (error) {
      console.warn('[WARNING] documentFingerprintService: Fingerprint konnte nicht gespeichert werden:', error.message);
    }
  }
}
```

Textkürzung (`truncate`): die ersten 3000 Zeichen des Dokumentinhalts —
deutlich weniger als die 50000 Zeichen vor dem LLM-Call, weil hier nur ein
struktureller Fingerabdruck gebraucht wird, kein vollständiges Verständnis.

### `services/entityEmbeddingService.js` (wiederverwendet)

Kein neuer Embedding-Client — dieselbe Instanz aus Phase 4 (`embed()`,
`cosineSimilarity()`), da bereits gegen Ollama/`bge-m3` konfiguriert und
getestet. Voraussetzung: `EMBEDDING_SIMILARITY_ENABLED=yes` **oder** ein
eigener Modell-Check — siehe Fehlerverhalten.

### `config/config.js` (erweitert)

```js
documentFingerprint: {
  enabled: parseEnvBoolean(process.env.DOCUMENT_FINGERPRINT_ENABLED, 'no') === 'yes',
  similarityThreshold: clampThreshold(
    parseEnvNumber(process.env.FINGERPRINT_SIMILARITY_THRESHOLD, 0.90),
    'FINGERPRINT_SIMILARITY_THRESHOLD'
  )
}
```

`0.90` ist ein konservativer Startwert, **nicht gemessen** — siehe
„Offener Folgeschritt".

### `server.js` (erweitert)

Neuer Schritt zwischen `buildUpdateData` und `saveDocumentChanges` in der
Verarbeitungsfunktion (Name im bestehenden Code z.B. `processDocument`):

```js
if (config.documentFingerprint.enabled && updateData.correspondent) {
  const match = await documentFingerprintService.findMatch(updateData.correspondent, content);
  if (match) {
    // Respektiert dieselben Aktivierungs-Schalter wie buildUpdateData selbst -
    // ein per activateTagging='no' abgeschaltetes Feld darf der Fingerprint
    // nicht wieder anschalten.
    if (config.limitFunctions?.activateTagging !== 'no') {
      updateData.tags = match.tagIds;
    }
    if (config.limitFunctions?.activateDocumentType !== 'no' && match.documentTypeId) {
      updateData.document_type = match.documentTypeId;
    }
  }
}
```

Nach erfolgreichem `saveDocumentChanges`:

```js
if (config.documentFingerprint.enabled && updateData.correspondent) {
  await documentFingerprintService.recordFingerprint({
    documentId: doc.id,
    correspondentId: updateData.correspondent,
    documentTypeId: updateData.document_type ?? null,
    tagIds: updateData.tags ?? [],
    content
  });
}
```

`content` ist zu diesem Zeitpunkt bereits vorhanden (wurde für den LLM-Call
geladen), kein zusätzlicher Paperless-Call nötig.

## Fehlerverhalten

| Fehler | Verhalten |
|---|---|
| Kein vorheriges Dokument für diesen Korrespondenten | kein Treffer, normaler Ablauf |
| `updateData.correspondent` nicht gesetzt (Korrespondenten-Erkennung deaktiviert) | Fingerprint-Check wird übersprungen |
| Embedding-Call schlägt fehl (Ollama nicht erreichbar) | Warnung loggen, kein Treffer, normaler Ablauf — Klassifikation bricht nie ab |
| `document_fingerprints` nicht schreibbar | Warnung loggen, Fingerprint für dieses Dokument geht verloren, restlicher Ablauf unverändert |
| `DOCUMENT_FINGERPRINT_ENABLED=no` | Verhalten identisch zu Phase 4, kein neuer Code-Pfad wird betreten |
| Falsch-positiver Treffer (unähnliches Dokument fälschlich als Serie erkannt) | keine automatische Korrektur — wird still angewendet. Mitigiert durch konservativen Start-Schwellwert und Logging jedes Treffers (Korrespondent, Similarity, referenzierte `document_id`) für manuelle Nachkontrolle |

## Testing

- `documentFingerprintService.test.js` (node:test, In-Memory-artiger Fake-Store
  nach demselben Muster wie `entityBackfillService.test.js`): kein Kandidat →
  `null`; ein Kandidat über Schwelle → dessen `tagIds`/`documentTypeId`; ein
  Kandidat unter Schwelle → `null`; mehrere Kandidaten, bester (höchste
  Similarity) gewinnt; Embedding-Fehler → `null`, kein Absturz;
  `recordFingerprint` schreibt und überschreibt bei erneuter Verarbeitung
  desselben `document_id` (`ON CONFLICT REPLACE`).
- `documentFingerprintStore.test.js`: CRUD, `findCandidates` filtert korrekt
  nach `correspondent_id`, Upsert-Semantik bei wiederholtem `document_id`.
- Kein Test für den `server.js`-Hook selbst nötig über das bestehende Maß
  hinaus — die Verdrahtung ist ein einfacher Sequenzaufruf, die Logik steckt
  vollständig in `documentFingerprintService`.

## Offener Folgeschritt (nicht Teil der Implementierung dieses Plans)

`FINGERPRINT_SIMILARITY_THRESHOLD=0.90` ist geschätzt, nicht gemessen — es
gibt aktuell keine gelabelte Fixture aus Dokumentpaaren ("gleiche
wiederkehrende Serie" vs. "verschieden, aber ähnlich"). Analog zu
`scripts/tune-thresholds.js` (Phase 2/4) braucht dieser Schwellwert eine
eigene Tuning-Messung, bevor der Kanal produktiv scharf geschaltet wird.
Diese Messung ist expliziter Folgeschritt nach der Implementierung, nicht
Teil davon — der Code-Default bleibt `DOCUMENT_FINGERPRINT_ENABLED=no`, bis
das nachgeholt ist.

## Bewusst ausgeschlossen

- **LLM-Judge-Stufe für Fingerprint-Treffer.** Anders als beim EntityResolver
  gibt es hier keine dritte Instanz, die unsichere Treffer beurteilt. Ein
  Judge-Call pro Dokument würde den Compute-Vorteil (kein zusätzlicher
  LLM-Call gegenüber heute) zunichtemachen und die Architektur unnötig
  verkomplizieren. Die Absicherung erfolgt stattdessen über einen
  konservativen Schwellwert und vollständiges Logging.
- **Review-Queue für Fingerprint-Treffer.** Aus demselben Grund — das würde
  die "starker Vorschlag, still übernommen"-Eigenschaft aus der
  Roadmap-Skizze aufgeben und näher an den EntityResolver-Mechanismus
  heranrücken, den es bewusst ergänzt statt dupliziert.
- **Fingerprint-Suche über Korrespondenten-Grenzen hinweg.** Ohne
  `correspondent_id`-Filter würde jede Kandidatensuche gegen den gesamten
  historischen Dokumentbestand laufen — sowohl langsamer als auch
  fehleranfälliger (zwei verschiedene Korrespondenten mit strukturell
  ähnlichen Formularen, z.B. zwei Versicherungen mit ähnlichem
  Beitragsrechnungs-Layout, dürften nicht sich gegenseitig beeinflussen).
- **Fuzzy-Korrespondentenabgleich innerhalb der Fingerprint-Suche.** Die
  Korrespondenten-Kanonisierung ist bereits vollständig Aufgabe des
  EntityResolvers (Phase 2–4). Eine zweite, eigene Fuzzy-Logik hier wäre
  Doppelarbeit und eine zweite Fehlerquelle.
