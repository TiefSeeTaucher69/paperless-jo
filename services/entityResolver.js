// services/entityResolver.js
const { normalizeForType } = require('./entityNormalizer');
const { diceCoefficient } = require('./entitySimilarity');

class EntityResolver {
  constructor({ store, judge, config = {} }) {
    this.store = store;
    this.judge = judge; // async (type, nameA, nameB) => { verdict, reason }
    this.autoThreshold = config.autoThreshold ?? 0.90;
    this.judgeMin = config.judgeMin ?? 0.65;
  }

  async resolve(type, proposedName, existingEntities) {
    if (!proposedName || !proposedName.trim()) {
      return { action: 'skip' };
    }

    const normalizedProposed = normalizeForType(proposedName, type);

    // Stufe 1: Alias-Tabelle
    const alias = this.store.findAlias(type, normalizedProposed);
    if (alias) {
      const stillExists = existingEntities.some(e => e.id === alias.canonical_id);
      if (stillExists) {
        return { action: 'map', id: alias.canonical_id, canonicalName: alias.canonical_name, via: 'alias' };
      }
      // Fehlerverhalten: Alias zeigt ins Leere -> verwerfen und neu entscheiden
      console.warn(`[WARNING] entityResolver: Alias "${normalizedProposed}" (${type}) zeigt auf geloeschte ID ${alias.canonical_id}, wird verworfen`);
      this.store.deleteAlias(type, normalizedProposed);
    }

    // Stufe 2: exakter Treffer (heutiges Verhalten)
    const exact = existingEntities.find(e => e.name.toLowerCase() === proposedName.toLowerCase());
    if (exact) {
      return { action: 'map', id: exact.id, canonicalName: exact.name, via: 'exact' };
    }

    // Stufe 3: normalisierter Treffer
    for (const entity of existingEntities) {
      if (normalizeForType(entity.name, type) === normalizedProposed) {
        this.store.insertAlias({
          entityType: type, aliasNormalized: normalizedProposed,
          canonicalName: entity.name, canonicalId: entity.id, source: 'auto'
        });
        return { action: 'map', id: entity.id, canonicalName: entity.name, via: 'normalized' };
      }
    }

    // Stufe 4 folgt in Task 6
    return { action: 'create' };
  }
}

module.exports = EntityResolver;
