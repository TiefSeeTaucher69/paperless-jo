const express = require('express');
const router = express.Router();
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const openaiService = require('../services/openaiService.js');
const ollamaService = require('../services/ollamaService.js');
const documentModel = require('../models/document.js');
const debugService = require('../services/debugService.js');

// API endpoints that should not redirect
const API_ENDPOINTS = ['/health', '/manual'];

// Setup middleware to check if app is configured
router.use(async (req, res, next) => {
  if (API_ENDPOINTS.includes(req.path) || req.path === '/setup') {
    return next();
  }
  
  const isConfigured = await setupService.isConfigured();
  if (!isConfigured) {
    return res.redirect('/setup');
  }
  
  next();
});

// const base64Encode = (str) => Buffer.from(str).toString('base64');

router.get('/setup', async (req, res) => {
  // Helper function to properly handle multiline strings
  const processSystemPrompt = (prompt) => {
    if (!prompt) return '';
    // Replace escaped newlines with actual newlines
    return prompt.replace(/\\n/g, '\n');
  };

  const isConfigured = await setupService.isConfigured();
  let config = {
    PAPERLESS_API_URL: (process.env.PAPERLESS_API_URL || 'http://localhost:8000').replace(/\/api$/, ''),
    PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
    AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
    SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
    PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
    TAGS: process.env.TAGS ? process.env.TAGS.split(',') : []
  };
  
  if (isConfigured) {
    const savedConfig = await setupService.loadConfig();
    // Remove /api from saved config URL if present
    if (savedConfig.PAPERLESS_API_URL) {
      savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(/\/api$/, '');
    }
    config = { ...config, ...savedConfig };
  }
  
  res.render('setup', { 
    config,
    success: isConfigured ? 'The application is already configured. You can update the configuration below.' : undefined
  });
});

