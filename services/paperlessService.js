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

    // Verarbeite zuerst die normalen Tags
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

    // Füge AI-Processed Tag hinzu, wenn aktiviert
    if (process.env.ADD_AI_PROCESSED_TAG === 'yes' && process.env.AI_PROCESSED_TAG_NAME) {
      try {
        const aiTagName = process.env.AI_PROCESSED_TAG_NAME;
        let aiTag = await this.findExistingTag(aiTagName);
        
        if (!aiTag) {
          aiTag = await this.createTagSafely(aiTagName);
        }

        if (aiTag && aiTag.id) {
          tagIds.push(aiTag.id);
        }
      } catch (error) {
        console.error(`Error processing AI tag "${process.env.AI_PROCESSED_TAG_NAME}":`, error.message);
        errors.push({ tagName: process.env.AI_PROCESSED_TAG_NAME, error: error.message });
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

  async getAllDocuments() {
    this.initialize();
    if (!this.client) {
      console.error('Client not initialized');
      return [];
    }

    let documents = [];
    let page = 1;
    let hasMore = true;
    const shouldFilterByTags = process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    let predefinedTags = [];

    // Vorverarbeitung der Tags, wenn Filter aktiv ist
    if (shouldFilterByTags) {
      if (!process.env.TAGS) {
        console.warn('PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined');
        return [];
      }
      // Initialen Tag-Cache aufbauen
      await this.ensureTagCache();
      predefinedTags = process.env.TAGS.split(',').map(tag => tag.trim().toLowerCase());
      console.log('Filtering documents for tags:', predefinedTags);
    }

    while (hasMore) {
      try {
        const response = await this.client.get('/documents/', {
          params: {
            page: page,
            page_size: 100
          }
        });

        // Überprüfe die API-Antwort auf Gültigkeit
        if (!response || !response.data) {
          console.error(`Invalid API response on page ${page}:`, response);
          break;
        }

        // Überprüfe, ob results ein Array ist
        if (!Array.isArray(response.data.results)) {
          console.error(`Invalid results format on page ${page}. Expected array, got:`, typeof response.data.results);
          break;
        }
        
        let pageDocuments = response.data.results;

        // Filter nach Tags, wenn aktiviert
        if (shouldFilterByTags && pageDocuments.length > 0) {
          // Verarbeite Dokumente parallel für bessere Performance
          const filteredDocuments = await Promise.all(
            pageDocuments.map(async doc => {
              if (!doc || !Array.isArray(doc.tags)) return null;

              // Prüfe Tags des Dokuments
              if (doc.tags.length === 0) return null;

              // Hole alle Tag-Namen für die Tag-IDs des Dokuments
              const docTagNames = await Promise.all(
                doc.tags.map(async tagId => {
                  try {
                    // Versuche zuerst im Cache nachzusehen
                    for (const [tagName, tagData] of this.tagCache) {
                      if (tagData.id === tagId) return tagName;
                    }
                    // Wenn nicht im Cache, hole von API
                    const tagText = await this.getTagTextFromId(tagId);
                    return tagText ? tagText.toLowerCase() : null;
                  } catch (error) {
                    console.error(`Error fetching tag ${tagId}:`, error.message);
                    return null;
                  }
                })
              );

              // Prüfe, ob mindestens ein Tag übereinstimmt
              const hasMatchingTag = docTagNames.some(tagName => 
                tagName && predefinedTags.includes(tagName)
              );

              return hasMatchingTag ? doc : null;
            })
          );

          // Filtere null-Werte heraus
          pageDocuments = filteredDocuments.filter(doc => doc !== null);
        }
        
        documents = documents.concat(pageDocuments);
        
        // Prüfe auf weitere Seiten
        hasMore = response.data.next !== null;
        page++;
        
        console.log(
          `Fetched page ${page-1}, got ${pageDocuments.length} ` +
          `${shouldFilterByTags ? 'matching ' : ''}documents. ` +
          `Total so far: ${documents.length}`
        );

        // Optional: Füge eine kleine Verzögerung ein, um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`Error fetching documents page ${page}:`, error.message);
        if (error.response) {
          console.error('Response data:', error.response.data);
          console.error('Response status:', error.response.status);
        }
        // Bei einem Fehler brechen wir die Schleife ab und geben die bisher gesammelten Dokumente zurück
        break;
      }
    }

    if (shouldFilterByTags) {
      console.log(`Finished filtering. Found ${documents.length} documents matching the predefined tags.`);
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
        // remove spaces from name and fill with - to get a valid name, remove . and , as well
        name = name.replace(/ /g, '-').replace(/\./g, '').replace(/,/g, '');
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