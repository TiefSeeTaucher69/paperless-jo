const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const config = require('./config/config');
const paperlessService = require('./services/paperlessService');
const AIServiceFactory = require('./services/aiServiceFactory');
const documentModel = require('./models/document');
const setupService = require('./services/setupService');
const setupRoutes = require('./routes/setup');

const app = express();

// running task true or false
let runningTask = false;

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files middleware
app.use(express.static(path.join(__dirname, 'public')));

// Custom render function
app.use((req, res, next) => {
  const originalRender = res.render;
  res.render = function (view, locals, callback) {
    if (!locals) {
      locals = {};
    }
    originalRender.call(this, view, locals, (err, html) => {
      if (err) return next(err);
      originalRender.call(this, 'layout', { content: html, ...locals }, callback);
    });
  };
  next();
});

// Data directory initialization
const initializeDataDirectory = async () => {
  const dataDir = path.join(process.cwd(), 'data');
  try {
    await fs.access(dataDir);
  } catch {
    console.log('Creating data directory...');
    await fs.mkdir(dataDir, { recursive: true });
  }
};

// Main scanning function
async function scanInital() {
  config.CONFIGURED = false;
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('Setup not completed. Skipping document scan.');
      return;
    }

    config.CONFIGURED = true;


    const existingTags = await paperlessService.getTags();
    const documents = await paperlessService.getAllDocuments();
    
    for (const doc of documents) {
      const isProcessed = await documentModel.isDocumentProcessed(doc.id);
      
      if (!isProcessed) {
        console.log(`Processing new document: ${doc.title}`);
        
        const content = await paperlessService.getDocumentContent(doc.id);
        const aiService = AIServiceFactory.getService();
        const analysis = await aiService.analyzeDocument(content, existingTags, doc.id);
        if (analysis.error) {
          console.error('Document analysis failed:', result.error);
          // Handle error appropriately
          return;
        }
        const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags);
        
        if (errors.length > 0) {
          console.warn('Some tags could not be processed:', errors);
        }

        let updateData = { 
          tags: tagIds,
          title: analysis.document.title || doc.title,
          created: analysis.document.document_date || doc.created,
        };
        
        if (analysis.document.correspondent) {
          try {
            const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent);
            if (correspondent) {
              updateData.correspondent = correspondent.id;
            }
          } catch (error) {
            console.error(`Error processing correspondent "${analysis.document.correspondent}":`, error.message);
          }
        }

        if (analysis.document.language) {
          updateData.language = analysis.document.language;
        }

        try {
          await paperlessService.updateDocument(doc.id, updateData);
          await documentModel.addProcessedDocument(doc.id, updateData.title);
          await documentModel.addOpenAIMetrics(doc.id, analysis.metrics.promptTokens, analysis.metrics.completionTokens, analysis.metrics.totalTokens);
        } catch (error) {
          console.error(`Error processing document: ${error}`);
        }
      }
    }
  } catch (error) {
    console.error('Error during document scan:', error);
  }
}

// Main scanning function
async function scanDocuments() {
  if (runningTask) {
    console.log('Task already running');
    return;
  }
  try {
    runningTask = true;
    const existingTags = await paperlessService.getTags();
    const documents = await paperlessService.getAllDocuments();
    
    for (const doc of documents) {
      const isProcessed = await documentModel.isDocumentProcessed(doc.id);
      
      if (!isProcessed) {
        console.log(`Processing new document: ${doc.title}`);
        
        const content = await paperlessService.getDocumentContent(doc.id);
        const aiService = AIServiceFactory.getService();
        const analysis = await aiService.analyzeDocument(content, existingTags);

        const { tagIds, errors } = await paperlessService.processTags(analysis.tags);
        
        if (errors.length > 0) {
          console.warn('Some tags could not be processed:', errors);
        }

        let updateData = { 
          tags: tagIds,
          title: analysis.title || doc.title,
          created: analysis.document_date || doc.created,
        };
        
        if (analysis.correspondent) {
          try {
            const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.correspondent);
            if (correspondent) {
              updateData.correspondent = correspondent.id;
            }
          } catch (error) {
            console.error(`Error processing correspondent "${analysis.correspondent}":`, error.message);
          }
        }

        if (analysis.language) {
          updateData.language = analysis.language;
        }

        try {
          await paperlessService.updateDocument(doc.id, updateData);
          await documentModel.addProcessedDocument(doc.id, updateData.title);
        } catch (error) {
          console.error(`Error processing document: ${error}`);
        }
      }
    }
  } catch (error) {
    console.error('Error during document scan:', error);
  }
  runningTask = false;
  console.log('[INFO] Task completed');
}

// Setup route handling
app.use('/', setupRoutes);

// Main route with setup check
app.get('/', async (req, res) => {
  try {
    // const isConfigured = await setupService.isConfigured();
    // if (!isConfigured) {
    //   return res.redirect('/setup');
    // }

    // const documents = await paperlessService.getDocuments();
    // res.render('index', { documents });
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).send('Error fetching documents');
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
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

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Schedule periodic scanning
const startScanning = async () => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('Setup not completed. Visit http://your-ip-or-host.com:3000/setup to complete setup.');
      return;
    }

    // Log the configured scan interval
    console.log('Configured scan interval:', config.scanInterval);

    // Initial scan
    console.log(`Starting initial scan at ${new Date().toISOString()}`);
    await scanInital();

    // Schedule regular scans
    cron.schedule(config.scanInterval, async () => {
      console.log(`Starting scheduled scan at ${new Date().toISOString()}`);
      await scanDocuments();
    });

  } catch (error) {
    console.error('Error in startScanning:', error);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Starting graceful shutdown...');
  try {
    documentModel.closeDatabase();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start server
const startServer = async () => {
  try {
    await initializeDataDirectory();
    app.listen(3000, () => {
      console.log('Server running on port 3000');
      startScanning();
    });
  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  }
};

startServer();