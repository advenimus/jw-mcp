export function mockRes() {
  return {
    headers: {},
    statusCode: 200,
    body: '',
    redirectUrl: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send(body) {
      this.body = body;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    redirect(url) {
      this.redirectUrl = url;
      this.statusCode = 302;
      return this;
    },
  };
}

export function testClient(overrides = {}) {
  return {
    client_id: 'test-client',
    client_name: 'Test Client',
    redirect_uris: ['http://localhost:9999/callback'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

export function authParams(overrides = {}) {
  return {
    state: 'state-123',
    scopes: ['mcp:tools'],
    redirectUri: 'http://localhost:9999/callback',
    codeChallenge: 'pkce-challenge',
    resource: new URL('http://localhost:8080/mcp'),
    ...overrides,
  };
}

export function pendingIdFromLoginHtml(html) {
  const match = String(html).match(/name="pending_id" value="([^"]+)"/);
  if (!match) {
    throw new Error('pending_id not found in login HTML');
  }
  return match[1];
}

export function codeFromRedirect(url) {
  return new URL(url).searchParams.get('code');
}
