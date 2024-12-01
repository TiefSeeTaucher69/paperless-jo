const express = require('express');
const cron = require('node-cron');
const path = require('path');
const config = require('./config/config');
const paperlessService = require('./services/paperlessService');
const openaiService = require('./services/openaiService');
const documentModel = require('./models/document');
const setupRoutes = require('./routes/setup');

const app = express();

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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

// Use setup routes
app.use('/', setupRoutes);

// Main scanning function
async function scanDocuments() {
  console.log('Starting document scan...');
  try {
    const documents = await paperlessService.getDocuments();
    
    for (const doc of documents) {
      const isProcessed = documentModel.isDocumentProcessed(doc.id);
      
      if (!isProcessed) {
        console.log(`Processing new document: ${doc.title}`);
        
        // Get document content
        const content = await paperlessService.getDocumentContent(doc.id);
        
        // Analyze with ChatGPT
        const analysis = await openaiService.analyzeDocument(content);
        
        // Initialize tag IDs array
        const tagIds = [];
        
        // Process tags
        for (const tagName of analysis.tags) {
          const tag = await paperlessService.createOrGetTag(tagName);
          if (tag) {
            tagIds.push(tag.id);
          }
        }
        
        // Process correspondent if present
        if (analysis.correspondent) {
          try {
            const correspondent = await paperlessService.createCorrespondent(analysis.correspondent);
            
            // Update document with tags and correspondent
            await paperlessService.updateDocument(doc.id, {
              tags: tagIds,
              correspondent: correspondent.id
            });
          } catch (error) {
            console.error(`Error processing correspondent for document ${doc.title}:`, error);
            // Still update tags even if correspondent processing failed
            await paperlessService.updateDocument(doc.id, { tags: tagIds });
          }
        } else {
          // Update only tags if no correspondent was identified
          await paperlessService.updateDocument(doc.id, { tags: tagIds });
        }
        
        // Mark as processed
        await documentModel.addProcessedDocument(doc.id, doc.title);
        console.log(`Document ${doc.title} processed successfully`);
      }
    }
  } catch (error) {
    console.error('Error during document scan:', error);
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check if config exists
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(503).json({ status: 'not_configured' });
    }

    // Check database
    try {
      documentModel.isDocumentProcessed(1);
    } catch (error) {
      return res.status(503).json({ status: 'database_error' });
    }

    // All checks passed
    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'error', message: error.message });
  }
});

// Schedule periodic scanning
cron.schedule(config.scanInterval, () => {
  scanDocuments();
});

// Routes
app.get('/', async (req, res) => {
  try {
    const documents = await paperlessService.getDocuments();
    res.render('index', { documents });
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).send('Error fetching documents');
  }
});

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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Initial scan
  scanDocuments();
});