//ragService.js

// Used to collect send all documents of paperless-ngx with
// body: { "title": $TITLE, "content": $CONTENT, "metadata": { "tags": $TAGS, "correspondent": $CORRESPONDENT} }
// to rag endpoint (http://localhost:5000/api/v1/content) and get the response

const paperlessService = require('./paperlessService');

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

class RAGService {
  constructor() {
    this.apiUrl = "http://localhost:5000/api/v1";
    this.apiToken = "test-key-123";
  }

    initialize() {
        if (!this.client && this.apiUrl && this.apiToken) {
        this.client = axios.create({
            baseURL: this.apiUrl,
            headers: {
            'Authorization': `Token ${this.apiToken}`,
            'Content-Type': 'application/json'
            }
        });
        }
    }

    async fetchAllDocumentsWithMetaData() {
        const documents = await paperlessService.getDocumentsForRAGService();
        return documents;
    }

    async sendDocumentsToRAGService() {
        try {
            const documents = await this.fetchAllDocumentsWithMetaData();
            for (const document of documents) {
                const tags = document.tags.join(",");
                const correspondent = document.correspondent;
                const title = document.title;
                const content = document.content;
                const body = {
                    title,
                    content,
                    metadata: {
                        tags,
                        correspondent
                    }
                }
                this.client.post('/content', body)
                .then(response => {
                    console.log(response.data);
                })
                .catch(error => {
                    console.error(error);
                }).finally(() => {
                    console.log("Document sent to RAG service");
                });
            }
            return true;
        } catch (error) {
            console.error("Error initializing RAG service client", error);
            return false;
        }       
    }




}

module.exports = new RAGService();
