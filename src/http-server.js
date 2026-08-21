import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { McpOAuthProvider, MCP_SCOPE, RESOURCE_NAME } from './auth.js';
import { mcpResourceUrl, originUrl as toOriginUrl } from './auth/urls.js';
import { createMcpServer } from './mcp-server.js';

const MAX_SESSIONS = 100;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const JSON_BODY_LIMIT = '256kb';
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTHORIZE_RATE_MAX = 100;
const CALLBACK_RATE_MAX = 20;
const SWEEP_INTERVAL_MAX_MS = 60 * 1000;
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function assertHttpBaseUrl(baseUrl, useAuth) {
  if (!baseUrl || !String(baseUrl).trim()) {
    throw new Error('MCP_BASE_URL is required');
  }

  let url;
  try {
    url = new URL(String(baseUrl).trim());
  } catch {
    throw new Error('MCP_BASE_URL must be a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP_BASE_URL must use http or https');
  }

  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('MCP_BASE_URL must use HTTPS unless the host is localhost or 127.0.0.1');
  }
  if (!useAuth && !loopback) {
    throw new Error('MCP_AUTH=false is only allowed when MCP_BASE_URL is localhost or 127.0.0.1');
  }

  return url;
}

function allowedHosts(url) {
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  const hosts = new Set([hostname, host]);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  hosts.add(`${hostname}:${port}`);
  return hosts;
}

function requestHost(req) {
  const host = req.headers.host;
  if (Array.isArray(host)) {
    return host[0];
  }
  return host;
}

function hostnameFromHostHeader(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(1, end);
  }
  return value.split(':')[0];
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function hostAllowlist(baseUrl) {
  const url = new URL(baseUrl);
  if (isLoopbackHostname(url.hostname)) {
    return (_req, _res, next) => next();
  }

  const allowed = allowedHosts(url);
  return (req, res, next) => {
    const host = requestHost(req);
    if (
      req.method === 'GET'
      && req.path === '/health'
      && isLoopbackHostname(hostnameFromHostHeader(host))
    ) {
      next();
      return;
    }
    if (!host || !allowed.has(String(host).toLowerCase())) {
      res.status(400).json({ error: 'Invalid Host header' });
      return;
    }
    next();
  };
}

function jsonErrorHandler(error, _req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }
  next(error);
}

function closeSession(sessions, id) {
  const session = sessions[id];
  if (!session) {
    return;
  }
  delete sessions[id];
  Promise.resolve(session.transport.close()).catch((error) => {
    console.error(`Failed to close session ${id}: ${error.message}`);
  });
}

function sweepExpiredSessions(sessions, idleMs, now = Date.now()) {
  for (const id of Object.keys(sessions)) {
    if (now - sessions[id].lastSeen >= idleMs) {
      closeSession(sessions, id);
    }
  }
}

function withScopeChallenge(middleware) {
  return (req, res, next) => {
    const originalSet = res.set.bind(res);
    res.set = (field, value) => {
      if (typeof field === 'string' && field.toLowerCase() === 'www-authenticate' && typeof value === 'string') {
        const header = value.includes('scope=') ? value : `${value}, scope="${MCP_SCOPE}"`;
        return originalSet(field, header);
      }
      return originalSet(field, value);
    };
    return middleware(req, res, next);
  };
}

function mountOAuth(app, { oauthProvider, issuerUrl, mcpUrl }) {
  const oauthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl,
    scopesSupported: [MCP_SCOPE],
  });
  oauthMetadata.issuer = issuerUrl.origin;
  oauthMetadata.client_id_metadata_document_supported = true;

  const protectedResourceMetadata = {
    resource: mcpUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: [MCP_SCOPE],
    resource_name: RESOURCE_NAME,
  };

  app.use(mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: mcpUrl,
    scopesSupported: [MCP_SCOPE],
    resourceName: RESOURCE_NAME,
  }));
  app.use('/.well-known/oauth-protected-resource', metadataHandler(protectedResourceMetadata));

  const authorizeLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: AUTHORIZE_RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/authorize', authorizeLimiter);
  app.use('/authorize', async (req, res, next) => {
    const clientId = req.query.client_id || req.body?.client_id;
    const redirectUri = req.query.redirect_uri || req.body?.redirect_uri;
    if (!clientId) {
      next();
      return;
    }
    try {
      await oauthProvider.ensureClient(
        String(clientId),
        redirectUri ? String(redirectUri) : undefined
      );
    } catch (error) {
      console.error(`CIMD lookup failed: ${error.message}`);
    }
    next();
  });
  app.use('/authorize', authorizationHandler({ provider: oauthProvider }));
  app.use('/token', tokenHandler({ provider: oauthProvider }));
  app.use('/register', clientRegistrationHandler({ clientsStore: oauthProvider.clientsStore }));
  app.use('/revoke', revocationHandler({ provider: oauthProvider }));

  const loginLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: CALLBACK_RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post('/authorize/callback', loginLimiter, async (req, res) => {
    const { pending_id: pendingId, secret } = req.body;
    if (!pendingId || !secret) {
      res.status(400).send('Missing required fields');
      return;
    }
    await oauthProvider.handleAuthCallback(pendingId, secret, res);
  });

  return withScopeChallenge(requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  }));
}

