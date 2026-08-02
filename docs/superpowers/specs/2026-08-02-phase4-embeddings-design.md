# Phase 4 — Embeddings-Ähnlichkeitskanal

**Datum:** 2026-08-02
**Projekt:** paperless-jo (Fork von clusterzx/paperless-ai)
**Status:** Entwurf freigegeben
**Roadmap:** [docs/planning/klassifikations-konsistenz-roadmap.md](../../planning/klassifikations-konsistenz-roadmap.md)
**Vorgänger-Design:** [docs/superpowers/specs/2026-08-01-klassifikations-konsistenz-design.md](2026-08-01-klassifikations-konsistenz-design.md)

## Ausgangslage

Phase 2 (Task 11, finaler Review) hat gemessen, dass reine Trigram-Ähnlichkeit
orthografisch nahe Varianten zuverlässig erkennt (`Meldebescheid` /
`Meldebescheinigung` = 0.71), aber an orthografisch fernen Synonymen strukturell
scheitert: `Entgeltabrechnung` / `Verdienstbescheinigung` = 0.10,
`Entgeltabrechnung` / `Payroll Statement` = 0.06 (sprachübergreifend
DE/EN). Bei keiner sinnvollen Schwelle wählt Stufe 4 der Kaskade diese Paare je
als Judge-Kandidat aus — der Judge bekommt sie nie zu sehen. Das ist kein
Schwellwert-, sondern ein Signal-Problem: Trigram-Ähnlichkeit kann semantische
Nähe ohne orthografische Nähe nicht abbilden.

Phase 4 ergänzt einen zweiten, semantischen Ähnlichkeitskanal über
Text-Embeddings, um genau diese Fälle sichtbar zu machen.

## Umgebung

- Ollama auf eigener VM, RTX 4060 mit 8 GB VRAM, `qwen2.5:7b-instruct-q4_K_M`
  bereits für Klassifikation und Judge geladen.
- Embedding-Modell: `bge-m3` (multilingual, gute DE/EN-Ausrichtung — passend
  zum Payroll-Statement-Beispiel), über Ollamas `/api/embed`. Zusätzlicher
  VRAM-Bedarf ca. 1.2 GB, muss vorab per `ollama pull bge-m3` auf der VM
  bereitstehen.
- Bestandsgröße unverändert klein (~40 Tags, 17 Dokumentarten, 16
  Korrespondenten) — quadratische Vergleiche im Altbestand bleiben
  unproblematisch, solange sie keinen Netzwerk-Call pro Paar auslösen.

## Grundsatzentscheidung: optional, additiv, per Default aus

Wie der EntityResolver selbst (`ENTITY_RESOLVER_ENABLED`) ist der
Embedding-Kanal ein eigener Schalter: `EMBEDDING_SIMILARITY_ENABLED=no` als
Code-Default. Bei `no` verhält sich die Anwendung exakt wie nach Phase 3 —
kein einziger Embedding-Call, keine neue Tabelle wird befüllt. Aktivierung ist
eine bewusste Folgeentscheidung, kein Teil dieser Phase (dieselbe Haltung wie
schon bei `ENTITY_RESOLVER_ENABLED` in Phase 2). Grund: die Software soll auch
ohne dedizierte Embedding-Infrastruktur (kein `bge-m3` auf der Ollama-Instanz)
lauffähig bleiben.

## Architektur

```
                    Stufe 4 (Ähnlichkeit)
Vorschlag N ─────┬──────────────────────────────────────┐
                  │ Trigram (immer)                      │ Embedding (falls enabled)
                  ▼                                      ▼
      trigramSim(N, jede Bestandsentität)      embeddingSim(N, jede Bestandsentität)
                  │                                      │
                  └──────────────┬───────────────────────┘
                                 ▼
              combinedScore(entität) = max(trigramSim, embeddingSim)
                                 │
                    bester Kandidat nach combinedScore
                                 │
        ┌────────────────────────┼─────────────────────────┐
        ▼ trigramSim ≥ AUTO      ▼ embeddingSim ≥ EMBED_AUTO ▼ sonst
     map (via 'similarity')   map (via 'embedding_similarity')  Negativ-Cache →
                                                                 Judge-Zone → create
```

