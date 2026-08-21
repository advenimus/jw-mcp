import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { McpOAuthProvider } from '../../src/auth.js';
import {
  mockRes,
  testClient,
  authParams,
  pendingIdFromLoginHtml,
  codeFromRedirect,
} from '../helpers.js';

const SECRET = 'test-secret-value';
const RESOURCE = 'http://localhost:8080/mcp';

function createProvider(overrides = {}) {
  return new McpOAuthProvider({
    authSecret: SECRET,
    resourceUrl: RESOURCE,
    ...overrides,
  });
}

async function issueTokens(provider, client = testClient()) {
  await provider.clientsStore.registerClient(client);
  const login = mockRes();
  await provider.authorize(client, authParams(), login);
  const pendingId = pendingIdFromLoginHtml(login.body);
  const callback = mockRes();
  await provider.handleAuthCallback(pendingId, SECRET, callback);
  const code = codeFromRedirect(callback.redirectUrl);
  return provider.exchangeAuthorizationCode(client, code);
}

describe('McpOAuthProvider', () => {
  it('rejects secrets shorter than 16 characters', () => {
    assert.throws(
      () => new McpOAuthProvider({ authSecret: 'short' }),
      /at least 16 characters/
    );
  });

  it('escapes client names on the login page', async () => {
    const provider = createProvider();
    const client = testClient({ client_name: '<script>alert(1)</script>' });
    const res = mockRes();
    await provider.authorize(client, authParams(), res);
    assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(res.body, /<script>alert\(1\)<\/script>/);
  });

  it('rejects a wrong access key', async () => {
    const provider = createProvider();
    const client = testClient();
    const login = mockRes();
    await provider.authorize(client, authParams(), login);
    const pendingId = pendingIdFromLoginHtml(login.body);
    const callback = mockRes();
    await provider.handleAuthCallback(pendingId, 'wrong-secret', callback);
    assert.equal(callback.statusCode, 403);
    assert.equal(callback.redirectUrl, null);
  });

  it('issues a code and preserves state after a valid access key', async () => {
    const provider = createProvider();
    const client = testClient();
    await provider.clientsStore.registerClient(client);
    const login = mockRes();
    await provider.authorize(client, authParams(), login);
    const callback = mockRes();
    await provider.handleAuthCallback(pendingIdFromLoginHtml(login.body), SECRET, callback);
    assert.equal(callback.statusCode, 302);
    const redirect = new URL(callback.redirectUrl);
    assert.ok(redirect.searchParams.get('code'));
    assert.equal(redirect.searchParams.get('state'), 'state-123');
  });

  it('rejects pending auths older than 10 minutes on callback', async () => {
    let now = Date.now();
    const provider = createProvider({ now: () => now });
    const client = testClient();
    const login = mockRes();
    await provider.authorize(client, authParams(), login);
    const pendingId = pendingIdFromLoginHtml(login.body);
    now += 11 * 60 * 1000;
    const callback = mockRes();
    await provider.handleAuthCallback(pendingId, SECRET, callback);
    assert.equal(callback.statusCode, 400);
    assert.equal(callback.redirectUrl, null);
  });

  it('always grants mcp:tools even when authorize requested none', async () => {
    const provider = createProvider();
    const client = testClient();
    await provider.clientsStore.registerClient(client);
    const login = mockRes();
    await provider.authorize(client, authParams({ scopes: [] }), login);
    const callback = mockRes();
    await provider.handleAuthCallback(pendingIdFromLoginHtml(login.body), SECRET, callback);
    const code = codeFromRedirect(callback.redirectUrl);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    assert.match(tokens.scope, /mcp:tools/);
    const info = await provider.verifyAccessToken(tokens.access_token);
    assert.ok(info.scopes.includes('mcp:tools'));
  });

  it('rejects token exchange when redirect_uri does not match', async () => {
    const provider = createProvider();
    const client = testClient();
    await provider.clientsStore.registerClient(client);
    const login = mockRes();
    await provider.authorize(client, authParams(), login);
    const callback = mockRes();
    await provider.handleAuthCallback(pendingIdFromLoginHtml(login.body), SECRET, callback);
    const code = codeFromRedirect(callback.redirectUrl);
    await assert.rejects(
      () => provider.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        'http://evil.example/callback'
      ),
      InvalidGrantError
    );
  });

  it('expires authorization codes after 10 minutes', async () => {
    let now = Date.now();
    const provider = createProvider({ now: () => now });
    const client = testClient();
    await provider.clientsStore.registerClient(client);
    const login = mockRes();
    await provider.authorize(client, authParams(), login);
    const callback = mockRes();
    await provider.handleAuthCallback(pendingIdFromLoginHtml(login.body), SECRET, callback);
    const code = codeFromRedirect(callback.redirectUrl);
    now += 11 * 60 * 1000;
    await assert.rejects(
      () => provider.exchangeAuthorizationCode(client, code),
      InvalidGrantError
    );
  });

  it('returns expiresAt in seconds for access tokens', async () => {
    const provider = createProvider();
    const tokens = await issueTokens(provider);
    const info = await provider.verifyAccessToken(tokens.access_token);
    assert.equal(typeof info.expiresAt, 'number');
    assert.ok(info.expiresAt < 1e12, 'expiresAt must be seconds, not milliseconds');
    assert.equal(info.resource, RESOURCE);
  });

  it('does not accept a refresh token as an access token', async () => {
    const provider = createProvider();
    const tokens = await issueTokens(provider);
    await assert.rejects(
      () => provider.verifyAccessToken(tokens.refresh_token),
      InvalidTokenError
    );
  });

  it('rotates refresh tokens and rejects the old one', async () => {
    const provider = createProvider();
    const client = testClient();
    const first = await issueTokens(provider, client);
    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token);
    assert.notEqual(rotated.refresh_token, first.refresh_token);
    await provider.verifyAccessToken(rotated.access_token);
    await assert.rejects(
      () => provider.exchangeRefreshToken(client, first.refresh_token),
      InvalidGrantError
    );
  });

  it('rejects tokens issued for a different resource', async () => {
    const provider = createProvider({ resourceUrl: RESOURCE });
    const client = testClient();
    await provider.clientsStore.registerClient(client);
    const login = mockRes();
    await provider.authorize(
      client,
      authParams({ resource: new URL('https://evil.example/mcp') }),
      login
    );
    const callback = mockRes();
    await provider.handleAuthCallback(pendingIdFromLoginHtml(login.body), SECRET, callback);
    const code = codeFromRedirect(callback.redirectUrl);
    await assert.rejects(
      () => provider.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        undefined,
        new URL('https://evil.example/mcp')
      ),
      InvalidGrantError
    );
  });

  it('reloads clients and tokens from the file store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jw-mcp-auth-'));
    const storePath = join(dir, 'auth.json');
    try {
      const first = createProvider({ storePath });
      const tokens = await issueTokens(first);
      const second = createProvider({ storePath });
      const info = await second.verifyAccessToken(tokens.access_token);
      assert.equal(info.clientId, 'test-client');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the auth store with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jw-mcp-auth-'));
    const storePath = join(dir, 'auth.json');
    try {
      await issueTokens(createProvider({ storePath }));
      const info = await stat(storePath);
      assert.equal(info.mode & 0o777, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
