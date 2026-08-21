import { createServer } from 'node:net';
import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../src/http-server.js';
import { DEFAULT_CONTENT_SECURITY_POLICY as CSP } from '../src/auth/csp.js';
import { completeOAuthHandshake, mcpRpc } from './handshake.js';

const SECRET = 'test-secret-value';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function initializeMessage(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'jw-mcp-test', version: '0.0.0' },
    },
  };
}

function assertSecurityHeaders(headers) {
  const get = typeof headers.get === 'function'
    ? (name) => headers.get(name)
    : (name) => headers[name];
  assert.equal(get('x-frame-options'), 'DENY');
  assert.equal(get('x-content-type-options'), 'nosniff');
  assert.equal(get('referrer-policy'), 'no-referrer');
  assert.equal(get('content-security-policy'), CSP);
}

function rawRequest({ port, path = '/health', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startTestServer(options = {}) {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const created = createHttpApp({
    authSecret: SECRET,
    baseUrl: origin,
    useAuth: true,
    ...options,
  });
  const server = created.app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    port,
    ...created,
    server,
    async close() {
      created.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('HTTP OAuth MCP server', () => {
  let server;
  let origin;
  let mcpUrl;
  let stop;

  before(async () => {
    const port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    mcpUrl = `${origin}/mcp`;
    const created = createHttpApp({
      authSecret: SECRET,
      baseUrl: origin,
      useAuth: true,
    });
    stop = created.stop;
    server = created.app.listen(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  });

  after(async () => {
    if (stop) {
      stop();
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('serves health without auth', async () => {
    const response = await fetch(`${origin}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: 'ok' });
  });

  it('sets security headers on /health', async () => {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assertSecurityHeaders(response.headers);
  });

  it('sets security headers on /authorize', async () => {
    const response = await fetch(`${origin}/authorize`);
    assertSecurityHeaders(response.headers);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  });

  it('allows the client redirect origin in login page CSP', async () => {
    const redirectUri = `${origin}/oauth/callback`;
    const registerResponse = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'csp-test',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    assert.equal(registerResponse.ok, true);
    const client = await registerResponse.json();

    const authorizeUrl = new URL('/authorize', origin);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('code_challenge', 'A'.repeat(43));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('resource', mcpUrl);

    const loginResponse = await fetch(authorizeUrl);
    assert.equal(loginResponse.status, 200);
    const csp = loginResponse.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, new RegExp(`form-action 'self' ${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:;|$)`));
  });

  it('rate-limits /authorize before CIMD lookup', async () => {
    const response = await fetch(`${origin}/authorize?client_id=not-a-cimd-client`);
    const limit = response.headers.get('ratelimit-limit');
    assert.ok(limit);
    assert.equal(Number(limit) <= 100, true);
  });

  it('reflects CORS Origin without credentials', async () => {
    const response = await fetch(`${origin}/health`, {
      headers: { Origin: 'https://chatgpt.com' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  });

  it('challenges unauthenticated MCP requests', async () => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(response.status, 401);
    const challenge = response.headers.get('www-authenticate') || '';
    assert.match(challenge, /resource_metadata=/);
    assert.match(challenge, /scope="mcp:tools"/);
    assert.match(challenge, /oauth-protected-resource\/mcp/);
    assertSecurityHeaders(response.headers);
  });

  it('rejects oversized JSON bodies', async () => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(300_000) }),
    });
    assert.equal(response.status, 413);
  });

  it('advertises protected resource metadata for /mcp', async () => {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.resource, mcpUrl);
    assert.deepEqual(body.authorization_servers, [origin]);
  });

  it('advertises root protected resource metadata too', async () => {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.resource, mcpUrl);
  });

  it('advertises authorization server metadata for public clients and CIMD', async () => {
    const response = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    assert.ok(body.token_endpoint_auth_methods_supported.includes('none'));
    assert.equal(body.client_id_metadata_document_supported, true);
    assert.ok(body.registration_endpoint);
  });

  it('completes DCR + PKCE and lists MCP tools', async () => {
    const { tokens } = await completeOAuthHandshake(origin, SECRET);
    const init = await mcpRpc(mcpUrl, tokens.access_token, undefined, initializeMessage(1));
    assert.equal(init.status, 200);
    assert.ok(init.sessionId);
    assert.equal(init.body.result.serverInfo.name, 'jw-mcp');

    const initialized = await mcpRpc(mcpUrl, tokens.access_token, init.sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.ok(initialized.status === 200 || initialized.status === 202);

    const tools = await mcpRpc(mcpUrl, tokens.access_token, init.sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.equal(tools.status, 200);
    const names = tools.body.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('search_bible_books'));
    assert.ok(names.includes('get_bible_verse'));
  });

  it('rejects a refresh token used as a bearer token', async () => {
    const { tokens } = await completeOAuthHandshake(origin, SECRET);
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.refresh_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(response.status, 401);
  });

  it('rejects mcp-session-id reuse by a different client', async () => {
    const clientA = await completeOAuthHandshake(origin, SECRET);
    const clientB = await completeOAuthHandshake(origin, SECRET);
    const init = await mcpRpc(mcpUrl, clientA.tokens.access_token, undefined, initializeMessage(1));
    assert.equal(init.status, 200);
    assert.ok(init.sessionId);

    const hijack = await mcpRpc(mcpUrl, clientB.tokens.access_token, init.sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.equal(hijack.status, 403);
  });
});

describe('HTTP app configuration', () => {
  it('does not trust proxy by default', () => {
    const { app, stop } = createHttpApp({
      authSecret: SECRET,
      baseUrl: 'http://127.0.0.1:8080',
      useAuth: true,
    });
    try {
      assert.equal(app.get('trust proxy'), false);
    } finally {
      stop();
    }
  });

  it('trusts the first proxy hop when trustProxy is true', () => {
    const { app, stop } = createHttpApp({
      authSecret: SECRET,
      baseUrl: 'http://127.0.0.1:8080',
      useAuth: true,
      trustProxy: true,
    });
    try {
      assert.equal(app.get('trust proxy'), 1);
    } finally {
      stop();
    }
  });

  it('requires MCP_BASE_URL', () => {
    assert.throws(
      () => createHttpApp({ authSecret: SECRET, useAuth: true }),
      /MCP_BASE_URL/
    );
  });

  it('rejects http base URLs that are not loopback', () => {
    assert.throws(
      () => createHttpApp({
        authSecret: SECRET,
        baseUrl: 'http://example.com',
        useAuth: true,
      }),
      /HTTPS/
    );
  });

  it('rejects MCP_AUTH=false on a public host', () => {
    assert.throws(
      () => createHttpApp({
        useAuth: false,
        baseUrl: 'https://example.com',
      }),
      /localhost|127\.0\.0\.1/
    );
  });

  it('allows MCP_AUTH=false on loopback', () => {
    const { stop } = createHttpApp({
      useAuth: false,
      baseUrl: 'http://127.0.0.1:8080',
    });
    stop();
  });
});

describe('HTTP session limits', () => {
  it('rejects new initialize requests when the session cap is reached', async () => {
    const ctx = await startTestServer({ maxSessions: 1 });
    try {
      const { tokens } = await completeOAuthHandshake(ctx.origin, SECRET);
      const first = await mcpRpc(ctx.mcpUrl, tokens.access_token, undefined, initializeMessage(1));
      assert.equal(first.status, 200);
      const second = await mcpRpc(ctx.mcpUrl, tokens.access_token, undefined, initializeMessage(2));
      assert.equal(second.status, 429);
    } finally {
      await ctx.close();
    }
  });

  it('expires idle sessions', async () => {
    const ctx = await startTestServer({ sessionIdleMs: 30 });
    try {
      const { tokens } = await completeOAuthHandshake(ctx.origin, SECRET);
      const init = await mcpRpc(ctx.mcpUrl, tokens.access_token, undefined, initializeMessage(1));
      assert.equal(init.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const tools = await mcpRpc(ctx.mcpUrl, tokens.access_token, init.sessionId, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      assert.equal(tools.status, 400);
    } finally {
      await ctx.close();
    }
  });

  it('serves MCP without auth on loopback when auth is disabled', async () => {
    const ctx = await startTestServer({ useAuth: false });
    try {
      const init = await mcpRpc(ctx.mcpUrl, undefined, undefined, initializeMessage(1));
      assert.equal(init.status, 200);
      assert.ok(init.sessionId);
    } finally {
      await ctx.close();
    }
  });
});

describe('Host header allowlist', () => {
  it('rejects unexpected Host headers when baseUrl is not loopback', async () => {
    const ctx = await startTestServer({ baseUrl: 'https://jw-mcp.example.com' });
    try {
      const denied = await rawRequest({
        port: ctx.port,
        headers: { Host: 'evil.example' },
      });
      assert.equal(denied.status, 400);

      const allowed = await rawRequest({
        port: ctx.port,
        headers: { Host: 'jw-mcp.example.com' },
      });
      assert.equal(allowed.status, 200);
      assert.deepEqual(JSON.parse(allowed.body), { status: 'ok' });
      assertSecurityHeaders(allowed.headers);

      const allowedWithPort = await rawRequest({
        port: ctx.port,
        headers: { Host: 'jw-mcp.example.com:443' },
      });
      assert.equal(allowedWithPort.status, 200);

      const loopbackHealth = await rawRequest({
        port: ctx.port,
        headers: { Host: '127.0.0.1:8080' },
      });
      assert.equal(loopbackHealth.status, 200);

      const loopbackAuthorize = await rawRequest({
        port: ctx.port,
        path: '/authorize',
        headers: { Host: '127.0.0.1:8080' },
      });
      assert.equal(loopbackAuthorize.status, 400);
    } finally {
      await ctx.close();
    }
  });
});
