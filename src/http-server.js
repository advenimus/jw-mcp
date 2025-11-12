#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { captionsTool, handleCaptionsTool } from './tools/captions-tool.js';
import { workbookTools, handleWorkbookTools } from './tools/workbook-tools.js';
import { watchtowerTools, handleWatchtowerTools } from './tools/watchtower-tools.js';
import {
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool,
  handleScriptureTools
} from './tools/scripture-tools.js';

const app = express();
app.use(cors());
app.use(express.json());

// Create server instance
const server = new Server(
  {
    name: 'jw-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Collect all tools from different modules
const allTools = [
  captionsTool,
  ...workbookTools,
  ...watchtowerTools,
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool
];

// Collect all tool handlers
const toolHandlers = [
  handleCaptionsTool,
  handleWorkbookTools,
  handleWatchtowerTools,
  handleScriptureTools
];

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools,
  };
});

// Handle tool calls by delegating to appropriate handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Try each handler until one returns a result
  for (const handler of toolHandlers) {
    const result = await handler(request);
    if (result !== null) {
      return result;
    }
  }

  // If no handler matched, return error
  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
    isError: true,
  };
});

// Store transports by sessionId for multiple concurrent connections
const transports = {};

// SSE endpoint - establishes connection and returns sessionId
app.get('/mcp', async (req, res) => {
  try {
    // Create a new SSE transport for this connection
    // The endpoint '/mcp' is where clients will POST messages
    const transport = new SSEServerTransport('/mcp', res);

    // Store the transport by its sessionId for later message routing
    transports[transport.sessionId] = transport;

    // Clean up when connection closes
    res.on('close', () => {
      delete transports[transport.sessionId];
      console.error(`Session ${transport.sessionId} disconnected`);
    });

    // Connect the server to this transport (this calls transport.start() internally)
    await server.connect(transport);

    console.error(`New SSE connection established: ${transport.sessionId}`);
  } catch (error) {
    console.error('Error establishing SSE connection:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish SSE connection' });
    }
  }
});

// POST endpoint - handles JSON-RPC messages from clients
app.post('/mcp', async (req, res) => {
  try {
    // Get sessionId from query parameter (sent by client)
    const sessionId = req.query.sessionId;

    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter' });
      return;
    }

    // Find the transport for this session
    const transport = transports[sessionId];

    if (!transport) {
      res.status(404).json({ error: `No active session found for sessionId: ${sessionId}` });
      return;
    }

    // Handle the POST message using the transport's built-in handler
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error('Error handling POST request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeSessions: Object.keys(transports).length
  });
});

// Start the server
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.error(`JW MCP Server running on HTTP port ${PORT}`);
  console.error(`SSE endpoint: GET http://localhost:${PORT}/mcp`);
  console.error(`Message endpoint: POST http://localhost:${PORT}/mcp?sessionId=<id>`);
  console.error(`Health check: GET http://localhost:${PORT}/health`);
});
