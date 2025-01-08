const OpenAI = require('openai');
const config = require('../config/config');
const tiktoken = require('tiktoken');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');

class OpenAIService {
  constructor() {
    this.client = null;
    this.tokenizer = null;
  }

  initialize() {
    if (!this.client && config.aiProvider === 'ollama') {
      this.client = new OpenAI({
        baseURL: config.ollama.apiUrl +'/v1',
        apiKey: 'ollama'
      });
    }
    if (!this.client && config.openai.apiKey) {
      this.client = new OpenAI({
        apiKey: config.openai.apiKey
      });
    }
  }

  // Calculate tokens for a given text
  async calculateTokens(text) {
    if (!this.tokenizer) {
      // Use the appropriate model encoding
      this.tokenizer = await tiktoken.encoding_for_model(process.env.OPENAI_MODEL || "gpt-3.5-turbo");
    }
    return this.tokenizer.encode(text).length;
  }

  // Truncate text to fit within token limit
  async truncateToTokenLimit(text, maxTokens) {
    const tokens = await this.calculateTokens(text);
    if (tokens <= maxTokens) return text;

    // Simple truncation strategy - could be made more sophisticated
    const ratio = maxTokens / tokens;
    return text.slice(0, Math.floor(text.length * ratio));
  }

  async analyzeDocument(content, existingTags = [], id) {
      const cachePath = path.join('./public/images', `${id}.png`);
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      
      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }

      try {
        // Prüfe ob das Bild bereits im Cache existiert
        try {
          await fs.access(cachePath);
          console.log('[DEBUG] Thumbnail already cached');
          
        } catch (err) {
          // File existiert nicht im Cache, hole es von Paperless
          console.log('Thumbnail not cached, fetching from Paperless');
          
          const thumbnailData = await paperlessService.getThumbnailImage(id);
          
          if (!thumbnailData) {
            console.warn('Thumbnail nicht gefunden');
          }
    
          // Speichere im Cache
          await fs.mkdir(path.dirname(cachePath), { recursive: true }); // Erstelle Verzeichnis falls nicht existiert
          await fs.writeFile(cachePath, thumbnailData);
        }

      } catch (error) {
        console.warn('Failed to get thumbnail', error);
        // Return a valid structure even in case of error
      }
      
      // Format existing tags
      const existingTagsList = existingTags
      .map(tag => tag.name)
      .join(', ');
      
      // Get system prompt and model
      let systemPrompt = process.env.SYSTEM_PROMPT;
      const model = process.env.OPENAI_MODEL;
      let promptTags = '';
      
      if (process.env.USE_PROMPT_TAGS === 'yes') {
        promptTags = process.env.PROMPT_TAGS;
        systemPrompt = config.specialPromptPreDefinedTags;
      }
      
      // Calculate available tokens for content
      const maxTokens = 128000; // Model's maximum context length
      const systemPromptTokens = await this.calculateTokens(systemPrompt);
      const reservedTokens = systemPromptTokens + 1000; // Reserve tokens for system prompt and response
      const availableTokens = maxTokens - reservedTokens;
      
      // Truncate content if necessary
      const truncatedContent = await this.truncateToTokenLimit(content, availableTokens);
      
      // Make API request
      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        temperature: 0.3,
      });
      
      // Handle response
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }
      
      //log used tokens and total tokens
      const usedTokens = response.choices[0].message.content.length;
      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Used tokens: ${usedTokens}, Total tokens: ${response.usage.total_tokens}`);
      
      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      // Validate response structure
      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      return { 
        document: parsedResponse, 
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      // Return a valid structure even in case of error
      return { 
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message 
      };
    }
  }

  async analyzePlayground(content, prompt) {
    const musthavePrompt = `
    Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:  
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`
  try {
    this.initialize();
    const now = new Date();
    const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    
    if (!this.client) {
      throw new Error('OpenAI client not initialized - missing API key');
    }
    
    // Get system prompt and model
    let systemPrompt = process.env.SYSTEM_PROMPT;
    const model = process.env.OPENAI_MODEL;
    let promptTags = '';
    
    if (process.env.USE_PROMPT_TAGS === 'yes') {
      promptTags = process.env.PROMPT_TAGS;
      systemPrompt = config.specialPromptPreDefinedTags;
    }
    
    // Calculate available tokens for content
    const maxTokens = 128000; // Model's maximum context length
    const systemPromptTokens = await this.calculateTokens(systemPrompt);
    const reservedTokens = systemPromptTokens + 1000; // Reserve tokens for system prompt and response
    const availableTokens = maxTokens - reservedTokens;
    
    // Truncate content if necessary
    const truncatedContent = await this.truncateToTokenLimit(content, availableTokens);
    
    // Make API request
    const response = await this.client.chat.completions.create({
      model: model,
      messages: [
        {
          role: "system",
          content: prompt + musthavePrompt
        },
        {
          role: "user",
          content: truncatedContent
        }
      ],
      temperature: 0.3,
    });
    
    // Handle response
    if (!response?.choices?.[0]?.message?.content) {
      throw new Error('Invalid API response structure');
    }
    
    //log used tokens and total tokens
    const usedTokens = response.choices[0].message.content.length;
    console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
    console.log(`[DEBUG] [${timestamp}] Used tokens: ${usedTokens}, Total tokens: ${response.usage.total_tokens}`);
    
    const usage = response.usage;
    const mappedUsage = {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens
    };

    let jsonContent = response.choices[0].message.content;
    jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(jsonContent);
    } catch (error) {
      console.error('Failed to parse JSON response:', error);
      throw new Error('Invalid JSON response from API');
    }

    // Validate response structure
    if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
      throw new Error('Invalid response structure: missing tags array or correspondent string');
    }

    return { 
      document: parsedResponse, 
      metrics: mappedUsage,
      truncated: truncatedContent.length < content.length
    };
  } catch (error) {
    console.error('Failed to analyze document:', error);
    // Return a valid structure even in case of error
    return { 
      document: { tags: [], correspondent: null },
      metrics: null,
      error: error.message 
    };
  }
}
}

module.exports = new OpenAIService();