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
      throw new Error(`Kein Queue-Eintrag mit id=${id}`);
    }
    return entry;
  }

  async previewMerge(id) {
    const entry = this._getEntryOrThrow(id);
    return this.paperlessService.mergeEntity(entry.entity_type, entry.proposed_id, entry.candidate_id, { dryRun: true });
  }

  async merge(id) {
    const entry = this._getEntryOrThrow(id);
    const result = await this.paperlessService.mergeEntity(entry.entity_type, entry.proposed_id, entry.candidate_id, { dryRun: false });

    this.store.insertAlias({
      entityType: entry.entity_type,
      aliasNormalized: entry.proposed_normalized,
      canonicalName: entry.candidate_name,
      canonicalId: entry.candidate_id,
      source: 'user'
    });
    this.store.updateQueueStatus(id, 'merged');

    return result;
  }

  reject(id) {
    const entry = this._getEntryOrThrow(id);
    this.store.updateQueueStatus(id, 'rejected');
    return entry;
  }
}

module.exports = ReviewQueueService;