`combinedScore` bestimmt **nur die Kandidatenauswahl** — welche Bestandsentität
am nächsten liegt, unabhängig davon, welcher Kanal das erkannt hat. Die
Entscheidung (`map`/`judge`/`create`) prüft danach den **rohen Wert jedes
Kanals gegen dessen eigenen Schwellwert**. Begründung: Cosine-Ähnlichkeit
(Embeddings) und Dice-Koeffizient (Trigram) liegen auf unterschiedlichen
Skalen — unverwandte Texte liefern bei Embedding-Modellen typischerweise eine
Baseline-Ähnlichkeit deutlich über 0, bei Trigram tendenziell gegen 0. Ein
einzelner gemeinsamer Schwellwert auf dem `max()`-Wert wäre daher statistisch
nicht belastbar und würde vermutlich zu falschen Auto-Merges durch die
Embedding-Baseline führen. Getrennte Schwellwerte pro Kanal, gemessen wie in
Phase 2, vermeiden das.

## Neue/geänderte Module

### `services/entityEmbeddingService.js` (neu)

Analog zu `services/entityJudge.js`: kleiner, injizierbarer Client.

```js
class EntityEmbeddingService {
  constructor({ apiUrl, model }) { ... }
  async embed(text) { ... }              // -> Float32Array, Ollama /api/embed
}

function cosineSimilarity(vecA, vecB) { ... }  // reine Funktion, testbar ohne Netzwerk
```

`entityResolver` und `entityBackfillService` bekommen diesen Service (bzw.
einen Fake in Tests) injiziert, dieselbe Trennung von Entscheidung und
Ausführung wie beim Judge.

### `models/entityStore.js` (erweitert)

Neue Tabelle:

```sql
CREATE TABLE entity_embeddings (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  entity_name TEXT NOT NULL,   -- fuer Staleness-Erkennung, siehe unten
  model TEXT NOT NULL,         -- fuer Modellwechsel-Erkennung
  vector BLOB NOT NULL,        -- Float32Array als Buffer
  created_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id)
);
```

Neue Methoden: `getEmbedding(type, id)`, `upsertEmbedding({type, id, name,
model, vector})`, `deleteEmbedding(type, id)`.

