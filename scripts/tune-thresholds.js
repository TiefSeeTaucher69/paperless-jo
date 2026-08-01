#!/usr/bin/env node
// scripts/tune-thresholds.js
const fs = require('fs');
const path = require('path');
const { normalizeForType } = require('../services/entityNormalizer');
const { diceCoefficient } = require('../services/entitySimilarity');

function loadJson(relativePath, fallback) {
  const full = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(full)) return fallback;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function buildLabeledPairs(clustersByType) {
  const pairs = []; // { type, a, b, label: 'same'|'different' }

  for (const [type, clusters] of Object.entries(clustersByType)) {
    for (let i = 0; i < clusters.length; i++) {
      for (let j = 0; j < clusters[i].length; j++) {
        for (let k = j + 1; k < clusters[i].length; k++) {
          pairs.push({ type, a: clusters[i][j], b: clusters[i][k], label: 'same' });
        }
      }
    }
    for (let i = 0; i < clusters.length; i++) {
      for (let ci = i + 1; ci < clusters.length; ci++) {
        for (const a of clusters[i]) {
          for (const b of clusters[ci]) {
            pairs.push({ type, a, b, label: 'different' });
          }
        }
      }
    }
  }

  return pairs;
}

function evaluateThreshold(pairs, threshold) {
  let tp = 0, fp = 0, fn = 0, tn = 0;

  for (const { type, a, b, label } of pairs) {
    const sim = diceCoefficient(normalizeForType(a, type), normalizeForType(b, type));
    const predictedSame = sim >= threshold;
    const actualSame = label === 'same';

    if (predictedSame && actualSame) tp++;
    else if (predictedSame && !actualSame) fp++;
    else if (!predictedSame && actualSame) fn++;
    else tn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return { threshold, tp, fp, fn, tn, precision, recall };
}

function main() {
  const labels = loadJson('data/eval/entity-labels.json', null);
  if (!labels) {
    console.error('[ERROR] data/eval/entity-labels.json fehlt. Siehe Plan-Dokument Task 11 fuer das Format.');
    process.exit(1);
  }

  const pairs = buildLabeledPairs(labels);
  console.log(`Gelabelte Paare: ${pairs.length} (${pairs.filter(p => p.label === 'same').length} same, ${pairs.filter(p => p.label === 'different').length} different)`);

  const results = [];
  for (let i = 1; i <= 19; i++) {
    const t = i / 20;
    results.push(evaluateThreshold(pairs, t));
  }

  console.log('\nThreshold | Precision | Recall | TP | FP | FN | TN');
  for (const r of results) {
    console.log(
      `${r.threshold.toFixed(2)}      | `
      + `${r.precision === null ? '  n/a  ' : r.precision.toFixed(2).padStart(7)} | `
      + `${r.recall === null ? '  n/a ' : r.recall.toFixed(2).padStart(6)} | `
      + `${String(r.tp).padStart(2)} | ${String(r.fp).padStart(2)} | ${String(r.fn).padStart(2)} | ${String(r.tn).padStart(2)}`
    );
  }

  const outPath = path.join('data', 'eval', `threshold-tuning-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pairs, results }, null, 2));
  console.log(`\nDetails geschrieben nach ${outPath} (nicht in git).`);

  const worstRecallSamePairs = pairs
    .filter(p => p.label === 'same')
    .map(p => ({ ...p, sim: diceCoefficient(normalizeForType(p.a, p.type), normalizeForType(p.b, p.type)) }))
    .sort((x, y) => x.sim - y.sim)
    .slice(0, 5);

  console.log('\nSchwierigste "same"-Paare (niedrigste Trigram-Aehnlichkeit - Kandidaten fuer die Embeddings-Entscheidung):');
  worstRecallSamePairs.forEach(p => console.log(`  ${p.a} / ${p.b} (${p.type}): ${p.sim.toFixed(3)}`));
}

main();
