import { randomUUID } from 'node:crypto';
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  ACCESS_TOKEN_LIFETIME_MS,
  AUTH_CODE_LIFETIME_MS,
  CIMD_REVALIDATE_MS,
  MCP_SCOPE,
  MIN_SECRET_LENGTH,
  PENDING_AUTH_LIFETIME_MS,
  REFRESH_TOKEN_LIFETIME_MS,
} from './constants.js';
import { fetchClientIdMetadata, isHttpsClientId } from './cimd.js';
import { renderDeniedPage, renderLoginPage } from './login-page.js';
import { safeCompare } from './safe-compare.js';
import { createAuthState, InMemoryClientsStore, TokenStore } from './store.js';
import { canonicalizeResourceUrl } from './urls.js';

function normalizeOptions(authSecretOrOptions, tokenLifetimeHours) {
  if (typeof authSecretOrOptions === 'string') {
    return { authSecret: authSecretOrOptions, tokenLifetimeHours };
  }
  return { tokenLifetimeHours: 24, ...authSecretOrOptions };
}

function copyClient(client) {
  return {
    ...client,
    redirect_uris: [...(client.redirect_uris ?? [])],
  };
}

function copyAuthParams(params) {
  return {
    ...params,
    scopes: Array.isArray(params.scopes) ? [...params.scopes] : [],
  };
}

function grantScopes(requested) {
  const scopes = Array.isArray(requested) ? [...requested] : [];
  if (scopes.includes(MCP_SCOPE)) {
    return scopes;
  }
  return [...scopes, MCP_SCOPE];
}

function cimdRecord(metadata, fetchedAt) {
  return {
    ...metadata,
    redirect_uris: [...metadata.redirect_uris],
    token_endpoint_auth_method: metadata.token_endpoint_auth_method || 'none',
    fetchedAt,
  };
}

function isStaleCimd(client, now) {
  if (!isHttpsClientId(client.client_id)) {
    return false;
  }
  return now - (client.fetchedAt ?? 0) > CIMD_REVALIDATE_MS;
}

export class McpOAuthProvider {
  constructor(authSecretOrOptions, tokenLifetimeHours = 24) {
    const options = normalizeOptions(authSecretOrOptions, tokenLifetimeHours);
    const authSecret = options.authSecret;

    if (!authSecret || authSecret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `MCP_AUTH_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters for secure operation`
      );
    }

