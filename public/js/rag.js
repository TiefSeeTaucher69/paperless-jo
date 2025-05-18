// Initialize marked with options for code highlighting
marked.setOptions({
    highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true
});

// Load saved theme on page load
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    setupTextareaAutoResize();
    
    // Clear initial state if there's chat history
    if (document.getElementById('chatHistory').children.length > 0) {
        document.getElementById('initialState').classList.add('hidden');
    }
    
    // Check RAG service status
    checkRagStatus();
    
    // Setup indexing buttons
    const startIndexingButton = document.getElementById('startIndexingButton');
    if (startIndexingButton) {
        startIndexingButton.addEventListener('click', startIndexing);
    }
    
    // Setup force reindex button
    const forceReindexButton = document.getElementById('forceReindexButton');
    if (forceReindexButton) {
        forceReindexButton.addEventListener('click', async () => {
            try {
                // Confirm with user
                if (!confirm('Sind Sie sicher, dass Sie eine Neuindexierung erzwingen möchten? Dies löscht alle vorhandenen Indizes.')) {
                    return;
                }
                
                // First try to delete existing index files via a special endpoint
                await fetch('/rag/start-indexing?force=true', {
                    method: 'POST'
                });
                
                // Then start normal indexing
                startIndexing();
            } catch (error) {
                console.error('Error forcing reindex:', error);
                alert('Fehler beim Erzwingen der Neuindexierung: ' + error.message);
            }
        });
    }
});

// Check RAG service status
async function checkRagStatus() {
    try {
        const response = await fetch('/rag/status');
        if (!response.ok) {
            throw new Error('Could not check RAG status');
        }
        
        const status = await response.json();
        updateIndexingUI(status);
        
        // Start polling if indexing is in progress
        if (status.running && !window.statusCheckInterval) {
            startStatusPolling();
        }
    } catch (error) {
        console.error('Error checking RAG status:', error);
        // Show setup section if we couldn't check status (service might not be running)
        document.getElementById('ragSetupSection').style.display = 'block';
        document.getElementById('initialState').style.display = 'none';
    }
}

// Start polling for status updates
function startStatusPolling() {
    if (window.statusCheckInterval) {
        clearInterval(window.statusCheckInterval);
    }
    
    window.statusCheckInterval = setInterval(async () => {
        try {
            const response = await fetch('/rag/status');
            if (!response.ok) {
                throw new Error('Could not check RAG status');
            }
            
            const status = await response.json();
            updateIndexingUI(status);
            
            // Stop polling when indexing is complete
            if (status.complete) {
                clearInterval(window.statusCheckInterval);
                window.statusCheckInterval = null;
            }
        } catch (error) {
            console.error('Error polling RAG status:', error);
            clearInterval(window.statusCheckInterval);
            window.statusCheckInterval = null;
        }
    }, 2000); // Check every 2 seconds
}

