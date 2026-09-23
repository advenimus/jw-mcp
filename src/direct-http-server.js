#!/usr/bin/env node
import express from 'express';

/**
 * Direct MCP HTTP server implementation
 * Bypasses Smithery SDK and implements MCP streamable HTTP directly
 * This should resolve the timeout issues
 */

const app = express();
app.use(express.json());

// Static tool definitions for instant response
const STATIC_TOOLS = [
  {
    name: 'get_jw_captions',
    description: 'Fetches video captions from JW.org by video ID or URL. Accepts either a direct video ID (e.g., "pub-jwbvod25_17_VIDEO") or a JW.org URL (e.g., "https://www.jw.org/finder?srcid=jwlshare&wtlocale=E&lank=pub-jwbvod25_17_VIDEO")',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: {
          type: 'string',
          description: 'The JW.org video ID or a JW.org URL containing the video ID. If a URL is provided, the video ID will be automatically extracted.',
        },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'getWorkbookLinks',
    description: 'STEP 1: Get JW.org "Our Christian Life and Ministry" (CLM) meeting workbook weeks. When a user asks for CLM workbook content, use this tool FIRST to show them available weeks. Returns weekly titles like "May 5-11 (Proverbs 12)" with their RTF download URLs. Automatically uses current month/year for the issue.',
    inputSchema: {
      type: 'object',
      properties: {
        pub: {
          type: 'string',
          description: 'Publication code: "mwb" for Meeting Workbook (CLM workbook)',
          default: 'mwb',
        },
        langwritten: {
          type: 'string',
          description: 'Language code: "E" for English, "S" for Spanish, etc.',
          default: 'E',
        },
        issue: {
          type: 'string',
          description: 'Issue in YYYYMM00 format. Leave empty to use current month/year automatically (e.g., "20250500" for May 2025)',
        },
        fileformat: {
          type: 'string',
          description: 'File format: "RTF" for Rich Text Format',
          default: 'RTF',
        },
      },
      required: [],
    },
  },
  {
    name: 'getWorkbookContent',
    description: 'STEP 2: Get the actual CLM workbook content after user chooses a week. Use this tool AFTER getWorkbookLinks when user specifies which week they want (e.g., "May 5-11" or "June 30-July 6"). Takes the RTF URL from Step 1 results and returns the full workbook text content for that specific week.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The RTF file URL from getWorkbookLinks results (e.g., "https://cfp2.jw-cdn.org/a/...")',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'getWatchtowerLinks',
    description: 'STEP 1: Get JW.org Watchtower study articles. When a user asks for current/this week\'s Watchtower content, use this tool FIRST without any parameters - it automatically gets the correct issue for current study articles (Watchtower publications are 2 months ahead, so May 2025 studies come from March 2025 issue). Returns article titles like "Imitate the Faithful Angels (July 14-20)" with their RTF download URLs. Just use defaults for current articles.',
    inputSchema: {
      type: 'object',
      properties: {
        pub: {
          type: 'string',
          description: 'Publication code: "w" for Watchtower (Study edition)',
          default: 'w',
        },
        langwritten: {
          type: 'string',
          description: 'Language code: "E" for English, "S" for Spanish, etc.',
          default: 'E',
        },
        issue: {
          type: 'string',
          description: 'Issue in YYYYMM00 format. Leave empty for current study articles (server automatically calculates correct issue - Watchtower studies are 2 months ahead of publication)',
        },
        fileformat: {
          type: 'string',
          description: 'File format: "RTF" for Rich Text Format',
          default: 'RTF',
        },
      },
      required: [],
    },
  },
  {
    name: 'getWatchtowerContent',
    description: 'STEP 2: Get the actual Watchtower article content after user chooses an article. Use this tool AFTER getWatchtowerLinks when user specifies which article they want (e.g., "Imitate the Faithful Angels" or "Look to Jehovah for Comfort"). Takes the RTF URL from Step 1 results and returns the full article text content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The RTF file URL from getWatchtowerLinks results (e.g., "https://cfp2.jw-cdn.org/a/...")',
        },
      },
      required: ['url'],
    },
  },
];

// Lazy load tool handlers
async function handleToolCall(name, args) {
  try {
    switch (name) {
      case 'get_jw_captions': {
        const { handleCaptionsTool } = await import('./tools/captions-tool.js');
        const mockRequest = { params: { name, arguments: args } };
        return await handleCaptionsTool(mockRequest);
      }
      
      case 'getWorkbookLinks':
      case 'getWorkbookContent': {
        const { handleWorkbookTools } = await import('./tools/workbook-tools.js');
        const mockRequest = { params: { name, arguments: args } };
        return await handleWorkbookTools(mockRequest);
      }
      
      case 'getWatchtowerLinks':
      case 'getWatchtowerContent': {
        const { handleWatchtowerTools } = await import('./tools/watchtower-tools.js');
        const mockRequest = { params: { name, arguments: args } };
        return await handleWatchtowerTools(mockRequest);
      }
      
      default:
        return {
          content: [{
            type: 'text',
            text: `Unknown tool: ${name}`,
          }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error executing tool ${name}: ${error.message}`,
      }],
      isError: true,
    };
  }
}

// MCP endpoint
app.all('/mcp', async (req, res) => {
  console.log(`MCP ${req.method} request:`, req.body ? JSON.stringify(req.body) : 'no body');
  
  // Set required headers for MCP streamable HTTP
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (req.method === 'POST' && req.body) {
      const { jsonrpc, id, method, params } = req.body;

      // Handle tools/list - instant response with static definitions
      if (method === 'tools/list') {
        const response = {
          jsonrpc: '2.0',
          id,
          result: { tools: STATIC_TOOLS }
        };
        
        res.write(`event: message\n`);
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }

      // Handle tools/call - lazy load functionality
      if (method === 'tools/call') {
        const { name, arguments: args } = params;
        const result = await handleToolCall(name, args);
        
        const response = {
          jsonrpc: '2.0',
          id,
          result
        };
        
        res.write(`event: message\n`);
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }
    }

    // Method not found
    const response = {
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: req.body?.id || null
    };
    
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(response)}\n\n`);
    res.end();

  } catch (error) {
    console.error('Error handling MCP request:', error);
    const response = {
      jsonrpc: '2.0',
      error: { code: -32000, message: error.message },
      id: req.body?.id || null
    };
    
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(response)}\n\n`);
    res.end();
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'JW MCP Server (Direct HTTP)',
    version: '1.0.0',
    tools: STATIC_TOOLS.length
  });
});

// Start server
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`JW MCP Server (Direct HTTP) running on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`Health check: http://localhost:${port}/`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