function createMcpHandler(sessions, { maxSessions, sessionIdleMs }) {
  return async (req, res) => {
    sweepExpiredSessions(sessions, sessionIdleMs);
    const sessionId = req.headers['mcp-session-id'];

    try {
      if (sessionId && sessions[sessionId]) {
        const session = sessions[sessionId];
        if (session.clientId && req.auth?.clientId !== session.clientId) {
          res.status(403).json({ error: 'Session belongs to a different client' });
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        if (Object.keys(sessions).length >= maxSessions) {
          res.status(429).json({ error: 'Too many sessions' });
          return;
        }

        const sid = randomUUID();
        const sessionServer = createMcpServer(sid.slice(0, 8));
        const sessionTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sid,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions[id] = {
              transport: sessionTransport,
              server: sessionServer,
              clientId: req.auth?.clientId,
              lastSeen: Date.now(),
            };
          },
        });
        sessionTransport.onclose = () => {
          const id = sessionTransport.sessionId;
          if (id) {
            delete sessions[id];
          }
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
}

export function createHttpApp({
  authSecret,
  baseUrl,
  useAuth = true,
  storePath,
  trustProxy = false,
  maxSessions = MAX_SESSIONS,
  sessionIdleMs = SESSION_IDLE_MS,
} = {}) {
  assertHttpBaseUrl(baseUrl, useAuth);
  if (useAuth && !authSecret) {
    throw new Error('MCP_AUTH_SECRET is required when auth is enabled');
  }

  const issuerUrl = toOriginUrl(baseUrl);
  const mcpUrl = mcpResourceUrl(baseUrl);
  const app = express();
  const sessions = Object.create(null);

  if (trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(securityHeaders);
  app.use(hostAllowlist(baseUrl));
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  let authMiddleware;
  if (useAuth) {
    const oauthProvider = new McpOAuthProvider({
      authSecret,
      resourceUrl: mcpUrl.href,
      storePath,
    });
    authMiddleware = mountOAuth(app, { oauthProvider, issuerUrl, mcpUrl });
    console.error(`OAuth enabled. Issuer: ${issuerUrl.origin}`);
  } else {
    console.error('Auth disabled (MCP_AUTH=false). WARNING: Server is unprotected.');
  }

  const mcpHandler = createMcpHandler(sessions, { maxSessions, sessionIdleMs });
  if (authMiddleware) {
    app.post('/mcp', authMiddleware, mcpHandler);
    app.get('/mcp', authMiddleware, mcpHandler);
    app.delete('/mcp', authMiddleware, mcpHandler);
  } else {
    app.post('/mcp', mcpHandler);
    app.get('/mcp', mcpHandler);
    app.delete('/mcp', mcpHandler);
  }

  app.use(jsonErrorHandler);

  const sweepMs = Math.min(Math.max(sessionIdleMs, 1000), SWEEP_INTERVAL_MAX_MS);
  const sweepTimer = setInterval(() => {
    sweepExpiredSessions(sessions, sessionIdleMs);
  }, sweepMs);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }

  function stop() {
    clearInterval(sweepTimer);
    for (const id of Object.keys(sessions)) {
      closeSession(sessions, id);
    }
  }

  return { app, sessions, issuerUrl, mcpUrl, stop };
}

export function startHttpServer(env = process.env) {
  const port = parseInt(env.MCP_PORT || '8080', 10);
  const useAuth = env.MCP_AUTH !== 'false';
  const authSecret = env.MCP_AUTH_SECRET;
  const baseUrl = typeof env.MCP_BASE_URL === 'string' ? env.MCP_BASE_URL.trim() : '';
  const trustProxy = env.MCP_TRUST_PROXY === 'true' || env.MCP_TRUST_PROXY === '1';

  if (!baseUrl) {
    console.error(
      'ERROR: MCP_BASE_URL is required.\n' +
      '  Set MCP_BASE_URL to the public origin (https://jw-mcp.example.com).'
    );
    process.exit(1);
  }

  if (useAuth && !authSecret) {
    console.error(
      'ERROR: MCP_AUTH_SECRET is required when auth is enabled.\n' +
      '  Set MCP_AUTH_SECRET to a strong secret (min 16 chars).\n' +
      '  Or set MCP_AUTH=false to disable auth (loopback only).'
    );
    process.exit(1);
  }

  let httpApp;
  try {
    httpApp = createHttpApp({
      authSecret,
      baseUrl,
      useAuth,
      storePath: env.AUTH_STORE_PATH,
      trustProxy,
    });
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }

  const { app, sessions, issuerUrl, mcpUrl, stop } = httpApp;

  const interval = setInterval(() => {
    const count = Object.keys(sessions).length;
    if (count > 0) {
      console.error(`Active MCP sessions: ${count}`);
    }
  }, 60000);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  const server = app.listen(port, () => {
    console.error(`JW MCP server listening on http://0.0.0.0:${port}`);
    console.error(`Health: http://0.0.0.0:${port}/health`);
    console.error(`MCP: ${mcpUrl.href}`);
    if (useAuth) {
      console.error(`OAuth metadata: ${issuerUrl.origin}/.well-known/oauth-authorization-server`);
    }
  });

  const shutdown = () => {
    clearInterval(interval);
    stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
