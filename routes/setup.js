const express = require('express');
const router = express.Router();
const setupService = require('../services/setupService.js');

// API endpoints that should not redirect
const API_ENDPOINTS = ['/health'];

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

router.get('/setup', async (req, res) => {
  const isConfigured = await setupService.isConfigured();
  if (isConfigured) {
    const config = await setupService.loadConfig();
    res.render('setup', { 
      success: 'Die Anwendung ist bereits konfiguriert. Neue Einstellungen überschreiben die bestehenden.',
      config
    });
  } else {
    res.render('setup');
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
      ollamaUrl,
      ollamaModel,
      scanInterval 
    } = req.body;

    // Validate Paperless config
    const isPaperlessValid = await setupService.validatePaperlessConfig(paperlessUrl, paperlessToken);
    if (!isPaperlessValid) {
      return res.render('setup', { 
        error: 'Paperless-ngx Verbindung fehlgeschlagen. Bitte überprüfen Sie URL und Token.',
        config: req.body
      });
    }

    // Prepare base config
    const config = {
      PAPERLESS_API_URL: paperlessUrl,
      PAPERLESS_API_TOKEN: paperlessToken,
      AI_PROVIDER: aiProvider,
      SCAN_INTERVAL: scanInterval
    };

    // Validate AI provider config
    if (aiProvider === 'openai') {
      const isOpenAIValid = await setupService.validateOpenAIConfig(openaiKey);
      if (!isOpenAIValid) {
        return res.render('setup', { 
          error: 'OpenAI API Key ist ungültig.',
          config: req.body
        });
      }
      config.OPENAI_API_KEY = openaiKey;
    } else if (aiProvider === 'ollama') {
      const isOllamaValid = await setupService.validateOllamaConfig(ollamaUrl, ollamaModel);
      if (!isOllamaValid) {
        return res.render('setup', { 
          error: 'Ollama Verbindung fehlgeschlagen. Bitte überprüfen Sie URL und Modell.',
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
      success: 'Konfiguration erfolgreich gespeichert. Die Anwendung wird neu gestartet...',
      config: req.body
    });

    // Trigger application restart
    setTimeout(() => {
      process.exit(0);  // PM2 will restart the application
    }, 1000);

  } catch (error) {
    console.error('Setup error:', error);
    res.render('setup', { 
      error: 'Ein Fehler ist aufgetreten: ' + error.message,
      config: req.body
    });
  }
});

module.exports = router;