// Update UI based on indexing status
function updateIndexingUI(status) {
    const setupSection = document.getElementById('ragSetupSection');
    const statusIndicator = document.getElementById('indexingStatus');
    const statusText = document.getElementById('indexingStatusText');
    const progressBar = document.getElementById('indexingProgress').querySelector('.progress-fill');
    const startButton = document.getElementById('startIndexingButton');
    const initialState = document.getElementById('initialState');
    
    // Debug information
    console.log('RAG Status:', status);
    
    // Always ensure button exists and is correctly styled
    if (startButton) {
        startButton.innerHTML = '<i class="fas fa-sync"></i> ' + (status.server_running === false ? 'Python-Server starten' : 'Indexierung starten');
        startButton.style.display = 'flex'; // Ensure button is visible by default
    } else {
        console.error('Start button not found in DOM');
    }
    
    // Get reference to forceReindexButton (it's now in the HTML)
    const forceReindexButton = document.getElementById('forceReindexButton');
    
    // Always ensure setup section is visible first
    setupSection.style.display = 'block';
    initialState.style.display = 'none';
    
    // Process status
    if (status.indexing_in_progress) {
        // Show progress for running indexing
        statusIndicator.style.display = 'flex';
        
        // Hide buttons during indexing
        if (startButton) startButton.style.display = 'none';
        if (forceReindexButton) forceReindexButton.style.display = 'none';
        
        // Create a detailed status message
        let message = 'Indexierung läuft...';
        
        // If we have document counts, show them
        if (status.indexed_documents !== undefined && status.total_documents) {
            message = `Indexierung läuft: ${status.indexed_documents}/${status.total_documents} Dokumente`;
            
            // Add ETA if available
            if (status.eta_formatted) {
                message += ` (ETA: ${status.eta_formatted})`;
            }
        }
        
        statusText.textContent = message;
        
        // Set progress percentage
        const progressPercent = typeof status.progress === 'number' ? status.progress : 50;
        progressBar.style.width = `${progressPercent}%`;
    } else if (status.indexing_complete) {
        // For complete status, show chat interface but keep reindex button
        initialState.style.display = 'block';
        
        // Keep setup section visible, but with a different message
        const sectionText = setupSection.querySelector('p');
        if (sectionText) {
            let message = 'Indexierung abgeschlossen.';
            if (status.documents_count) {
                message += ` ${status.documents_count} Dokumente sind indexiert.`;
            }
            message += ' Sie können den RAG-Chat nutzen oder bei Bedarf eine Neuindexierung starten.';
            sectionText.textContent = message;
        }
        
        // Show the button for reindexing, hide progress
        statusIndicator.style.display = 'none';
        if (startButton) startButton.style.display = 'flex';
        if (forceReindexButton) forceReindexButton.style.display = 'flex';
        
        // Stop any active polling
        if (window.statusCheckInterval) {
            clearInterval(window.statusCheckInterval);
            window.statusCheckInterval = null;
        }
    } else {
        // Show setup UI for server not running or indexing needed
        initialState.style.display = 'none';
        statusIndicator.style.display = 'none';
        
        if (startButton) startButton.style.display = 'flex';
        if (forceReindexButton) forceReindexButton.style.display = 'flex';
        
        // Update text based on server status
        const sectionText = setupSection.querySelector('p');
        if (sectionText) {
            if (status.server_running === false) {
                sectionText.textContent = 'Der Python-Server muss gestartet werden, bevor Dokumente indiziert werden können.';
            } else {
                sectionText.textContent = 'Der RAG-Service muss initialisiert werden, um Ihre Dokumente zu indizieren.';
            }
        }
    }
}

