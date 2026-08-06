#!/usr/bin/env node
/**
 * Ad-hoc Messung der Judge-Latenz gegen reale Namenspaare (Paket-1-Abnahme,
 * Fixplan-Kriterium 2). Ruft services/entityJudge.judge() direkt auf - beruehrt
 * weder Paperless noch die Resolver-Kaskade. scripts/dry-run-eval.js kann das
 * nicht leisten (ruft laut eigenem Kopfkommentar ausschliesslich analyzeDocument
 * auf).
 *
 * Aufruf:
 *   node scripts/measure-judge-latency.js
 *   node scripts/measure-judge-latency.js --pairs data/eval/entity-labels.json
 *
 * Paarquelle: data/eval/entity-labels.json, Format wie in scripts/tune-thresholds.js:
 *   { "<type>": [["Name A", "Name B", "Name C"], ...] }
 * Je Cluster wird ein Paar pro benachbartem Eintrag gebildet. Mindestens 12 Paare
 * fuer die Abnahme (Fixplan Paket 1, Kriterium 2).
 */
const fs = require('fs');
const path = require('path');
const entityJudge = require('../services/entityJudge');

function parseArgs(argv) {
  const args = { pairsFile: 'data/eval/entity-labels.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pairs') args.pairsFile = argv[++i];
  }
  return args;
}

function loadPairs(pairsFile) {
  const full = path.join(process.cwd(), pairsFile);
  if (!fs.existsSync(full)) {
    console.error(`[ERROR] ${pairsFile} fehlt. Format: { "<type>": [["Name A", "Name B", ...], ...] } - siehe scripts/tune-thresholds.js.`);
    process.exit(1);
  }
  const clustersByType = JSON.parse(fs.readFileSync(full, 'utf8'));
  const pairs = [];
  for (const [type, clusters] of Object.entries(clustersByType)) {
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.length - 1; i++) {
        pairs.push({ type, a: cluster[i], b: cluster[i + 1] });
      }
    }
  }
  return pairs;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  const { pairsFile } = parseArgs(process.argv.slice(2));
  const pairs = loadPairs(pairsFile);

  if (pairs.length < 12) {
    console.warn(`[WARNING] Nur ${pairs.length} Paare gefunden - die Paket-1-Abnahme verlangt mindestens 12.`);
  }

  const durations = [];
  let timeouts = 0;

  for (const { type, a, b } of pairs) {
    const startedAt = Date.now();
    try {
      const result = await entityJudge.judge(type, a, b);
      const durationMs = Date.now() - startedAt;
      durations.push(durationMs);
      // result.verdict kann bei einer nicht parsebaren Modellantwort fehlen/kein String sein -
      // .padEnd wuerde dann das ganze Messskript abbrechen statt nur die eine Zeile zu markieren.
      console.log(`${String(durationMs).padStart(6)} ms  ${String(result?.verdict ?? 'INVALID').padEnd(9)}  ${type}: "${a}" vs "${b}"`);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      timeouts += 1;
      console.log(`${String(durationMs).padStart(6)} ms  TIMEOUT/FEHLER  ${type}: "${a}" vs "${b}" (${error.message})`);
    }
  }

  console.log(`\nPaare: ${pairs.length}, Timeouts/Fehler: ${timeouts}`);
  if (durations.length > 0) {
    console.log(`Median: ${median(durations).toFixed(0)} ms, Max: ${Math.max(...durations)} ms, Min: ${Math.min(...durations)} ms`);
  }
}

main();
