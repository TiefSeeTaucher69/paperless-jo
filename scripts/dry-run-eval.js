#!/usr/bin/env node
/**
 * Dry-Run-Harness: schickt Dokumente durch die echte Klassifikationskette und
 * misst die Ergebnisse, OHNE irgendetwas nach Paperless-ngx zu schreiben.
 *
 * Es wird ausschliesslich aiService.analyzeDocument aufgerufen. Die
 * schreibenden Pfade (buildUpdateData, saveDocumentChanges, processTags,
 * getOrCreate*) werden nie beruehrt.
 *
 * Aufruf:
 *   node scripts/dry-run-eval.js
 *   node scripts/dry-run-eval.js --limit 10
 *   node scripts/dry-run-eval.js --limit 10 --repeat 2 --label vorher
 *
 * Optionen:
 *   --limit N    nur die ersten N Dokumente (Default: alle)
 *   --repeat N   jedes Dokument N-mal klassifizieren, um Stabilitaet zu messen
 *   --label TEXT Kennzeichnung im Dateinamen des Reports
 *
 * Der Report landet unter data/eval/ (gitignored), weil er Dokumenttitel und
 * Korrespondentennamen enthaelt.
 */
const path = require('path');
const fs = require('fs').promises;

const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const AIServiceFactory = require('../services/aiServiceFactory');

const OUT_DIR = path.join(process.cwd(), 'data', 'eval');

// ---------------------------------------------------------------------------
// Argumente
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { limit: null, repeat: 1, label: 'run', ids: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--repeat') args.repeat = parseInt(argv[++i], 10);
    else if (argv[i] === '--label') args.label = argv[++i];
    else if (argv[i] === '--ids') args.ids = argv[++i].split(',').map(id => parseInt(id.trim(), 10));
  }

  return args;
}

// ---------------------------------------------------------------------------
// Ungefilterte Dokumentliste.
//
// paperlessService.getAllDocuments() respektiert PROCESS_PREDEFINED_DOCUMENTS
// und TAGS aus der .env - das ist fuer den Produktions-Scan richtig, aber
// fuer die Auswertung falsch: existiert der konfigurierte Filter-Tag nicht
// (oder ist keinem Dokument zugewiesen), liefert getAllDocuments() eine leere
// Liste, obwohl Dokumente vorhanden sind. Der Dry-Run soll den vorhandenen
// Bestand auswerten, nicht den Scan-Filter nachbilden.
// ---------------------------------------------------------------------------

async function fetchAllDocumentsUnfiltered() {
  paperlessService.initialize();
  const client = paperlessService.client;
  if (!client) {
    throw new Error('paperlessService.client wurde nicht initialisiert - PAPERLESS_API_URL/TOKEN pruefen');
  }

  const documents = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await client.get('/documents/', {
      params: { page, page_size: 100, fields: 'id,title,created,tags,correspondent' }
    });

    if (!response?.data?.results || !Array.isArray(response.data.results)) break;

    documents.push(...response.data.results);
    hasMore = response.data.next !== null;
    page++;
  }

  return documents;
}

// ---------------------------------------------------------------------------
// Grobe Normalisierung, nur fuer die Messung.
// Phase 2 ersetzt das durch services/entityNormalizer.js mit Tests.
// ---------------------------------------------------------------------------

function roughNormalize(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Heuristiken fuer bekannte Fehlermuster
// ---------------------------------------------------------------------------

const POSTAL_CODE = /\b\d{5}\b/;
const SALUTATION = /^(herr|herrn|frau|fr\.|hr\.)\s+/i;
const DATE_LIKE = /^(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|q[1-4]|\d{4})\b|\b(19|20)\d{2}$/i;

function flagsFor(correspondent) {
  const flags = [];
  if (!correspondent) return flags;
  if (POSTAL_CODE.test(correspondent)) flags.push('anschrift_im_namen');
  if (SALUTATION.test(correspondent)) flags.push('anrede_im_namen');
  return flags;
}

// ---------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------

function clusterVariants(names) {
  const clusters = new Map();

  for (const name of names) {
    const key = roughNormalize(name);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, new Set());
    clusters.get(key).add(name);
  }

  return [...clusters.entries()]
    .filter(([, variants]) => variants.size > 1)
    .map(([key, variants]) => ({ key, variants: [...variants] }));
}