// Start indexing process
async function startIndexing() {
    try {
        const statusIndicator = document.getElementById('indexingStatus');
        const statusText = document.getElementById('indexingStatusText');
        const progressBar = document.getElementById('indexingProgress').querySelector('.progress-fill');
        const startButton = document.getElementById('startIndexingButton');
        const forceReindexButton = document.getElementById('forceReindexButton');
        
        // Update UI
        statusIndicator.style.display = 'flex';
        startButton.style.display = 'none';
        if (forceReindexButton) forceReindexButton.style.display = 'none';
        statusText.textContent = 'Python-Dienst wird gestartet...';
        progressBar.style.width = '5%';
        
        // Send request to start indexing
        const response = await fetch('/rag/start-indexing', {
            method: 'POST'
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to start indexing');
        }
        
        // Check if indexing is already running in another process or already complete
        const data = await response.json().catch(() => null);
        if (data) {
            if (data.alreadyRunning) {
                console.log('Indexing already running in another process');
                statusText.textContent = 'Indexierung läuft bereits in einem anderen Prozess';
                progressBar.style.width = '20%';
                
                // Show the initial state and start polling for updates
                startStatusPolling();
                return;
            } else if (data.alreadyComplete) {
                console.log('Indexing already complete');
                statusText.textContent = 'Indexierung bereits abgeschlossen';
                progressBar.style.width = '100%';
                
                // Show completion state
                setTimeout(() => {
                    document.getElementById('ragSetupSection').style.display = 'none';
                    document.getElementById('initialState').style.display = 'block';
                    if (startButton) startButton.style.display = 'flex';
                    if (forceReindexButton) forceReindexButton.style.display = 'flex';
                    statusIndicator.style.display = 'none';
                }, 2000);
                
                return;
            }
        }
        
        // If no special condition detected, start polling for status updates
        startStatusPolling();
        
        // Set up SSE for progress updates
        const sseResponse = await fetch('/rag/start-indexing', {
            method: 'POST',
            headers: {
                'Accept': 'text/event-stream'
            }
        });
        
        if (!sseResponse.ok) return; // Already started, just use polling
        
        const reader = sseResponse.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const text = decoder.decode(value);
            const lines = text.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    
                    try {
                        const parsed = JSON.parse(data);
                        
                        // Update UI
                        statusText.textContent = parsed.message || 'Indexierung läuft...';
                        if (parsed.progress) {
                            progressBar.style.width = `${parsed.progress}%`;
                        }
                        
                        // On completion
                        if (parsed.status === 'complete') {
                            setTimeout(() => {
                                document.getElementById('ragSetupSection').style.display = 'none';
                                document.getElementById('initialState').style.display = 'block';
                            }, 2000);
                            
                            // Stop polling
                            if (window.statusCheckInterval) {
                                clearInterval(window.statusCheckInterval);
                                window.statusCheckInterval = null;
                            }
                        } else if (parsed.status === 'error') {
                            statusIndicator.classList.add('error');
                            startButton.style.display = 'flex';
                            
                            // Stop polling
                            if (window.statusCheckInterval) {
                                clearInterval(window.statusCheckInterval);
                                window.statusCheckInterval = null;
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing SSE data:', e);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error starting indexing:', error);
        alert('Fehler beim Starten der Indexierung: ' + error.message);
        
        // Reset UI
        document.getElementById('indexingStatus').style.display = 'none';
        document.getElementById('startIndexingButton').style.display = 'flex';
    }
}


async function sendQuestion(question) {
    try {
                
        // Detect question language to ensure response is in the same language
        const questionLanguage = detectLanguage(question);
        
        // Show user message immediately
        addMessage(question, true);
        
        // Create loading message with enhanced animation
        const containerDiv = document.createElement('div');
        containerDiv.className = 'message-container assistant';
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';
        
        // Create content and timestamp for loading message
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = '<p class="loading-dots">Searching documents and generating answer</p>';
        
        const timeSpan = document.createElement('span');
        timeSpan.className = 'message-time';
        
        // Format current time
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        timeSpan.textContent = `${hours}:${minutes}`;
        
        messageDiv.appendChild(contentDiv);
        messageDiv.appendChild(timeSpan);
        containerDiv.appendChild(messageDiv);
        
        document.getElementById('chatHistory').appendChild(containerDiv);
        scrollToBottom();
        
        // Check if we need to start the Python server first
        try {
            const statusResponse = await fetch('/rag/status');
            
            if (!statusResponse.ok) {
                // Try to start just the server
                await fetch('/rag/start-indexing?serverOnly=true', { method: 'POST' });
                console.log('Started Python server for chat');
            } else {
                // Check if the indexing is complete
                const statusData = await statusResponse.json();
                if (!statusData.indexing_complete) {
                    // Show a more informative message
                    contentDiv.innerHTML = '<p>Indexing is still in progress. Please wait until document indexing is complete before asking questions.</p>';
                    return;
                }
            }
        } catch (error) {
            console.warn('Could not check server status:', error);
        }
        
        const response = await fetch('/rag/ask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                question: question
            })
        });
        
        if (!response.ok) throw new Error('Failed to get answer');
        
        // Stream the response
        let markdown = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        // Store sources for later addition
        let sources = [];
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const text = decoder.decode(value);
            const lines = text.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    
                    try {
                        const parsed = JSON.parse(data);
                        
                        if (parsed.content) {
                            markdown += parsed.content;
                            
                            // Update message with current markdown content
                            const contentDiv = messageDiv.querySelector('.message-content');
                            contentDiv.innerHTML = marked.parse(markdown);
                            
                            // Apply syntax highlighting to any code blocks
                            contentDiv.querySelectorAll('pre code').forEach((block) => {
                                hljs.highlightBlock(block);
                            });
                            
                            // Add citation links
                            addCitations(contentDiv);
                            
                            scrollToBottom();
                        }
                        
                        // Store sources when they're received
                        if (parsed.sources && Array.isArray(parsed.sources) && parsed.sources.length > 0) {
                            console.log('Sources received:', parsed.sources);
                            sources = parsed.sources;
                        }
                    } catch (e) {
                        console.error('Error parsing SSE data:', e);
                    }
                }
            }
        }
        
        // After streaming complete, add source documents if available
        if (sources && sources.length > 0) {
            try {
                // Ensure sources have the correct structure
                const validSources = sources.filter(doc => 
                    doc && typeof doc === 'object' && doc.title && doc.snippet && doc.doc_id);
                
                if (validSources.length > 0) {
                    const sourceDocsDiv = document.createElement('div');
                    sourceDocsDiv.className = 'source-documents';
                    
                    sourceDocsDiv.innerHTML = `
                        <div class="source-title">
                            <i class="fas fa-file-alt"></i>
                            <span>Source Documents (${validSources.length})</span>
                        </div>
                        <div class="source-list">
                            ${validSources.map((doc, index) => `
                                <div class="source-item" data-doc-id="${doc.doc_id}">
                                    <div class="source-header">
                                        <div class="source-name">${escapeHtml(doc.title || 'Untitled Document')}</div>
                                        <div class="source-meta">${escapeHtml(doc.correspondent || 'Unknown')} | ${doc.date || 'No date'}</div>
                                    </div>
                                    <div class="source-snippet">${escapeHtml(doc.snippet || 'No content available')}</div>
                                    <div class="source-score">
                                        <span>Relevance: ${Math.round((doc.score || 0) * 100)}%</span>
                                        <span>Cross-Score: ${Math.round((doc.cross_score || 0) * 100)}%</span>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `;
                    
                    containerDiv.appendChild(sourceDocsDiv);
                    scrollToBottom();
                    
                    // Add click events for source items
                    containerDiv.querySelectorAll('.source-item').forEach(item => {
                        item.addEventListener('click', () => {
                            const docId = item.getAttribute('data-doc-id');
                            if (docId) {
                                // Use the dashboard link that will handle redirecting to the correct Paperless instance
                                window.open(`/dashboard/doc/${docId}`, '_blank');
                            }
                        });
                    });
                } else {
                    console.warn('Received invalid source documents format', sources);
                }
            } catch (error) {
                console.error('Error displaying source documents:', error);
            }
        }
        
        // Remove loading dots
        if (messageDiv.querySelector('.loading-dots')) {
            messageDiv.querySelector('.loading-dots').remove();
        }
        
        return;
    } catch (error) {
        console.error('Error sending question:', error);
        showError(error.message || 'Failed to process question');
    }
}

function addMessage(message, isUser = true) {
    // Remove initial state if visible
    const initialState = document.getElementById('initialState');
    if (initialState && !initialState.classList.contains('hidden')) {
        initialState.classList.add('hidden');
    }
    
    const containerDiv = document.createElement('div');
    containerDiv.className = `message-container ${isUser ? 'user' : 'assistant'}`;
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isUser ? 'user' : 'assistant'}`;
    
    // Create content and timestamp
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    
    // Format current time
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    timeSpan.textContent = `${hours}:${minutes}`;
    
    // Add content based on message type
    if (isUser) {
        contentDiv.innerHTML = `<p>${escapeHtml(message)}</p>`;
    } else {
        contentDiv.innerHTML = marked.parse(message);
        contentDiv.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightBlock(block);
        });
        
        // Add citation links
        addCitations(contentDiv);
    }
    
    messageDiv.appendChild(contentDiv);
    messageDiv.appendChild(timeSpan);
    containerDiv.appendChild(messageDiv);
    
    // Add with animation
    containerDiv.style.opacity = '0';
    containerDiv.style.transform = 'translateY(20px)';
    
    const chatHistory = document.getElementById('chatHistory');
    chatHistory.appendChild(containerDiv);
    
    // Trigger animation
    setTimeout(() => {
        containerDiv.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        containerDiv.style.opacity = '1';
        containerDiv.style.transform = 'translateY(0)';
        scrollToBottom();
    }, 10);
}

