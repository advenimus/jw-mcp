#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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

// MCP endpoint for HTTP transport
app.post('/mcp', async (req, res) => {
  try {
    // The SDK's server will handle the MCP protocol over HTTP
    await server.handlePostRequest(req, res);
  } catch (error) {
    console.error('Error handling POST request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/mcp', async (req, res) => {
  try {
    // The SDK's server will handle SSE (Server-Sent Events) for streaming
    await server.handleGetRequest(req, res);
  } catch (error) {
    console.error('Error handling GET request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Start the server
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => {
  console.error(`JW MCP Server running on HTTP port ${PORT}`);
  console.error(`MCP endpoint available at /mcp`);
});
