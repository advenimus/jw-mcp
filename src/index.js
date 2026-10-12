#!/usr/bin/env node
// cheerio and undici need Node 20.18.1 or newer. On older Node they crash while
// loading ("File is not defined"), so check before importing anything else.
const MIN_NODE = [20, 18, 1];
const found = process.versions.node.split('.').map(Number);
const diff = MIN_NODE.map((n, i) => (found[i] ?? 0) - n).find((d) => d !== 0) ?? 0;
if (diff < 0) {
  console.error(`jw-mcp requires Node >=${MIN_NODE.join('.')} (found v${process.versions.node}). Install Node 22 LTS, then start jw-mcp again.`);
  process.exit(1);
}

const transport = process.env.MCP_TRANSPORT || 'stdio';

if (transport === 'http') {
  const { startHttpServer } = await import('./http-server.js');
  startHttpServer();
} else {
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  );
  const { createMcpServer } = await import('./mcp-server.js');

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
