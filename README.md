![GitHub commit activity](https://img.shields.io/github/commit-activity/t/clusterzx/paperless-ai) ![Docker Pulls](https://img.shields.io/docker/pulls/clusterzx/paperless-ai) ![GitHub User's stars](https://img.shields.io/github/stars/clusterzx) ![GitHub License](https://img.shields.io/github/license/clusterzx/paperless-ai?cacheSeconds=1)

# Paperless-AI

An automated document analyzer for Paperless-ngx using OpenAI API, Ollama and all OpenAI API compatible Services to automatically analyze and tag your documents. \
It features: Automode, Manual Mode, Ollama and OpenAI, a Chat function to query your documents with AI, a modern and intuitive Webinterface. \
\
**Following Services and OpenAI API compatible services have been successfully tested:**
- Ollama
- OpenAI
- DeepSeek.ai
- OpenRouter.ai
- Perplexity.ai
- Together.ai
- VLLM
- LiteLLM
- Fastchat
- Gemini (Google)
- ... and there are possibly many more

![PPAI_SHOWCASE3](https://github.com/user-attachments/assets/1fc9f470-6e45-43e0-a212-b8fa6225e8dd)


## Features

### Automated Document Management
- **Automatic Scanning**: Identifies and processes new documents within Paperless-ngx.
- **AI-Powered Analysis**: Leverages OpenAI API and Ollama (Mistral, Llama, Phi 3, Gemma 2) for precise document analysis.
- **Metadata Assignment**: Automatically assigns titles, tags, document_type and correspondent details.

### Advanced Customization Options
- **Predefined Processing Rules**: Specify which documents to process based on existing tags. *(Optional)* 🆕
- **Selective Tag Assignment**: Use only selected tags for processing. *(Disables the prompt dialog)* 🆕
- **Custom Tagging**: Assign a specific tag (of your choice) to AI-processed documents for easy identification. 🆕

### Manual Mode
- **AI-Assisted Analysis**: Manually analyze documents with AI support in a modern web interface. *(Accessible via the `/manual` endpoint)* 🆕

### Interactive Chat Functionality
- **Document Querying**: Ask questions about your documents and receive accurate, AI-generated answers. 🆕

## Installation

Visit the Wiki for installation:\
[Click here for Installation](https://github.com/clusterzx/paperless-ai/wiki/2.-Installation)
-------------------------------------------


## Docker Support

The application comes with full Docker support:

- Automatic container restart on failure
- Health monitoring
- Volume persistence for database
- Resource management
- Graceful shutdown handling

## Development

To run the application locally without Docker:

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run test
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) for the amazing document management system
- OpenAI API
- The Express.js and Node.js communities for their excellent tools

## Support

If you encounter any issues or have questions:

1. Check the [Issues](https://github.com/clusterzx/paperless-ai/issues) section
2. Create a new issue if yours isn't already listed
3. Provide detailed information about your setup and the problem

## Roadmap (DONE)

- [x] Support for custom AI models
- [x] Support for multiple language analysis
- [x] Advanced tag matching algorithms
- [x] Custom rules for document processing
- [x] Enhanced web interface with statistics

