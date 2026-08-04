const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { OpenAI } = require('openai');
const config = require('../config/config');
const AzureOpenAI = require('openai').AzureOpenAI;

const THRESHOLD_PAIRS = [
  { auto: 'ENTITY_RESOLVER_AUTO_THRESHOLD', judge: 'ENTITY_RESOLVER_JUDGE_MIN' },
  { auto: 'EMBED_AUTO_THRESHOLD', judge: 'EMBED_JUDGE_MIN' }
];

// Mirrors the [0,1] clamp-and-warn logic in config/config.js, but as a hard
// save-time error: a value typed into the Settings UI should fail loudly
// immediately, not silently get clamped after the next restart.
function parseThresholdOrThrow(config, key) {
  const raw = config[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null; // unset -- the code default in config/config.js applies
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be a number between 0 and 1 (got "${raw}")`);
  }
  return value;
}

function validateEntitySimilarityThresholds(config) {
  for (const { auto, judge } of THRESHOLD_PAIRS) {
    const autoValue = parseThresholdOrThrow(config, auto);
    const judgeValue = parseThresholdOrThrow(config, judge);
    if (autoValue !== null && judgeValue !== null && judgeValue > autoValue) {
      throw new Error(`${judge} must not be greater than ${auto} (the LLM-judge stage would be unreachable)`);
    }
  }
}

class SetupService {
  constructor(envPath = path.join(process.cwd(), 'data', '.env')) {
    this.envPath = envPath;
    this.configured = null; // Variable to store the configuration status
  }

  async loadConfig() {
    try {
      const envContent = await fs.readFile(this.envPath, 'utf8');
      const lines = envContent.split('\n');
      const config = {};

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) continue;

        const key = line.slice(0, eqIndex).trim();
        let value = line.slice(eqIndex + 1);
        if (!key) continue;

        // saveConfig() writes SYSTEM_PROMPT as a backtick-delimited value that
        // can span multiple physical lines (`${value}\n\``, where the \n is a
        // real newline in the written file). Reconstruct it here by consuming
        // lines until the lone closing backtick, then strip both backticks --
        // otherwise every save/load round-trip accumulates an extra leading
        // backtick (previously observed as a real corruption bug).
        if (key === 'SYSTEM_PROMPT' && value.startsWith('`')) {
          if (!(value.length > 1 && value.endsWith('`'))) {
            // Strip a trailing \r left over from a CRLF-saved file -- split('\n')
            // doesn't remove it, and it would otherwise get embedded mid-value.
            const parts = [value.replace(/\r$/, '')];
            // Stop at the lone closing backtick (compared trimmed, so a
            // trailing \r from a CRLF-saved file doesn't defeat the match),
            // or at the start of what is clearly the next KEY=value line --
            // this bounds the loop even when a hand-edited file is missing
            // its closing backtick, instead of running to end-of-file and
            // swallowing every subsequent key (e.g. JWT_SECRET).
            const isNextKeyLine = (l) => /^[A-Z_][A-Z0-9_]*=/.test(l);
            while (
              i + 1 < lines.length &&
              lines[i + 1].trim() !== '`' &&
              !isNextKeyLine(lines[i + 1])
            ) {
              i++;
              parts.push(lines[i].replace(/\r$/, ''));
            }
            if (i + 1 < lines.length && lines[i + 1].trim() === '`') {
              i++;
            }
            value = parts.join('\n');
          }
          value = value.replace(/^`/, '').replace(/`$/, '');
        }

        config[key] = value.trim();
      }

      return config;
    } catch (error) {
      console.error('Error loading config:', error.message);
      return null;
    }
  }

  async validatePaperlessConfig(url, token) {
    try {
      console.log('Validating Paperless config for:', url + '/api/documents/');
      const response = await axios.get(`${url}/api/documents/`, {
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

  async validateApiPermissions(url, token) {
    for (const endpoint of ['correspondents', 'tags', 'documents', 'document_types', 'custom_fields', 'users']) {
      try {
        console.log(`Validating API permissions for ${url}/api/${endpoint}/`);
        const response = await axios.get(`${url}/api/${endpoint}/`, {
          headers: {
            'Authorization': `Token ${token}`
          }
        });
        console.log(`API permissions validated for ${endpoint}, ${response.status}`);
        if (response.status !== 200) {
          console.error(`API permissions validation failed for ${endpoint}`);
          return { success: false, message: `API permissions validation failed for endpoint '/api/${endpoint}/'` };
        }
      } catch (error) {
        console.error(`API permissions validation failed for ${endpoint}:`, error.message);
        return { success: false, message: `API permissions validation failed for endpoint '/api/${endpoint}/'` };
      }
    }
    return { success: true, message: 'API permissions validated successfully' };
}


  async validateOpenAIConfig(apiKey) {
    if (config.CONFIGURED === false) {
      try {
        const openai = new OpenAI({ apiKey });
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Test" }],
        });
        const now = new Date();
        const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
        return response.choices && response.choices.length > 0;
      } catch (error) {
        console.error('OpenAI validation error:', error.message);
        return false;
      }
    }else{
      return true;
    }
  }

  async validateCustomConfig(url, apiKey, model) {
    const config = {
      baseURL: url,
      apiKey: apiKey,
      model: model
    };
    console.log('Custom AI config:', config);
    try {
      const openai = new OpenAI({ 
        apiKey: config.apiKey, 
        baseURL: config.baseURL,
      });
      const completion = await openai.chat.completions.create({
        messages: [{ role: "user", content: "Test" }],
        model: config.model,
      });
      return completion.choices && completion.choices.length > 0;
    } catch (error) {
      console.error('Custom AI validation error:', error);
      return false;
    }
  }



  async validateOllamaConfig(url, model) {
    try {
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

  async validateAzureConfig(apiKey, endpoint, deploymentName, apiVersion) {
    console.log('Endpoint: ', endpoint);
    if (config.CONFIGURED === false) {
      try {
        const openai = new AzureOpenAI({ apiKey: apiKey,
                endpoint: endpoint,
                deploymentName: deploymentName,
                apiVersion: apiVersion });
        const response = await openai.chat.completions.create({
          model: deploymentName,
          messages: [{ role: "user", content: "Test" }],
        });
        const now = new Date();
        const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
        return response.choices && response.choices.length > 0;
      } catch (error) {
        console.error('OpenAI validation error:', error.message);
        return false;
      }
    }else{
      return true;
    }
  }

  async validateConfig(config) {
    validateEntitySimilarityThresholds(config);

    // Validate Paperless config
    const paperlessApiUrl = config.PAPERLESS_API_URL.replace(/\/api/g, '');
    const paperlessValid = await this.validatePaperlessConfig(
      paperlessApiUrl,
      config.PAPERLESS_API_TOKEN
    );
    
    if (!paperlessValid) {
      throw new Error('Invalid Paperless configuration');
    }

    // Validate AI provider config
    const aiProvider = config.AI_PROVIDER || 'openai';

    console.log('AI provider:', aiProvider);
    
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
    } else if (aiProvider === 'custom') {
      const customValid = await this.validateCustomConfig(
        config.CUSTOM_BASE_URL,
        config.CUSTOM_API_KEY,
        config.CUSTOM_MODEL
      );
      if (!customValid) {
        throw new Error('Invalid Custom AI configuration');
      }
    } else if (aiProvider === 'azure') {
      const azureValid = await this.validateAzureConfig(
        config.AZURE_API_KEY,
        config.AZURE_ENDPOINT,
        config.AZURE_DEPLOYMENT_NAME,
        config.AZURE_API_VERSION
      );
      if (!azureValid) {
        throw new Error('Invalid Azure configuration');
      }
    }


    return true;
  }

  async saveConfig(updates, { validate = true } = {}) {
    try {
      // Read-modify-write against the real file instead of trusting the caller
      // to pass a complete config: a caller that only knows about a subset of
      // keys (e.g. the Settings form) must never be able to erase the rest
      // (JWT_SECRET, feature-flag env vars added after the form was written).
      const existing = (await this.loadConfig()) || {};
      const config = { ...existing, ...updates };

      // Validate the merged configuration before saving, unless the caller
      // explicitly opts out (e.g. jwtSecretGuard persisting a random secret
      // into an already-validated config shouldn't re-check live Paperless/AI
      // connectivity on every server boot).
      if (validate) {
        await this.validateConfig(config);
      }

      const JSON_STANDARD_PROMPT = `
        Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
        
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

      // Ensure data directory exists
      const dataDir = path.dirname(this.envPath);
      await fs.mkdir(dataDir, { recursive: true });

      const envContent = Object.entries(config)
        .map(([key, value]) => {
          if (key === "SYSTEM_PROMPT") {
            return `${key}=\`${value}\n\``;
          }
          return `${key}=${value}`;
        })
        .join('\n');

      await fs.writeFile(this.envPath, envContent);
      
      // Reload environment variables
      Object.entries(config).forEach(([key, value]) => {
        process.env[key] = value;
      });
    } catch (error) {
      console.error('Error saving config:', error.message);
      throw error;
    }
  }

  async isConfigured() {
    if (this.configured !== null) {
      return this.configured;
    }

    const maxAttempts = 60; // 5 minutes = 300 seconds, attempting every 5 seconds = 60 attempts
    const delayBetweenAttempts = 5000; // 5 seconds in milliseconds
    let attempts = 0;

    // First check if .env exists and if PAPERLESS_API_URL is set
    try {
      // Check if .env file exists
      try {
        await fs.access(this.envPath, fs.constants.F_OK);
      } catch (err) {
        console.log('No .env file found. Starting setup process...');
        this.configured = false;
        return false;
      }

      // Load and check for PAPERLESS_API_URL
      const config = await this.loadConfig();
      if (!config || !config.PAPERLESS_API_URL) {
        console.log('PAPERLESS_API_URL not set. Starting setup process...');
        this.configured = false;
        return false;
      }
    } catch (error) {
      console.error('Error checking initial configuration:', error.message);
      this.configured = false;
      return false;
    }

    const attemptConfiguration = async () => {
      try {
        // Check data directory and create if needed
        const dataDir = path.dirname(this.envPath);
        try {
          await fs.access(dataDir, fs.constants.F_OK);
        } catch (err) {
          console.log('Creating data directory...');
          await fs.mkdir(dataDir, { recursive: true });
        }

        // Load and validate full configuration
        const config = await this.loadConfig();
        if (!config) {
          throw new Error('Failed to load configuration');
        }

        await this.validateConfig(config);
        this.configured = true;
        return true;
      } catch (error) {
        console.error('Configuration attempt failed:', error.message);
        throw error;
      }
    };

    // Only enter retry loop if we have PAPERLESS_API_URL set
    while (attempts < maxAttempts) {
      try {
        const result = await attemptConfiguration();
        return result;
      } catch (error) {
        attempts++;
        if (attempts === maxAttempts) {
          console.error('Max configuration attempts reached. Final error:', error.message);
          this.configured = false;
          return false;
        }
        console.log(`Retrying configuration (attempt ${attempts}/${maxAttempts}) in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenAttempts));
      }
    }

    this.configured = false;
    return false;
  }

  // Cheap, local, non-memoized check for whether initial setup has been
  // persisted to disk. Unlike isConfigured(), this makes no network calls
  // and never caches a stale result -- used by POST /setup's security gate,
  // which must reflect the current on-disk state immediately (including the
  // instant saveConfig() finishes writing .env), not a network-availability-
  // dependent value that can get permanently stuck at false for the rest of
  // the process if Paperless-ngx or the AI provider was briefly unreachable
  // the first time isConfigured() happened to run.
  async hasEnvConfig() {
    try {
      await fs.access(this.envPath, fs.constants.F_OK);
    } catch {
      return false;
    }
    const config = await this.loadConfig();
    return !!(config && config.PAPERLESS_API_URL);
  }
}

const setupServiceSingleton = new SetupService();
setupServiceSingleton.SetupService = SetupService;
module.exports = setupServiceSingleton;
