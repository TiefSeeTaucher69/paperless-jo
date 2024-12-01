const axios = require('axios');
const config = require('../config/config');

class PaperlessService {
  constructor() {
    this.client = null;
  }

  initialize() {
    if (!this.client && config.paperless.apiUrl && config.paperless.apiToken) {
      this.client = axios.create({
        baseURL: config.paperless.apiUrl,
        headers: {
          'Authorization': `Token ${config.paperless.apiToken}`,
          'Content-Type': 'application/json'
        }
      });
    }
  }

  async findTagByName(name) {
    const response = await this.client.get('/tags/', {
      params: {
        name: name
      }
    });
    return response.data.results.find(tag => tag.name.toLowerCase() === name.toLowerCase());
  }

  async createOrGetTag(name) {
    try {
      // First try to find existing tag
      const existingTag = await this.findTagByName(name);
      if (existingTag) {
        console.log(`Tag "${name}" already exists with ID ${existingTag.id}`);
        return existingTag;
      }

      // If not found, create new tag
      const response = await this.client.post('/tags/', { name });
      console.log(`Created new tag "${name}" with ID ${response.data.id}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 400 && error.response?.data?.error?.includes('unique constraint')) {
        // Tag was created in the meantime, try to fetch it
        console.log(`Tag "${name}" appears to exist, fetching...`);
        const existingTag = await this.findTagByName(name);
        if (existingTag) {
          return existingTag;
        }
      }
      throw error;
    }
  }

  async getDocuments() {
    this.initialize();
    if (!this.client) {
      console.error('Paperless client not initialized - missing configuration');
      return [];
    }
    const response = await this.client.get('/documents/');
    return response.data.results;
  }

  async getDocumentContent(documentId) {
    this.initialize();
    if (!this.client) return null;
    const response = await this.client.get(`/documents/${documentId}/`);
    return response.data.content;
  }

  async updateDocument(documentId, updates) {
    this.initialize();
    if (!this.client) return;

    // Ensure tags array is unique
    if (updates.tags) {
      updates.tags = [...new Set(updates.tags)];
    }

    await this.client.patch(`/documents/${documentId}/`, updates);
  }

  async getTags() {
    this.initialize();
    if (!this.client) return [];
    const response = await this.client.get('/tags/');
    return response.data.results;
  }

  async getCorrespondents() {
    this.initialize();
    if (!this.client) return [];
    const response = await this.client.get('/correspondents/');
    return response.data.results;
  }

  async createCorrespondent(name) {
    this.initialize();
    if (!this.client) return null;
    try {
      const response = await this.client.post('/correspondents/', { name });
      return response.data;
    } catch (error) {
      if (error.response?.status === 400 && error.response?.data?.error?.includes('unique constraint')) {
        // Try to fetch existing correspondent
        const existingCorrespondents = await this.getCorrespondents();
        const existingCorrespondent = existingCorrespondents.find(
          c => c.name.toLowerCase() === name.toLowerCase()
        );
        if (existingCorrespondent) {
          return existingCorrespondent;
        }
      }
      throw error;
    }
  }
}

module.exports = new PaperlessService();