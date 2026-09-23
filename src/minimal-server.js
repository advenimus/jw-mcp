#!/usr/bin/env node
import express from 'express';

/**
 * Minimal MCP HTTP server implementation without Smithery SDK
 * This bypasses the Smithery SDK to test if the issue is there
 */

const app = express();
app.use(express.json());

// Static tool definitions - exactly what we need for tool listing
const TOOLS = [
  {
    name: 'get_jw_captions',
    description: 'Fetches video captions from JW.org by video ID or URL',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: {
          type: 'string',
          description: 'The JW.org video ID or URL',
        },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'getWorkbookLinks',
    description: 'Get JW.org CLM meeting workbook weeks',
    inputSchema: {
      type: 'object',
      properties: {
        pub: { type: 'string', default: 'mwb' },
        langwritten: { type: 'string', default: 'E' },
        issue: { type: 'string' },
        fileformat: { type: 'string', default: 'RTF' },
      },
      required: [],
    },
  },
  {
    name: 'getWorkbookContent',
    description: 'Get CLM workbook content for a specific week',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'RTF file URL' },
      },
      required: ['url'],
    },
  },
  {
    name: 'getWatchtowerLinks',
    description: 'Get JW.org Watchtower study articles',
    inputSchema: {
      type: 'object',
      properties: {
        pub: { type: 'string', default: 'w' },
        langwritten: { type: 'string', default: 'E' },
        issue: { type: 'string' },
        fileformat: { type: 'string', default: 'RTF' },
      },
      required: [],
    },
  },
  {
    name: 'getWatchtowerContent',
    description: 'Get Watchtower article content',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'RTF file URL' },
      },
      required: ['url'],
    },
  },
];

// MCP endpoint
app.all('/mcp', (req, res) => {
  console.log('MCP request received:', req.method, req.headers, req.body);
  
  // Set required headers for MCP
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (req.method === 'POST' && req.body) {
      const { jsonrpc, id, method, params } = req.body;

      if (method === 'tools/list') {
        const response = {
          jsonrpc: '2.0',
          id,
          result: { tools: TOOLS }
        };
        
        res.write(`event: message\n`);
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }

      if (method === 'tools/call') {
        const response = {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: `Tool ${params?.name} called successfully (minimal server)`
            }]
          }
        };
        
        res.write(`event: message\n`);
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }
    }

    // Default response
    const response = {
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Method not found' },
      id: req.body?.id || null
    };
    
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(response)}\n\n`);
    res.end();

  } catch (error) {
    console.error('Error handling request:', error);
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Minimal MCP Server' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Minimal MCP Server running on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
});
