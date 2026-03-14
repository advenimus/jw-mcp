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
  getBibleVerseURLTool,
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
  getVerseWithStudyTool,
  getBibleVerseURLTool
];

// Collect all tool handlers
const toolHandlers = [
  handleCaptionsTool,
  handleWorkbookTools,
  handleWatchtowerTools,
  handleScriptureTools
];

// Function to create and configure a new MCP Server instance
function createServer(requestId = 'unknown') {
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
    console.log(`[${requestId}] ListTools called — returning ${allTools.length} tools`);
    return {
      tools: allTools,
    };
  });

  // Handle tool calls by delegating to appropriate handlers
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments;
    const toolStart = Date.now();
    console.log(`[${requestId}] ToolCall: ${toolName} args=${JSON.stringify(args)}`);

    try {
      // Try each handler until one returns a result
      for (const handler of toolHandlers) {
        const result = await handler(request);
        if (result !== null) {
          const duration = Date.now() - toolStart;
          const isError = result.isError || false;
          const preview = result.content?.[0]?.text?.slice(0, 200) || '';
          console.log(`[${requestId}] ToolResult: ${toolName} ${isError ? 'ERROR' : 'OK'} ${duration}ms preview=${preview}`);
          return result;
        }
      }

      console.error(`[${requestId}] ToolResult: ${toolName} — no handler matched`);
      // If no handler matched, return error
      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${toolName}`,
          },
        ],
        isError: true,
      };
    } catch (error) {
      const duration = Date.now() - toolStart;
      console.error(`[${requestId}] ToolError: ${toolName} ${duration}ms — ${error.message}`);
      console.error(`[${requestId}] ToolStack: ${error.stack}`);
      throw error;
    }
  });

  return server;
}

// STATELESS MODE: Create fresh Server + Transport instances for EVERY request
// This ensures compatibility with Smithery's distributed architecture where
// requests may be routed to different container instances without sticky sessions.

app.post('/mcp', async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 10);
  const startTime = Date.now();
  console.log(`[${requestId}] POST /mcp received`);

  // Create fresh instances for this request only
  const server = createServer(requestId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined  // Critical: undefined for stateless mode
  });

  try {
    // Connect server to transport
    await server.connect(transport);

    // Set up cleanup when response finishes
    res.on('close', () => {
      const duration = Date.now() - startTime;
      console.log(`[${requestId}] Request completed in ${duration}ms`);
      try {
        transport.close?.();
        server.close?.();
      } catch (cleanupError) {
        console.error(`[${requestId}] Cleanup error:`, cleanupError);
      }
    });

    // Handle the request
    await transport.handleRequest(req, res);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error after ${duration}ms:`, error.message);
    console.error(`[${requestId}] Stack:`, error.stack);
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
