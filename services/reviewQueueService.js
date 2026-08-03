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

    const persisted = this.store.completeMerge({
      alias: {
        entityType: entry.entity_type,
        aliasNormalized: entry.proposed_normalized,
        canonicalName: entry.candidate_name,
        canonicalId: entry.candidate_id,
        source: 'user'
      },
      queueEntryId: id,
      mergeLog: {
        queueEntryId: id, entityType: entry.entity_type, fromId: entry.proposed_id, toId: entry.candidate_id,
        affectedCount: result.affectedCount, chunksCompleted: result.chunksCompleted ?? 0, chunksTotal: result.chunksTotal ?? 0,
        status: 'completed', errorMessage: null
      }
    });
    if (!persisted) {
      // Der Merge in Paperless ist bereits vollzogen (fromId geloescht) - ein erneuter Versuch
      // ueber die UI wuerde jetzt fehlschlagen. Laut loggen statt den Fehler zu verschlucken,
      // aber dem Aufrufer trotzdem das erfolgreiche Paperless-Ergebnis zurueckgeben (AUDIT-015).
      console.error(`[ERROR] reviewQueueService.merge: Merge fuer Queue-Eintrag ${id} in Paperless erfolgreich, aber Alias/Queue-Status/Merge-Log konnten nicht gespeichert werden - Eintrag bleibt inkonsistent, manuelle Pruefung von entity_aliases/entity_review_queue noetig`);
      // completeMerge rollt bei einem Fehlschlag auch den Merge-Log-Eintrag zurueck (eine
      // Transaktion) - ohne diesen eigenstaendigen Fallback ginge der einzige Nachweis eines
      // erfolgreichen, aber lokal nicht persistierten Merges verloren. Bewusst ausserhalb der
      // Transaktion, damit ein erneuter Fehler hier zumindest sichtbar wuerde statt den Verlust
      // ein zweites Mal stillschweigend zu wiederholen.
      this.store.insertMergeLog({
        queueEntryId: id, entityType: entry.entity_type, fromId: entry.proposed_id, toId: entry.candidate_id,
        affectedCount: result.affectedCount, chunksCompleted: result.chunksCompleted ?? 0, chunksTotal: result.chunksTotal ?? 0,
        status: 'completed', errorMessage: 'Alias/Queue-Status nicht persistiert (completeMerge fehlgeschlagen)'
      });
    }

    return result;
  }

  reject(id) {
    const entry = this._getEntryOrThrow(id);
    this.store.updateQueueStatus(id, 'rejected');
    return entry;
  }
}

module.exports = ReviewQueueService;
