const OpenAI = require('openai');
const config = require('../config/config');

class OpenAIService {
  constructor() {
    this.client = null;
  }

  initialize() {
    if (!this.client && config.openai.apiKey) {
      this.client = new OpenAI({
        apiKey: config.openai.apiKey
      });
    }
  }

  async analyzeDocument(content, existingTags = []) {
    try {
      this.initialize();

      if (!this.client) {
        console.error('OpenAI client not initialized - missing API key');
        return { tags: [], correspondent: null };
      }

      // Formatiere existierende Tags für den Prompt
      const existingTagsList = existingTags
        .map(tag => tag.name)
        .join(', ');

      const systemPrompt = `Sie sind ein Dokumentanalysator. Ihre Aufgabe:

1. Analysieren Sie den Dokumentinhalt und extrahieren Sie wichtige Informationen.
2. Erstellen Sie ein JSON-Objekt mit passenden Tags und dem Korrespondenten.
3. Berücksichtigen Sie die folgenden bereits existierenden Tags:
${existingTagsList}

Wichtige Regeln:
- Prüfen Sie zuerst, ob einer der existierenden Tags passt, bevor Sie neue vorschlagen
- Verwenden Sie nur relevante Kategorien (Rechnung, Steuer, Vertrag, Mitteilung, Kfz, Versicherung etc.)
- Vermeiden Sie generische oder irrelevante Tags
- Es sollen wirklich nur die wichtigsten Informationen zum erstellen eines Tags benutzt werden.
- Der Korrespondent sollte die tatsächlich sendende Firma/Institution sein
- Geben Sie NUR das JSON-Objekt zurück, keine Erklärungen oder Markdown
- Format: {"tags": ["Tag1", "Tag2"], "correspondent": "Firma"}

Prüfen Sie für jeden neuen Tag, ob nicht ein existierender Tag den gleichen Zweck erfüllt.`;

      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: content
          }
        ],
        temperature: 0.3,
      });

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const parsedResponse = JSON.parse(jsonContent);
      
      if (!Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure');
      }
      
      return parsedResponse;
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return { tags: [], correspondent: null };
    }
  }
}

module.exports = new OpenAIService();