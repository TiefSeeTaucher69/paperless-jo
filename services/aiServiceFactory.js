const config = require('../config/config');
const openaiService = require('./openaiService');
const ollamaService = require('./ollamaService');
const customService = require('./customService');

class AIServiceFactory {
  static getService() {
    switch (config.aiProvider) {
      case 'ollama':
        return ollamaService;
      case 'openai':
      default:
        return openaiService;
      case 'custom':
        return customService;
    }
  }
}

module.exports = AIServiceFactory;