function summarize(results) {
  const tags = [];
  const documentTypes = [];
  const correspondents = [];
  const flagged = [];
  const dateTags = [];

  for (const r of results) {
    for (const attempt of r.attempts) {
      if (!attempt || attempt.error) continue;
      (attempt.tags || []).forEach(t => {
        tags.push(t);
        if (DATE_LIKE.test(String(t).trim())) dateTags.push({ documentId: r.documentId, tag: t });
      });
      if (attempt.document_type) documentTypes.push(attempt.document_type);
      if (attempt.correspondent) {
        correspondents.push(attempt.correspondent);
        const f = flagsFor(attempt.correspondent);
        if (f.length) flagged.push({ documentId: r.documentId, correspondent: attempt.correspondent, flags: f });
      }
    }
  }

  // Stabilitaet: nur Dokumente mit mehr als einem Versuch
  const repeated = results.filter(r => r.attempts.filter(a => a && !a.error).length > 1);
  const unstable = [];

  for (const r of repeated) {
    const ok = r.attempts.filter(a => a && !a.error);
    const signature = a => JSON.stringify({
      title: a.title,
      correspondent: a.correspondent,
      document_type: a.document_type,
      tags: [...(a.tags || [])].sort()
    });
    const signatures = new Set(ok.map(signature));
    if (signatures.size > 1) {
      unstable.push({ documentId: r.documentId, variants: [...signatures].map(s => JSON.parse(s)) });
    }
  }

  const distinct = arr => [...new Set(arr)];

  return {
    documentsProcessed: results.length,
    documentsFailed: results.filter(r => r.attempts.every(a => !a || a.error)).length,
    tags: {
      total: tags.length,
      distinct: distinct(tags).length,
      variantClusters: clusterVariants(distinct(tags))
    },
    documentTypes: {
      total: documentTypes.length,
      distinct: distinct(documentTypes).length,
      distinctValues: distinct(documentTypes).sort((a, b) => a.localeCompare(b, 'de')),
      variantClusters: clusterVariants(distinct(documentTypes))
    },
    correspondents: {
      total: correspondents.length,
      distinct: distinct(correspondents).length,
      distinctValues: distinct(correspondents).sort((a, b) => a.localeCompare(b, 'de')),
      variantClusters: clusterVariants(distinct(correspondents))
    },
    problems: {
      correspondentFlags: flagged,
      dateLikeTags: dateTags
    },
    stability: {
      documentsRepeated: repeated.length,
      documentsUnstable: unstable.length,
      unstable
    }
  };
}

