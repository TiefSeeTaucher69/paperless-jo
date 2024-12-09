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

  async findExistingTag(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    // 1. Zuerst im Cache suchen
    const cachedTag = this.tagCache.get(normalizedName);
    if (cachedTag) {
      console.log(`Found tag "${tagName}" in cache with ID ${cachedTag.id}`);
      return cachedTag;
    }

    // 2. Direkte API-Suche
    try {
      const response = await this.client.get('/tags/', {
        params: {
          name__iexact: normalizedName  // Case-insensitive exact match
        }
      });

      if (response.data.results.length > 0) {
        const foundTag = response.data.results[0];
        console.log(`Found existing tag "${tagName}" via API with ID ${foundTag.id}`);
        this.tagCache.set(normalizedName, foundTag);
        return foundTag;
      }
    } catch (error) {
      console.warn(`Error searching for tag "${tagName}":`, error.message);
    }

    return null;
  }

  async createTagSafely(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    try {
      // Versuche zuerst, den Tag zu erstellen
      const response = await this.client.post('/tags/', { name: tagName });
      const newTag = response.data;
      console.log(`Successfully created tag "${tagName}" with ID ${newTag.id}`);
      this.tagCache.set(normalizedName, newTag);
      return newTag;
    } catch (error) {
      if (error.response?.status === 400) {
        // Bei einem 400er Fehler könnte der Tag bereits existieren
        // Aktualisiere den Cache und suche erneut
        await this.refreshTagCache();
        
        // Suche nochmal nach dem Tag
        const existingTag = await this.findExistingTag(tagName);
        if (existingTag) {
          return existingTag;
        }
      }
      throw error; // Wenn wir den Tag nicht finden konnten, werfen wir den Fehler weiter
    }
  }

  // Hauptfunktion für die Tag-Verarbeitung
  async processTags(tagNames) {
    this.initialize();
    await this.ensureTagCache();

    const tagIds = [];
    const errors = [];
    const processedTags = new Set(); // Verhindert Duplikate

    for (const tagName of tagNames) {
      if (!tagName || typeof tagName !== 'string') {
        console.warn(`Skipping invalid tag name: ${tagName}`);
        continue;
      }

      const normalizedName = tagName.toLowerCase().trim();
      
      // Überspringe leere oder bereits verarbeitete Tags
      if (!normalizedName || processedTags.has(normalizedName)) {
        continue;
      }

      try {
        // Suche zuerst nach existierendem Tag
        let tag = await this.findExistingTag(tagName);
        
        // Wenn kein existierender Tag gefunden wurde, erstelle einen neuen
        if (!tag) {
          tag = await this.createTagSafely(tagName);
        }

        if (tag && tag.id) {
          tagIds.push(tag.id);
          processedTags.add(normalizedName);
        }

      } catch (error) {
        console.error(`Error processing tag "${tagName}":`, error.message);
        errors.push({ tagName, error: error.message });
      }
    }

    return { 
      tagIds: [...new Set(tagIds)], // Entferne eventuelle Duplikate
      errors 
    };
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

  // Verbesserte getAllDocuments Methode mit Paginierung
  async getAllDocuments() {
    this.initialize();
    let documents = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.client.get('/documents/', {
          params: {
            page: page,
            page_size: 100  // Erhöhen Sie die Seitengröße für effizienteres Abrufen
          }
        });
        
        documents = documents.concat(response.data.results);
        
        // Prüfe, ob es weitere Seiten gibt
        hasMore = response.data.next !== null;
        page++;
        
        console.log(`Fetched page ${page-1}, got ${response.data.results.length} documents. Total so far: ${documents.length}`);
        
      } catch (error) {
        console.error(`Error fetching documents page ${page}:`, error.message);
        throw error;
      }
    }

    return documents;
  }

  // Aktualisierte getDocuments Methode
  async getDocuments() {
    return this.getAllDocuments();
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

  async removeUnusedTagsFromDocument(documentId, keepTagIds) {
    this.initialize();
    if (!this.client) return;
  
    try {
      console.log(`Removing unused tags from document ${documentId}, keeping tags:`, keepTagIds);
      
      // Hole aktuelles Dokument
      const currentDoc = await this.getDocument(documentId);
      
      // Finde Tags die entfernt werden sollen (die nicht in keepTagIds sind)
      const tagsToRemove = currentDoc.tags.filter(tagId => !keepTagIds.includes(tagId));
      
      if (tagsToRemove.length === 0) {
        console.log('No tags to remove');
        return currentDoc;
      }
  
      // Update das Dokument mit nur den zu behaltenden Tags
      const updateData = {
        tags: keepTagIds
      };
  
      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(`Successfully removed ${tagsToRemove.length} tags from document ${documentId}`);
      
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(`Error removing unused tags from document ${documentId}:`, error.message);
      throw error;
    }
  }

  async getTagTextFromId(tagId) {
    this.initialize();
    try {
      const response = await this.client.get(`/tags/${tagId}/`);
      return response.data.name;
    } catch (error) {
      console.error(`Error fetching tag text for ID ${tagId}:`, error.message);
      return null;
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
  
      // Bereite die Update-Daten vor
      const updateData = {
        ...updates,
        // Wenn ein Datum vorhanden ist, formatiere es korrekt für die API
        ...(updates.created && {
          created: new Date(updates.created).toISOString()
        })
      };
  
      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(`Updated document ${documentId} with:`, updateData);
      
      return await this.getDocument(documentId); // Optional: Gib das aktualisierte Dokument zurück
    } catch (error) {
      console.error(`Error updating document ${documentId}:`, error.message);
      return null; // Oder eine andere geeignete Rückgabe
    }
  }
}

module.exports = new PaperlessService();