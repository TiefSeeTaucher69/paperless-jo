#!/usr/bin/env node
// scripts/tune-thresholds.js
const fs = require('fs');
const path = require('path');
const { normalizeForType } = require('../services/entityNormalizer');
const { diceCoefficient } = require('../services/entitySimilarity');
const entityEmbeddingService = require('../services/entityEmbeddingService');

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

async function evaluateEmbeddingThresholds(pairs) {
  const uniqueTexts = [...new Set(pairs.flatMap(p => [p.a, p.b]))];
  const vectors = new Map();

  for (const text of uniqueTexts) {
    try {
      vectors.set(text, await entityEmbeddingService.embed(text));
    } catch (error) {
      console.warn(`[WARNING] Embedding fuer "${text}" fehlgeschlagen, Embedding-Sweep wird uebersprungen:`, error.message);
      return null;
    }
  }

  const pairsWithSim = pairs.map(p => ({
    ...p,
    sim: entityEmbeddingService.cosineSimilarity(vectors.get(p.a), vectors.get(p.b))
  }));

  const results = [];
  for (let i = 1; i <= 19; i++) {
    const threshold = i / 20;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const { sim, label } of pairsWithSim) {
      const predictedSame = sim >= threshold;
      const actualSame = label === 'same';
      if (predictedSame && actualSame) tp++;
      else if (predictedSame && !actualSame) fp++;
      else if (!predictedSame && actualSame) fn++;
      else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    results.push({ threshold, tp, fp, fn, tn, precision, recall });
  }

  return { pairsWithSim, results };
}

