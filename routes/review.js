const express = require('express');
const router = express.Router();
const { isAuthenticated, authenticateJWT } = require('./auth');
const config = require('../config/config');
const paperlessService = require('../services/paperlessService');
const EntityStore = require('../models/entityStore');
const ReviewQueueService = require('../services/reviewQueueService');
const EntityBackfillService = require('../services/entityBackfillService');

let store = null;
let reviewQueueService = null;
let backfillService = null;

// Lazy statt Modul-Top-Level: verhindert, dass jeder Server-Boot data/entities.db oeffnet
// (auch wenn ENTITY_RESOLVER_ENABLED=no) und dass ein DB-Fehler den gesamten Server-Start crasht.
function getServices() {
  if (!store) {
    store = new EntityStore(config.entityResolver.dbPath);
    reviewQueueService = new ReviewQueueService({ store, paperlessService });
    backfillService = new EntityBackfillService({ store, judgeMin: config.entityResolver.judgeMin });
  }
  return { store, reviewQueueService, backfillService };
}

const ENTITY_LISTERS = {
  tag: () => paperlessService.getTags(),
  correspondent: () => paperlessService.listCorrespondentsNames(),
  document_type: () => paperlessService.listDocumentTypesNames()
};

router.get('/review', isAuthenticated, (req, res) => {
  const { reviewQueueService } = getServices();
  const baseURL = (process.env.PAPERLESS_API_URL || '').replace(/\/api$/, '');
  const queue = reviewQueueService.listOpen().map(entry => ({
    ...entry,
    documentLink: entry.document_id ? `${baseURL}/documents/${entry.document_id}/` : null
  }));

  res.render('review', { queue, version: config.PAPERLESS_AI_VERSION || ' ' });
});

router.post('/api/review/:id/merge', authenticateJWT, async (req, res) => {
  const id = Number(req.params.id);
  const dryRun = req.body?.dryRun !== false;

  try {
    const { reviewQueueService } = getServices();
    const result = dryRun
      ? await reviewQueueService.previewMerge(id)
      : await reviewQueueService.merge(id);
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
    return res.status(400).json({ message: `Unbekannter Entity-Typ "${entityType}"` });
  }

  try {
    const { backfillService } = getServices();
    const existingEntities = await lister();
    const result = backfillService.run(entityType, existingEntities);
    res.json(result);
  } catch (error) {
    console.error(`[ERROR] Altbestands-Durchlauf fuer "${entityType}" fehlgeschlagen:`, error.message);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