router.get('/manual/preview/:id', async (req, res) => {
  try {
    const documentId = req.params.id;
    console.log('Fetching content for document:', documentId);
    
    const response = await fetch(
      `${process.env.PAPERLESS_API_URL}/documents/${documentId}/`,
      {
        headers: {
          'Authorization': `Token ${process.env.PAPERLESS_API_TOKEN}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch document content: ${response.status} ${response.statusText}`);
    }

    const document = await response.json();
    //map the tags to their names
    document.tags = await Promise.all(document.tags.map(async tag => {
      const tagName = await paperlessService.getTagTextFromId(tag);
      return tagName;
    }
    ));
    console.log('Document Data:', document);
    res.json({ content: document.content, title: document.title, id: document.id, tags: document.tags });
  } catch (error) {
    console.error('Content fetch error:', error);
    res.status(500).json({ error: `Error fetching document content: ${error.message}` });
  }
});


router.get('/manual', async (req, res) => {
  res.render('manual', {
    title: 'Document Review',
    error: null,
    success: null,
    paperlessUrl: process.env.PAPERLESS_API_URL,
    paperlessToken: process.env.PAPERLESS_API_TOKEN,
    config: {}
  });
});

router.get('/manual/tags', async (req, res) => {
  const getTags = await paperlessService.getTags();
  res.json(getTags);
});

router.get('/manual/documents', async (req, res) => {
  const getDocuments = await paperlessService.getDocuments();
  res.json(getDocuments);
});

router.get('/debug', async (req, res) => {
  const isConfigured = await setupService.isConfigured();
  if (!isConfigured) {
    return res.status(503).json({ 
      status: 'not_configured',
      message: 'Application setup not completed'
    });
  }

  res.render('debug');
});

router.get('/debug/tags', async (req, res) => {
  const tags = await debugService.getTags();
  res.json(tags);
});

router.get('/debug/documents', async (req, res) => {
  const documents = await debugService.getDocuments();
  res.json(documents);
});

router.get('/debug/correspondents', async (req, res) => {
  const correspondents = await debugService.getCorrespondents();
  res.json(correspondents);
});

router.post('/manual/analyze', express.json(), async (req, res) => {
  try {
    const { content, existingTags } = req.body;
    
    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res.status(400).json({ error: 'Valid content string is required' });
    }

    if (process.env.AI_PROVIDER === 'openai') {
      const analyzeDocument = await openaiService.analyzeDocument(content, existingTags || []);
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'ollama') {
      const analyzeDocument = await ollamaService.analyzeDocument(content, existingTags || []);
      return res.json(analyzeDocument);
    } else {
      return res.status(500).json({ error: 'AI provider not configured' });
    }
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/manual/updateDocument', express.json(), async (req, res) => {
  try {
    var { documentId, tags, correspondent } = req.body;
    
    // Convert all tags to names if they are IDs
    tags = await Promise.all(tags.map(async tag => {
      console.log('Processing tag:', tag);
      if (!isNaN(tag)) {
        const tagName = await paperlessService.getTagTextFromId(Number(tag));
        console.log('Converted tag ID:', tag, 'to name:', tagName);
        return tagName;
      }
      return tag;
    }));

    // Filter out any null or undefined tags
    tags = tags.filter(tag => tag != null);

    // Process new tags to get their IDs
    const { tagIds, errors } = await paperlessService.processTags(tags);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    // Process correspondent if provided
    const correspondentData = correspondent ? await paperlessService.getOrCreateCorrespondent(correspondent) : null;

    // First, remove all unused tags
    await paperlessService.removeUnusedTagsFromDocument(documentId, tagIds);
    
    // Then update with new tags (this will only add new ones since we already removed unused ones)
    const updateData = {
      tags: tagIds,
      correspondent: correspondentData ? correspondentData.id : null
    };

    const updateDocument = await paperlessService.updateDocument(documentId, updateData);
    
    // Mark document as processed
    await documentModel.addProcessedDocument(documentId, updateDocument.title);

    res.json(updateDocument);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/health', async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(503).json({ 
        status: 'not_configured',
        message: 'Application setup not completed'
      });
    }

    try {
      await documentModel.isDocumentProcessed(1);
    } catch (error) {
      return res.status(503).json({ 
        status: 'database_error',
        message: 'Database check failed'
      });
    }

    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

router.post('/setup', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { 
      paperlessUrl, 
      paperlessToken, 
      aiProvider,
      openaiKey,
      openaiModel,
      ollamaUrl,
      ollamaModel,
      scanInterval,
      systemPrompt,
      showTags,
      tags
    } = req.body;

    // Process system prompt - replace line breaks with \n
    const processedPrompt = systemPrompt.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');

    // Validate Paperless config
    const isPaperlessValid = await setupService.validatePaperlessConfig(paperlessUrl, paperlessToken);
    if (!isPaperlessValid) {
      return res.render('setup', { 
        error: 'Paperless-ngx connection failed. Please check URL and Token.',
        config: req.body
      });
    }

    // Prepare base config
    const config = {
      PAPERLESS_API_URL: paperlessUrl + '/api',
      PAPERLESS_API_TOKEN: paperlessToken,
      AI_PROVIDER: aiProvider,
      SCAN_INTERVAL: scanInterval,
      SYSTEM_PROMPT: processedPrompt, // Use the processed prompt
      PROCESS_PREDEFINED_DOCUMENTS: showTags,
      TAGS: tags.split(',').map(tag => tag.trim())
    };

    // Validate AI provider config
    if (aiProvider === 'openai') {
      const isOpenAIValid = await setupService.validateOpenAIConfig(openaiKey);
      if (!isOpenAIValid) {
        return res.render('setup', { 
          error: 'OpenAI API Key is not valid. Please check the key.',
          config: req.body
        });
      }
      config.OPENAI_API_KEY = openaiKey;
      config.OPENAI_MODEL = openaiModel;
    } else if (aiProvider === 'ollama') {
      const isOllamaValid = await setupService.validateOllamaConfig(ollamaUrl, ollamaModel);
      if (!isOllamaValid) {
        return res.render('setup', { 
          error: 'Ollama connection failed. Please check URL and Model.',
          config: req.body
        });
      }
      config.OLLAMA_API_URL = ollamaUrl;
      config.OLLAMA_MODEL = ollamaModel;
    }

    // Save configuration
    await setupService.saveConfig(config);

    // Send success response
    res.render('setup', { 
      success: 'Configuration saved successfully. The application will restart...',
      config: req.body
    });

    // Trigger application restart
    setTimeout(() => {
      process.exit(0);  // PM2 will restart the application
    }, 1000);

  } catch (error) {
    console.error('Setup error:', error);
    res.render('setup', { 
      error: 'An error occurred: ' + error.message,
      config: req.body
    });
  }
});

module.exports = router;