async function runFingerprintTuning() {
  const labeledPairs = loadJson('data/eval/fingerprint-pairs.json', null);
  if (!labeledPairs) {
    console.error(
      '[ERROR] data/eval/fingerprint-pairs.json fehlt. Format: ' +
      '[{ "documentIdA": 1, "documentIdB": 2, "label": "same"|"different" }, ...]. ' +
      'Siehe Audit Abschnitt 18.4 fuer die empfohlene Verteilung (mind. 60 Paare ueber ' +
      'die dort genannten Risikoklassen).'
    );
    process.exit(1);
  }

  const paperlessService = require('../services/paperlessService');
  // AUDIT-025: dieselbe Kuerzung wie services/documentFingerprintService.js - jede Abweichung
  // macht die Messung ungueltig (Audit Abschnitt 18.5 Punkt 1).
  const FINGERPRINT_CONTENT_CHARS = 3000;
  const contentCache = new Map();

  async function getTruncatedContent(documentId) {
    if (contentCache.has(documentId)) {
      return contentCache.get(documentId);
    }
    const content = await paperlessService.getDocumentContent(documentId);
    const truncated = (content || '').slice(0, FINGERPRINT_CONTENT_CHARS);
    contentCache.set(documentId, truncated);
    return truncated;
  }

  const documentIds = [...new Set(labeledPairs.flatMap(p => [p.documentIdA, p.documentIdB]))];
  const vectors = new Map();
  for (const id of documentIds) {
    try {
      const text = await getTruncatedContent(id);
      vectors.set(id, await entityEmbeddingService.embed(text));
    } catch (error) {
      console.error(`[ERROR] Embedding fuer Dokument ${id} fehlgeschlagen, Fingerprint-Tuning abgebrochen:`, error.message);
      process.exit(1);
    }
  }

  const pairsWithSim = labeledPairs.map(p => ({
    ...p,
    sim: entityEmbeddingService.cosineSimilarity(vectors.get(p.documentIdA), vectors.get(p.documentIdB))
  }));

  console.log(`Gelabelte Dokumentpaare: ${pairsWithSim.length} (${pairsWithSim.filter(p => p.label === 'same').length} same, ${pairsWithSim.filter(p => p.label === 'different').length} different)`);
  console.log('\n=== Fingerprint-Aehnlichkeit (Dokumentinhalt) ===');
  console.log('Threshold | Precision | Recall | TP | FP | FN | TN');

  let bestPrecision1Threshold = null;
  const results = [];
  for (let i = 80; i <= 99; i++) {
    const threshold = i / 100;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const { sim, label } of pairsWithSim) {
      const predictedSame = sim >= threshold;
      const actualSame = label === 'same';
      if (predictedSame && actualSame) tp++;
      else if (predictedSame && !actualSame) fp++;
      else if (!predictedSame && actualSame) fn++;
      else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    results.push({ threshold, tp, fp, fn, tn, precision, recall });

    // AUDIT-025 / Audit Abschnitt 18.5 Punkt 3: nach Precision optimieren, nicht F1 - ein
    // False Positive ist beim Fingerprint unkorrigierbar und still, ein False Negative kostet
    // nur einen ohnehin schon anfallenden LLM-Call. Kleinsten Threshold mit Precision=1.00 merken.
    if (precision === 1 && bestPrecision1Threshold === null) {
      bestPrecision1Threshold = threshold;
    }

    console.log(
      `${threshold.toFixed(2)}      | `
      + `${precision === null ? '  n/a  ' : precision.toFixed(2).padStart(7)} | `
      + `${recall === null ? '  n/a ' : recall.toFixed(2).padStart(6)} | `
      + `${String(tp).padStart(2)} | ${String(fp).padStart(2)} | ${String(fn).padStart(2)} | ${String(tn).padStart(2)}`
    );
  }

  if (bestPrecision1Threshold !== null) {
    const recommended = Math.min(0.99, bestPrecision1Threshold + 0.02);
    console.log(`\nKleinster Threshold mit Precision=1.00: ${bestPrecision1Threshold.toFixed(2)}. Empfohlen mit Sicherheitsaufschlag (+0.02): FINGERPRINT_SIMILARITY_THRESHOLD=${recommended.toFixed(2)} (Audit Abschnitt 18.5 Punkt 3).`);
  } else {
    console.log('\nKein Threshold in [0.80, 0.99] erreicht Precision=1.00 - mit den vorliegenden Paaren ist der Fingerprint-Kanal nicht sicher aktivierbar (Audit Abschnitt 18.6).');
  }

  const worstDifferentPairs = pairsWithSim
    .filter(p => p.label === 'different')
    .sort((x, y) => y.sim - x.sim)
    .slice(0, 5);
  console.log('\nSchwierigste "different"-Paare (hoechste Aehnlichkeit trotz unterschiedlichem Label - bestimmen die obere Schwellwertgrenze, Audit Abschnitt 18.5 Punkt 4):');
  worstDifferentPairs.forEach(p => console.log(`  Dokument ${p.documentIdA} / Dokument ${p.documentIdB}: ${p.sim.toFixed(3)}`));

  const outPath = path.join('data', 'eval', `fingerprint-threshold-tuning-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pairs: pairsWithSim, results }, null, 2));
  console.log(`\nDetails geschrieben nach ${outPath} (nicht in git).`);
}

async function main() {
  // AUDIT-025: additiver Modus fuer die Fingerprint-Schwellwertmessung (Audit Abschnitt 18.5) -
  // der bestehende Modus (Entitaets-Namenspaare, unten) bleibt vollstaendig unveraendert.
  if (process.argv.includes('--fingerprint')) {
    await runFingerprintTuning();
    return;
  }

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

  console.log('\n=== Trigram-Aehnlichkeit ===');
  console.log('Threshold | Precision | Recall | TP | FP | FN | TN');
  for (const r of results) {
    console.log(
      `${r.threshold.toFixed(2)}      | `
      + `${r.precision === null ? '  n/a  ' : r.precision.toFixed(2).padStart(7)} | `
      + `${r.recall === null ? '  n/a ' : r.recall.toFixed(2).padStart(6)} | `
      + `${String(r.tp).padStart(2)} | ${String(r.fp).padStart(2)} | ${String(r.fn).padStart(2)} | ${String(r.tn).padStart(2)}`
    );
  }

  const worstRecallSamePairs = pairs
    .filter(p => p.label === 'same')
    .map(p => ({ ...p, sim: diceCoefficient(normalizeForType(p.a, p.type), normalizeForType(p.b, p.type)) }))
    .sort((x, y) => x.sim - y.sim)
    .slice(0, 5);

  console.log('\nSchwierigste "same"-Paare (niedrigste Trigram-Aehnlichkeit - Kandidaten fuer die Embeddings-Entscheidung):');
  worstRecallSamePairs.forEach(p => console.log(`  ${p.a} / ${p.b} (${p.type}): ${p.sim.toFixed(3)}`));

  console.log('\n=== Embedding-Aehnlichkeit (Phase 4) ===');
  const embeddingResult = await evaluateEmbeddingThresholds(pairs);
  let embeddingOutput = null;
  if (!embeddingResult) {
    console.log('Ollama/Embedding-Modell nicht erreichbar - Embedding-Sweep uebersprungen. EMBED_AUTO_THRESHOLD/EMBED_JUDGE_MIN bleiben auf den geschaetzten Defaults, bis dieses Skript mit laufendem Ollama erneut ausgefuehrt wird.');
  } else {
    console.log('Threshold | Precision | Recall | TP | FP | FN | TN');
    for (const r of embeddingResult.results) {
      console.log(
        `${r.threshold.toFixed(2)}      | `
        + `${r.precision === null ? '  n/a  ' : r.precision.toFixed(2).padStart(7)} | `
        + `${r.recall === null ? '  n/a ' : r.recall.toFixed(2).padStart(6)} | `
        + `${String(r.tp).padStart(2)} | ${String(r.fp).padStart(2)} | ${String(r.fn).padStart(2)} | ${String(r.tn).padStart(2)}`
      );
    }

    const worstRecallSamePairsEmbedding = embeddingResult.pairsWithSim
      .filter(p => p.label === 'same')
      .sort((x, y) => x.sim - y.sim)
      .slice(0, 5);
    console.log('\nSchwierigste "same"-Paare (niedrigste Embedding-Aehnlichkeit):');
    worstRecallSamePairsEmbedding.forEach(p => console.log(`  ${p.a} / ${p.b} (${p.type}): ${p.sim.toFixed(3)}`));

    embeddingOutput = embeddingResult;
  }

  const outPath = path.join('data', 'eval', `threshold-tuning-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ pairs, trigram: results, embedding: embeddingOutput }, null, 2));
  console.log(`\nDetails geschrieben nach ${outPath} (nicht in git).`);
}

main();
