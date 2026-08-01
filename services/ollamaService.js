const {
    calculateTokens,
    calculateTotalPromptTokens,
    truncateToTokenLimit,
    writePromptToFile
} = require('./serviceUtils');
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs').promises;
const path = require('path');
const paperlessService = require('./paperlessService');
const os = require('os');
const OpenAI = require('openai');
const RestrictionPromptService = require('./restrictionPromptService');

/**
 * Service for document analysis using Ollama
 */
class OllamaService {
    /**
     * Initialize the Ollama service
     */
    constructor() {
        this.apiUrl = config.ollama.apiUrl;
        this.model = config.ollama.model;
        this.client = axios.create({
            timeout: 1800000 // 30 minutes timeout
        });

        // JSON schema for document analysis output
        this.documentAnalysisSchema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" },
                custom_fields: {
                    type: "object",
                    additionalProperties: true
                }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };

        // Schema for playground analysis (simpler version)
        this.playgroundSchema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };
    }

    /**
     * Analyze a document and extract metadata
     * @param {string} content - Document content
     * @param {Array} existingTags - List of existing tags
     * @param {Array} existingCorrespondentList - List of existing correspondents
     * @param {string} id - Document ID
     * @param {string} customPrompt - Custom prompt (optional)
     * @returns {Object} Analysis results
     */
    async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
        try {
            // Truncate content if needed
            content = this._truncateContent(content);

            // Cache thumbnail
            await this._handleThumbnailCaching(id);

            // Get external API data if available (validation happens once, inside _buildPrompt)
            let externalApiData = options.externalApiData || null;

            // Build prompt: instructions go to `system`, document text to `prompt`
            let system;
            let user;
            if (!customPrompt) {
                ({ system, user } = this._buildPrompt(
                    content, existingTags, existingCorrespondentList, existingDocumentTypesList, options
                ));
            } else {
                const customFieldsStr = this._generateCustomFieldsTemplate();
                system = customPrompt + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
                user = JSON.stringify(content);
                console.log('[DEBUG] Ollama Service started with custom prompt');
            }

            console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
            console.log(`[DEBUG] External API data: ${externalApiData ? 'provided' : 'none'}`);

            // Fit into the context window; only the document text may be trimmed
            const fitted = this._fitPromptToContext(system, user);

            // Call Ollama API
            const response = await this._callOllamaAPI(fitted.user, system, fitted.numCtx, this.documentAnalysisSchema);

            // Process response
            const parsedResponse = this._normalizeParsedDocument(this._processOllamaResponse(response));

            // Check for missing data
            if (parsedResponse.tags.length === 0 && parsedResponse.correspondent === null) {
                console.warn('No tags or correspondent found in response from Ollama for Document. Please review your prompt or switch to OpenAI for better results.');
            }

            // Log the prompt and response
            await this._logPromptAndResponse(system, fitted.user, parsedResponse);

            // Return results in consistent format
            return {
                document: parsedResponse,
                metrics: {
                    promptTokens: 0,  // Ollama doesn't provide token metrics
                    completionTokens: 0,
                    totalTokens: 0
                },
                truncated: fitted.truncated
            };
        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: { tags: [], correspondent: null },
                metrics: null,
                error: error.message
            };
        }
    }

    /**
     * Analyze a document in playground mode
     * @param {string} content - Document content
     * @param {string} prompt - User-provided prompt
     * @returns {Object} Analysis results
     */
    async analyzePlayground(content, prompt) {
        try {
            // Generate playground system prompt (simpler than full analysis)
            const systemPrompt = this._generatePlaygroundSystemPrompt();

            // Fit into the context window
            const fitted = this._fitPromptToContext(
                systemPrompt,
                prompt + "\n\n" + JSON.stringify(content)
            );

            // Call Ollama API
            const response = await this._callOllamaAPI(
                fitted.user,
                systemPrompt,
                fitted.numCtx,
                this.playgroundSchema
            );

            // Process response
            const parsedResponse = this._processOllamaResponse(response);

            // Check for missing data
            if (parsedResponse.tags.length === 0 && parsedResponse.correspondent === null) {
                console.warn('No tags or correspondent found in response from Ollama for Document. Please review your prompt or switch to OpenAI for better results.');
            }

            // Return results in consistent format
            return {
                document: parsedResponse,
                metrics: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0
                },
                truncated: false
            };
        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: { tags: [], correspondent: null },
                metrics: null,
                error: error.message
            };
        }
    }

    /**
     * Truncate content to maximum length if specified
     * @param {string} content - Content to truncate
     * @returns {string} Truncated content
     */
    _truncateContent(content) {
        try {
            if (process.env.CONTENT_MAX_LENGTH) {
                console.log('Truncating content to max length:', process.env.CONTENT_MAX_LENGTH);
                return content.substring(0, process.env.CONTENT_MAX_LENGTH);
            }
        } catch (error) {
            console.error('Error truncating content:', error);
        }
        return content;
    }

    /**
     * Build the system and user halves of the prompt.
     * The system half carries all instructions, the format template and the
     * pre-existing entity lists. The user half carries only the document text,
     * so that truncation can never eat the instructions.
     *
     * @param {string} content - Document content
     * @param {Array} existingTags - Existing tags
     * @param {Array} existingCorrespondent - Existing correspondents
     * @param {Array} existingDocumentTypes - Existing document types
     * @param {Object} options - May carry externalApiData
     * @returns {{system: string, user: string}}
     */
    _buildPrompt(content, existingTags = [], existingCorrespondent = [], existingDocumentTypes = [], options = {}) {
        const correspondentList = Array.isArray(existingCorrespondent) ? existingCorrespondent : [];
        const customFieldsStr = this._generateCustomFieldsTemplate();
        const mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
        const basePrompt = (process.env.SYSTEM_PROMPT || '').trim() || this._defaultAnalyzerPrompt();

        let systemPrompt;

        if (config.useExistingData === 'yes'
            && config.restrictToExistingTags === 'no'
            && config.restrictToExistingCorrespondents === 'no') {
            const tagList = RestrictionPromptService._formatNameList(existingTags);
            const correspondentNames = RestrictionPromptService._formatNameList(correspondentList);
            const documentTypeNames = RestrictionPromptService._formatNameList(existingDocumentTypes);

            systemPrompt = `Pre-existing tags: ${tagList}\n\n`
                + `Pre-existing correspondents: ${correspondentNames}\n\n`
                + `Pre-existing document types: ${documentTypeNames}\n\n`
                + `${basePrompt}\n\n${mustHavePrompt}`;
        } else {
            systemPrompt = `${basePrompt}\n\n${mustHavePrompt}`;
        }

        systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
            systemPrompt,
            existingTags,
            correspondentList,
            existingDocumentTypes,
            config
        );

        if (options.externalApiData) {
            try {
                const validated = this._validateAndTruncateExternalApiData(options.externalApiData);
                if (validated) {
                    systemPrompt += `\n\nAdditional context from external API:\n${validated}`;
                    console.log('[DEBUG] External API data validated and included');
                }
            } catch (error) {
                console.warn('[WARNING] External API data validation failed:', error.message);
            }
        }

        if (process.env.USE_PROMPT_TAGS === 'yes') {
            systemPrompt = `Take these tags and try to match one or more to the document content.\n\n`
                + config.specialPromptPreDefinedTags;
        }

        return { system: systemPrompt, user: JSON.stringify(content) };
    }

    /**
     * Validate and truncate external API data to prevent token overflow
     * @param {any} apiData - The external API data to validate
     * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
     * @returns {string} - Validated and potentially truncated data string
     */
    _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
        if (!apiData) {
            return null;
        }

        const dataString = typeof apiData === 'object'
            ? JSON.stringify(apiData, null, 2)
            : String(apiData);

        // Calculate tokens for the data (using simple estimation for Ollama)
        const dataTokens = Math.ceil(dataString.length / 4);

        if (dataTokens > maxTokens) {
            console.warn(`[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`);
            // Simple truncation based on character count
            const maxChars = maxTokens * 4;
            return dataString.substring(0, maxChars);
        }

        console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
        return dataString;
    }

    /**
     * Generate custom fields template for prompts
     * @returns {string} Custom fields template as a string
     */
    _generateCustomFieldsTemplate() {
        let customFieldsObj;
        try {
            customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
        } catch (error) {
            console.error('Failed to parse CUSTOM_FIELDS:', error);
            customFieldsObj = { custom_fields: [] };
        }

        // Generate custom fields template for the prompt
        const customFieldsTemplate = {};

        customFieldsObj.custom_fields.forEach((field, index) => {
            customFieldsTemplate[index] = {
                field_name: field.value,
                value: "Fill in the value based on your analysis"
            };
        });

        // Convert template to string for replacement and wrap in custom_fields
        return '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
            .split('\n')
            .map(line => '    ' + line)  // Add proper indentation
            .join('\n');
    }

    /**
     * Fallback instructions used when SYSTEM_PROMPT is not configured.
     * Deliberately carries no JSON template: config.mustHavePrompt supplies it,
     * and two competing templates confused the model.
     * @returns {string}
     */
    _defaultAnalyzerPrompt() {
        return `You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions.
YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
YOU MUSTNOT: Return a response without the desired JSON format.
The tags, title and document_type MUST be in the language used in the document.
The custom_fields are optional; only fill in values you actually find in the document.`;
    }

    /**
     * Generate system prompt for playground analysis
     * @returns {string} System prompt
     */
    _generatePlaygroundSystemPrompt() {
        return `
            You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
            YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
            YOU MUSTNOT: Return a response without the desired JSON format.
            YOU MUST: Analyze the document content and extract the following information into this structured JSON format and only this format!:         {
            "title": "xxxxx",
            "correspondent": "xxxxxxxx",
            "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
            "document_type": "Invoice/Contract/...",
            "document_date": "YYYY-MM-DD",
            "language": "en/de/es/..."
            }
            ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
        `;
    }

    /**
     * Calculate prompt token count
     * @param {string} prompt - Prompt text
     * @returns {number} Estimated token count
     */
    _calculatePromptTokenCount(prompt) {
        return Math.ceil(prompt.length / 4);
    }

    /**
     * Fit the prompt into the context window.
     *
     * The system half is never touched: it carries the instructions, the format
     * template and the pre-existing entity lists. Only the document text is
     * trimmed, and only when it does not fit.
     *
     * @param {string} systemPrompt - System half (protected)
     * @param {string} userPrompt - User half (document text, may be trimmed)
     * @param {number} [numPredict] - Tokens reserved for the response
     * @returns {{user: string, numCtx: number, truncated: boolean}}
     */
    _fitPromptToContext(systemPrompt, userPrompt, numPredict = config.ollama.numPredict) {
        const MIN_CTX = 2048;
        const MIN_DOC_TOKENS = 512;
        const maxCtx = config.ollama.numCtxMax;

        const systemTokens = this._calculatePromptTokenCount(systemPrompt);
        let budget = maxCtx - systemTokens - numPredict;
        let user = userPrompt;
        let truncated = false;

        if (budget < MIN_DOC_TOKENS) {
            console.error(
                `[ERROR] System prompt (${systemTokens} tokens) plus reserved response `
                + `(${numPredict} tokens) leaves only ${budget} tokens for the document `
                + `within OLLAMA_NUM_CTX_MAX=${maxCtx}. Forcing ${MIN_DOC_TOKENS} document `
                + `tokens and exceeding the configured maximum. Raise OLLAMA_NUM_CTX_MAX or `
                + `shorten the pre-existing tag/correspondent lists.`
            );
            budget = MIN_DOC_TOKENS;
        }

        if (this._calculatePromptTokenCount(user) > budget) {
            user = user.substring(0, budget * 4);
            truncated = true;
            console.warn(`[WARNING] Document text truncated to ${budget} tokens to protect the system prompt`);
        }

        const userTokens = this._calculatePromptTokenCount(user);
        const numCtx = Math.max(MIN_CTX, systemTokens + userTokens + numPredict);

        console.log(`[DEBUG] num_ctx=${numCtx} (system=${systemTokens}, user=${userTokens}, predict=${numPredict}, truncated=${truncated})`);

        return { user, numCtx, truncated };
    }

    /**
     * Get available system memory
     * @returns {Object} Object with totalMemoryMB and freeMemoryMB
     */
    async _getAvailableMemory() {
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const totalMemoryMB = (totalMemory / (1024 * 1024)).toFixed(0);
        const freeMemoryMB = (freeMemory / (1024 * 1024)).toFixed(0);
        return { totalMemoryMB, freeMemoryMB };
    }

    /**
     * Handle thumbnail caching for documents
     * @param {string} id - Document ID
     */
    async _handleThumbnailCaching(id) {
        if (!id) return;

        const cachePath = path.join('./public/images', `${id}.png`);
        try {
            await fs.access(cachePath);
            console.log('[DEBUG] Thumbnail already cached');
        } catch (err) {
            console.log('Thumbnail not cached, fetching from Paperless');
            const thumbnailData = await paperlessService.getThumbnailImage(id);
            if (!thumbnailData) {
                console.warn('Thumbnail nicht gefunden');
                return;
            }
            await fs.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.writeFile(cachePath, thumbnailData);
        }
    }

    /**
     * Call Ollama API
     * @param {string} prompt - Prompt text
     * @param {string} systemPrompt - System prompt
     * @param {number} numCtx - Context window size
     * @param {Object} schema - Response schema
     * @returns {Object} Ollama API response
     */
    async _callOllamaAPI(prompt, systemPrompt, numCtx, schema) {
        const response = await this.client.post(`${this.apiUrl}/api/generate`, {
            model: this.model,
            prompt: prompt,
            system: systemPrompt,
            stream: false,
            format: schema,
            options: {
                temperature: config.ollama.temperature,
                seed: config.ollama.seed,
                top_p: 1,
                repeat_penalty: 1.1,
                num_predict: config.ollama.numPredict,
                num_ctx: numCtx
            }
        });

        if (!response.data) {
            throw new Error('Invalid response from Ollama API');
        }

        return response.data;
    }

    /**
     * A category tag is a short label. Anything containing a colon is very
     * likely a "field: value" fragment the model extracted instead of
     * categorizing (observed baseline: "Personal-Nr.: XXXXXX 000"). Anything
     * implausibly long is likely a full sentence, not a label.
     * @param {*} tag
     * @returns {boolean}
     */
    _isPlausibleTag(tag) {
        if (typeof tag !== 'string') return false;
        const trimmed = tag.trim();
        if (!trimmed) return false;
        if (trimmed.includes(':')) return false;
        if (trimmed.length > 60) return false;
        return true;
    }

    /**
     * Defensive post-processing for a parsed model response. Runs
     * unconditionally after every successful parse, regardless of which
     * branch of _processOllamaResponse/_parseResponse produced it.
     * @param {Object} doc
     * @returns {Object} the same object, mutated
     */
    _normalizeParsedDocument(doc) {
        if (Array.isArray(doc.tags)) {
            const before = doc.tags.length;
            doc.tags = doc.tags.filter(tag => this._isPlausibleTag(tag));
            if (doc.tags.length < before) {
                console.warn(`[WARNING] Dropped ${before - doc.tags.length} tag(s) that looked like extracted data rather than category labels`);
            }
        }

        return doc;
    }

    /**
     * Process Ollama API response
     * @param {Object} responseData - Ollama API response data
     * @returns {Object} Parsed response
     */
    _processOllamaResponse(responseData) {
        // Check if we got a structured response or need to parse from text
        if (responseData.response && typeof responseData.response === 'object') {
            // We got a structured response directly
            console.log('Using structured output response');
            return {
                tags: Array.isArray(responseData.response.tags) ? responseData.response.tags : [],
                correspondent: responseData.response.correspondent || null,
                title: responseData.response.title || null,
                document_date: responseData.response.document_date || null,
                document_type: responseData.response.document_type || null,
                language: responseData.response.language || null,
                custom_fields: responseData.response.custom_fields || null
            };
        } else if (responseData.response) {
            // Fall back to parsing from text response
            console.log('Falling back to text response parsing');
            return this._parseResponse(responseData.response);
        } else {
            throw new Error('No response data from Ollama API');
        }
    }

    /**
     * Parse text response to extract JSON
     * @param {string} response - Response text
     * @returns {Object} Parsed object
     */
    _parseResponse(response) {
        try {
            // Find JSON in response using regex
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { tags: [], correspondent: null };
            }

            let jsonStr = jsonMatch[0];
            console.log('Extracted JSON String:', jsonStr);

            try {
                // Attempt to parse the JSON
                const result = JSON.parse(jsonStr);

                // Validate and return the result
                return {
                    tags: Array.isArray(result.tags) ? result.tags : [],
                    correspondent: result.correspondent || null,
                    title: result.title || null,
                    document_date: result.document_date || null,
                    document_type: result.document_type || null,
                    language: result.language || null,
                    custom_fields: result.custom_fields || null
                };

            } catch (jsonError) {
                console.warn('Error parsing JSON from response:', jsonError.message);
                console.warn('Attempting to sanitize the JSON...');

                // Sanitize the JSON
                jsonStr = this._sanitizeJsonString(jsonStr);

                try {
                    const sanitizedResult = JSON.parse(jsonStr);
                    return {
                        tags: Array.isArray(sanitizedResult.tags) ? sanitizedResult.tags : [],
                        correspondent: sanitizedResult.correspondent || null,
                        title: sanitizedResult.title || null,
                        document_date: sanitizedResult.document_date || null,
                        language: sanitizedResult.language || null
                    };
                } catch (finalError) {
                    console.error('Final JSON parsing failed after sanitization. This happens when the JSON structure is too complex or invalid. That indicates an issue with the generated JSON string by Ollama. Switch to OpenAI for better results or fine tune your prompt.');
                    return { tags: [], correspondent: null };
                }
            }
        } catch (error) {
            console.error('Error parsing Ollama response:', error.message);
            return { tags: [], correspondent: null };
        }
    }

    /**
     * Sanitize a JSON string
     * @param {string} jsonStr - JSON string to sanitize
     * @returns {string} Sanitized JSON string
     */
    _sanitizeJsonString(jsonStr) {
        return jsonStr
            .replace(/,\s*}/g, '}') // Remove trailing commas before closing braces
            .replace(/,\s*]/g, ']') // Remove trailing commas before closing brackets
            .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":'); // Ensure property names are quoted
    }

    /**
     * Log prompt and response to file
     * @param {string} systemPrompt - System half of the prompt
     * @param {string} userPrompt - User half of the prompt
     * @param {Object} response - Response object
     */
    async _logPromptAndResponse(systemPrompt, userPrompt, response) {
        const content = '================================================================================\n'
            + '--- SYSTEM ---\n' + systemPrompt + '\n\n'
            + '--- USER ---\n' + userPrompt + '\n\n'
            + JSON.stringify(response)
            + '\n\n'
            + '================================================================================\n\n';

        await writePromptToFile(content);
    }

    /**
     * Generate text based on a prompt
     * @param {string} prompt - The prompt to generate text from
     * @returns {Promise<string>} - The generated text
     */
    async generateText(prompt) {
        try {
            // Simple system prompt for text generation
            const systemPrompt = `You are a helpful assistant. Generate a clear, concise, and informative response to the user's question or request.`;

            // Fit into the context window; free-text generation reserves more tokens
            const fitted = this._fitPromptToContext(systemPrompt, prompt, 1024);

            // Call Ollama API without enforcing a specific response format
            const response = await this.client.post(`${this.apiUrl}/api/generate`, {
                model: this.model,
                prompt: fitted.user,
                system: systemPrompt,
                stream: false,
                options: {
                    temperature: 0.7,
                    top_p: 0.9,
                    num_predict: 1024,
                    num_ctx: fitted.numCtx
                }
            });

            if (!response.data || !response.data.response) {
                throw new Error('Invalid response from Ollama API');
            }

            return response.data.response;
        } catch (error) {
            console.error('Error generating text with Ollama:', error);
            throw error;
        }
    }

    /**
     * Check if the Ollama service is running
     * @returns {Promise<boolean>} - True if the service is running, false otherwise
     */
    async checkStatus() {
        // use ollama status endpoint
        try {
            const response = await this.client.get(`${this.apiUrl}/api/ps`);
            if (response.status === 200) {
                const data = response.data;
                // Ensure data is an array and has at least one model
                let modelName = null;
                if (Array.isArray(data.models) && data.models.length > 0) {
                    modelName = data.models[0].name;
                }
                console.log('Ollama model name:', modelName);
                return { status: 'ok', model: modelName };
            }
        } catch (error) {
            console.error('Error checking Ollama service status:', error);
        }
        return { status: 'error' };
    }
}

module.exports = new OllamaService();
