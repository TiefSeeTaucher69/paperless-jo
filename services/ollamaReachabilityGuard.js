// services/ollamaReachabilityGuard.js
const axios = require('axios');
const config = require('../config/config');

// AUDIT-007: entityJudge und entityEmbeddingService rufen Ollama fest verdrahtet auf,
// unabhaengig von config.aiProvider. Ist der Resolver oder der Embedding-Kanal aktiv und
// Ollama nicht erreichbar, faellt heute jeder Judge-Aufruf einzeln auf ECONNREFUSED ->
// "unsure" zurueck und jeder Embedding-Aufruf einzeln in eine eigene console.warn-Zeile -
// bei einem groesseren Dokumentbestand potenziell hunderte identische Meldungen statt
// einer. check() prueft einmalig beim Serverstart und gibt bei Nichterreichbarkeit genau
// eine deutliche Warnung aus.
class OllamaReachabilityGuard {
  constructor() {
    this.client = axios.create({ timeout: 5000 });
  }

  async check() {
    if (!config.entityResolver.enabled && !config.embedding.enabled) {
      return true;
    }

    try {
      await this.client.get(`${config.ollama.apiUrl}/api/tags`);
      return true;
    } catch (error) {
      // config._maskUrl statt config.ollama.apiUrl im Klartext - data/.env-Werte (hier die
      // Ollama-URL) duerfen laut CLAUDE.md nie im Log erscheinen.
      console.warn(
        `[WARNING] ollamaReachabilityGuard: Ollama unter ${config._maskUrl(config.ollama.apiUrl)} ` +
        `nicht erreichbar (${error.message}), obwohl ENTITY_RESOLVER_ENABLED und/oder ` +
        'EMBEDDING_SIMILARITY_ENABLED aktiv sind. Judge- und Embedding-Aufrufe sind fest ' +
        'an Ollama gebunden und werden bis zur naechsten Verfuegbarkeit auf "unsure" bzw. ' +
        'Trigram-only degradieren. (AUDIT-007)'
      );
      return false;
    }
  }
}

module.exports = new OllamaReachabilityGuard();