// ---------------------------------------------------------------------------
// Hauptlauf
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('=== Dry-Run: klassifiziert, schreibt NICHT nach Paperless ===');
  console.log(`Provider: ${config.aiProvider} | Modell: ${config.ollama.model}`);
  console.log(`USE_EXISTING_DATA=${config.useExistingData} | repeat=${args.repeat}`);

  const [existingTags, documents, correspondentObjects, documentTypeObjects] = await Promise.all([
    paperlessService.getTags(),
    fetchAllDocumentsUnfiltered(),
    paperlessService.listCorrespondentsNames(),
    paperlessService.listDocumentTypesNames()
  ]);

  // Abbruch statt stiller Erfolgsmeldung: liefert Paperless nichts, ist die
  // Verbindung kaputt und jede Messung darauf waere wertlos.
  if (!Array.isArray(documents) || documents.length === 0) {
    console.error(
      '\n[ERROR] Paperless lieferte keine Dokumente. Moegliche Ursachen: '
      + 'PAPERLESS_API_URL in data/.env endet nicht auf "/api" (Paperless '
      + 'antwortet dann mit der Login-Seite statt JSON), oder Token/URL sind '
      + 'falsch, oder die Instanz enthaelt tatsaechlich keine Dokumente.'
    );
    process.exit(1);
  }

  const existingTagNames = (existingTags || []).map(t => t.name);
  const existingCorrespondentNames = (correspondentObjects || []).map(c => c.name);
  const existingDocumentTypeNames = (documentTypeObjects || []).map(d => d.name);

  const selected = args.ids
    ? documents.filter(d => args.ids.includes(d.id))
    : (args.limit ? documents.slice(0, args.limit) : documents);
  console.log(`Dokumente: ${selected.length} von ${documents.length}\n`);

  const aiService = AIServiceFactory.getService();
  const results = [];
  const startedAt = Date.now();

  for (const [index, doc] of selected.entries()) {
    const label = `[${index + 1}/${selected.length}] Dok ${doc.id}`;
    let content;

    try {
      content = await paperlessService.getDocumentContent(doc.id);
    } catch (error) {
      console.log(`${label} Inhalt nicht abrufbar: ${error.message}`);
      results.push({ documentId: doc.id, title: doc.title, attempts: [{ error: error.message }] });
      continue;
    }

    if (!content || content.length < 10) {
      console.log(`${label} kein verwertbarer Inhalt, uebersprungen`);
      results.push({ documentId: doc.id, title: doc.title, attempts: [{ error: 'no content' }] });
      continue;
    }

    if (content.length > 50000) content = content.substring(0, 50000);

    const attempts = [];

    for (let run = 0; run < args.repeat; run++) {
      const t0 = Date.now();
      try {
        // id = null: ueberspringt das Thumbnail-Caching, das fuer die
        // Klassifikation ohne Bedeutung ist.
        const analysis = await aiService.analyzeDocument(
          content,
          existingTagNames,
          existingCorrespondentNames,
          existingDocumentTypeNames,
          null
        );

        if (analysis.error) {
          attempts.push({ error: analysis.error, ms: Date.now() - t0 });
        } else {
          attempts.push({ ...analysis.document, ms: Date.now() - t0 });
        }
      } catch (error) {
        attempts.push({ error: error.message, ms: Date.now() - t0 });
      }
    }

    const first = attempts[0] || {};
    console.log(
      `${label} ${(first.ms || 0) / 1000}s | ` +
      `Typ: ${first.document_type || '-'} | Korr: ${first.correspondent || '-'} | ` +
      `Tags: ${(first.tags || []).length}`
    );

    results.push({ documentId: doc.id, title: doc.title, attempts });
  }

  const summary = summarize(results);
  summary.meta = {
    label: args.label,
    startedAt: new Date(startedAt).toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    provider: config.aiProvider,
    model: config.ollama.model,
    useExistingData: config.useExistingData,
    repeat: args.repeat,
    temperature: config.ollama.temperature ?? '(nicht konfigurierbar in dieser Version)',
    seed: config.ollama.seed ?? '(nicht gesetzt)'
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(OUT_DIR, `dryrun-${args.label}-${stamp}.json`);
  await fs.writeFile(outFile, JSON.stringify({ summary, results }, null, 2), 'utf8');

  printSummary(summary, outFile);
}

function printSummary(s, outFile) {
  const line = '-'.repeat(70);
  console.log(`\n${line}\nERGEBNIS\n${line}`);
  console.log(`Dokumente verarbeitet: ${s.documentsProcessed}, fehlgeschlagen: ${s.documentsFailed}`);
  console.log(`Dauer: ${s.meta.durationSeconds}s\n`);

  console.log(`Tags:           ${s.tags.distinct} verschiedene aus ${s.tags.total} Nennungen`);
  console.log(`Dokumentarten:  ${s.documentTypes.distinct} verschiedene aus ${s.documentTypes.total} Nennungen`);
  console.log(`Korrespondenten:${s.correspondents.distinct} verschiedene aus ${s.correspondents.total} Nennungen\n`);

  for (const [name, data] of [['Tags', s.tags], ['Dokumentarten', s.documentTypes], ['Korrespondenten', s.correspondents]]) {
    if (data.variantClusters.length) {
      console.log(`Schreibvarianten bei ${name}: ${data.variantClusters.length} Gruppen`);
      data.variantClusters.forEach(c => console.log(`  - ${c.variants.join('  |  ')}`));
    } else {
      console.log(`Schreibvarianten bei ${name}: keine`);
    }
  }

  console.log(`\nKorrespondenten mit Anrede oder Anschrift im Namen: ${s.problems.correspondentFlags.length}`);
  s.problems.correspondentFlags.slice(0, 10).forEach(f =>
    console.log(`  - Dok ${f.documentId}: "${f.correspondent}" (${f.flags.join(', ')})`)
  );

  console.log(`\nTags, die wie ein Datum aussehen: ${s.problems.dateLikeTags.length}`);
  s.problems.dateLikeTags.slice(0, 10).forEach(t =>
    console.log(`  - Dok ${t.documentId}: "${t.tag}"`)
  );

  if (s.stability.documentsRepeated > 0) {
    console.log(`\nStabilitaet: ${s.stability.documentsUnstable} von ${s.stability.documentsRepeated} wiederholten Dokumenten lieferten unterschiedliche Ergebnisse`);
  } else {
    console.log('\nStabilitaet: nicht gemessen (--repeat 1)');
  }

  console.log(`\nReport: ${outFile}`);
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
