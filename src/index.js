#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('JW MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
}); 