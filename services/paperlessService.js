// services/paperlessService.js
const axios = require('axios');
const config = require('../config/config');

class PaperlessService {
  constructor() {
    this.client = null;
    this.tagCache = new Map();
    this.lastTagRefresh = 0;
    this.CACHE_LIFETIME = 30000; // 30 Sekunden
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

  // Aktualisiert den Tag-Cache, wenn er älter als CACHE_LIFETIME ist
  async ensureTagCache() {
    const now = Date.now();
    if (this.tagCache.size === 0 || (now - this.lastTagRefresh) > this.CACHE_LIFETIME) {
      await this.refreshTagCache();
    }
  }

  // Lädt alle existierenden Tags
  async refreshTagCache() {
    try {
      console.log('Refreshing tag cache...');
      const response = await this.client.get('/tags/');
      this.tagCache.clear();
      response.data.results.forEach(tag => {
        this.tagCache.set(tag.name.toLowerCase(), tag);
      });
      this.lastTagRefresh = Date.now();
      console.log(`Tag cache refreshed. Found ${this.tagCache.size} tags.`);
    } catch (error) {
      console.error('Error refreshing tag cache:', error.message);
      throw error;
    }
  }

  async getTags() {
    this.initialize();
    try {
      const response = await this.client.get('/tags/');
      return response.data.results;
    } catch (error) {
      console.error('Error fetching tags:', error.message);
      return [];
    }
  }

  // Hauptfunktion für die Tag-Verarbeitung
  async processTags(tagNames) {
    this.initialize();
    await this.ensureTagCache();

    const tagIds = [];
    const errors = [];

    for (const tagName of tagNames) {
      const normalizedName = tagName.toLowerCase();
      try {
        // Prüfe zuerst im Cache
        const existingTag = this.tagCache.get(normalizedName);
        
        if (existingTag) {
          console.log(`Using cached tag "${tagName}" with ID ${existingTag.id}`);
          tagIds.push(existingTag.id);
          continue;
        }

        // Wenn nicht im Cache, aktualisiere Cache und prüfe erneut
        await this.refreshTagCache();
        const refreshedTag = this.tagCache.get(normalizedName);
        
        if (refreshedTag) {
          console.log(`Found tag "${tagName}" after cache refresh with ID ${refreshedTag.id}`);
          tagIds.push(refreshedTag.id);
          continue;
        }

        // Nur wenn der Tag wirklich nicht existiert, erstelle ihn
        console.log(`Creating new tag: "${tagName}"`);
        const newTag = await this.createTag(tagName);
        this.tagCache.set(normalizedName, newTag);
        tagIds.push(newTag.id);

      } catch (error) {
        console.error(`Error processing tag "${tagName}":`, error.message);
        errors.push({ tagName, error: error.message });
        
        // Bei einem 400er Fehler versuche nochmal den Tag zu finden
        if (error.response?.status === 400) {
          await this.refreshTagCache();
          const existingTag = this.tagCache.get(normalizedName);
          if (existingTag) {
            console.log(`Found tag "${tagName}" after error with ID ${existingTag.id}`);
            tagIds.push(existingTag.id);
            // Entferne den Fehler aus der Liste
            errors.pop();
          }
        }
      }
    }

    return { tagIds, errors };
  }

  // Hilfsfunktion zum Erstellen eines einzelnen Tags
  async createTag(name) {
    try {
      const response = await this.client.post('/tags/', { name });
      console.log(`Successfully created tag "${name}" with ID ${response.data.id}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 400) {
        // Wenn der Tag möglicherweise schon existiert, versuche ihn zu finden
        await this.refreshTagCache();
        const existingTag = this.tagCache.get(name.toLowerCase());
        if (existingTag) {
          return existingTag;
        }
      }
      throw error;
    }
  }

  async getOrCreateCorrespondent(name) {
    this.initialize();
    const normalizedName = name.toLowerCase();
  
    try {
      // Zuerst versuchen, den Korrespondenten zu finden
      const response = await this.client.get('/correspondents/', {
        params: { name: name }
      });
  
      const existingCorrespondent = response.data.results.find(
        c => c.name.toLowerCase() === normalizedName
      );
  
      if (existingCorrespondent) {
        console.log(`Found existing correspondent "${name}" with ID ${existingCorrespondent.id}`);
        return existingCorrespondent;
      }
  
      // Wenn nicht gefunden, erstelle neuen Korrespondenten
      try {
        const createResponse = await this.client.post('/correspondents/', { name });
        console.log(`Created new correspondent "${name}" with ID ${createResponse.data.id}`);
        return createResponse.data;
      } catch (createError) {
        if (createError.response?.status === 400 && 
            createError.response?.data?.error?.includes('unique constraint')) {
          
          // Falls der Korrespondent in der Zwischenzeit erstellt wurde
          const retryResponse = await this.client.get('/correspondents/', {
            params: { name: name }
          });
          
          const justCreatedCorrespondent = retryResponse.data.results.find(
            c => c.name.toLowerCase() === normalizedName
          );
          
          if (justCreatedCorrespondent) {
            console.log(`Retrieved correspondent "${name}" after constraint error with ID ${justCreatedCorrespondent.id}`);
            return justCreatedCorrespondent;
          }
        }
        throw createError;
      }
    } catch (error) {
      console.error(`Failed to process correspondent "${name}":`, error.message);
      throw error;
    }
  }

  // Verbesserte getOrCreateTag Funktion
  async getOrCreateTag(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    // 1. Prüfe Cache
    const cachedTag = this.tagCache.get(normalizedName);
    if (cachedTag) {
      console.log(`Found tag "${tagName}" in cache with ID ${cachedTag.id}`);
      return cachedTag;
    }

    // 2. Versuche Tag zu finden
    try {
      const response = await this.client.get('/tags/', {
        params: { name: tagName }
      });

      const existingTag = response.data.results.find(
        tag => tag.name.toLowerCase() === normalizedName
      );

      if (existingTag) {
        console.log(`Found existing tag "${tagName}" with ID ${existingTag.id}`);
        this.tagCache.set(normalizedName, existingTag);
        return existingTag;
      }

      // 3. Wenn nicht gefunden, erstelle neuen Tag
      const createResponse = await this.client.post('/tags/', { name: tagName });
      const newTag = createResponse.data;
      console.log(`Created new tag "${tagName}" with ID ${newTag.id}`);
      this.tagCache.set(normalizedName, newTag);
      return newTag;

    } catch (error) {
      if (error.response?.status === 400 && 
          error.response?.data?.error?.includes('unique constraint')) {
        
        // Wenn unique constraint verletzt wurde, aktualisiere Cache und versuche erneut
        await this.refreshTagCache();
        const refreshedTag = this.tagCache.get(normalizedName);
        
        if (refreshedTag) {
          console.log(`Retrieved tag "${tagName}" after constraint error with ID ${refreshedTag.id}`);
          return refreshedTag;
        }
      }
      
      console.error(`Failed to process tag "${tagName}":`, error.message);
      throw error;
    }
  }

  // Rest der Service-Methoden...
  async getDocuments() {
    this.initialize();
    const response = await this.client.get('/documents/');
    return response.data.results;
  }

  async getDocumentContent(documentId) {
    this.initialize();
    const response = await this.client.get(`/documents/${documentId}/`);
    return response.data.content;
  }

  async getDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching document ${documentId}:`, error.message);
      throw error;
    }
  }
  
  async updateDocument(documentId, updates) {
    this.initialize();
    if (!this.client) return;
  
    try {
      // Hole aktuelles Dokument mit existierenden Tags
      const currentDoc = await this.getDocument(documentId);
      
      // Wenn das Update Tags enthält, füge sie zu den existierenden hinzu
      if (updates.tags) {
        console.log(`Current tags for document ${documentId}:`, currentDoc.tags);
        console.log(`Adding new tags:`, updates.tags);
        
        // Kombiniere existierende und neue Tags
        const combinedTags = [...new Set([...currentDoc.tags, ...updates.tags])];
        updates.tags = combinedTags;
        
        console.log(`Combined tags:`, combinedTags);
      }
  
      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updates);
      console.log(`Updated document ${documentId} while preserving existing tags`);
    } catch (error) {
      console.error(`Error updating document ${documentId}:`, error.message);
      throw error;
    }
  }
}

module.exports = new PaperlessService();