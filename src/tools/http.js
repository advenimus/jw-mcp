// HTTP helpers for JW.org: host allowlist, one timeout covering redirects and
// the body read, a size cap, one retry on transient failures, and a single
// typed error (JwFetchError) with a readable message and a next-step hint.

import {
  DEFAULT_HEADERS,
  DEFAULT_TIMEOUT_MS,
  FetchTimeoutError,
  JwFetchError,
  hostOf,
  networkError
} from './fetch-with-timeout.js';

export { DEFAULT_HEADERS, DEFAULT_TIMEOUT_MS, FetchTimeoutError, JwFetchError };

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// '*.example.org' matches any subdomain of example.org (not example.org itself).
export const DEFAULT_ALLOW_HOSTS = Object.freeze([
  'wol.jw.org',
  'www.jw.org',
  'jw.org',
  'b.jw-cdn.org',
  'cfp2.jw-cdn.org',
  '*.jw-cdn.org'
]);

const MAX_REDIRECTS = 5;
const ABORTED = Symbol('aborted');
const RETRY_STATUSES = new Set([502, 503, 504]);
// A retry is pointless if the timer would cut it off immediately.
const MIN_RETRY_BUDGET_MS = 1000;

const ALLOWED_HOSTS_HINT =
  'Only https links on wol.jw.org, www.jw.org, jw.org or *.jw-cdn.org can be fetched. Use a link returned by this server\'s other tools.';

// JW.org's CDN/WAF answers 401/403 when it refuses this server's network; its links do not expire.
const REFUSED_HINT =
  'JW.org refused the request; it may be blocking this server\'s network (VPN or datacenter IP) or rate-limiting it. Wait a few minutes and try again, or run jw-mcp from another network.';
// The call's own deadline ran out: a longer JW_MCP_FETCH_TIMEOUT_MS would not help.
const BUDGET_HINT = 'This call ran out of its overall time budget. Try again, asking for less in one call.';

const STATUS_HINTS = {
  400: 'JW.org rejected the request. Check the parameters: a JW.org language code (E, S, F...), an issue as YYYYMM00, a valid book/chapter/verse.',
  401: REFUSED_HINT,
  403: REFUSED_HINT,
  404: 'Nothing exists at that address. Check the reference, issue and language; the item may not be published (yet) in that language.',
  410: 'Nothing exists at that address any more. Check the reference, issue and language, or get the link again from the tool that gave it.',
  429: 'JW.org is rate-limiting requests. Wait a minute, then try again.'
};

function defaultHint(status) {
  if (STATUS_HINTS[status]) return STATUS_HINTS[status];
  if (status >= 500) return 'JW.org is having trouble right now. Try again in a minute.';
  return null;
}

/** True when url is https, on the default port, without credentials, on an allowed host. */
export function isAllowedUrl(url, allowHosts = DEFAULT_ALLOW_HOSTS) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return allowHosts.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern
  );
}

function blockedError(url, message) {
  return new JwFetchError({ kind: 'blocked_host', url: String(url), message, hint: ALLOWED_HOSTS_HINT });
}

function httpError(url, res) {
  const text = res.statusText ? ` ${res.statusText}` : '';
  return new JwFetchError({
    kind: 'http',
    status: res.status,
    url,
    message: `${hostOf(url)} returned ${res.status}${text} for ${url}`,
    hint: defaultHint(res.status)
  });
}