    const { state, persist } = createAuthState(options.storePath);
    this.clientsStore = new InMemoryClientsStore(state.clients, persist);
    this.tokens = new TokenStore(state, persist);
    this.codes = new Map();
    this.pendingAuths = new Map();
    this.tokenLifetimeMs = (options.tokenLifetimeHours ?? 24) * 60 * 60 * 1000
      || ACCESS_TOKEN_LIFETIME_MS;
    this.authSecret = authSecret;
    this.resourceUrl = canonicalizeResourceUrl(options.resourceUrl);
    this.now = options.now ?? (() => Date.now());
    this.cimdOptions = options.cimd ?? {};
  }

  async ensureClient(clientId, _redirectUri) {
    if (!clientId) {
      return undefined;
    }

    const existing = await this.clientsStore.getClient(clientId);
    if (existing && !isStaleCimd(existing, this.now())) {
      return existing;
    }

    if (!isHttpsClientId(clientId)) {
      return existing;
    }

    try {
      const metadata = await fetchClientIdMetadata(clientId, this.cimdOptions);
      return await this.clientsStore.registerClient(cimdRecord(metadata, this.now()));
    } catch (error) {
      if (existing) {
        return existing;
      }
      throw error;
    }
  }

  async authorize(client, params, res) {
    const pendingId = randomUUID();
    this.pendingAuths.set(pendingId, {
      client: copyClient(client),
      params: copyAuthParams(params),
      createdAt: this.now(),
    });

    const cutoff = this.now() - PENDING_AUTH_LIFETIME_MS;
    for (const [key, value] of this.pendingAuths) {
      if (value.createdAt < cutoff) {
        this.pendingAuths.delete(key);
      }
    }

    let redirectHostname;
    try {
      redirectHostname = new URL(params.redirectUri).hostname;
    } catch {
      redirectHostname = undefined;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(renderLoginPage({
      pendingId,
      clientName: client.client_name || client.client_id,
      redirectHostname,
    }));
  }

  async handleAuthCallback(pendingId, secret, res) {
    const pending = this.pendingAuths.get(pendingId);
    if (!pending || this.now() - pending.createdAt > PENDING_AUTH_LIFETIME_MS) {
      this.pendingAuths.delete(pendingId);
      res.status(400).send('Authorization request expired. Please try again.');
      return;
    }

    if (!safeCompare(secret, this.authSecret)) {
      this.pendingAuths.delete(pendingId);
      res.status(403).send(renderDeniedPage());
      return;
    }

    this.pendingAuths.delete(pendingId);
    const code = randomUUID();
    this.codes.set(code, {
      client: copyClient(pending.client),
      params: copyAuthParams(pending.params),
      createdAt: this.now(),
    });

    const redirectUrl = new URL(pending.params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (pending.params.state !== undefined) {
      redirectUrl.searchParams.set('state', pending.params.state);
    }

    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, _redirectUri, resource) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    if (codeData.client.client_id !== client.client_id) {
      throw new InvalidGrantError('Authorization code was not issued to this client');
    }

    if (this.now() - codeData.createdAt > AUTH_CODE_LIFETIME_MS) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('Authorization code expired');
    }

    if (_redirectUri !== undefined && _redirectUri !== codeData.params.redirectUri) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('redirect_uri does not match authorization request');
    }

    this.codes.delete(authorizationCode);

    const requested = canonicalizeResourceUrl(resource ?? codeData.params.resource);
    if (this.resourceUrl && requested && requested !== this.resourceUrl) {
      throw new InvalidGrantError('Resource does not match this server');
    }
    const boundResource = this.resourceUrl || requested;

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const scopes = grantScopes(codeData.params.scopes);

    this.tokens.saveAccess(accessToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: this.now() + this.tokenLifetimeMs,
      resource: boundResource,
    });
    this.tokens.saveRefresh(refreshToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: this.now() + REFRESH_TOKEN_LIFETIME_MS,
      resource: boundResource,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: Math.floor(this.tokenLifetimeMs / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    const tokenData = this.tokens.getRefresh(refreshToken);
    if (!tokenData || tokenData.expiresAt < this.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (tokenData.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was not issued to this client');
    }

    const requested = canonicalizeResourceUrl(resource);
    if (this.resourceUrl && requested && requested !== this.resourceUrl) {
      throw new InvalidGrantError('Resource does not match this server');
    }

    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const scopes = grantScopes(tokenData.scopes);
    this.tokens.rotateRefresh(
      refreshToken,
      newAccessToken,
      newRefreshToken,
      {
        clientId: client.client_id,
        scopes,
        expiresAt: this.now() + this.tokenLifetimeMs,
        resource: tokenData.resource,
      },
      {
        clientId: client.client_id,
        scopes,
        expiresAt: this.now() + REFRESH_TOKEN_LIFETIME_MS,
        resource: tokenData.resource,
      }
    );

    return {
      access_token: newAccessToken,
      token_type: 'bearer',
      expires_in: Math.floor(this.tokenLifetimeMs / 1000),
      refresh_token: newRefreshToken,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token) {
    const tokenData = this.tokens.getAccess(token);
    if (!tokenData || tokenData.expiresAt < this.now()) {
      throw new InvalidTokenError('Invalid or expired token');
    }
    if (this.resourceUrl && tokenData.resource && tokenData.resource !== this.resourceUrl) {
      throw new InvalidTokenError('Token was not issued for this resource');
    }
    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource,
    };
  }

  async revokeToken(_client, request) {
    this.tokens.deleteAccess(request.token);
    this.tokens.deleteRefresh(request.token);
  }
}
