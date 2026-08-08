const express = require('express');
const router = express.Router();
const { isAuthenticated, authenticateJWT } = require('./auth');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const EntityStore = require('../models/entityStore');
const ReviewQueueService = require('../services/reviewQueueService');
const EntityBackfillService = require('../services/entityBackfillService');
const entityEmbeddingService = require('../services/entityEmbeddingService');
const entityJudge = require('../services/entityJudge');

let store = null;
let reviewQueueService = null;
let backfillService = null;

// Lazy statt Modul-Top-Level: verhindert, dass jeder Server-Boot data/entities.db oeffnet
// (auch wenn ENTITY_RESOLVER_ENABLED=no) und dass ein DB-Fehler den gesamten Server-Start crasht.
function getServices() {
  if (!store) {
    store = new EntityStore(config.entityResolver.dbPath);
    reviewQueueService = new ReviewQueueService({ store, paperlessService });
    backfillService = new EntityBackfillService({
      store,
      judgeMin: config.entityResolver.judgeMin,
      embeddingService: config.embedding.enabled ? entityEmbeddingService : null,
      embeddingEnabled: config.embedding.enabled,
      embedJudgeMin: config.embedding.judgeMin,
      excludedTypes: config.embedding.excludedTypes
    });
  }
  return { store, reviewQueueService, backfillService };
}

const ENTITY_LISTERS = {
  tag: () => paperlessService.getTags(),
  correspondent: () => paperlessService.listCorrespondentsNames(),
  document_type: () => paperlessService.listDocumentTypesWithCounts()
};

// AUDIT-030: feste Whitelists statt Query-Werte ungeprueft weiterzureichen.
const ENTITY_TYPES = Object.keys(ENTITY_LISTERS);
const QUEUE_SORTS = ['created_at_asc', 'created_at_desc', 'similarity_asc', 'similarity_desc'];
const QUEUE_STATUSES = ['open', 'merged', 'rejected'];
const REVIEW_PAGE_SIZE = 25;

router.get('/review', isAuthenticated, async (req, res) => {
  const { reviewQueueService } = getServices();

  const entityType = ENTITY_TYPES.includes(req.query.entityType) ? req.query.entityType : null;
  const status = QUEUE_STATUSES.includes(req.query.status) ? req.query.status : 'open';
  const sort = QUEUE_SORTS.includes(req.query.sort) ? req.query.sort : 'created_at_asc';
  const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);

  const total = reviewQueueService.countOpen({ entityType, status });
  const totalPages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);

  const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
  const rawQueue = reviewQueueService.listOpen({
    entityType, status, sort, limit: REVIEW_PAGE_SIZE, offset: (currentPage - 1) * REVIEW_PAGE_SIZE
  });
  // Ein Live-Aufruf pro Seite und Entitaet (bis zu 2 * REVIEW_PAGE_SIZE Paperless-Requests) -
  // bei der aktuellen Bestandsgroesse (siehe Fixplan, 64 Dokumente) unkritisch. Sollte die
  // Instanz deutlich wachsen, ist das der erste Ort, an dem sich ein Cache lohnt.
  const queue = await Promise.all(rawQueue.map(async entry => ({
    ...entry,
    documentLink: entry.document_id ? `${baseURL}/documents/${entry.document_id}/` : null,
    proposedDocumentCount: entry.proposed_id
      ? await paperlessService.getDocumentCountForEntity(entry.entity_type, entry.proposed_id).catch(() => null)
      : 0,
    candidateDocumentCount: await paperlessService.getDocumentCountForEntity(entry.entity_type, entry.candidate_id).catch(() => null)
  })));

  const pageUrl = (targetPage) => {
    const params = new URLSearchParams();
    if (entityType) params.set('entityType', entityType);
    if (status !== 'open') params.set('status', status);
    if (sort !== 'created_at_asc') params.set('sort', sort);
    params.set('page', targetPage);
    return `/review?${params.toString()}`;
  };

  res.render('review', {
    queue, version: config.PAPERLESS_AI_VERSION || ' ',
    entityType, status, sort, entityTypes: ENTITY_TYPES, statuses: QUEUE_STATUSES,
    currentPage, totalPages, total,
    prevPageUrl: pageUrl(Math.max(1, currentPage - 1)),
    nextPageUrl: pageUrl(Math.min(totalPages, currentPage + 1)),
    thresholds: {
      autoThreshold: config.entityResolver.autoThreshold,
      judgeMin: config.entityResolver.judgeMin,
      embedJudgeMin: config.embedding.judgeMin
    },
    embeddingEnabled: config.embedding.enabled
  });
});