function tooLargeError(url, maxBytes) {
  return new JwFetchError({
    kind: 'too_large',
    url,
    message: `The response from ${hostOf(url)} is larger than ${formatBytes(maxBytes)} (${url})`,
    hint: 'Ask for a smaller piece, such as one week, one chapter or a shorter verse range.'
  });
}

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${+(n / 1024 / 1024).toFixed(1)} MB` : `${+(n / 1024).toFixed(1)} KB`;
}

function discard(res) {
  res.body?.cancel().catch(() => {});
}

function buildHeaders(accept, headers) {
  const h = new Headers(DEFAULT_HEADERS);
  if (accept) h.set('Accept', accept);
  for (const [name, value] of Object.entries(headers ?? {})) h.set(name, value);
  return h;
}

// Settles first wins; the loser's rejection is swallowed. Racing against the
// timer means a fetch or stream that ignores the abort signal still times out.
function race(promise, aborted) {
  const p = Promise.resolve(promise);
  p.catch(() => {});
  return Promise.race([p, aborted]);
}

async function readBody(res, { url, maxBytes, aborted, budget }) {
  if (Number(res.headers.get('content-length')) > maxBytes) {
    discard(res);
    throw tooLargeError(url, maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read(), aborted);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLargeError(url, maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof JwFetchError) throw error;
    if (error === ABORTED) throw new FetchTimeoutError(url, budget, { reading: true });
    throw networkError(url, error);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a JW.org resource. Resolves to
 * { url, status, contentType, headers, buffer, location }.
 *
 * Options:
 * - timeoutMs: one budget for the whole call (redirects, retry, body). Default DEFAULT_TIMEOUT_MS.
 * - deadline: absolute epoch ms; the budget is cut to fit (for tools making several requests).
 * - maxBytes: body size cap, default 5 MB.
 * - headers, accept: merged over the browser-like DEFAULT_HEADERS.
 * - allowHosts: host patterns; https only. Redirects are followed only to allowed hosts.
 * - redirect: 'follow' (default) or 'manual' (a 3xx resolves with location set, empty buffer).
 * - retries: extra attempts on network errors and 502/503/504 (default 1), retryDelayMs apart (250).
 * - hints: { [status or kind]: string } overriding the default hint.
 */
export async function fetchResource(url, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deadline,
    maxBytes = DEFAULT_MAX_BYTES,
    headers,
    accept,
    allowHosts = DEFAULT_ALLOW_HOSTS,
    redirect = 'follow',
    retries = 1,
    retryDelayMs = 250,
    hints
  } = opts;

  const href = url instanceof URL ? url.href : String(url ?? '');
  if (!isAllowedUrl(href, allowHosts)) {
    throw blockedError(href, `Refusing to fetch "${href}": not an https URL on an allowed JW.org host`);
  }

  const budget = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now());
  if (budget <= 0) {
    throw new JwFetchError({
      kind: 'timeout',
      url: href,
      message: `Ran out of time before fetching ${href}: the tool's time budget is used up`,
      hint: BUDGET_HINT
    });
  }

  const started = Date.now();
  const controller = new AbortController();
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(ABORTED), { once: true });
  });
  aborted.catch(() => {});
  const timer = setTimeout(() => controller.abort(), Math.min(budget, 2147483647)); // setTimeout's maximum
  const request = { headers: buildHeaders(accept, headers), redirect: 'manual', signal: controller.signal };

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await attemptFetch(href, request, { aborted, allowHosts, redirect, maxBytes, budget });
      } catch (error) {
        const retryable = error.kind === 'network' || (error.kind === 'http' && RETRY_STATUSES.has(error.status));
        const left = budget - (Date.now() - started);
        if (!retryable || attempt >= retries || left < MIN_RETRY_BUDGET_MS + retryDelayMs) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  } catch (error) {
    // The call's deadline, not JW_MCP_FETCH_TIMEOUT_MS, set this limit.
    if (error instanceof FetchTimeoutError && budget < timeoutMs) error.hint = BUDGET_HINT;
    if (error instanceof JwFetchError && hints) {
      error.hint = hints[error.status] ?? hints[error.kind] ?? error.hint;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function attemptFetch(href, request, { aborted, allowHosts, redirect, maxBytes, budget }) {
  let current = href;
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await race(globalThis.fetch(current, request), aborted);
    } catch (error) {
      if (error === ABORTED || request.signal.aborted) throw new FetchTimeoutError(current, budget);
      throw networkError(current, error);
    }

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location) {
      discard(res);
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        throw new JwFetchError({
          kind: 'bad_content',
          status: res.status,
          url: current,
          message: `${hostOf(current)} redirected ${current} to an invalid address (${location})`,
          hint: 'JW.org may be misbehaving; try again later.'
        });
      }
      if (redirect === 'manual') {
        return { url: current, status: res.status, contentType: '', headers: res.headers, buffer: Buffer.alloc(0), location: next };
      }
      if (hop >= MAX_REDIRECTS) {
        throw new JwFetchError({
          kind: 'http',
          status: res.status,
          url: href,
          message: `Too many redirects (more than ${MAX_REDIRECTS}) starting at ${href}`,
          hint: 'JW.org may be misbehaving; try again later.'
        });
      }
      if (!isAllowedUrl(next, allowHosts)) {
        throw blockedError(next, `${hostOf(current)} redirected to ${next}, which is not an allowed JW.org address`);
      }
      current = next;
      continue;
    }

    if (!res.ok) {
      discard(res);
      throw httpError(current, res);
    }

    const buffer = await readBody(res, { url: current, maxBytes, aborted, budget });
    return {
      url: current,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      headers: res.headers,
      buffer,
      location: null
    };
  }
}

function decode(buffer, contentType) {
  const charset = /charset=["']?([^;"']+)/i.exec(contentType)?.[1]?.trim();
  let decoder;
  try {
    decoder = new TextDecoder(charset || 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(buffer);
}

/** Fetch and decode as text (charset from Content-Type, default UTF-8, BOM stripped). */
export async function fetchText(url, opts = {}) {
  const res = await fetchResource(url, opts);
  return decode(res.buffer, res.contentType);
}

/** Fetch and parse JSON; anything unparseable is a 'bad_content' JwFetchError. */
export async function fetchJson(url, opts = {}) {
  const res = await fetchResource(url, { accept: 'application/json', ...opts });
  const text = decode(res.buffer, res.contentType);
  try {
    return JSON.parse(text);
  } catch (error) {
    const what = /html/i.test(res.contentType) ? 'an HTML page' : 'something';
    throw new JwFetchError({
      kind: 'bad_content',
      url: res.url,
      status: res.status,
      message: `${hostOf(res.url)} returned ${what} instead of JSON for ${res.url}`,
      hint: 'JW.org may be busy or blocking the request; try again in a minute.',
      cause: error
    });
  }
}

/** Fetch the raw body as a Buffer. */
export async function fetchBuffer(url, opts = {}) {
  return (await fetchResource(url, opts)).buffer;
}

/** Make one request and return the absolute redirect target, or null if it did not redirect. */
export async function fetchRedirect(url, opts = {}) {
  return (await fetchResource(url, { ...opts, redirect: 'manual' })).location;
}
