#!/usr/bin/env node
/**
 * Fixplan Paket 2, Abschnitt 2.1 ("Vokabular konsolidieren"): fuehrt die dort
 * aufgelisteten Merges/Loeschungen ueber die Paperless-API aus, statt sie von Hand in
 * der Paperless-ngx-Oberflaeche zu klicken - Vorschau (dry-run) per Default, --apply
 * fuehrt aus. Siehe docs/superpowers/specs/2026-08-06-paket2-altdaten-bereinigen-design.md.
 *
 * Aufruf:
 *   node scripts/cleanup-legacy-vocabulary.js          (Vorschau, aendert nichts)
 *   node scripts/cleanup-legacy-vocabulary.js --apply  (fuehrt aus)
 *
 * Die vier Konstanten unten sind teils schon aus dem Fixplan bekannt, teils erst nach
 * einer Bestandsdurchsicht befuellbar (siehe Implementierungsplan-Task 4). Ein leerer
 * Eintrag fuehrt zu keiner Aktion, nicht zu einem Fehler.
 */
const paperlessService = require('../services/paperlessService');

// Fixplan Zeile 473-474: contract ist der Prompt-Platzhalter aus A-2 (mit 1.2.a an der
// Quelle geschlossen, der Alias/die Dokumentart bestand aber fort). Zeile 480-483: die
// DE/EN-Paare, die Trigram strukturell nie sieht.
const DOCUMENT_TYPE_MERGES = [
  { from: 'contract', to: 'Entgeltabrechnung' },
  { from: 'Payroll Statement', to: 'Entgeltabrechnung' },
  { from: 'salary tax certificate', to: 'Lohnsteuerbescheinigung' },
  { from: 'Practicum Confirmation', to: 'Praktikumsbestätigung' }
  // 'Notification' -> 'Mitteilung' ODER 'Bescheid': im Fixplan (Zeile 483) bewusst
  // offen gelassen, dokumentinhaltsabhaengig. Wird in Task 4 anhand der betroffenen
  // Dokumente aufgeloest und hier ergaenzt.
];

// Fixplan Zeile 484-485.
const TAG_MERGES = [
  { from: 'Personal Data', to: 'Persönliche Daten' },
  { from: 'Electronic Document', to: 'elektronisch' }
  // Tax Document, Invoice, Curriculum Vitae: deutsches Ziel-Tag wird in Task 4 anhand
  // des tatsaechlichen Bestands ermittelt (moeglicherweise existiert noch keins) und
  // hier ergaenzt.
];

// Fixplan Zeile 490-494: vier Empfaenger-Varianten, die entfernt (nicht gemergt) werden
// sollen. Namen werden in Task 4 aus dem Bestand ermittelt.
const CORRESPONDENT_NAMES_TO_REMOVE = [];

// Fixplan Zeile 486-489 (2.1.4): je ein Dokument fuer die drei in Paket 1 §1.4
// geloeschten Fehl-Aliase. Wird in Task 4 ueber entity_merge_log + entity_review_queue
// ermittelt und hier ergaenzt: { documentId, removeTagId, removeTagName, addTagId, addTagName }.
const MISTAGGED_DOCUMENT_FIXES = [];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function resolveMergeRow(type, from, to, lookup) {
  const source = lookup.find(e => e.name === from);
  const target = lookup.find(e => e.name === to);
  if (!source) {
    return { action: 'merge', type, from, to, skip: `Quelle "${from}" nicht gefunden (evtl. bereits gemergt)` };
  }
  if (!target) {
    return { action: 'merge', type, from, to, skip: `Ziel "${to}" nicht gefunden` };
  }
  const preview = await paperlessService.mergeEntity(type, source.id, target.id, { dryRun: true });
  return {
    action: 'merge', type, from, to,
    fromId: source.id, toId: target.id,
    affectedCount: preview.affectedCount, documentIds: preview.documentIds
  };
}

