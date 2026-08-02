class ReviewQueueService {
  constructor({ store, paperlessService }) {
    this.store = store;
    this.paperlessService = paperlessService;
  }

  listOpen() {
    return this.store.listOpenQueueEntries();
  }

  _getEntryOrThrow(id) {
    const entry = this.store.getQueueEntryById(id);
    if (!entry) {
      throw new Error(`No queue entry with id=${id}`);
    }
    return entry;
  }

  async previewMerge(id) {
    const entry = this._getEntryOrThrow(id);
    return this.paperlessService.mergeEntity(entry.entity_type, entry.proposed_id, entry.candidate_id, { dryRun: true });
  }

  async merge(id, { expectedDocumentIds = null } = {}) {
    const entry = this._getEntryOrThrow(id);

    let result;
    try {
      result = await this.paperlessService.mergeEntity(entry.entity_type, entry.proposed_id, entry.candidate_id, { dryRun: false, expectedDocumentIds });
    } catch (error) {
      const progress = error.mergeProgress || {};
      this.store.insertMergeLog({
        queueEntryId: id, entityType: entry.entity_type, fromId: entry.proposed_id, toId: entry.candidate_id,
        affectedCount: progress.affectedCount ?? 0, chunksCompleted: progress.chunksCompleted ?? 0, chunksTotal: progress.chunksTotal ?? 0,
        status: 'failed', errorMessage: error.message
      });
      throw error;
    }

    this.store.insertAlias({
      entityType: entry.entity_type,
      aliasNormalized: entry.proposed_normalized,
      canonicalName: entry.candidate_name,
      canonicalId: entry.candidate_id,
      source: 'user'
    });
    this.store.updateQueueStatus(id, 'merged');
    this.store.insertMergeLog({
      queueEntryId: id, entityType: entry.entity_type, fromId: entry.proposed_id, toId: entry.candidate_id,
      affectedCount: result.affectedCount, chunksCompleted: result.chunksCompleted ?? 0, chunksTotal: result.chunksTotal ?? 0,
      status: 'completed', errorMessage: null
    });

    return result;
  }

  reject(id) {
    const entry = this._getEntryOrThrow(id);
    this.store.updateQueueStatus(id, 'rejected');
    return entry;
  }
}

module.exports = ReviewQueueService;
