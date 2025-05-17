// ragService.js
const axios = require('axios');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');

class RAGService {
  constructor() {
    this.searchApiUrl = "http://localhost:8000/search";
    this.aiService = AIServiceFactory.getService();
  }

  /**
   * Search for documents relevant to a query
   * @param {string} query - The search query
   * @param {Object} options - Optional search parameters
   * @param {string} options.from_date - Filter by start date (YYYY-MM-DD)
   * @param {string} options.to_date - Filter by end date (YYYY-MM-DD)
   * @param {string} options.correspondent - Filter by correspondent name
   * @returns {Promise<Array>} - Array of matching documents
   */
  async searchDocuments(query, options = {}) {
    try {
      const requestBody = {
        query: query,
        ...options
      };

      const response = await axios.post(this.searchApiUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      return response.data;
    } catch (error) {
      console.error("Error searching documents:", error.message);
      throw new Error(`Failed to search documents: ${error.message}`);
    }
  }

  /**
   * Generate an AI answer based on the provided question and documents
   * @param {string} question - The user's question
   * @param {Array} documents - Array of relevant documents
   * @returns {Promise<string>} - The AI-generated answer
   */
  async generateAnswerFromDocuments(question, documents, options = {}) {
    try {
      if (!documents || documents.length === 0) {
        return {
          answer: "No relevant documents found to answer your question.",
          sources: []
        };
      }

      // Prepare context from documents
      const context = documents.map((doc, index) => {
        return `Document ${index + 1}: "${doc.title}" (${doc.correspondent}, ${doc.date})
Snippet: ${doc.snippet}`;
      }).join("\n\n");

      // Get the language to use for the response (defaults to matching the question language)
      const language = options.language || 'en';
      
      // Create instruction text based on language
      let languageInstruction = '';
      switch (language) {
        case 'de':
          languageInstruction = 'WICHTIG: Antworte auf Deutsch.';
          break;
        case 'fr':
          languageInstruction = 'IMPORTANT: Répondez en français.';
          break;
        case 'es':
          languageInstruction = 'IMPORTANTE: Responde en español.';
          break;
        default: // English or other languages
          languageInstruction = 'IMPORTANT: Answer in the same language as the question.';
      }

      // Create prompt for the AI
      const prompt = `Answer the following question based ONLY on the information provided in these documents:

Question: ${question}

Context Documents:
${context}

${languageInstruction}
Please provide a comprehensive answer citing the specific documents used. If the information to answer the question is not contained in the documents, state that clearly.`;

      // Create a custom system prompt specifically for RAG
      const ragSystemPrompt = `You are a document-based question answering assistant.
I will provide you with a user question and document context. Analyze the documents and create a detailed answer to the question based ONLY on the information in these documents.

IMPORTANT RULES:
1. ONLY use information from the provided documents
2. DO NOT use any prior knowledge or information not in the provided documents
3. If the documents do not contain the information needed, state that clearly
4. When referencing information, cite which document it came from (e.g., "According to Document 1...")
5. Provide a comprehensive, accurate answer directly addressing the question

FORMAT YOUR RESPONSE AS A SIMPLE TEXT ANSWER, NOT JSON.
Do not include any JSON formatting, tags, or field names like "title," "correspondent," etc.
Just write a clear, direct answer in plain text.

This overrides any previous instructions about JSON formatting. DO NOT return JSON - only return the text of your answer.`;

      // Use direct OpenAI call instead of analyzeDocument which handles thumbnails
      this.aiService.initialize();
      
      if (!this.aiService.client) {
        throw new Error('AI client not initialized');
      }
      
      // Create messages for AI completion
      const messages = [
        {
          role: "system",
          content: ragSystemPrompt
        },
        {
          role: "user",
          content: question + "\n\n" + context
        }
      ];
      
      // Call AI service directly
      const response = await this.aiService.client.chat.completions.create({
        model: process.env.OPENAI_MODEL || config.ollama.model,
        messages: messages,
        temperature: 0.3,
      });
      
      // Extract the answer from the result
      let answer = "Unable to generate an answer from the documents.";
      
      if (response?.choices?.[0]?.message?.content) {
        answer = response.choices[0].message.content.trim();
      }
      
      return {
        answer,
        sources: documents
      };
    } catch (error) {
      console.error("Error generating answer:", error.message);
      throw new Error(`Failed to generate answer: ${error.message}`);
    }
  }

  /**
   * Main function to ask a question and get an answer with sources
   * @param {string} question - The user's question
   * @param {Object} options - Optional search parameters
   * @returns {Promise<Object>} - Object containing answer and source documents
   */
  async askQuestion(question, options = {}) {
    try {
      // Search for relevant documents
      const documents = await this.searchDocuments(question, options);
      
      // Get top 3 documents based on score
      const topDocuments = documents
        .sort((a, b) => (b.score + b.cross_score) - (a.score + a.cross_score))
        .slice(0, 3);
      
      // Generate answer from documents, passing the options including language
      const result = await this.generateAnswerFromDocuments(question, topDocuments, options);
      
      return result;
    } catch (error) {
      console.error("Error in RAG process:", error.message);
      throw new Error(`RAG process failed: ${error.message}`);
    }
  }
}

module.exports = new RAGService();
