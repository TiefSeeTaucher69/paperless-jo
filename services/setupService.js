const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { OpenAI } = require('openai');

class SetupService {
  constructor() {
    this.envPath = path.join(process.cwd(), '.env');
  }

  async loadConfig() {
    try {
      const envContent = await fs.readFile(this.envPath, 'utf8');
      const config = {};
      envContent.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
          config[key.trim()] = value.trim();
        }
      });
      return config;
    } catch (error) {
      return null;
    }
  }

  async validatePaperlessConfig(url, token) {
    try {
      const response = await axios.get(`${url}/documents/`, {
        headers: {
          'Authorization': `Token ${token}`
        }
      });
      return response.status === 200;
    } catch (error) {
      console.error('Paperless validation error:', error.message);
      return false;
    }
  }

  async validateOpenAIConfig(apiKey) {
    try {
      const openai = new OpenAI({ apiKey });
      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: "Test" }],
      });
      return response.choices && response.choices.length > 0;
    } catch (error) {
      console.error('OpenAI validation error:', error.message);
      return false;
    }
  }

  async validateOllamaConfig(url, model) {
    try {
      // Test connection to Ollama server
      const response = await axios.post(`${url}/api/generate`, {
        model: model || 'llama3.2',
        prompt: 'Test',
        stream: false
      });
      return response.data && response.data.response;
    } catch (error) {
      console.error('Ollama validation error:', error.message);
      return false;
    }
  }

  async validateConfig(config) {
    // Validate Paperless config
    const paperlessValid = await this.validatePaperlessConfig(
      config.PAPERLESS_API_URL,
      config.PAPERLESS_API_TOKEN
    );
    
    if (!paperlessValid) {
      throw new Error('Invalid Paperless configuration');
    }

    // Validate AI provider config
    const aiProvider = config.AI_PROVIDER || 'openai';
    
    if (aiProvider === 'openai') {
      const openaiValid = await this.validateOpenAIConfig(config.OPENAI_API_KEY);
      if (!openaiValid) {
        throw new Error('Invalid OpenAI configuration');
      }
    } else if (aiProvider === 'ollama') {
      const ollamaValid = await this.validateOllamaConfig(
        config.OLLAMA_API_URL || 'http://localhost:11434',
        config.OLLAMA_MODEL
      );
      if (!ollamaValid) {
        throw new Error('Invalid Ollama configuration');
      }
    }

    return true;
  }

  async saveConfig(config) {
    // Validate the new configuration before saving
    await this.validateConfig(config);
    const JSON_STANDARD_PROMPT = `
        Return the result EXCLUSIVELY as a JSON object. In addition, fill the data according to the language of the original document.:
        
        {
          "title": "Title",
          "correspondent": "Correspondent/Author",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/esp/..."
        }`;
    const envContent = Object.entries(config)
      .map(([key, value]) => {
        if (key === "SYSTEM_PROMPT") {
          return `${key}=\`${value}\n${JSON_STANDARD_PROMPT}\``;
        }
        return `${key}=${value}`;
      })
      .join('\n');
    await fs.writeFile(this.envPath, envContent);
    
    // Reload environment variables
    Object.entries(config).forEach(([key, value]) => {
      process.env[key] = value;
    });
  }

  async isConfigured() {
    try {
      await fs.access(this.envPath);
      const config = await this.loadConfig();
      if (!config) return false;
      
      // Validate all configurations
      try {
        await this.validateConfig(config);
        return true;
      } catch (error) {
        console.error('Configuration validation failed:', error.message);
        return false;
      }
    } catch {
      return false;
    }
  }
}

module.exports = new SetupService();