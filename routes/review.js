const express = require('express');
const router = express.Router();
const { isAuthenticated, authenticateJWT } = require('./auth');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const EntityStore = require('../models/entityStore');
const ReviewQueueService = require('../services/reviewQueueService');
const EntityBackfillService = require('../services/entityBackfillService');
const entityEmbeddingService = require('../services/entityEmbeddingService');

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
const REVIEW_PAGE_SIZE = 25;

router.get('/review', isAuthenticated, (req, res) => {
  const { reviewQueueService } = getServices();

  const entityType = ENTITY_TYPES.includes(req.query.entityType) ? req.query.entityType : null;
  const sort = QUEUE_SORTS.includes(req.query.sort) ? req.query.sort : 'created_at_asc';
  const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);

  const total = reviewQueueService.countOpen({ entityType });
  const totalPages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);

  const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
  const queue = reviewQueueService.listOpen({
    entityType, sort, limit: REVIEW_PAGE_SIZE, offset: (currentPage - 1) * REVIEW_PAGE_SIZE
  }).map(entry => ({
    ...entry,
    documentLink: entry.document_id ? `${baseURL}/documents/${entry.document_id}/` : null
  }));

  const pageUrl = (targetPage) => {
    const params = new URLSearchParams();
    if (entityType) params.set('entityType', entityType);
    if (sort !== 'created_at_asc') params.set('sort', sort);
    params.set('page', targetPage);
    return `/review?${params.toString()}`;
  };

  res.render('review', {
    queue, version: config.PAPERLESS_AI_VERSION || ' ',
    entityType, sort, entityTypes: ENTITY_TYPES,
    currentPage, totalPages, total,
    prevPageUrl: pageUrl(Math.max(1, currentPage - 1)),
    nextPageUrl: pageUrl(Math.min(totalPages, currentPage + 1))
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

module.exports = router;
