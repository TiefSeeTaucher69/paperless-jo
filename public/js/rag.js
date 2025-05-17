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
    setupFilterToggle();
    
    // Clear initial state if there's chat history
    if (document.getElementById('chatHistory').children.length > 0) {
        document.getElementById('initialState').classList.add('hidden');
    }
});

// Setup filter panel toggle
function setupFilterToggle() {
    const toggleBtn = document.getElementById('toggleFilters');
    const filterPanel = document.getElementById('filterPanel');
    const clearBtn = document.getElementById('clearFilters');
    
    toggleBtn.addEventListener('click', () => {
        filterPanel.classList.toggle('hidden');
    });
    
    clearBtn.addEventListener('click', () => {
        document.getElementById('fromDate').value = '';
        document.getElementById('toDate').value = '';
        document.getElementById('correspondent').value = '';
    });
}

async function sendQuestion(question) {
    try {
        // Get filter values
        const fromDate = document.getElementById('fromDate').value;
        const toDate = document.getElementById('toDate').value;
        const correspondent = document.getElementById('correspondent').value.trim();
        
        // Build filter object
        const filters = {};
        if (fromDate) filters.from_date = fromDate;
        if (toDate) filters.to_date = toDate;
        if (correspondent) filters.correspondent = correspondent;
        
        // Detect question language to ensure response is in the same language
        const questionLanguage = detectLanguage(question);
        if (questionLanguage) {
            filters.language = questionLanguage;
        }
        
        // Show user message immediately
        addMessage(question, true);
        
        // Create loading message
        const containerDiv = document.createElement('div');
        containerDiv.className = 'message-container assistant';
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';
        messageDiv.innerHTML = '<p class="loading-dots">Searching documents and generating answer</p>';
        containerDiv.appendChild(messageDiv);
        
        document.getElementById('chatHistory').appendChild(containerDiv);
        scrollToBottom();
        
        const response = await fetch('/rag/ask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                question: question,
                filters: filters
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
                            
                            // Add citations if not present
                            if (parsed.sources && !sources.length) {
                                sources = parsed.sources;
                            }
                            
                            // Update message with current markdown content
                            messageDiv.innerHTML = marked.parse(markdown);
                            
                            // Apply syntax highlighting to any code blocks
                            messageDiv.querySelectorAll('pre code').forEach((block) => {
                                hljs.highlightBlock(block);
                            });
                            
                            scrollToBottom();
                        }
                    } catch (e) {
                        console.error('Error parsing SSE data:', e);
                    }
                }
            }
        }
        
        // After streaming complete, add source documents if available
        if (sources && sources.length > 0) {
            const sourceDocsDiv = document.createElement('div');
            sourceDocsDiv.className = 'source-documents';
            
            sourceDocsDiv.innerHTML = `
                <div class="source-title">
                    <i class="fas fa-file-alt"></i>
                    <span>Source Documents (${sources.length})</span>
                </div>
                <div class="source-list">
                    ${sources.map((doc, index) => `
                        <div class="source-item" data-doc-id="${doc.doc_id}">
                            <div class="source-header">
                                <div class="source-name">${escapeHtml(doc.title)}</div>
                                <div class="source-meta">${escapeHtml(doc.correspondent)} | ${doc.date}</div>
                            </div>
                            <div class="source-snippet">${escapeHtml(doc.snippet)}</div>
                            <div class="source-score">
                                <span>Relevance: ${Math.round(doc.score * 100)}%</span>
                                <span>Cross-Score: ${Math.round(doc.cross_score * 100)}%</span>
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
                        window.open(`/dashboard?doc=${docId}`, '_blank');
                    }
                });
            });
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
    
    if (isUser) {
        messageDiv.innerHTML = `<p>${escapeHtml(message)}</p>`;
    } else {
        messageDiv.innerHTML = marked.parse(message);
        messageDiv.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightBlock(block);
        });
    }
    
    containerDiv.appendChild(messageDiv);
    const chatHistory = document.getElementById('chatHistory');
    chatHistory.appendChild(containerDiv);
    scrollToBottom();
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
