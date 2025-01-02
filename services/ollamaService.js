const axios = require('axios');
const config = require('../config/config');

class OllamaService {
    constructor() {
      this.apiUrl = config.ollama.apiUrl;
      this.model = config.ollama.model;
      this.client = axios.create({
        timeout: 300000 // 5 Minuten Timeout
      });
    }
  
    async analyzeDocument(content, existingTags) {
      try {
        const prompt = this._buildPrompt(content, existingTags);
        
        const response = await this.client.post(`${this.apiUrl}/api/generate`, {
          model: this.model,
          prompt: prompt,
          system: `
          You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
          YOU MUST: Analyze the document content and extract the following information into this structured JSON format and only this format!:         {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
          }
          ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
          `,
          stream: false,
          options: {
            temperature: 0.7,    // Kreativität (0.0 - 1.0)
            top_p: 0.9,         // Nucleus sampling
            repeat_penalty: 1.1  // Verhindert Wiederholungen
          }
        });
  
        // Prüfe explizit auf Response-Fehler
        if (!response.data || !response.data.response) {
          console.error('Unexpected Ollama response format:', response);
          throw new Error('Invalid response from Ollama API');
        }
  
        return this._parseResponse(response.data.response);
      } catch (error) {
        if (error.code === 'ECONNABORTED') {
          console.error('Timeout bei der Ollama-Anfrage:', error);
          throw new Error('Die Analyse hat zu lange gedauert. Bitte versuchen Sie es erneut.');
        }
        console.error('Error analyzing document with Ollama:', error);
        throw error;
      }
    }

  _buildPrompt(content) {
    return process.env.SYSTEM_PROMPT + '\n\n' + JSON.stringify(content);
  }
  
  _parseResponse(response) {
    try {
      // Find JSON in response using regex
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('No JSON found in response:', response);
        return { tags: [], correspondent: null };
      }

      const jsonStr = jsonMatch[0];
      console.log('Extracted JSON:', jsonStr);

      // Try to parse the extracted JSON
      const result = JSON.parse(jsonStr);

      // Validate and return structured data
      return {
        tags: Array.isArray(result.tags) ? result.tags : [],
        correspondent: typeof result.correspondent === 'string' ? result.correspondent : null
      };
    } catch (error) {
      console.error('Error parsing Ollama response:', error);
      console.error('Raw response:', response);
      return { tags: [], correspondent: null };
    }
  }
}

module.exports = new OllamaService();