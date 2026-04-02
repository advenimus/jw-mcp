#!/usr/bin/env node
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
  getBibleVerseURLTool,
  handleScriptureTools
} from './tools/scripture-tools.js';

// All tools and handlers shared across transport modes
const allTools = [
  captionsTool,
  ...workbookTools,
  ...watchtowerTools,
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool,
  getBibleVerseURLTool
];

const toolHandlers = [
  handleCaptionsTool,
  handleWorkbookTools,
  handleWatchtowerTools,
  handleScriptureTools
];

/**
 * Creates a configured MCP Server instance.
 * Each HTTP session needs its own Server (SDK binds one transport per Server).
 */
function createServer(requestId = 'default') {
  const server = new Server(
    { name: 'jw-mcp', version: '1.0.2' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`[${requestId}] ListTools — ${allTools.length} tools`);
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments;
    const start = Date.now();
    console.error(`[${requestId}] ToolCall: ${toolName} args=${JSON.stringify(args)}`);

    try {
      for (const handler of toolHandlers) {
        const result = await handler(request);
        if (result !== null) {
          const duration = Date.now() - start;
          const isError = result.isError || false;
          console.error(`[${requestId}] ToolResult: ${toolName} ${isError ? 'ERROR' : 'OK'} ${duration}ms`);
          return result;
        }
      }

      console.error(`[${requestId}] ToolResult: ${toolName} — no handler matched`);
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    } catch (error) {
      console.error(`[${requestId}] ToolError: ${toolName} ${Date.now() - start}ms — ${error.message}`);
      throw error;
    }
  });

  return server;
}

// ---------- Transport selection ----------

const transport = process.env.MCP_TRANSPORT || 'stdio';

if (transport === 'http') {
  // HTTP mode: Express + OAuth + per-session Server+Transport
  const { default: express } = await import('express');
  const { randomUUID } = await import('node:crypto');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { isInitializeRequest } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );

  const port = parseInt(process.env.MCP_PORT || '8080', 10);
  const useAuth = process.env.MCP_AUTH !== 'false';
  const authSecret = process.env.MCP_AUTH_SECRET;
  const baseUrl = process.env.MCP_BASE_URL || `http://localhost:${port}`;
  const mcpServerUrl = new URL(baseUrl);

  if (useAuth && !authSecret) {
    console.error(
      'ERROR: MCP_AUTH_SECRET is required when auth is enabled.\n' +
      '  Set MCP_AUTH_SECRET to a strong secret (min 8 chars).\n' +
      '  Or set MCP_AUTH=false to disable auth (not recommended).'
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Health check (unauthenticated)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'http', auth: useAuth });
  });

  let authMiddleware;

  if (useAuth && authSecret) {
    const { McpOAuthProvider } = await import('./auth.js');
    const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = await import(
      '@modelcontextprotocol/sdk/server/auth/router.js'
    );
    const { requireBearerAuth } = await import(
      '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
    );

    const oauthProvider = new McpOAuthProvider(authSecret);

    app.use(mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: mcpServerUrl,
      scopesSupported: ['mcp:tools'],
    }));

    app.post('/authorize/callback', async (req, res) => {
      const { pending_id, secret } = req.body;
      if (!pending_id || !secret) {
        res.status(400).send('Missing required fields');
        return;
      }
      await oauthProvider.handleAuthCallback(pending_id, secret, res);
    });

    authMiddleware = requireBearerAuth({
      verifier: oauthProvider,
      requiredScopes: [],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
    });

    console.error(`OAuth enabled. Issuer: ${mcpServerUrl}`);
  } else {
    console.error('Auth disabled (MCP_AUTH=false). WARNING: Server is unprotected.');
  }

  // Per-session Server+Transport pairs
  const sessions = {};

  const mcpHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    try {
      if (sessionId && sessions[sessionId]) {
        await sessions[sessionId].transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const sid = randomUUID();
        const sessionServer = createServer(sid.slice(0, 8));
        const sessionTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sid,
          onsessioninitialized: (id) => {
            sessions[id] = { transport: sessionTransport, server: sessionServer };
          },
        });
        sessionTransport.onclose = () => {
          const id = sessionTransport.sessionId;
          if (id) delete sessions[id];
        };
        await sessionServer.connect(sessionTransport);
        await sessionTransport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({ error: 'Bad request: missing session ID or not an init request' });
    } catch (error) {
      console.error('MCP handler error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  if (authMiddleware) {
    app.post('/mcp', authMiddleware, mcpHandler);
    app.get('/mcp', authMiddleware, mcpHandler);
    app.delete('/mcp', authMiddleware, mcpHandler);
  } else {
    app.post('/mcp', mcpHandler);
    app.get('/mcp', mcpHandler);
    app.delete('/mcp', mcpHandler);
  }

  // Log active session count periodically
  setInterval(() => {
    const count = Object.keys(sessions).length;
    if (count > 0) console.error(`Active MCP sessions: ${count}`);
  }, 60000);

  app.listen(port, () => {
    console.error(`JW MCP server listening on http://0.0.0.0:${port}`);
    console.error(`Health: http://0.0.0.0:${port}/health`);
    console.error(`MCP: ${baseUrl}/mcp`);
    if (useAuth) {
      console.error(`OAuth metadata: ${baseUrl}/.well-known/oauth-authorization-server`);
    }
  });

  const shutdown = () => {
    for (const s of Object.values(sessions)) {
      s.transport.close();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

} else {
  // Default: stdio transport
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  );

  const server = createServer();
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
