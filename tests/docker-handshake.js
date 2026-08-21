#!/usr/bin/env node
import { completeOAuthHandshake, mcpRpc } from './handshake.js';

const origin = process.env.MCP_BASE_URL || 'http://localhost:8080';
const secret = process.env.MCP_AUTH_SECRET;

if (!secret) {
  console.error('MCP_AUTH_SECRET is required');
  process.exit(1);
}

const health = await fetch(`${origin}/health`);
if (!health.ok) {
  throw new Error(`Health check failed: ${health.status}`);
}

const unauthorized = await fetch(`${origin}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
});
if (unauthorized.status !== 401) {
  throw new Error(`Expected 401 from /mcp, got ${unauthorized.status}`);
}

const { tokens } = await completeOAuthHandshake(origin, secret);
const init = await mcpRpc(`${origin}/mcp`, tokens.access_token, undefined, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'jw-mcp-docker-smoke', version: '0.0.0' },
  },
});
if (init.status !== 200 || !init.sessionId) {
  throw new Error(`Initialize failed: ${init.status} ${JSON.stringify(init.body)}`);
}

await mcpRpc(`${origin}/mcp`, tokens.access_token, init.sessionId, {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
});

const tools = await mcpRpc(`${origin}/mcp`, tokens.access_token, init.sessionId, {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});
const names = tools.body?.result?.tools?.map((tool) => tool.name) ?? [];
if (!names.includes('search_bible_books')) {
  throw new Error(`tools/list missing scripture tools: ${JSON.stringify(tools.body)}`);
}

console.log(`Docker handshake OK. Tools: ${names.length}`);
