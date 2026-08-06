#!/usr/bin/env node
// Read-only Verteilungsreport fuer Fingerprint-Beobachtungen (DOCUMENT_FINGERPRINT_MODE=observe,
// NACHAUDIT-11, Audit Abschnitt 18.6 Bedingung 5). Zeigt, wie viele Treffer im Beobachtungsmodus
// protokolliert wurden und mit welcher Aehnlichkeit - Grundlage fuer die Stichprobenpruefung vor
// einer Umschaltung auf DOCUMENT_FINGERPRINT_MODE=apply. Aendert keine Daten.
// buildReport/printReport sind getrennt, damit buildReport ohne data/entities.db testbar ist
// (siehe test/fingerprintObservationReport.test.js) - main() bleibt der einzige Ort, der eine
// echte Datenbankverbindung oeffnet.
const Database = require('better-sqlite3');
const fs = require('fs');

// Finding 2 (Nachaudit Paket 4, Review-Fix): auf einer Instanz, auf der
// DOCUMENT_FINGERPRINT_ENABLED nie 'yes' war, existiert weder data/entities.db noch (falls die
// Datei aus einem anderen Grund existiert) die Tabelle document_fingerprint_observations - die
// wird erst beim Instanziieren von DocumentFingerprintStore angelegt. tableExists ist von main()
// getrennt, damit dieser Vorab-Check ohne echte Datenbankverbindung testbar ist.
function tableExists(db, name) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return !!row;
}

function buildReport(db) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM document_fingerprint_observations`).get();
  const byCorrespondent = db.prepare(`
    SELECT correspondent_id, COUNT(*) AS n
    FROM document_fingerprint_observations
    GROUP BY correspondent_id ORDER BY n DESC LIMIT 20
  `).all();
  const bySimilarityBand = db.prepare(`
    SELECT
      CASE
        WHEN similarity < 0.85 THEN '0.80-0.85'
        WHEN similarity < 0.90 THEN '0.85-0.90'
        WHEN similarity < 0.95 THEN '0.90-0.95'
        ELSE '0.95-1.00'
      END AS band,
      COUNT(*) AS n
    FROM document_fingerprint_observations
    GROUP BY band ORDER BY band
  `).all();
  const recent = db.prepare(`
    SELECT id, document_id, correspondent_id, matched_document_id, similarity, tag_ids, document_type_id, created_at
    FROM document_fingerprint_observations
    ORDER BY created_at DESC, id DESC LIMIT 20
  `).all();

  return { total: total.n, byCorrespondent, bySimilarityBand, recent };
}

function printReport(report, { dbPath, mode, similarityThreshold }) {
  console.log(`Datenbank: ${dbPath}`);
  console.log(`Modus: ${mode}, Schwellwert: ${similarityThreshold}`);
  console.log(`\nProtokollierte Beobachtungen gesamt: ${report.total}`);

  if (report.total === 0) {
    console.log('\nKeine Beobachtungen vorhanden. Voraussetzung: DOCUMENT_FINGERPRINT_ENABLED=yes und DOCUMENT_FINGERPRINT_MODE=observe in data/.env, danach mindestens ein Scan-Zyklus.');
    return;
  }

  console.log('\nNach Korrespondent (Top 20):');
  for (const row of report.byCorrespondent) {
    console.log(`  Korrespondent ${row.correspondent_id}: ${row.n}`);
  }

  console.log('\nAehnlichkeits-Baender:');
  for (const row of report.bySimilarityBand) {
    console.log(`  ${row.band}: ${row.n}`);
  }

  console.log('\nJuengste 20 Beobachtungen (Ausgangspunkt fuer die Stichprobenpruefung):');
  for (const row of report.recent) {
    console.log(`  [${row.created_at}] document=${row.document_id ?? '(unbekannt)'} correspondent=${row.correspondent_id} matched_document=${row.matched_document_id} similarity=${row.similarity.toFixed(3)} tags=${row.tag_ids} document_type=${row.document_type_id ?? '(keine)'}`);
  }
}

const EMPTY_REPORT = { total: 0, byCorrespondent: [], bySimilarityBand: [], recent: [] };

function main() {
  const config = require('../config/config');
  const meta = {
    dbPath: config.entityResolver.dbPath,
    mode: config.documentFingerprint.mode,
    similarityThreshold: config.documentFingerprint.similarityThreshold
  };

  // Finding 2: fehlt die Datenbankdatei komplett (Feature noch nie aktiviert), wuerde
  // `new Database(..., {readonly:true})` mit SQLITE_CANTOPEN werfen, statt der freundlichen
  // Hinweismeldung, die printReport fuer "keine Beobachtungen" ohnehin schon hat.
  if (!fs.existsSync(meta.dbPath)) {
    printReport(EMPTY_REPORT, meta);
    return;
  }

  const db = new Database(meta.dbPath, { readonly: true });
  try {
    // Die Datei kann existieren (z.B. wegen des EntityResolvers), ohne dass die
    // Beobachtungstabelle je angelegt wurde - die entsteht erst, wenn DocumentFingerprintStore
    // instanziiert wird (DOCUMENT_FINGERPRINT_ENABLED=yes).
    if (!tableExists(db, 'document_fingerprint_observations')) {
      printReport(EMPTY_REPORT, meta);
      return;
    }
    const report = buildReport(db);
    printReport(report, meta);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildReport, printReport, tableExists };
