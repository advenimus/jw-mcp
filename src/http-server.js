#!/usr/bin/env node
import { createStatelessServer } from '@smithery/sdk/server/stateless.js';
import { createMcpServer } from './mcp-server.js';

/**
 * HTTP server for JW MCP using Smithery SDK
 * This creates a stateless HTTP server that can be deployed on Smithery
 * Optimized for fast tool listing and lazy loading of functionality
 */

// Create the stateless server using our MCP server function
const { app } = createStatelessServer(createMcpServer, {
  // No configuration schema needed - all tools work without authentication
});

// Start the server with optimizations for fast startup
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`JW MCP HTTP Server running on port ${port}`);
  console.log(`MCP endpoint available at: http://localhost:${port}/mcp`);
});

// Set timeout to 30 seconds to handle Smithery's 2-minute timeout
server.timeout = 30000;

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
