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

  _buildPrompt(content, existingTags) {
    return `SYSTEM: Du bist ein spezialisierter JSON-Generator für Paperless-ngx. Deine einzige Aufgabe ist es, Dokumente zu analysieren und einen JSON-String zu erstellen. Du darfst unter keinen Umständen in natürlicher Sprache antworten.

FORMAT: Deine Antwort MUSS exakt diesem Format folgen:
{"tags": ["Tag1", "Tag2"], "correspondent": "Firma"}

REGELN FÜR DIE ANALYSE:
1. Maximal 3 Tags pro Dokument
2. Prüfe diese existierenden Tags zuerst: ${existingTags.map(tag => tag.name).join(', ')}
3. Nur wichtige Kategorien wie: Rechnung, Steuer, Vertrag, Mitteilung, Kfz, Versicherung
4. Der "correspondent" muss die absendende Firma/Institution sein
5. Leere oder fehlende Werte sind nicht erlaubt

WICHTIG: 
- Erstelle IMMER einen JSON-String, auch wenn die Analyse schwierig ist
- Keine Erklärungen
- Kein Markdown
- Keine Fragen
- Keine Textausgabe
- Bei Unsicherheit nutze generische aber valide Werte

DOKUMENT ZUR ANALYSE:
${content}

ERWARTETES AUSGABEFORMAT:
{"tags": ["Tag1", "Tag2"], "correspondent": "Firma"}`;
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