// Add citation references to document mentions in text
function addCitations(contentElement) {
    const text = contentElement.innerHTML;
    
    // Replace "Document X" with citation links
    const citedText = text.replace(
        /Document (\d+)/g, 
        '<span class="citation" data-doc-id="$1">$1</span>'
    );
    
    contentElement.innerHTML = citedText;
    
    // Add click handlers to citations
    contentElement.querySelectorAll('.citation').forEach(citation => {
        citation.addEventListener('click', () => {
            const docId = citation.getAttribute('data-doc-id');
            // Highlight corresponding source document
            highlightSourceDocument(docId);
        });
    });
}

// Highlight a source document when its citation is clicked
function highlightSourceDocument(docIndex) {
    const sourceItems = document.querySelectorAll('.source-item');
    
    // Remove any existing highlights
    sourceItems.forEach(item => {
        item.classList.remove('highlighted');
        item.style.transform = '';
        item.style.boxShadow = '';
    });
    
    // Add highlight to the clicked item
    if (sourceItems[docIndex - 1]) {
        const item = sourceItems[docIndex - 1];
        item.classList.add('highlighted');
        item.style.transform = 'translateY(-4px)';
        item.style.boxShadow = '0 6px 12px rgba(0, 0, 0, 0.15)';
        
        // Scroll the source into view
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'message-container assistant';
    errorDiv.innerHTML = `
        <div class="message assistant error">
            <p>Error: ${escapeHtml(message)}</p>
        </div>
    `;
    document.getElementById('chatHistory').appendChild(errorDiv);
    scrollToBottom();
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function scrollToBottom() {
    const chatHistory = document.getElementById('chatHistory');
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function toggleTheme() {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    
    // Update theme toggle icon
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.innerHTML = theme === 'dark' 
            ? '<i class="fas fa-sun"></i>' 
            : '<i class="fas fa-moon"></i>';
    }
}

function setupTextareaAutoResize() {
    const textarea = document.getElementById('messageInput');
    
    function adjustHeight() {
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight) + 'px';
    }
    
    textarea.addEventListener('input', adjustHeight);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitForm();
        }
    });
}

