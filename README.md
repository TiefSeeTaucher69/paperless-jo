# Paperless Assistant

An automated document analyzer for Paperless-ngx using ChatGPT to automatically analyze and tag your documents.

## Features

- 🔍 Automatic document scanning in Paperless-ngx
- 🤖 AI-powered document analysis using ChatGPT
- 🏷️ Automatic tag and correspondent assignment
- 🚀 Easy setup through web interface
- 📊 Document processing dashboard
- 🔄 Automatic restart and health monitoring
- 🛡️ Error handling and graceful shutdown
- 🐳 Docker support with health checks

## Prerequisites

- Docker and Docker Compose
- Access to a Paperless-ngx installation
- OpenAI API key
- Basic understanding of cron syntax (for scan interval configuration)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/clusterzx/paperless-ai.git
cd paperless-ai
```

2. Start the container:
```bash
docker-compose up -d
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

4. Complete the setup by providing:
- Paperless-ngx API URL
- Paperless-ngx API Token
- OpenAI API Key
- Scan interval (default: every 30 minutes)

## How it Works

1. **Document Discovery**
   - Periodically scans Paperless-ngx for new documents
   - Tracks processed documents in a local SQLite database

2. **AI Analysis**
   - Sends document content to ChatGPT for analysis
   - Extracts relevant tags and correspondent information
   - Uses GPT-4 for accurate document understanding

3. **Automatic Organization**
   - Creates new tags if they don't exist
   - Creates new correspondents if they don't exist
   - Updates documents with analyzed information
   - Marks documents as processed to avoid duplicate analysis

## Configuration Options

The application can be configured through environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| PAPERLESS_API_URL | URL to your Paperless-ngx API | - |
| PAPERLESS_API_TOKEN | API Token from Paperless-ngx | - |
| OPENAI_API_KEY | Your OpenAI API key | - |
| SCAN_INTERVAL | Cron expression for scan interval | */30 * * * * |

## Docker Support

The application comes with full Docker support:

- Automatic container restart on failure
- Health monitoring
- Volume persistence for database
- Resource management
- Graceful shutdown handling

### Docker Commands

```bash
# Start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Restart container
docker-compose restart

# Stop container
docker-compose down

# Rebuild and start
docker-compose up -d --build
```

## Health Checks

The application provides a health check endpoint at `/health` that returns:

```json
# Healthy system
{
  "status": "healthy"
}

# System not configured
{
  "status": "not_configured",
  "message": "Application setup not completed"
}

# Database error
{
  "status": "database_error",
  "message": "Database check failed"
}
```

## Development

To run the application locally without Docker:

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## Security Considerations

- Store API keys securely
- Restrict container access
- Monitor API usage
- Regularly update dependencies
- Back up your database

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) for the amazing document management system
- OpenAI for the ChatGPT API
- The Express.js and Node.js communities for their excellent tools

## Support

If you encounter any issues or have questions:

1. Check the [Issues](https://github.com/yourusername/paperless-assistant/issues) section
2. Create a new issue if yours isn't already listed
3. Provide detailed information about your setup and the problem

## Roadmap

- [ ] Support for multiple language analysis
- [ ] Advanced tag matching algorithms
- [ ] Custom rules for document processing
- [ ] Enhanced web interface with statistics
- [ ] Support for custom AI models
