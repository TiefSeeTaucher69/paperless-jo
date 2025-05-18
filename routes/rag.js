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
        // First check if we have valid index files and if an indexing process is already running
        // This is done by calling checkRagStatus which now checks for existing index files 
        // and lock files regardless of whether the server is running
        const initialStatus = await ragService.checkRagStatus();

        // If indexing is already complete or in progress in another process, return that status
        if (initialStatus.indexing_complete || initialStatus.locked_by_another_process) {
            console.log('Indexing already complete or in progress, returning status without starting server');
            return res.json(initialStatus);
        }
        
        // If the server isn't running but we have a previous valid index, we don't need to start it
        // just to check status - checkRagStatus already handled this case
        if (!initialStatus.server_running) {
            // If we have valid index files, don't auto-start the server
            if (initialStatus.complete) {
                console.log('Valid index exists, returning status without starting server');
                return res.json(initialStatus);
            }
            
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
        
        // Check if indexing is already in progress in another process
        if (!force && !serverOnly) {
            const currentStatus = await ragService.checkRagStatus();
            
            // If indexing is already in progress in another process, inform the client
            if (currentStatus.locked_by_another_process) {
                if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
                    // If SSE requested, setup headers and send status
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    
                    res.write(`data: ${JSON.stringify({ 
                        status: 'running',
                        progress: 20,
                        message: 'Indexierung läuft bereits in einem anderen Prozess' 
                    })}\n\n`);
                    
                    // Set up a polling interval to keep client updated
                    const pollInterval = setInterval(async () => {
                        try {
                            const status = await ragService.checkRagStatus();
                            
                            // Send updates
                            res.write(`data: ${JSON.stringify({ 
                                status: status.indexing_complete ? 'complete' : 'running',
                                progress: status.progress || 50,
                                message: status.message || 'Indexierung läuft...'
                            })}\n\n`);
                            
                            // If complete, end the connection
                            if (status.indexing_complete) {
                                clearInterval(pollInterval);
                                res.write(`data: ${JSON.stringify({ 
                                    status: 'complete',
                                    progress: 100,
                                    message: 'Indexierung abgeschlossen!'
                                })}\n\n`);
                                res.write('data: [DONE]\n\n');
                                res.end();
                            }
                        } catch (error) {
                            console.error('Error polling status:', error);
                        }
                    }, 2000);
                    
                    // Clean up on client disconnect
                    req.on('close', () => {
                        clearInterval(pollInterval);
                    });
                    
                    return;
                } else {
                    // Just return JSON response
                    return res.json({
                        status: 'running',
                        message: 'Indexierung läuft bereits in einem anderen Prozess',
                        alreadyRunning: true
                    });
                }
            }
            
            // If indexing is complete and we're not forcing a reindex, let the client know
            if (currentStatus.indexing_complete && !force) {
                if (!req.headers.accept || !req.headers.accept.includes('text/event-stream')) {
                    return res.json({
                        status: 'complete',
                        message: 'Indexierung bereits abgeschlossen',
                        alreadyComplete: true
                    });
                }
            }
        }
        
        // If force is true, try to delete existing index files
        if (force) {
            try {
                // Make sure to release any existing locks first
                if (fs.existsSync(path.join(process.cwd(), 'rag_indexing.lock'))) {
                    fs.unlinkSync(path.join(process.cwd(), 'rag_indexing.lock'));
                    console.log('Removed indexing lock for forced reindexing');
                }
                
                // Remove completion flag
                if (fs.existsSync(path.join(process.cwd(), 'indexing_complete.flag'))) {
                    fs.unlinkSync(path.join(process.cwd(), 'indexing_complete.flag'));
                    console.log('Removed completion flag for forced reindexing');
                }
                
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
        
        // First check if we have valid index files
        const flagExists = fs.existsSync(path.join(process.cwd(), 'indexing_complete.flag'));
        const docsExist = fs.existsSync(path.join(process.cwd(), 'documents.json'));
        const chromadbExists = fs.existsSync(path.join(process.cwd(), 'chromadb')) && 
                              fs.statSync(path.join(process.cwd(), 'chromadb')).isDirectory();
        
        // We ALWAYS need to check if the server is running and start it if needed
        // Even if we have valid index files, we still need the server for search
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
        
        // If we have valid index files, we don't need to perform indexing
        // But we still need to make sure server is running (which we did above)
        if (flagExists && docsExist && chromadbExists) {
            console.log('Found valid index files - no need for indexing');
        } else {
            // If we don't have valid index files, check if indexing is needed
            const status = await ragService.checkRagStatus();
            if (!status.complete && !status.indexing_complete) {
                return res.status(400).json({ 
                    error: 'Indexierung erforderlich. Bitte starten Sie zuerst die Indexierung.' 
                });
            }
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
