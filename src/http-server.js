#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
app.use(cors({
  origin: '*',
  exposedHeaders: ['mcp-session-id', 'Mcp-Session-Id', 'Content-Type'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'Mcp-Session-Id']
}));
// NOTE: Do NOT use express.json() middleware here!
// StreamableHTTPServerTransport needs access to the raw request stream.
// express.json() consumes the stream, causing "stream is not readable" errors.

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

// Function to create and configure a new MCP Server instance
function createServer() {
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

  return server;
}

// STATELESS MODE: Create fresh Server + Transport instances for EVERY request
// This ensures compatibility with Smithery's distributed architecture where
// requests may be routed to different container instances without sticky sessions.

app.post('/mcp', async (req, res) => {
  // Create fresh instances for this request only
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined  // Critical: undefined for stateless mode
  });

  try {
    // Connect server to transport
    await server.connect(transport);

    // Set up cleanup when response finishes
    res.on('close', () => {
      try {
        transport.close?.();
        server.close?.();
      } catch (cleanupError) {
        console.error('Error during cleanup:', cleanupError);
      }
    });

    // Handle the request
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling POST request:', error);
    console.error('Error stack:', error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  }
});

// GET endpoint - SSE streaming not supported in stateless mode
// Stateless servers cannot maintain persistent connections for streaming
app.get('/mcp', (req, res) => {
  res.status(501).json({
    error: 'Not Implemented',
    message: 'SSE streaming (GET requests) is not supported in stateless mode. Use POST for all MCP requests.',
    mode: 'stateless-per-request'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    transport: 'streamable-http',
    mode: 'stateless-per-request',
    description: 'Each request creates fresh Server and Transport instances for Smithery compatibility'
  });
});

// Start the server
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.error(`JW MCP Server running in STATELESS mode`);
  console.error(`Transport: Streamable HTTP (per-request instances)`);
  console.error(`Port: ${PORT}`);
  console.error(`POST endpoint: http://localhost:${PORT}/mcp`);
  console.error(`Health check: http://localhost:${PORT}/health`);
  console.error(`Note: SSE streaming (GET) not supported in stateless mode`);
});
