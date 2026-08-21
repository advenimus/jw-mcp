import { createHash, randomBytes } from 'node:crypto';
import { pendingIdFromLoginHtml } from './helpers.js';

function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got: ${text.slice(0, 400)}`);
  }
}

export async function completeOAuthHandshake(origin, secret) {
  const mcpUrl = `${origin}/mcp`;
  const redirectUri = `${origin}/oauth/callback`;
  const pkce = createPkce();

  const registerResponse = await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'jw-mcp-test',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (!registerResponse.ok) {
    throw new Error(`DCR failed: ${registerResponse.status} ${await registerResponse.text()}`);
  }
  const client = await readJson(registerResponse);

  const authorizeUrl = new URL('/authorize', origin);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', 'test-state');
  authorizeUrl.searchParams.set('resource', mcpUrl);
  authorizeUrl.searchParams.set('scope', 'mcp:tools');

  const loginResponse = await fetch(authorizeUrl);
  if (!loginResponse.ok) {
    throw new Error(`Authorize failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }
  const loginHtml = await loginResponse.text();
  const pendingId = pendingIdFromLoginHtml(loginHtml);

  const callbackResponse = await fetch(`${origin}/authorize/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending_id: pendingId, secret }),
    redirect: 'manual',
  });
  const location = callbackResponse.headers.get('location');
  if (!location) {
    throw new Error(`Auth callback missing redirect (${callbackResponse.status})`);
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) {
    throw new Error(`Auth callback missing code: ${location}`);
  }

  const tokenResponse = await fetch(`${origin}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce.verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      resource: mcpUrl,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  const tokens = await readJson(tokenResponse);
  return { client, tokens, mcpUrl };
}

export async function mcpRpc(mcpUrl, token, sessionId, message) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    sessionId: response.headers.get('mcp-session-id') || sessionId,
  };
}
