# Use a slim Node.js (LTS) image as base
FROM node:22-slim

WORKDIR /app

# Install system dependencies and clean up in single layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install PM2 process manager globally
RUN npm install pm2 -g

# Copy package files for dependency installation
COPY package*.json ./

# Install node dependencies with clean install
RUN npm ci --only=production && npm cache clean --force

# Copy application source code
COPY . .

# Configure persistent data volume
VOLUME ["/app/data"]

# Configure application port
EXPOSE 3000

# Add health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Set production environment
ENV NODE_ENV=production

# Start application with PM2 with user node
CMD ["pm2-runtime", "ecosystem.config.js"]