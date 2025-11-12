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
  exposedHeaders: ['Mcp-Session-Id', 'Content-Type']
}));
// NOTE: Do NOT use express.json() middleware here!
// StreamableHTTPServerTransport needs access to the raw request stream.
// express.json() consumes the stream, causing "stream is not readable" errors.

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

// Store transports by sessionId for session-aware connections
const transports = new Map();

// Streamable HTTP POST endpoint - handles all MCP messages
app.post('/mcp', async (req, res) => {
  try {
    // Get sessionId from header (Smithery's gateway sends this)
    const sessionId = req.headers['mcp-session-id'];

    let transport;
    let isNewSession = false;

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for this session
      transport = transports.get(sessionId);
    } else {
      // Create new transport for new session or stateless request
      transport = new StreamableHTTPServerTransport({
        endpoint: '/mcp',
        sessionIdGenerator: () => {
          // Use session ID from header if provided, otherwise generate new one
          return sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        }
      });

      isNewSession = true;

      // Connect server to transport only for new transports
      await server.connect(transport);

      // Store transport if we have a session ID
      if (sessionId || transport.sessionId) {
        const finalSessionId = sessionId || transport.sessionId;
        transports.set(finalSessionId, transport);

        // Set up cleanup when transport closes
        transport.onclose = () => {
          transports.delete(finalSessionId);
          console.error(`Session ${finalSessionId} closed`);
        };
      }

      if (isNewSession) {
        console.error(`New session created: ${sessionId || transport.sessionId}`);
      }
    }

    // Handle the request using the transport
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling POST request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  }
});

// Optional GET endpoint for SSE streaming responses (if needed)
app.get('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
    }

    const transport = transports.get(sessionId);

    if (!transport) {
      return res.status(404).json({ error: `No active session found for sessionId: ${sessionId}` });
    }

    // Handle GET request (for SSE streaming)
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling GET request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    transport: 'streamable-http',
    activeSessions: transports.size
  });
});

// Start the server
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.error(`JW MCP Server running on Streamable HTTP transport`);
  console.error(`Port: ${PORT}`);
  console.error(`POST endpoint: http://localhost:${PORT}/mcp`);
  console.error(`GET endpoint (SSE): http://localhost:${PORT}/mcp`);
  console.error(`Health check: http://localhost:${PORT}/health`);
});
