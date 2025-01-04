FROM node:latest
# FROM node:20-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && \
    apt-get install -y python3 make g++ curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install PM2 globally
RUN npm install pm2 -g

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create volume mount points
VOLUME ["/app/data"]

# Expose port
EXPOSE 3000

# Copy PM2 configuration
COPY ecosystem.config.js .

# Start the application with PM2
CMD ["pm2-runtime", "ecosystem.config.js"]