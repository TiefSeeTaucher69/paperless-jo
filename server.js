// server.js
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const config = require('./config/config');
const paperlessService = require('./services/paperlessService');
const AIServiceFactory = require('./services/aiServiceFactory');
const documentModel = require('./models/document');
const setupService = require('./services/setupService');
const setupRoutes = require('./routes/setup');

const app = express();

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Main scanning function
async function scanDocuments() {
  console.log('Starting document scan...');
  try {
    // Prüfe zuerst, ob Setup abgeschlossen ist
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('Setup not completed. Skipping document scan.');
      return;
    }

    // Hole existierende Tags
    const existingTags = await paperlessService.getTags();
    console.log(`Found ${existingTags.length} existing tags`);
    
    const documents = await paperlessService.getDocuments();
    
    for (const doc of documents) {
      const isProcessed = await documentModel.isDocumentProcessed(doc.id);
      
      if (!isProcessed) {
        console.log(`Processing new document: ${doc.title}`);
        
        // Get document content
        const content = await paperlessService.getDocumentContent(doc.id);
        
        // Analyze with ChatGPT, passing existing tags for context
        //const analysis = await openaiService.analyzeDocument(content, existingTags);
        const aiService = AIServiceFactory.getService();
        const analysis = await aiService.analyzeDocument(content, existingTags);

        // Process tags
        const { tagIds, errors } = await paperlessService.processTags(analysis.tags);
        
        if (errors.length > 0) {
          console.warn('Some tags could not be processed:', errors);
        }

        // Prepare update data
        let updateData = { tags: tagIds };
        
        // Process correspondent if present
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

        try {
          // Update document while preserving existing tags
          await paperlessService.updateDocument(doc.id, updateData);
          console.log(`Updated document ${doc.title} with ${tagIds.length} tags` + 
                     (updateData.correspondent ? ' and correspondent' : ''));
          
          // Mark as processed
          await documentModel.addProcessedDocument(doc.id, doc.title);
          console.log(`Document ${doc.title} processing completed`);
        } catch (error) {
          console.error(`Error processing document: ${error}`);
        }
      }
    }
  } catch (error) {
    console.error('Error during document scan:', error);
  }
}

// Setup route handling
app.use('/', setupRoutes);

// Main route with setup check
app.get('/', async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.redirect('/setup');
    }

    const documents = await paperlessService.getDocuments();
    res.render('index', { documents });
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

    // Check database
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
const startScanning = () => {
  // Initial scan wird nur durchgeführt, wenn Setup abgeschlossen
  setupService.isConfigured().then(isConfigured => {
    if (isConfigured) {
      console.log('Running initial scan...');
      scanDocuments();
    } else {
      console.log('Setup not completed. Skipping initial scan. Visit http://your-domain-or-ip.com:3000/setup to complete setup.');
    }
  });

  // Plane regelmäßige Scans
  cron.schedule(config.scanInterval, () => {
    scanDocuments();
  });
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Starting graceful shutdown...');
  
  try {
    // Close database connection
    documentModel.closeDatabase();
    
    console.log('Graceful shutdown completed');
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
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startScanning();
});