**Cache-Invalidierung**, defensiv wie beim bestehenden Alias-Mechanismus
(„ID nicht mehr im Bestand → Alias verwerfen, neu entscheiden"):

- gecachter `entity_name` weicht vom aktuellen Bestandsnamen derselben ID ab
  (Umbenennung in Paperless) → Zeile verwerfen, neu berechnen.
- `entity_id` ist nicht mehr im aktuellen Bestand → Zeile verwerfen.
- gecachtes `model` weicht von `config.embedding.model` ab (Modellwechsel) →
  Zeile ignorieren, neu berechnen. Vektoren verschiedener Modelle sind nicht
  vergleichbar.

`entity_review_queue` bekommt statt des einen `similarity`-Felds zwei
nullable Spalten:

```sql
ALTER TABLE entity_review_queue ADD COLUMN trigram_similarity REAL;
ALTER TABLE entity_review_queue ADD COLUMN embedding_similarity REAL;
```

(Bestehende `similarity`-Spalte bleibt für Rückwärtskompatibilität mit
Backfill-Läufen vor Phase 4 erhalten, wird aber von neuem Code nicht mehr
geschrieben — neue Einträge befüllen ausschließlich die beiden spezifischen
Spalten. Die Migration ist rein additiv, `CREATE TABLE IF NOT EXISTS` plus
`ALTER TABLE ... ADD COLUMN` mit Existenzprüfung, kein Datenverlust.)

`entity_aliases.source` erhält den zusätzlichen möglichen Wert
`'auto_embedding'` (neben `'auto'`, `'llm'`, `'user'`) — keine Schema-Änderung
nötig, das Feld ist bereits `TEXT`.

### `services/entityResolver.js` (erweitert)

Stufe 4 wird umgebaut: statt nur des besten Trigram-Kandidaten wird pro
Bestandsentität `max(trigramSim, embeddingSim)` gebildet (Embedding-Teil nur,
wenn `config.embedding.enabled` und der Embed-Call für den Vorschlag
erfolgreich war — sonst fließt nur Trigram ein, siehe Fehlerverhalten). Der
Kandidat mit dem höchsten kombinierten Wert wird gewählt.

Reihenfolge der Prüfung für diesen Kandidaten (Negativ-Cache wie bisher vor
jeder Auto-Stufe):

1. `trigramSim ≥ AUTO_THRESHOLD` → `map`, `via: 'similarity'`, Alias
   `source: 'auto'` (unverändertes Verhalten aus Phase 2 — Trigram-Treffer
   gehen unverändert vor, damit sich für bereits funktionierende Fälle nichts
   ändert)
2. sonst `embeddingSim ≥ EMBED_AUTO_THRESHOLD` → `map`, `via:
   'embedding_similarity'`, Alias `source: 'auto_embedding'`
3. Negativ-Cache-Treffer → `create`
4. `trigramSim ≥ JUDGE_MIN` oder `embeddingSim ≥ EMBED_JUDGE_MIN` → Judge
   (unverändert: nur die beiden Namen, kein Hinweis auf den auslösenden
   Kanal — der Judge beurteilt Namen, nicht Scores)
5. sonst `create`

Bei `create_and_queue` bzw. `recordCreatedAndQueued` werden künftig beide
Rohwerte durchgereicht und in `trigram_similarity`/`embedding_similarity`
geschrieben.

### `services/entityBackfillService.js` (erweitert)

Der quadratische Altbestandsvergleich bekommt denselben kombinierten Score.
Da alle Bestandsvektoren nach dem ersten Durchlauf im Cache liegen, verursacht
das keine zusätzlichen Ollama-Calls — nur Cosine-Berechnung in JS. Vor dem
eigentlichen Vergleichslauf werden fehlende Embeddings für den gesamten
Bestand des jeweiligen Typs einmalig nachgezogen (Batch, kein Call pro Paar).
Ohne aktivierten Embedding-Kanal bleibt der Lauf exakt wie heute
(Trigram-only).

### `scripts/tune-thresholds.js` (erweitert)

Läuft weiterhin über `data/eval/entity-labels.json` (gleiche Fixture wie
Phase 2). Zusätzlich zur bestehenden Trigram-Schwellwerttabelle wird — nur
wenn Ollama mit `bge-m3` erreichbar ist — dieselbe Precision/Recall-Analyse
für Embedding-Ähnlichkeit ausgegeben, inklusive der bereits vorhandenen Liste
„schwierigste same-Paare" (der Kommentar im bestehenden Skript verweist
bereits auf genau diesen Zweck). Ergebnis: `EMBED_AUTO_THRESHOLD` und
`EMBED_JUDGE_MIN` werden gemessen statt geschätzt, wie schon `AUTO_THRESHOLD`/
`JUDGE_MIN` in Phase 2.

### `config/config.js` (erweitert)

```js
embedding: {
  enabled: process.env.EMBEDDING_SIMILARITY_ENABLED === 'yes', // Default: aus
  apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434', // dieselbe Instanz
  model: process.env.EMBEDDING_MODEL || 'bge-m3',
  autoThreshold: parseEnvNumber(process.env.EMBED_AUTO_THRESHOLD, <gemessener Wert>),
  judgeMin: parseEnvNumber(process.env.EMBED_JUDGE_MIN, <gemessener Wert>)
}
```

Startwerte für `EMBED_AUTO_THRESHOLD`/`EMBED_JUDGE_MIN` werden aus der
Tuning-Messung (siehe oben) übernommen, nicht vorab geschätzt in den Code
geschrieben — konsistent mit der Vorgehensweise in Phase 2.

