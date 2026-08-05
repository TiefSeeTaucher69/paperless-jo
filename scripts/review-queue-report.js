#!/usr/bin/env node
// Read-only Verteilungsreport der offenen Review-Queue vor NACHAUDIT-08/-09.
// Aendert nichts - dient nur der Priorisierung vor dem manuellen Durchgang.
const Database = require('better-sqlite3');
const config = require('../config/config');

const db = new Database(config.entityResolver.dbPath, { readonly: true });

console.log(`Datenbank: ${config.entityResolver.dbPath}`);
console.log(`Aktive Schwellwerte: autoThreshold=${config.entityResolver.autoThreshold}, judgeMin=${config.entityResolver.judgeMin}`);

const total = db.prepare(`SELECT COUNT(*) AS n FROM entity_review_queue WHERE status = 'open'`).get();
console.log(`\nOffene Eintraege gesamt: ${total.n}`);

console.log('\nNach entity_type:');
for (const row of db.prepare(`
  SELECT entity_type, COUNT(*) AS n
  FROM entity_review_queue WHERE status = 'open'
  GROUP BY entity_type ORDER BY n DESC
`).all()) {
  console.log(`  ${row.entity_type}: ${row.n}`);
}

console.log('\nNach llm_verdict (NULL = Backfill ohne Judge-Aufruf):');
for (const row of db.prepare(`
  SELECT COALESCE(llm_verdict, '(null)') AS verdict, COUNT(*) AS n
  FROM entity_review_queue WHERE status = 'open'
  GROUP BY llm_verdict ORDER BY n DESC
`).all()) {
  console.log(`  ${row.verdict}: ${row.n}`);
}

console.log('\nTrigram-Similarity-Baender (Spalte "similarity", AUDIT-029-Skala):');
for (const row of db.prepare(`
  SELECT
    CASE
      WHEN similarity < 0.5 THEN '< 0.50'
      WHEN similarity < 0.65 THEN '0.50-0.65'
      WHEN similarity < 0.8 THEN '0.65-0.80'
      ELSE '>= 0.80'
    END AS band,
    COUNT(*) AS n
  FROM entity_review_queue WHERE status = 'open'
  GROUP BY band ORDER BY band
`).all()) {
  console.log(`  ${row.band}: ${row.n}`);
}

console.log('\nentity_merge_log nach status:');
for (const row of db.prepare(`
  SELECT status, COUNT(*) AS n FROM entity_merge_log GROUP BY status
`).all()) {
  console.log(`  ${row.status}: ${row.n}`);
}

console.log('\nentity_aliases nach source:');
for (const row of db.prepare(`
  SELECT source, COUNT(*) AS n FROM entity_aliases GROUP BY source ORDER BY n DESC
`).all()) {
  console.log(`  ${row.source}: ${row.n}`);
}

db.close();
