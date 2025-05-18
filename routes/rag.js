// routes/rag.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const ragService = require('../services/ragService');
const { isAuthenticated } = require('./auth');
const config = require('../config/config.js');

/**
 * GET /rag
 * Render RAG view
 */
router.get('/', isAuthenticated, (req, res) => {
    const version = config.PAPERLESS_AI_VERSION || ' ';
    res.render('rag', {
        title: 'RAG Assistant',
        version: version
    });
});

/**
 * GET /rag/status
 * Check if RAG indexing is running or complete
 */
router.get('/status', isAuthenticated, async (req, res) => {
    try {
        // First, check if we need to start the Python server (but not indexing)
        const serverStatus = await ragService.checkServerStatus();
        if (!serverStatus.server_running) {
            try {
                // First create the config file
                await ragService.createRagConfig();
                
                // Then start just the server without indexing
                await ragService.startPythonServer();
                console.log('Started Python server for status check');
            } catch (err) {
                console.warn('Failed to auto-start Python server:', err);
                // Continue anyway to return current status
            }
        }
        
        // Now get the full status
        const status = await ragService.checkRagStatus();
        res.json(status);
    } catch (error) {
        console.error('Error checking RAG status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /rag/start-indexing
 * Start either just the Python server or the server and indexing
 */
router.post('/start-indexing', isAuthenticated, async (req, res) => {
    try {
        // Get query parameters
        const serverOnly = req.query.serverOnly === 'true';
        const force = req.query.force === 'true';
        
        // If force is true, try to delete existing index files
        if (force) {
            try {
                // Delete documents.json and chromadb directory if they exist
                const docsPath = path.join(process.cwd(), 'documents.json');
                const chromaPath = path.join(process.cwd(), 'chromadb');
                
                if (fs.existsSync(docsPath)) {
                    fs.unlinkSync(docsPath);
                    console.log('Deleted documents.json for forced reindexing');
                }
                
                if (fs.existsSync(chromaPath)) {
                    // Use rimraf to delete directory with contents
                    // For v4+ we need to import it differently
                    const rimraf = require('rimraf');
                    await rimraf(chromaPath);
                    console.log('Deleted chromadb directory for forced reindexing');
                }
                
                // If it's just a force request with no SSE/indexing, return success
                if (!req.headers.accept || !req.headers.accept.includes('text/event-stream')) {
                    return res.json({
                        status: 'success',
                        message: 'Index-Dateien gelöscht. Neuindexierung kann jetzt gestartet werden.'
                    });
                }
            } catch (error) {
                console.error('Error deleting index files:', error);
                // Continue anyway, as the Python process might handle missing files gracefully
            }
        }
        
        // Step 1: Create rag_config.conf from configuration
        await ragService.createRagConfig();
        
        // Check if server is already running
        const serverStatus = await ragService.checkServerStatus();
        
        // Step 2: Start server if needed, or full process with indexing
        if (!serverStatus.server_running) {
            try {
                // Just start the Python server
                await ragService.startPythonServer();
                
                // If user only wanted to start the server, we're done
                if (serverOnly) {
                    return res.json({
                        status: 'success',
                        message: 'Python-Server erfolgreich gestartet'
                    });
                }
            } catch (error) {
                console.error('Failed to start Python server:', error);
                return res.status(500).json({ 
                    error: `Failed to start Python server: ${error.message}` 
                });
            }
        } else if (serverOnly) {
            // Server already running and that's all user wanted
            return res.json({
                status: 'success',
                message: 'Python-Server läuft bereits'
            });
        }
        
        // If we get here, we need to start the indexing process
        if (!serverOnly) {
            await ragService.startIndexing();
        }
        
        // Setup SSE for progress updates
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Send initial status
        res.write(`data: ${JSON.stringify({ 
            status: 'starting', 
            progress: 0,
            message: 'Python-Prozess wird gestartet...' 
        })}\n\n`);
        
        // Setup event listeners for process output
        ragService.on('indexing-progress', (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        });
        
        // Event for completion
        ragService.on('indexing-complete', () => {
            res.write(`data: ${JSON.stringify({ 
                status: 'complete', 
                progress: 100,
                message: 'Indexierung abgeschlossen!' 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        });
        
        // Event for errors
        ragService.on('indexing-error', (error) => {
            res.write(`data: ${JSON.stringify({ 
                status: 'error', 
                message: `Fehler: ${error.message}` 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        });
        
    } catch (error) {
        console.error('Error starting RAG indexing:', error);
        
        // If headers aren't sent yet, send error as JSON
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            // Otherwise send through SSE
            res.write(`data: ${JSON.stringify({ 
                status: 'error', 
                message: `Fehler: ${error.message}` 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

/**
 * POST /rag/ask
 * Process a question using RAG and return answer with sources
 */
router.post('/ask', isAuthenticated, async (req, res) => {
    try {
        const { question, filters } = req.body;
        
        if (!question || typeof question !== 'string') {
            return res.status(400).json({ error: 'Question is required' });
        }
        
        // First, ensure Python server is running
        const serverStatus = await ragService.checkServerStatus();
        if (!serverStatus.server_running) {
            try {
                // Create config file if needed
                await ragService.createRagConfig();
                
                // Start just the server (no indexing)
                await ragService.startPythonServer();
                console.log('Started Python server for question processing');
            } catch (err) {
                console.error('Could not start Python server:', err);
                return res.status(500).json({ 
                    error: 'Failed to start Python server: ' + err.message 
                });
            }
        }
        
        // Then check if we need indexing
        const status = await ragService.checkRagStatus();
        if (!status.complete) {
            return res.status(400).json({ 
                error: 'Indexierung erforderlich. Bitte starten Sie zuerst die Indexierung.' 
            });
        }
        
        // Pass detected language to the prompt if available
        const questionLanguage = filters && filters.language ? filters.language : null;
        
        // Set up SSE 
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Prepare loading message based on language
        let loadingMessage = "Searching relevant documents...";
        if (questionLanguage === 'de') {
            loadingMessage = "Suche relevante Dokumente...";
        } else if (questionLanguage === 'fr') {
            loadingMessage = "Recherche de documents pertinents...";
        } else if (questionLanguage === 'es') {
            loadingMessage = "Buscando documentos relevantes...";
        }
        
        // Tell client we're starting to search with appropriate language
        res.write(`data: ${JSON.stringify({ content: loadingMessage + "\n\n" })}\n\n`);
        
        // Search for documents using RAG service
        let result;
        try {
            result = await ragService.askQuestion(question, filters);
        } catch (error) {
            // Send error message
            res.write(`data: ${JSON.stringify({ 
                content: `Error searching documents: ${error.message}` 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        
        // If no documents found or no answer
        if (!result || !result.answer) {
            res.write(`data: ${JSON.stringify({ 
                content: "I couldn't find any relevant documents to answer your question." 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        
        // Stream the answer
        const answer = result.answer;
        const sources = result.sources;
        
        // If the answer is short, send it all at once
        if (answer.length < 1000) {
            res.write(`data: ${JSON.stringify({ 
                content: answer,
                sources: sources
            })}\n\n`);
        } else {
            // For longer answers, simulate streaming by sending chunks
            const chunkSize = 30;
            const words = answer.split(' ');
            
            for (let i = 0; i < words.length; i += chunkSize) {
                const chunk = words.slice(i, i + chunkSize).join(' ');
                res.write(`data: ${JSON.stringify({ content: chunk + ' ' })}\n\n`);
                
                // Small delay to simulate typing and prevent browser buffering
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // At the end, also send the sources
            res.write(`data: ${JSON.stringify({ sources: sources })}\n\n`);
        }
        
        // Signal that we're done
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('Error in RAG processing:', error);
        
        // Try to respond if headers haven't been sent
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Failed to process question' });
        } else {
            // Send error through SSE
            res.write(`data: ${JSON.stringify({ 
                content: `An error occurred: ${error.message}` 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

module.exports = router;