router.get('/api/review/:id/documents', authenticateJWT, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const { store } = getServices();
    const entry = store.getQueueEntryById(id);
    if (!entry) {
      return res.status(404).json({ message: `No queue entry with id=${id}` });
    }

    const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
    const withLinks = (docs) => docs.map(doc => ({ ...doc, link: `${baseURL}/documents/${doc.id}/` }));
    // proposed_id ist nullable (Schema), candidate_id nicht - siehe models/entityStore.js.
    const fetchDocs = (entityId) => entityId
      ? paperlessService.getExampleDocumentsForEntity(entry.entity_type, entityId, 3)
      : Promise.resolve([]);
    const fetchCount = (entityId) => entityId
      ? paperlessService.getDocumentCountForEntity(entry.entity_type, entityId)
      : Promise.resolve(0);

    const [proposedDocs, candidateDocs, proposedCount, candidateCount] = await Promise.all([
      fetchDocs(entry.proposed_id),
      fetchDocs(entry.candidate_id),
      fetchCount(entry.proposed_id),
      fetchCount(entry.candidate_id)
    ]);

    res.json({
      proposed: { name: entry.proposed_name, documentCount: proposedCount, documents: withLinks(proposedDocs) },
      candidate: { name: entry.candidate_name, documentCount: candidateCount, documents: withLinks(candidateDocs) }
    });
  } catch (error) {
    console.error(`[ERROR] Example documents for queue entry ${id} failed:`, error.message);
    res.status(500).json({ message: error.message });
  }
});

router.post('/api/review/:id/merge', authenticateJWT, async (req, res) => {
  const id = Number(req.params.id);
  const dryRun = req.body?.dryRun !== false;
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : null;
  const reverse = req.body?.reverse === true;

  try {
    const { reviewQueueService } = getServices();
    const result = dryRun
      ? await reviewQueueService.previewMerge(id, { reverse })
      : await reviewQueueService.merge(id, { expectedDocumentIds: documentIds, reverse });
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] Merge fuer Queue-Eintrag ${id} fehlgeschlagen:`, error.message);
    res.status(400).json({ message: error.message });
  }
});

router.post('/api/review/:id/reject', authenticateJWT, (req, res) => {
  const { reviewQueueService } = getServices();
  const id = Number(req.params.id);

  try {
    const entry = reviewQueueService.reject(id);
    res.json({ id: entry.id, status: 'rejected' });
  } catch (error) {
    console.error(`[ERROR] Reject fuer Queue-Eintrag ${id} fehlgeschlagen:`, error.message);
    res.status(400).json({ message: error.message });
  }
});

router.post('/api/review/:id/ask-judge', authenticateJWT, async (req, res) => {
  const { store } = getServices();
  const id = Number(req.params.id);
  const entry = store.getQueueEntryById(id);
  if (!entry) {
    return res.status(404).json({ message: `No queue entry with id=${id}` });
  }

  // Dieselbe Fehler-zu-'unavailable'-Abbildung wie entityResolver._askJudge (1.1.c) - ein
  // ausgefallener Judge ist keine Modellunsicherheit.
  let verdict;
  try {
    const result = await entityJudge.judge(entry.entity_type, entry.proposed_name, entry.candidate_name);
    verdict = (result && ['same', 'different', 'unsure'].includes(result.verdict))
      ? result
      : { verdict: 'unsure', reason: 'ungueltige oder leere Judge-Antwort' };
  } catch (error) {
    verdict = { verdict: 'unavailable', reason: `judge nicht erreichbar: ${error.message}` };
  }

  const updated = store.updateQueueJudgment(id, verdict);
  if (!updated) {
    return res.status(500).json({ message: 'Judge verdict could not be saved' });
  }
  res.json({ id, ...verdict });
});

router.post('/api/review/backfill/:entityType', authenticateJWT, async (req, res) => {
  const entityType = req.params.entityType;
  const lister = ENTITY_LISTERS[entityType];

  if (!lister) {
    return res.status(400).json({ message: `Unknown entity type "${entityType}"` });
  }

  try {
    const { backfillService } = getServices();
    const existingEntities = await lister();
    const result = await backfillService.run(entityType, existingEntities);
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] Altbestands-Durchlauf fuer "${entityType}" fehlgeschlagen:`, error.message);
    res.status(500).json({ message: error.message });
  }
});

router.post('/api/review/bulk-reject', authenticateJWT, (req, res) => {
  const entityType = ENTITY_TYPES.includes(req.body?.entityType) ? req.body.entityType : null;
  const maxSimilarity = Number(req.body?.maxSimilarity);

  if (!Number.isFinite(maxSimilarity) || maxSimilarity < 0 || maxSimilarity > 1) {
    return res.status(400).json({ message: 'maxSimilarity must be a number between 0 and 1' });
  }

  try {
    const { reviewQueueService } = getServices();
    const rejected = reviewQueueService.bulkReject({ entityType, maxSimilarity });
    res.json({ rejected });
  } catch (error) {
    console.error('[ERROR] Massen-Ablehnung fehlgeschlagen:', error.message);
    res.status(400).json({ message: error.message });
  }
});

router.get('/review/aliases', isAuthenticated, async (req, res) => {
  const { store } = getServices();
  const aliases = store.listAliases();

  const counts = await Promise.all(
    aliases.map(alias => paperlessService.getDocumentCountForEntity(alias.entity_type, alias.canonical_id).catch(() => null))
  );

  res.render('review-aliases', {
    version: config.PAPERLESS_AI_VERSION || ' ',
    aliases: aliases.map((alias, i) => ({ ...alias, targetDocumentCount: counts[i] }))
  });
});

router.delete('/api/review/aliases/:id', authenticateJWT, (req, res) => {
  const { store } = getServices();
  const id = Number(req.params.id);

  const deleted = store.deleteAliasById(id);
  if (!deleted) {
    return res.status(404).json({ message: `No alias with id=${id}` });
  }
  res.json({ id, deleted: true });
});

module.exports = router;
