import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { CIMD_FETCH_TIMEOUT_MS, CIMD_MAX_BYTES } from './constants.js';

const PRIVATE_V4_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
];

export function isHttpsClientId(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.pathname.length > 1
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export function isLoopbackRedirectMatch(registeredUris, requested) {
  let requestedUrl;
  try {
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }

  if (requestedUrl.protocol !== 'http:' || !isLoopbackHost(requestedUrl.hostname)) {
    return false;
  }

  return registeredUris.some((registered) => {
    try {
      const registeredUrl = new URL(registered);
      return registeredUrl.protocol === 'http:'
        && isLoopbackHost(registeredUrl.hostname)
        && registeredUrl.pathname === requestedUrl.pathname;
    } catch {
      return false;
    }
  });
}

export function isAllowedRedirectUri(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    if (url.protocol === 'javascript:' || url.protocol === 'data:' || url.protocol === 'file:') {
      return false;
    }
    if (url.protocol === 'https:') {
      return true;
    }
    if (url.protocol === 'http:') {
      return isLoopbackHost(url.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  return PRIVATE_V4_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function parseHextet(part) {
  if (!part || part.length > 4 || !/^[0-9a-f]+$/.test(part)) {
    return null;
  }
  return Number.parseInt(part, 16);
}

function parseIpv6Hextets(ip) {
  if (typeof ip !== 'string' || ip.length === 0) {
    return null;
  }

  let value = ip.toLowerCase();
  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) {
    value = value.slice(0, zoneIndex);
  }

  let ipv4 = null;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon === -1) {
      return null;
    }
    ipv4 = value.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) {
      return null;
    }
    value = value.slice(0, lastColon);
  }

  if (value.includes(':::')) {
    return null;
  }

  const sides = value.split('::');
  if (sides.length > 2) {
    return null;
  }

  const parseSide = (side) => (side === '' ? [] : side.split(':'));
  const headParts = parseSide(sides[0]);
  const tailParts = sides.length === 2 ? parseSide(sides[1]) : [];
  const extra = ipv4 ? 2 : 0;
  const present = headParts.length + tailParts.length + extra;

  if (sides.length === 2) {
    if (present > 8) {
      return null;
    }
  } else if (present !== 8) {
    return null;
  }

  const raw = [
    ...headParts,
    ...Array(8 - present).fill('0'),
    ...tailParts,
  ];
  if (ipv4) {
    const n = ipv4ToInt(ipv4);
    raw.push(((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16));
  }
  if (raw.length !== 8) {
    return null;
  }

  const hextets = [];
  for (const part of raw) {
    const parsed = parseHextet(part);
    if (parsed === null) {
      return null;
    }
    hextets.push(parsed);
  }
  return hextets;
}

function hextetsToIpv4(high, low) {
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function isUnspecifiedIpv6(hextets) {
  return hextets.every((part) => part === 0);
}

function isLoopbackIpv6(hextets) {
  return hextets[0] === 0
    && hextets[1] === 0
    && hextets[2] === 0
    && hextets[3] === 0
    && hextets[4] === 0
    && hextets[5] === 0
    && hextets[6] === 0
    && hextets[7] === 1;
}

function isIpv4Mapped(hextets) {
  return hextets[0] === 0
    && hextets[1] === 0
    && hextets[2] === 0
    && hextets[3] === 0
    && hextets[4] === 0
    && hextets[5] === 0xffff;
}

function isNat64(hextets) {
  return hextets[0] === 0x64
    && hextets[1] === 0xff9b
    && hextets[2] === 0
    && hextets[3] === 0
    && hextets[4] === 0
    && hextets[5] === 0;
}

function isBlockedIpv6(ip) {
  const hextets = parseIpv6Hextets(ip);
  if (!hextets) {
    return true;
  }
  if (isUnspecifiedIpv6(hextets) || isLoopbackIpv6(hextets)) {
    return true;
  }
  if ((hextets[0] & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((hextets[0] & 0xffc0) === 0xfe80) {
    return true;
  }
  if (isIpv4Mapped(hextets) || isNat64(hextets)) {
    return isBlockedIpv4(hextetsToIpv4(hextets[6], hextets[7]));
  }
  return false;
}

export function isBlockedAddress(address, family) {
  const version = family === 4 || family === 6 ? family : isIP(address);
  if (version === 4) {
    return isBlockedIpv4(address);
  }
  if (version === 6) {
    return isBlockedIpv6(address);
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === 'metadata.google.internal'
    || host.endsWith('.internal');
}

async function assertPublicHttpsUrl(value, resolveFn) {
  if (!isHttpsClientId(value)) {
    throw new Error('CIMD client_id must be an HTTPS URL with a path');
  }

  const url = new URL(value);
  if (isBlockedHostname(url.hostname)) {
    throw new Error('CIMD host is blocked');
  }

  if (isIP(url.hostname) === 4 && isBlockedIpv4(url.hostname)) {
    throw new Error('CIMD host resolves to a private address');
  }
  if (isIP(url.hostname) === 6 && isBlockedIpv6(url.hostname)) {
    throw new Error('CIMD host resolves to a private address');
  }

  const records = await resolveFn(url.hostname);
  const blocked = !Array.isArray(records)
    || records.length === 0
    || records.some((record) => isBlockedAddress(record.address, record.family));
  if (blocked) {
    throw new Error('CIMD host resolves to a private or blocked address');
  }

  return { url, records: records.map((record) => ({ ...record })) };
}

export function createPinnedLookup(records) {
  const addresses = records.map((record) => ({
    address: record.address,
    family: record.family === 6 || record.family === 'IPv6' ? 6 : 4,
  }));

  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' || options == null ? {} : options;
    const wanted = opts.family === 4 || opts.family === 6
      ? addresses.filter((entry) => entry.family === opts.family)
      : addresses;
    const chosen = wanted.length > 0 ? wanted : addresses;
    if (opts.all) {
      cb(null, chosen.map((entry) => ({ address: entry.address, family: entry.family })));
      return;
    }
    const first = chosen[0];
    cb(null, first.address, first.family);
  };
}

export function createPinnedDispatcher(records) {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(records),
    },
  });
}

function declaredContentLength(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared == null || declared === '') {
    return undefined;
  }
  const length = Number(declared);
  return Number.isFinite(length) ? length : undefined;
}