async function buildPlan() {
  const documentTypes = await paperlessService.listDocumentTypesWithCounts();
  const tags = await paperlessService.getTags();
  const correspondents = await paperlessService.listCorrespondentsNames();

  const rows = [];

  for (const { from, to } of DOCUMENT_TYPE_MERGES) {
    try {
      rows.push(await resolveMergeRow('document_type', from, to, documentTypes));
    } catch (error) {
      rows.push({ action: 'merge', type: 'document_type', from, to, skip: `Fehler bei der Vorschau: ${error.message}` });
    }
  }
  for (const { from, to } of TAG_MERGES) {
    try {
      rows.push(await resolveMergeRow('tag', from, to, tags));
    } catch (error) {
      rows.push({ action: 'merge', type: 'tag', from, to, skip: `Fehler bei der Vorschau: ${error.message}` });
    }
  }

  for (const t of documentTypes.filter(dt => dt.document_count === 0)) {
    rows.push({ action: 'delete-empty', type: 'document_type', name: t.name, id: t.id });
  }

  for (const name of CORRESPONDENT_NAMES_TO_REMOVE) {
    const c = correspondents.find(e => e.name === name);
    if (!c) {
      rows.push({ action: 'remove-correspondent', name, skip: 'nicht gefunden' });
      continue;
    }
    rows.push({ action: 'remove-correspondent', name, id: c.id, document_count: c.document_count });
  }

  for (const fix of MISTAGGED_DOCUMENT_FIXES) {
    rows.push({ action: 'fix-tag', ...fix });
  }

  return rows;
}

async function applyRow(row) {
  if (row.action === 'merge') {
    await paperlessService.mergeEntity(row.type, row.fromId, row.toId, { dryRun: false, expectedDocumentIds: row.documentIds });
  } else if (row.action === 'delete-empty') {
    await paperlessService.deleteEmptyEntity(row.type, row.id);
  } else if (row.action === 'remove-correspondent') {
    await paperlessService.clearAndDeleteEntity('correspondent', row.id);
  } else if (row.action === 'fix-tag') {
    const doc = await paperlessService.getDocument(row.documentId);
    const withoutWrong = doc.tags.filter(id => id !== row.removeTagId);
    const newTags = withoutWrong.includes(row.addTagId) ? withoutWrong : withoutWrong.concat(row.addTagId);
    await paperlessService.overwriteDocumentFields(row.documentId, { tags: newTags });
  } else {
    throw new Error(`unbekannte Aktion: ${row.action}`);
  }
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const rows = await buildPlan();

  console.table(rows.map(r => ({
    action: r.action,
    beschreibung: r.from ? `${r.from} -> ${r.to}` : (r.name || r.documentId),
    betroffen: r.affectedCount ?? r.document_count ?? '-',
    status: r.skip ? `UEBERSPRUNGEN: ${r.skip}` : 'bereit'
  })));

  if (!apply) {
    console.log(`\n${rows.length} Zeile(n) in der Vorschau. Mit --apply ausfuehren.`);
    return;
  }

  const results = [];
  for (const row of rows) {
    if (row.skip) {
      results.push({ ...row, status: 'skipped' });
      continue;
    }
    try {
      await applyRow(row);
      results.push({ ...row, status: 'done' });
    } catch (error) {
      results.push({ ...row, status: 'failed', error: error.message });
    }
  }

  console.table(results.map(r => ({ action: r.action, beschreibung: r.from ? `${r.from} -> ${r.to}` : (r.name || r.documentId), status: r.status, error: r.error || '' })));

  const failed = results.filter(r => r.status === 'failed');
  if (failed.length > 0) {
    console.error(`\n${failed.length} von ${results.length} Zeile(n) fehlgeschlagen - siehe Tabelle oben. Erneuter Lauf mit --apply wiederholt nur die fehlgeschlagenen (bereits erledigte Zeilen finden beim Neu-Aufloesen keinen fromId/keine leere Entitaet mehr und werden uebersprungen).`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[ERROR]', error.message);
    process.exit(1);
  });
}

module.exports = { buildPlan, resolveMergeRow, applyRow };
