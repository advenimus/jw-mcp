#!/usr/bin/env node
import { createMcpServer } from './mcp-server.js';

const transport = process.env.MCP_TRANSPORT || 'stdio';

if (transport === 'http') {
  const { startHttpServer } = await import('./http-server.js');
  startHttpServer();
} else {
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  );

  const server = createMcpServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error('JW MCP Server running on stdio');

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
