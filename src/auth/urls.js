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

export function mcpResourceUrl(baseUrl) {
  const origin = originUrl(baseUrl);
  const source = new URL(baseUrl);
  if (source.pathname && source.pathname !== '/') {
    return new URL(canonicalizeResourceUrl(source));
  }
  return new URL('/mcp', origin);
}
