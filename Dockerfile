FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Command to run the direct HTTP server (bypasses Smithery SDK issues)
CMD ["node", "src/direct-http-server.js"]
