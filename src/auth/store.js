import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function copyClient(client) {
  return {
    ...client,
    redirect_uris: [...(client.redirect_uris ?? [])],
  };
}

function copyToken(token) {
  return {
    ...token,
    scopes: [...(token.scopes ?? [])],
  };
}

export function createAuthState(storePath) {
  const state = {
    clients: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
  };

  if (storePath && existsSync(storePath)) {
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    for (const [id, client] of raw.clients ?? []) {
      state.clients.set(id, copyClient(client));
    }
    for (const [token, data] of raw.accessTokens ?? []) {
      state.accessTokens.set(token, copyToken(data));
    }
    for (const [token, data] of raw.refreshTokens ?? []) {
      state.refreshTokens.set(token, copyToken(data));
    }
  }

  function persist() {
    if (!storePath) {
      return;
    }
    mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      clients: [...state.clients.entries()],
      accessTokens: [...state.accessTokens.entries()],
      refreshTokens: [...state.refreshTokens.entries()],
    });
    const tmp = `${storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, storePath);
    chmodSync(storePath, 0o600);
  }

  return { state, persist };
}

export class InMemoryClientsStore {
  constructor(clients, persist = () => {}) {
    this.clients = clients;
    this.persist = persist;
  }

  async getClient(clientId) {
    const client = this.clients.get(clientId);
    return client ? copyClient(client) : undefined;
  }

  async registerClient(clientMetadata) {
    const stored = copyClient(clientMetadata);
    this.clients.set(stored.client_id, stored);
    this.persist();
    return copyClient(stored);
  }
}

export class TokenStore {
  constructor(state, persist = () => {}) {
    this.state = state;
    this.persist = persist;
  }

  saveAccess(token, data) {
    const next = new Map(this.state.accessTokens);
    next.set(token, copyToken(data));
    this.state.accessTokens = next;
    this.persist();
  }

  saveRefresh(token, data) {
    const next = new Map(this.state.refreshTokens);
    next.set(token, copyToken(data));
    this.state.refreshTokens = next;
    this.persist();
  }

  getAccess(token) {
    const data = this.state.accessTokens.get(token);
    return data ? copyToken(data) : undefined;
  }

  getRefresh(token) {
    const data = this.state.refreshTokens.get(token);
    return data ? copyToken(data) : undefined;
  }

  deleteAccess(token) {
    if (!this.state.accessTokens.has(token)) {
      return;
    }
    const next = new Map(this.state.accessTokens);
    next.delete(token);
    this.state.accessTokens = next;
    this.persist();
  }

  deleteRefresh(token) {
    if (!this.state.refreshTokens.has(token)) {
      return;
    }
    const next = new Map(this.state.refreshTokens);
    next.delete(token);
    this.state.refreshTokens = next;
    this.persist();
  }

  rotateRefresh(oldRefresh, newAccess, newRefresh, accessData, refreshData) {
    const accessTokens = new Map(this.state.accessTokens);
    const refreshTokens = new Map(this.state.refreshTokens);
    refreshTokens.delete(oldRefresh);
    accessTokens.set(newAccess, copyToken(accessData));
    refreshTokens.set(newRefresh, copyToken(refreshData));
    this.state.accessTokens = accessTokens;
    this.state.refreshTokens = refreshTokens;
    this.persist();
  }
}