async function readLimitedBody(response, maxBytes) {
  const declared = declaredContentLength(response);
  if (declared !== undefined && declared > maxBytes) {
    throw new Error('CIMD document too large');
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('CIMD document missing body');
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('CIMD document too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function readJsonDocument(response, maxBytes) {
  const buffer = await readLimitedBody(response, maxBytes);
  return JSON.parse(buffer.toString('utf8'));
}

async function closeDispatcher(dispatcher) {
  if (dispatcher && typeof dispatcher.close === 'function') {
    await dispatcher.close();
  }
}

async function fetchWithRedirects(urlString, options, redirectsLeft) {
  const {
    fetchFn,
    resolveFn,
    timeoutMs,
    maxBytes,
    createDispatcher = createPinnedDispatcher,
  } = options;

  const { url, records } = await assertPublicHttpsUrl(urlString, resolveFn);
  const dispatcher = createDispatcher(records);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url.href, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      dispatcher,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectsLeft <= 0) {
        throw new Error('CIMD fetch had too many redirects');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('CIMD redirect missing location');
      }
      return fetchWithRedirects(new URL(location, url).href, options, redirectsLeft - 1);
    }

    if (!response.ok) {
      throw new Error(`CIMD fetch failed: ${response.status}`);
    }

    return readJsonDocument(response, maxBytes);
  } finally {
    clearTimeout(timer);
    await closeDispatcher(dispatcher);
  }
}

function defaultResolve(hostname) {
  return import('node:dns/promises').then(({ lookup }) => lookup(hostname, { all: true }));
}

export async function fetchClientIdMetadata(clientIdUrl, options = {}) {
  const {
    fetchFn = undiciFetch,
    resolveFn = defaultResolve,
    timeoutMs = CIMD_FETCH_TIMEOUT_MS,
    maxBytes = CIMD_MAX_BYTES,
    createDispatcher = createPinnedDispatcher,
  } = options;

  const document = await fetchWithRedirects(
    clientIdUrl,
    { fetchFn, resolveFn, timeoutMs, maxBytes, createDispatcher },
    3
  );

  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('CIMD document must be a JSON object');
  }
  if (document.client_id !== clientIdUrl) {
    throw new Error('CIMD client_id must match the document URL');
  }
  if (!Array.isArray(document.redirect_uris) || document.redirect_uris.length === 0) {
    throw new Error('CIMD document must include redirect_uris');
  }
  if (!document.redirect_uris.every((uri) => isAllowedRedirectUri(uri))) {
    throw new Error('CIMD redirect_uris must be https or loopback http URLs');
  }

  return {
    client_id: document.client_id,
    client_name: document.client_name,
    redirect_uris: [...document.redirect_uris],
    grant_types: document.grant_types ? [...document.grant_types] : ['authorization_code'],
    response_types: document.response_types ? [...document.response_types] : ['code'],
    token_endpoint_auth_method: document.token_endpoint_auth_method || 'none',
    token_endpoint_auth_methods_supported: document.token_endpoint_auth_methods_supported
      ? [...document.token_endpoint_auth_methods_supported]
      : undefined,
    jwks_uri: document.jwks_uri,
  };
}
