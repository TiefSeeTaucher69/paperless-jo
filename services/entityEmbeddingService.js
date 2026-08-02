// services/entityEmbeddingService.js
const axios = require('axios');
const config = require('../config/config');

class EntityEmbeddingService {
  constructor() {
    this.client = axios.create({ timeout: 15000 });
  }

  async embed(text) {
    const response = await this.client.post(`${config.embedding.apiUrl}/api/embed`, {
      model: config.embedding.model,
      input: text
    });

    const vector = response.data?.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Ollama /api/embed lieferte keinen gueltigen Vektor');
    }
    return vector;
  }

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

module.exports = new EntityEmbeddingService();
