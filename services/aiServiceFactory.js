const config = require('../config/config');
const openaiService = require('./openaiService');
const ollamaService = require('./ollamaService');

class AIServiceFactory {
  static getService() {
    switch (config.aiProvider) {
      case 'ollama':
        return ollamaService;
      case 'openai':
      default:
        return openaiService;
    }
  }
}

module.exports = AIServiceFactory;