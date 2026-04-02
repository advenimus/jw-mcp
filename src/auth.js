import { randomUUID, createHash, timingSafeEqual } from "node:crypto";

function safeCompare(a, b) {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

class InMemoryClientsStore {
  constructor() {
    this.clients = new Map();
  }

  async getClient(clientId) {
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata) {
    this.clients.set(clientMetadata.client_id, clientMetadata);
    return clientMetadata;
  }
}

/**
 * OAuth 2.1 provider for MCP server authentication.
 *
 * Requires MCP_AUTH_SECRET — the authorize flow presents a login page
 * requiring this secret before granting access.
 */
export class McpOAuthProvider {
  constructor(authSecret, tokenLifetimeHours = 24) {
    if (!authSecret || authSecret.length < 8) {
      throw new Error(
        "MCP_AUTH_SECRET must be set and at least 8 characters for secure operation"
      );
    }
    this.clientsStore = new InMemoryClientsStore();
    this.codes = new Map();
    this.tokens = new Map();
    this.pendingAuths = new Map();
    this.tokenLifetimeMs = tokenLifetimeHours * 60 * 60 * 1000;
    this.authSecret = authSecret;
  }

  async authorize(client, params, res) {
    const pendingId = randomUUID();
    this.pendingAuths.set(pendingId, {
      client,
      params,
      createdAt: Date.now(),
    });

    // Clean up expired pending auths (older than 10 minutes)
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of this.pendingAuths) {
      if (value.createdAt < cutoff) this.pendingAuths.delete(key);
    }

    res.setHeader("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>JW MCP - Authorize</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
    .card { background: #1e293b; padding: 2rem; border-radius: 12px; max-width: 400px; width: 90%; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #f8fafc; }
    p { font-size: 0.875rem; color: #94a3b8; margin: 0 0 1.5rem; }
    label { display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: #cbd5e1; }
    input[type="password"] { width: 100%; padding: 0.75rem; border: 1px solid #334155; border-radius: 8px; background: #0f172a; color: #f8fafc; font-size: 1rem; box-sizing: border-box; }
    input[type="password"]:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
    button { width: 100%; padding: 0.75rem; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 1rem; }
    button:hover { background: #2563eb; }
    .client-info { font-size: 0.75rem; color: #64748b; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="card">
    <h1>JW MCP Server</h1>
    <p>Enter the server access key to authorize this connection.</p>
    <form method="POST" action="/authorize/callback">
      <input type="hidden" name="pending_id" value="${pendingId}">
      <label for="secret">Access Key</label>
      <input type="password" id="secret" name="secret" placeholder="Enter access key" required autofocus>
      <button type="submit">Authorize</button>
    </form>
    <div class="client-info">Client: ${client.client_name || client.client_id}</div>
  </div>
</body>
</html>`);
  }

  async handleAuthCallback(pendingId, secret, res) {
    const pending = this.pendingAuths.get(pendingId);
    if (!pending) {
      res.status(400).send("Authorization request expired. Please try again.");
      return;
    }

    if (!safeCompare(secret, this.authSecret)) {
      this.pendingAuths.delete(pendingId);
      res.status(403).send(`<!DOCTYPE html>
<html>
<head>
  <title>Access Denied</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
    .card { background: #1e293b; padding: 2rem; border-radius: 12px; max-width: 400px; width: 90%; text-align: center; }
    h1 { color: #f87171; font-size: 1.25rem; }
    p { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Access Denied</h1>
    <p>Invalid access key. Connection rejected.</p>
  </div>
</body>
</html>`);
      return;
    }

    // Secret valid — issue auth code
    this.pendingAuths.delete(pendingId);
    const code = randomUUID();
    this.codes.set(code, {
      client: pending.client,
      params: pending.params,
      createdAt: Date.now(),
    });

    const redirectUrl = new URL(pending.params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (pending.params.state !== undefined) {
      redirectUrl.searchParams.set("state", pending.params.state);
    }

    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error("Invalid authorization code");
    }
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error("Invalid authorization code");
    }
    if (codeData.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }

    // Auth codes expire after 10 minutes
    if (Date.now() - codeData.createdAt > 10 * 60 * 1000) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code expired");
    }

    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();

    this.tokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
      expiresAt: Date.now() + this.tokenLifetimeMs,
      resource: codeData.params.resource,
    });

    this.tokens.set(refreshToken, {
      token: refreshToken,
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
      resource: codeData.params.resource,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(this.tokenLifetimeMs / 1000),
      refresh_token: refreshToken,
      scope: (codeData.params.scopes || []).join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, _scopes, _resource) {
    const tokenData = this.tokens.get(refreshToken);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new Error("Invalid or expired refresh token");
    }
    if (tokenData.clientId !== client.client_id) {
      throw new Error("Refresh token was not issued to this client");
    }

    const newAccessToken = randomUUID();
    this.tokens.set(newAccessToken, {
      token: newAccessToken,
      clientId: client.client_id,
      scopes: tokenData.scopes,
      expiresAt: Date.now() + this.tokenLifetimeMs,
      resource: tokenData.resource,
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: Math.floor(this.tokenLifetimeMs / 1000),
      refresh_token: refreshToken,
      scope: tokenData.scopes.join(" "),
    };
  }

  async verifyAccessToken(token) {
    const tokenData = this.tokens.get(token);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new Error("Invalid or expired token");
    }
    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000), // seconds, not ms
      resource: tokenData.resource,
    };
  }

  async revokeToken(_client, request) {
    this.tokens.delete(request.token);
  }
}