async function submitForm() {
    const messageInput = document.getElementById('messageInput');
    const question = messageInput.value.trim();
    
    if (!question) return;
    
    try {
        // Clear input and reset height
        messageInput.value = '';
        messageInput.style.height = 'auto';
        
        // Send message and handle streaming response
        await sendQuestion(question);
    } catch (error) {
        showError('Failed to process question');
    }
}

// Language detection function
function detectLanguage(text) {
    // Simple language detection based on common words and characters
    // This is a basic implementation - a more robust solution would use a proper NLP library
    
    // German detection
    const germanPatterns = /[äöüßÄÖÜ]|(\b(und|der|die|das|ist|ich|du|wir|sie|nicht|für|von|mit|auf|wenn|warum|wie|wann|wo)\b)/i;
    if (germanPatterns.test(text)) {
        return 'de';
    }
    
    // French detection
    const frenchPatterns = /[éèêëàâäôöùûüÿçÉÈÊËÀÂÄÔÖÙÛÜŸÇ]|(\b(le|la|les|un|une|des|et|ou|je|tu|il|elle|nous|vous|ils|elles|est|sont|avoir|être|faire|voir|pouvoir|vouloir)\b)/i;
    if (frenchPatterns.test(text)) {
        return 'fr';
    }
    
    // Spanish detection
    const spanishPatterns = /[áéíóúüñÁÉÍÓÚÜÑ]|(\b(el|la|los|las|un|una|unos|unas|y|o|pero|porque|como|cuando|donde|quien|que|si|no|con|sin|por|para|en|de)\b)/i;
    if (spanishPatterns.test(text)) {
        return 'es';
    }
    
    // Default to English or null
    // English detection
    const englishPatterns = /\b(the|a|an|and|or|but|of|in|on|at|to|for|with|by|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|may|might|must|can|could)\b/i;
    if (englishPatterns.test(text)) {
        return 'en';
    }
    
    return null; // Could not detect with confidence
}

// Add event listeners once DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    
    document.getElementById('messageInput').addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            await submitForm();
        }
    });
    
    document.getElementById('sendButton').addEventListener('click', async () => {
        await submitForm();
    });
});
