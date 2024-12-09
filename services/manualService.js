const axios = require('axios');
const OpenAI = require('openai');
const config = require('../config/config');
const emptyVar = null;

class ManualService {
    constructor() {
        this.openai = new OpenAI({ apiKey: config.openai.apiKey });
        this.ollama = axios.create({
        timeout: 300000
        });
    }
    
    async analyzeDocument(content, existingTags, provider) {
        try {
        if (provider === 'openai') {
            return this._analyzeOpenAI(content, existingTags);
        } else if (provider === 'ollama') {
            return this._analyzeOllama(content, existingTags);
        } else {
            throw new Error('Invalid provider');
        }
        } catch (error) {
        console.error('Error analyzing document:', error);
        return { tags: [], correspondent: null };
        }
    }
    
    async _analyzeOpenAI(content, existingTags) {
        try {
        const existingTagsList = existingTags
            .map(tag => tag.name)
            .join(', ');
    
        const systemPrompt = process.env.SYSTEM_PROMPT;
    
        const response = await this.openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
            {
                role: "system",
                content: systemPrompt
            },
            {
                role: "user",
                content: content
            }
            ],
            temperature: 0.3,
        });
    
        let jsonContent = response.choices[0].message.content;
        jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        const parsedResponse = JSON.parse(jsonContent);
        
        if (!Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
            throw new Error('Invalid response structure');
        }
        
        return parsedResponse;
        } catch (error) {
        console.error('Failed to analyze document with OpenAI:', error);
        return { tags: [], correspondent: null };
        }
    }
    
    async _analyzeOllama(content, existingTags) {
        try {
        const prompt = process.env.SYSTEM_PROMPT;
        
        const response = await this.ollama.post(`${config.ollama.apiUrl}/api/generate`, {
            model: config.ollama.model,
            prompt: prompt,
            stream: false,
            options: {
            temperature: 0.7,
            top_p: 0.9,
            repeat_penalty: 1.1
            }
        });
    
        if (!response.data || !response.data.response) {
            console.error('Unexpected Ollama response format:', response);
            throw new Error('Invalid response from Ollama API');
        }

        return this._parseResponse(response.data.response);
        }

        catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error('Timeout bei der Ollama-Anfrage:', error);
            throw new Error('Die Analyse hat zu lange gedauert. Bitte versuchen Sie es erneut.');
        }
        console.error('Error analyzing document with Ollama:', error);
        throw error;
        }
    }
}

module.exports = ManualService; 
