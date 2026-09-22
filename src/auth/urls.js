export function canonicalizeResourceUrl(value) {
  if (!value) {
    return undefined;
  }

  const url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.href;
}

export function originUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return new URL(url.origin);
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Claude.ai never contacts custom connectors on non-443 ports, and it only reports "couldn't reach".
export function connectorPortWarning(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.port === '' || isLoopbackHostname(url.hostname)) {
    return null;
  }
  return `MCP_BASE_URL uses port ${url.port}. Claude.ai connectors only connect on port 443, `
    + 'so Claude will fail with "Couldn\'t reach the MCP server". Serve the public URL on 443 '
    + '(for example with a Cloudflare Tunnel) and leave the port out of MCP_BASE_URL.';
}

export function mcpResourceUrl(baseUrl) {
  const origin = originUrl(baseUrl);
  const source = new URL(baseUrl);
  if (source.pathname && source.pathname !== '/') {
    return new URL(canonicalizeResourceUrl(source));
  }
  return new URL('/mcp', origin);
}