### `routes/review.js` / `views/review.ejs` (erweitert)

Die Tabelle zeigt zusätzlich zur bisherigen Ähnlichkeitsspalte, welcher Kanal
den Kandidaten geliefert hat: Trigram-Wert, Embedding-Wert (falls vorhanden),
optisch hervorgehoben, welcher über der jeweiligen Judge-Schwelle lag. Reine
Erweiterung der bestehenden Tabelle (Englisch, wie seit Phase 3), kein
Layout-Umbau.

## Fehlerverhalten

Ergänzt die bestehende Tabelle aus dem Hauptentwurf, Leitlinie unverändert:
die Klassifikation darf nie an der neuen Schicht scheitern.

| Fehler | Verhalten |
|---|---|
| Embedding-Endpoint nicht erreichbar/Timeout | Warnung loggen, für diesen `resolve()`-Aufruf nur mit Trigram weiterrechnen, nichts cachen |
| Embedding-Antwort unparsbar | wie oben |
| `entity_embeddings`-Tabelle nicht schreibbar | Warnung, Embedding-Vergleich läuft ungecacht weiter (jeder Aufruf berechnet neu) oder fällt auf Trigram-only zurück, je nachdem was den Fehler auslöst — Klassifikation bricht nie ab |
| `EMBEDDING_SIMILARITY_ENABLED=no` | Verhalten identisch zu Phase 3, kein Embedding-Code-Pfad wird betreten |
| Gecachter Vektor stale (Name/Modell weicht ab) | verwerfen, neu berechnen (wie Alias-Fehlerverhalten) |

## Testing

- `entityEmbeddingService`: Cosine-Funktion pur getestet (bekannte
  Vektorpaare), `embed()` mit injiziertem Fake-Ollama-Client (kein Netzwerk).
- `entityResolver`: bestehende Fake-Judge-Tests um Fälle mit injiziertem
  Fake-Embedding-Provider erweitert — Map über Embedding allein (Trigram
  unter `JUDGE_MIN`, Embedding über `EMBED_AUTO_THRESHOLD`), Judge nur wegen
  Embedding-Nähe ausgelöst, beide Kanäle unter Schwelle → `create`,
  `EMBEDDING_SIMILARITY_ENABLED=no` → Verhalten unverändert zu Phase 2/3.
- `entityBackfillService`: Test mit injiziertem Fake-Embedding-Provider für
  den kombinierten Score im quadratischen Vergleich.
- `entityStore`: Tests für `entity_embeddings` CRUD und Staleness-Erkennung
  (Name-Mismatch, ID-Mismatch, Modell-Mismatch).
- `scripts/tune-thresholds.js`-Erweiterung ist wie schon in Phase 2 ein
  manuelles Betriebsskript gegen echtes Ollama, kein Teil von `node --test`.

## Bewusst ausgeschlossen

- **Dedizierte Vektor-Datenbank.** Bei ~70 Bestandsentitäten pro Typ ist ein
  Brute-Force-Cosine-Vergleich in JS trivial schnell; eine Vektor-DB (z.B.
  sqlite-vec) wäre unbezogene Infrastruktur für diese Bestandsgröße.
- **Embeddings für den Dokumenttext selbst.** Phase 4 vergleicht ausschließlich
  kurze Entitätsnamen (Tags, Dokumentarten, Korrespondenten), nicht ganze
  Dokumente — das bleibt Aufgabe von Phase 5 (Fingerprint), falls dort
  überhaupt gebraucht.
- **Automatisches Vorab-Befüllen aller Embeddings beim Serverstart.** Lazy
  Caching bei erster Verwendung reicht bei dieser Bestandsgröße; ein
  Vorab-Lauf wäre zusätzliche Komplexität ohne messbaren Nutzen.
- **Ersetzen von Trigram durch Embeddings.** Beide Kanäle bleiben aktiv;
  Trigram ist kostenlos (keine Ollama-Calls) und für orthografisch nahe Fälle
  bereits gemessen zuverlässig (Phase 2, Task 11).
