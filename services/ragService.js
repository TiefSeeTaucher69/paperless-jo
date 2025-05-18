// ragService.js
const axios = require('axios');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');
const paperlessService = require('./paperlessService');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class RAGService extends EventEmitter {
  constructor() {
    super();
    this.searchApiUrl = "http://localhost:8000/search";
    this.aiService = null;
    this.pythonProcess = null;
    this.indexingStatus = {
      running: false,
      complete: false,
      progress: 0,
      lastMessage: ''
    };
    
    // Path to lock file to prevent multiple indexing processes
    this.lockFilePath = path.join(process.cwd(), 'rag_indexing.lock');
    
    // Path to flag file indicating successful indexing completion
    this.completionFlagPath = path.join(process.cwd(), 'indexing_complete.flag');
    
    // Path to documents file and chromadb directory
    this.documentsPath = path.join(process.cwd(), 'documents.json');
    this.chromadbPath = path.join(process.cwd(), 'chromadb');
    
    // Make sure paperlessService is initialized
    paperlessService.initialize();
    
    // Check if indexing was previously completed
    this._checkPreviousIndexingState();
  }
  
  /**
   * Check if indexing was previously completed by examining index files
   * @private
   */
  _checkPreviousIndexingState() {
    try {
      // Check if the completion flag exists
      const flagExists = fs.existsSync(this.completionFlagPath);
      
      // Check if documents.json and chromadb directory exist
      const docsExist = fs.existsSync(this.documentsPath);
      const chromadbExists = fs.existsSync(this.chromadbPath);
      
      // If both the flag and the actual index files exist, consider indexing complete
      if (flagExists && docsExist && chromadbExists) {
        console.log('Found existing valid index files - marking indexing as previously completed');
        this.indexingStatus.complete = true;
      } else if (docsExist && chromadbExists) {
        // If index files exist but no flag, create the flag
        console.log('Found index files but no completion flag - creating flag file');
        fs.writeFileSync(this.completionFlagPath, new Date().toISOString(), 'utf8');
        this.indexingStatus.complete = true;
      } else {
        console.log('No valid index files found - indexing will be required');
        this.indexingStatus.complete = false;
        
        // Clean up flag file if it exists but indexes don't
        if (flagExists) {
          console.log('Removing stale completion flag file');
          fs.unlinkSync(this.completionFlagPath);
        }
      }
    } catch (error) {
      console.error('Error checking previous indexing state:', error);
      this.indexingStatus.complete = false;
    }
  }

  /**
   * Create rag_config.conf file from paperless-ai configuration
   * @returns {Promise<Object>} Result of the operation
   */
  async createRagConfig() {
    const configPath = path.join(process.cwd(), 'rag_config.conf');
    
    // Get sanitized data from config
    const ragConfig = {
      PAPERLESS_URL: config.paperless.apiUrl.replace(/\/api\/?$/, ''),
      PAPERLESS_TOKEN: config.paperless.apiToken,
      // Optional: More configuration values
      EMBEDDING_MODEL_NAME: "paraphrase-multilingual-MiniLM-L12-v2",
      DOCUMENTS_FILE: "./documents.json",
      CHROMADB_DIR: "./chromadb",
      BM25_WEIGHT: 0.3,
      SEMANTIC_WEIGHT: 0.7,
      MAX_RESULTS: 20
    };
    
    // Write config in INI format with section header
    const configContent = `[DEFAULT]\n${Object.entries(ragConfig)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}`;
    
    return new Promise((resolve, reject) => {
      fs.writeFile(configPath, configContent, 'utf8', (err) => {
        if (err) {
          console.error('Error creating rag_config.conf:', err);
          reject(err);
        } else {
          console.log('Created rag_config.conf successfully');
          resolve({ success: true, path: configPath });
        }
      });
    });
  }
  
  /**
   * Start the Python server only (without indexing)
   * @returns {Promise<boolean>} True if successful
   */
  async startPythonServer() {
    // Check if server is already running
    try {
      const status = await this.checkServerStatus(1000);
      if (status.server_running) {
        console.log('Python Server is already running');
        return true;
      }
    } catch (error) {
      console.log('Python Server not running, will start it now');
    }
    
    // Start the Python process
    return new Promise((resolve, reject) => {
      try {
        // Start Python script
        const pythonPath = 'python'; // Or 'python3' depending on system
        this.pythonProcess = spawn(pythonPath, ['main.py']);
        
        // Configure output handling (helps with debugging)
        this.pythonProcess.stdout.on('data', (data) => {
          const output = data.toString().trim();
          console.log('Python output:', output);
          // When we see the "ready" message, we know the server is running
          if (output.includes('RAGZ Document Search API ready')) {
            console.log('Python server is now running');
            resolve(true);
          }
        });
        
        this.pythonProcess.stderr.on('data', (data) => {
          console.log('Python stderr:', data.toString().trim());
        });
        
        // Also start a timer to poll for server availability
        const startTime = Date.now();
        const MAX_WAIT_TIME = 30000; // 30 seconds
        const POLL_INTERVAL = 1000; // 1 second
        
        const checkInterval = setInterval(async () => {
          try {
            // Check if server is responding
            const status = await this.checkServerStatus(1000);
            if (status.server_running) {
              clearInterval(checkInterval);
              resolve(true);
              return;
            }
          } catch (err) {
            // Not ready yet, continue waiting
            if (Date.now() - startTime > MAX_WAIT_TIME) {
              clearInterval(checkInterval);
              if (this.pythonProcess) {
                this.pythonProcess.kill();
                this.pythonProcess = null;
              }
              reject(new Error('Timeout waiting for Python server to start'));
            }
          }
        }, POLL_INTERVAL);
        
        // Handle process exit
        this.pythonProcess.on('close', (code) => {
          clearInterval(checkInterval);
          
          if (code !== 0 && Date.now() - startTime < MAX_WAIT_TIME) {
            console.error(`Python process exited unexpectedly with code ${code}`);
            reject(new Error(`Python process exited with code ${code}`));
          }
        });
        
      } catch (err) {
        reject(err);
      }
    });
  }
  
  /**
   * Check if another indexing process is currently running
   * @returns {boolean} True if locked, false if not
   * @private 
   */
  _isIndexingLocked() {
    try {
      // Check if lock file exists
      if (fs.existsSync(this.lockFilePath)) {
        // Read the lock file to get the timestamp
        const lockData = fs.readFileSync(this.lockFilePath, 'utf8');
        const lockTime = new Date(lockData);
        const currentTime = new Date();
        
        // If lock is older than 10 minutes, consider it stale and remove it
        if (currentTime - lockTime > 10 * 60 * 1000) {
          console.log('Found stale lock file, removing it');
          fs.unlinkSync(this.lockFilePath);
          return false;
        }
        
        // Lock file is recent, indexing is in progress
        return true;
      }
      
      // No lock file found
      return false;
    } catch (error) {
      console.error('Error checking indexing lock:', error);
      return false; // Assume unlocked in case of error
    }
  }
  
  /**
   * Create a lock file to prevent multiple indexing processes
   * @returns {boolean} True if lock was successfully created, false if already locked
   * @private
   */
  _createIndexingLock() {
    try {
      // Check if already locked
      if (this._isIndexingLocked()) {
        console.log('Cannot create lock: indexing is already in progress');
        return false;
      }
      
      // Create lock file with current timestamp
      fs.writeFileSync(this.lockFilePath, new Date().toISOString(), 'utf8');
      console.log('Created indexing lock file');
      return true;
    } catch (error) {
      console.error('Error creating indexing lock:', error);
      return false;
    }
  }
  
  /**
   * Remove the indexing lock file
   * @private
   */
  _releaseIndexingLock() {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
        console.log('Released indexing lock');
      }
    } catch (error) {
      console.error('Error releasing indexing lock:', error);
    }
  }
  
  /**
   * Create a flag file to indicate indexing was successfully completed
   * @private
   */
  _createCompletionFlag() {
    try {
      fs.writeFileSync(this.completionFlagPath, new Date().toISOString(), 'utf8');
      console.log('Created indexing completion flag file');
    } catch (error) {
      console.error('Error creating completion flag:', error);
    }
  }

  /**
   * Start the indexing process (assumes the server is already running)
   * @returns {Promise<Object>} Result of operation 
   */
  async startIndexing() {
    // Check if indexing is already in progress
    if (this._isIndexingLocked()) {
      console.log('Another indexing process is already running');
      return { 
        success: false, 
        message: 'Another indexing process is already running', 
        alreadyRunning: true 
      };
    }
    
    // Create lock to prevent multiple processes
    if (!this._createIndexingLock()) {
      return { 
        success: false, 
        message: 'Failed to acquire indexing lock', 
        alreadyRunning: true 
      };
    }
    
    // Update indexing status
    this.indexingStatus = {
      running: true,
      complete: false,
      progress: 10,
      lastMessage: 'Indexierung wird gestartet...'
    };
    
    // Emit initial progress
    this.emit('indexing-progress', {
      status: 'running',
      progress: this.indexingStatus.progress,
      message: this.indexingStatus.lastMessage
    });
    
    try {
      // We don't need a long timeout here as we're just initiating the process,
      // not waiting for it to complete
      const response = await axios.post('http://localhost:8000/start-indexing', {}, { 
        timeout: 3000
      });
      
      console.log('Indexing started:', response.data);
      this.indexingStatus.lastMessage = 'Indexierung läuft...';
      this.indexingStatus.progress = 20;
      
      // Emit progress update
      this.emit('indexing-progress', {
        status: 'running',
        progress: this.indexingStatus.progress,
        message: this.indexingStatus.lastMessage
      });
      
      // Start polling for progress updates
      this._startIndexingProgressPolling();
      
      return { success: true };
    } catch (error) {
      console.error('Error starting indexing:', error);
      this.indexingStatus.running = false;
      this.indexingStatus.lastMessage = `Fehler bei der Indexierung: ${error.message}`;
      
      this.emit('indexing-error', new Error(`Fehler beim Starten der Indexierung: ${error.message}`));
      throw error;
    }
  }
  
  /**
   * Start polling for indexing progress updates
   * @private
   */
  _startIndexingProgressPolling() {
    if (this._progressInterval) {
      clearInterval(this._progressInterval);
    }
    
    const POLL_INTERVAL = 2000; // 2 seconds
    this._progressInterval = setInterval(async () => {
      try {
        const status = await this.checkRagStatus();
        
        // Update our internal status
        this.indexingStatus.running = status.indexing_in_progress;
        this.indexingStatus.complete = status.indexing_complete;
        
        // Use the exact progress from the API if available
        if (typeof status.progress === 'number') {
          this.indexingStatus.progress = status.progress;
        } else {
          this.indexingStatus.progress = status.indexing_complete ? 100 : 
                                        status.indexing_in_progress ? 50 : 0;
        }
        
        // Create a message that includes progress info
        let message = status.message || '';
        if (status.indexing_in_progress && status.indexed_documents && status.total_documents) {
          message = `Indexierung läuft: ${status.indexed_documents}/${status.total_documents} Dokumente`;
          
          // Add ETA if available
          if (status.eta_formatted) {
            message += ` (ETA: ${status.eta_formatted})`;
          }
        } else if (status.indexing_complete) {
          message = 'Indexierung abgeschlossen';
          if (status.documents_count) {
            message += `: ${status.documents_count} Dokumente indiziert`;
          }
          
          // Create completion flag file when indexing is complete
          this._createCompletionFlag();
          
          // Release the lock file
          this._releaseIndexingLock();
        }
        
        // Emit progress event
        this.emit('indexing-progress', {
          status: status.indexing_complete ? 'complete' : 
                 status.indexing_in_progress ? 'running' : 'waiting',
          progress: this.indexingStatus.progress,
          message: message || (status.indexing_complete ? 'Indexierung abgeschlossen' :
                  status.indexing_in_progress ? 'Indexierung läuft...' : 
                  'Warten auf Indexierung...'),
          eta: status.eta_formatted
        });
        
        // Stop polling when complete
        if (status.indexing_complete) {
          clearInterval(this._progressInterval);
          this._progressInterval = null;
          
          // Final completion event
          this.emit('indexing-complete');
        }
      } catch (error) {
        console.warn('Error polling indexing status:', error);
        
        // Don't stop polling on temporary errors
      }
    }, POLL_INTERVAL);
  }
  
  /**
   * Start the Python RAG indexing process (combined server start and indexing)
   * @returns {Promise<Object>} Result of the operation
   */
  async startPythonProcess() {
    // Step 1: Make sure Python server is running
    try {
      await this.startPythonServer();
    } catch (error) {
      console.error('Failed to start Python server:', error);
      this.emit('indexing-error', new Error(`Fehler beim Starten des Python-Servers: ${error.message}`));
      throw error;
    }
    
    // Step 2: Start indexing process
    try {
      return await this.startIndexing();
    } catch (error) {
      console.error('Failed to start indexing:', error);
      throw error;
    }
  }
  
  /**
   * Check if server is running (faster check than full status)
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<Object>} Status object with server_running flag
   * @private
   */
  async checkServerStatus(timeout = 2000) {
    try {
      await axios.get('http://localhost:8000/status', { timeout });
      return { server_running: true };
    } catch (error) {
      // If we get a response but with error, server is still running
      if (error.response) {
        return { server_running: true, error: error.message };
      }
      // Otherwise server is not running
      return { server_running: false };
    }
  }
  
  /**
   * Count the number of documents in the documents.json file
   * @returns {number} Number of documents or 0 if file doesn't exist
   * @private
   */
  _countDocumentsInFile() {
    try {
      if (fs.existsSync(this.documentsPath)) {
        const content = fs.readFileSync(this.documentsPath, 'utf8');
        const documents = JSON.parse(content);
        return Array.isArray(documents) ? documents.length : 0;
      }
      return 0;
    } catch (error) {
      console.error('Error counting documents in file:', error);
      return 0;
    }
  }

  /**
   * Check the current status of RAG indexing
   * @returns {Promise<Object>} Current status information
   */
  async checkRagStatus() {
    try {
      // First check if we have valid index files, regardless of server status
      const docsExist = fs.existsSync(this.documentsPath);
      const chromadbExists = fs.existsSync(this.chromadbPath);
      const flagExists = fs.existsSync(this.completionFlagPath);
      
      // Check if indexing is currently locked by another process
      const isLocked = this._isIndexingLocked();
      
      // First do a basic connection check
      const serverStatus = await this.checkServerStatus();
      if (!serverStatus.server_running) {
        // Even if server isn't running, if we have valid index files, report them
        if (docsExist && chromadbExists && flagExists) {
          return {
            running: false,
            complete: true,
            progress: 100,
            message: 'Indexierung bereits abgeschlossen. Server nicht gestartet.',
            server_running: false,
            indexing_in_progress: false,
            indexing_complete: true,
            idle: true,
            documents_loaded: true,
            documents_count: this._countDocumentsInFile()
          };
        }
        
        // If indexing is locked by another process
        if (isLocked) {
          return {
            running: true,
            complete: false,
            progress: 20,
            message: 'Indexierung läuft in einem anderen Prozess',
            server_running: false,
            indexing_in_progress: true,
            indexing_complete: false,
            idle: false,
            locked_by_another_process: true
          };
        }
        
        return {
          running: false,
          complete: false,
          progress: 0,
          message: 'Python-Server nicht gestartet',
          server_running: false,
          indexing_in_progress: false,
          indexing_complete: false,
          idle: true
        };
      }
      
      try {
        // Get status from API
        const response = await axios.get('http://localhost:8000/status', { timeout: 2000 });
        const statusData = response.data;
        
        // Map API status to our format for backward compatibility
        const mappedStatus = {
          running: statusData.indexing_in_progress,
          complete: statusData.indexing_complete,
          server_running: true,
          indexing_in_progress: statusData.indexing_in_progress,
          indexing_complete: statusData.indexing_complete,
          idle: statusData.idle !== undefined ? statusData.idle : !statusData.indexing_in_progress,
          // Directly pass through all the detailed information from the API
          ...statusData
        };
        
        // Add human-readable message based on status
        if (statusData.indexing_complete) {
          mappedStatus.message = 'Indexierung abgeschlossen';
          if (statusData.documents_count) {
            mappedStatus.message += `: ${statusData.documents_count} Dokumente indiziert`;
          }
        } else if (statusData.indexing_in_progress) {
          mappedStatus.message = `Indexierung läuft: ${statusData.indexed_documents || 0}/${statusData.total_documents || '?'} Dokumente`;
        } else if (statusData.documents_loaded) {
          mappedStatus.message = `${statusData.documents_count || 0} Dokumente geladen`;
        } else {
          mappedStatus.message = 'Indexierung erforderlich';
        }
        
        return mappedStatus;
      } catch (error) {
        console.error('Error checking RAG status:', error);
        
        // API not reachable or error
        return {
          running: false,
          complete: false,
          progress: 0,
          message: 'Fehler bei Statusabfrage',
          server_running: true,
          indexing_in_progress: false,
          indexing_complete: false,
          idle: true,
          error: error.message
        };
      }
    } catch (error) {
      console.error('Error checking RAG status:', error);
      throw error;
    }
  }
  
  /**
   * Initialize or get the AI service
   * @returns {Object} The initialized AI service
   */
  initialize() {
    if (!this.aiService) {
      this.aiService = AIServiceFactory.getService();
      
      // If the service has an initialize method, call it
      if (typeof this.aiService.initialize === 'function') {
        this.aiService.initialize();
      }
    }
    return this.aiService;
  }

  /**
   * Search for documents relevant to a query
   * @param {string} query - The search query
   * @param {Object} options - Optional search parameters
   * @param {string} options.from_date - Filter by start date (YYYY-MM-DD)
   * @param {string} options.to_date - Filter by end date (YYYY-MM-DD)
   * @param {string} options.correspondent - Filter by correspondent name
   * @returns {Promise<Array>} - Array of matching documents
   */
  async searchDocuments(query, options = {}) {
    try {
      const requestBody = {
        query: query,
        ...options
      };

      const response = await axios.post(this.searchApiUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      return response.data;
    } catch (error) {
      console.error("Error searching documents:", error.message);
      throw new Error(`Failed to search documents: ${error.message}`);
    }
  }

  /**
   * Generate an AI answer based on the provided question and documents
   * @param {string} question - The user's question
   * @param {Array} documents - Array of relevant documents
   * @returns {Promise<string>} - The AI-generated answer
   */
  async generateAnswerFromDocuments(question, documents, options = {}) {
    try {
      if (!documents || documents.length === 0) {
        return {
          answer: "No relevant documents found to answer your question.",
          sources: []
        };
      }

      // Debug: Log documents used for context
      console.log("\n[DEBUG] RAG SERVICE - DOCUMENT CONTEXT");
      console.log("========================================");
      console.log(`Question: "${question}"`);
      console.log(`Number of documents: ${documents.length}`);
      
      // Prepare context from documents with full content
      const context = await Promise.all(documents.map(async (doc, index) => {
        // Debug: Log each document's details
        console.log(`\n[Document ${index + 1}] ID: ${doc.doc_id}`);
        console.log(`Title: "${doc.title}"`);
        console.log(`Correspondent: ${doc.correspondent}`);
        console.log(`Date: ${doc.date}`);
        console.log(`Relevance Score: ${doc.score.toFixed(2)}`);
        console.log(`Cross Score: ${doc.cross_score.toFixed(2)}`);
        console.log(`Snippet: "${doc.snippet.substring(0, 500)}${doc.snippet.length > 500 ? '...' : ''}"`);
        
        // Fetch full document content if available
        let fullContent = "";
        try {
          console.log(`[DEBUG] Fetching full content for document ID: ${doc.doc_id}`);
          fullContent = await paperlessService.getDocumentContent(doc.doc_id);
          
          if (fullContent) {
            // Truncate for debug log only
            const contentPreview = fullContent.substring(0, 300);
            console.log(`[DEBUG] Full content retrieved (${fullContent.length} chars). Preview: "${contentPreview}..."`);
          } else {
            console.log(`[DEBUG] No full content found, using snippet only`);
          }
        } catch (error) {
          console.error(`[ERROR] Failed to get full content for document ${doc.doc_id}: ${error.message}`);
          console.log('[DEBUG] Will proceed with snippet only');
        }
        
        // Use full content if available, otherwise fall back to snippet
        const contentToUse = fullContent || doc.snippet;
        
        return `Document ${index + 1}: "${doc.title}" (${doc.correspondent}, ${doc.date})
Content: ${contentToUse}`;
      }));
      
      // Join all document contexts with double line breaks
      const fullContext = context.join("\n\n");

      // Get the language to use for the response (defaults to matching the question language)
      const language = options.language || 'en';
      
      // Create instruction text based on language
      let languageInstruction = '';
      switch (language) {
        case 'de':
          languageInstruction = 'WICHTIG: Antworte auf Deutsch.';
          break;
        case 'fr':
          languageInstruction = 'IMPORTANT: Répondez en français.';
          break;
        case 'es':
          languageInstruction = 'IMPORTANTE: Responde en español.';
          break;
        default: // English or other languages
          languageInstruction = 'IMPORTANT: Answer in the same language as the question.';
      }

      // Create prompt for the AI
      const prompt = `Answer the following question based ONLY on the information provided in these documents:

Question: ${question}

Context Documents:
${fullContext}

${languageInstruction}
Please provide a comprehensive answer citing the specific documents used. If the information to answer the question is not contained in the documents, state that clearly.`;

      // Debug log the full prompt
      console.log("\n[DEBUG] RAG SERVICE - PROMPT INFORMATION");
      console.log("=========================================");
      console.log(`Full prompt length: ${prompt.length} characters`);
      if (prompt.length > 1000) {
        console.log(`Prompt (trimmed): ${prompt.substring(0, 500)}...${prompt.substring(prompt.length - 500)}`);
      } else {
        console.log(`Full prompt: ${prompt}`);
      }

      // Create a custom system prompt specifically for RAG
      const ragSystemPrompt = `You are a document-based question answering assistant.
I will provide you with a user question and document context. Analyze the documents and create a detailed answer to the question based ONLY on the information in these documents.

IMPORTANT RULES:
1. ONLY use information from the provided documents
2. DO NOT use any prior knowledge or information not in the provided documents
3. If the documents do not contain the information needed, state that clearly
4. When referencing information, cite which document it came from (e.g., "According to Document 1...")
5. Provide a comprehensive, accurate answer directly addressing the question

FORMAT YOUR RESPONSE AS A SIMPLE TEXT ANSWER, NOT JSON.
Do not include any JSON formatting, tags, or field names like "title," "correspondent," etc.
Just write a clear, direct answer in plain text.

This overrides any previous instructions about JSON formatting. DO NOT return JSON - only return the text of your answer.`;

      // Initialize the AI service
      const aiService = this.initialize();
      
      // Different handling based on AI provider type
      let response;
      const aiProvider = config.aiProvider;
      
      if (aiProvider === 'openai' || aiProvider === 'azure' || aiProvider === 'custom') {
        // These providers use the OpenAI client format
        if (!aiService.client) {
          throw new Error('AI client not initialized');
        }
        
        // Create messages for AI completion
        const messages = [
          {
            role: "system",
            content: ragSystemPrompt
          },
          {
            role: "user",
            content: question + "\n\n" + fullContext
          }
        ];
        
        // Call AI service directly with OpenAI client
        response = await aiService.client.chat.completions.create({
          model: process.env.OPENAI_MODEL || config.ollama.model,
          messages: messages,
          temperature: 0.3,
        });
      } else if (aiProvider === 'ollama') {
        // Ollama uses a different API format
        response = await aiService.client.post(`${config.ollama.apiUrl}/api/generate`, {
          model: config.ollama.model,
          prompt: question + "\n\n" + fullContext,
          system: ragSystemPrompt,
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 1024
          }
        });
        
        // Transform Ollama response to match OpenAI format
        if (response.data) {
          response = {
            model: config.ollama.model,
            choices: [{
              message: {
                content: response.data.response
              }
            }]
          };
        }
      } else {
        throw new Error(`Unsupported AI provider: ${aiProvider}`);
      }
      
      // Debug log the AI response
      console.log("\n[DEBUG] RAG SERVICE - AI RESPONSE");
      console.log("=================================");
      console.log(`Model used: ${response.model || 'Unknown'}`);
      if (response.usage) {
        console.log(`Tokens used: ${response.usage.total_tokens} (Prompt: ${response.usage.prompt_tokens}, Completion: ${response.usage.completion_tokens})`);
      }
      
      // Extract the answer from the result
      let answer = "Unable to generate an answer from the documents.";
      
      if (response?.choices?.[0]?.message?.content) {
        answer = response.choices[0].message.content.trim();
        
        // Log a preview of the response content
        console.log(`\nResponse content (first 500 chars):\n${answer.substring(0, 500)}${answer.length > 500 ? '...' : ''}`);
        
        // Log if the response contains specific phrases indicating "no information"
        const noInfoPhrases = [
          "cannot answer", "cannot provide", "don't have enough information",
          "keine Informationen", "cannot find", "not contained", "not mentioned",
          "not specified", "not provided", "not included", "not found", "no specific"
        ];
        
        const containsNoInfoPhrase = noInfoPhrases.some(phrase => 
          answer.toLowerCase().includes(phrase.toLowerCase())
        );
        
        if (containsNoInfoPhrase) {
          console.log("\n[WARNING] Response indicates no information found, but documents might contain relevant info.");
          console.log("Consider reviewing the full document content beyond the snippets.");
        }
      }
      
      return {
        answer,
        sources: documents
      };
    } catch (error) {
      console.error("Error generating answer:", error.message);
      throw new Error(`Failed to generate answer: ${error.message}`);
    }
  }

  /**
   * Main function to ask a question and get an answer with sources
   * @param {string} question - The user's question
   * @param {Object} options - Optional search parameters
   * @returns {Promise<Object>} - Object containing answer and source documents
   */
  async askQuestion(question, options = {}) {
    try {
      // Search for relevant documents
      const documents = await this.searchDocuments(question, options);
      
      // Log the total number of matching documents before filtering
      console.log(`\n[DEBUG] RAG SERVICE - SEARCH RESULTS`);
      console.log(`Total matching documents: ${documents.length}`);
      
      // Get top 3 documents based on score
      const topDocuments = documents
        .sort((a, b) => (b.score + b.cross_score) - (a.score + a.cross_score))
        .slice(0, 3);
      
      // Generate answer from documents, passing the options including language
      const result = await this.generateAnswerFromDocuments(question, topDocuments, options);
      
      // If the response indicates no information was found but we have more documents
      if (
        result.answer.toLowerCase().includes("keine information") || 
        result.answer.toLowerCase().includes("not contained") ||
        result.answer.toLowerCase().includes("not mentioned") ||
        result.answer.toLowerCase().includes("not enough information") ||
        result.answer.toLowerCase().includes("nicht genügend")
      ) {
        console.log("\n[DEBUG] RAG SERVICE - POSSIBLE INFORMATION GAP");
        console.log("AI indicates no information found, but there may be more relevant documents available.");
        console.log(`Total available documents: ${documents.length}, Used: ${topDocuments.length}`);
        
        if (documents.length > topDocuments.length) {
          console.log("Consider retrieving more content from the original documents or increasing snippet size.");
          console.log("Document IDs to check: " + documents.slice(0, Math.min(5, documents.length))
            .map(doc => `${doc.doc_id} (${doc.title.substring(0, 30)}...)`)
            .join(", "));
        }
      }
      
      return result;
    } catch (error) {
      console.error("Error in RAG process:", error.message);
      throw new Error(`RAG process failed: ${error.message}`);
    }
  }
}

module.exports = new RAGService();
