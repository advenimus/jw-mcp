// Timeout defaults, default headers and the JwFetchError classes used by http.js.

const FALLBACK_TIMEOUT_MS = 20000;

// Capped: setTimeout treats anything above 2^31-1 ms as 1 ms.
export const MAX_TIMEOUT_MS = 600000;

// Overridable so slow networks (and tests) can adjust without a code change.
// 20 s keeps two sequential requests inside the MCP client's 60 s default.
export const DEFAULT_TIMEOUT_MS = timeoutFromEnv(process.env.JW_MCP_FETCH_TIMEOUT_MS);

function timeoutFromEnv(raw) {
  const value = Number(raw);
  if (!(value > 0)) return FALLBACK_TIMEOUT_MS;
  if (value > MAX_TIMEOUT_MS) {
    // stderr: stdout is the MCP stdio channel.
    console.error(`jw-mcp: JW_MCP_FETCH_TIMEOUT_MS=${raw} is above the ${MAX_TIMEOUT_MS} ms maximum; using ${MAX_TIMEOUT_MS}.`);
    return MAX_TIMEOUT_MS;
  }
  return value;
}

// wol.jw.org (Akamai) stalls indefinitely on requests that send a browser
// User-Agent without Accept-Language. Do not drop Accept-Language.
export const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
});

/**
 * Every JW.org fetch failure. kind is one of
 * 'timeout' | 'http' | 'too_large' | 'blocked_host' | 'network' | 'bad_content'.
 * message is one human-readable sentence; hint says what to try next.
 */
export class JwFetchError extends Error {
  constructor({ kind, message, url = null, status = null, hint = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'JwFetchError';
    this.kind = kind;
    this.url = url;
    this.status = status;
    this.hint = hint;
  }
}

export class FetchTimeoutError extends JwFetchError {
  constructor(url, timeoutMs, { reading = false } = {}) {
    const host = hostOf(url);
    super({
      kind: 'timeout',
      url,
      message: reading
        ? `Timed out after ${seconds(timeoutMs)} reading the response from ${host} (${url})`
        : `${host} did not respond within ${seconds(timeoutMs)} (${url})`,
      hint:
        DEFAULT_TIMEOUT_MS < MAX_TIMEOUT_MS
          ? `Try again in a moment. If it keeps happening, raise JW_MCP_FETCH_TIMEOUT_MS (now ${DEFAULT_TIMEOUT_MS} ms).`
          : 'Try again in a moment; JW.org may be slow or unreachable from this server.'
    });
    this.name = 'FetchTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

// Global fetch reports every connection problem as TypeError('fetch failed');
// the useful part (ENOTFOUND, ECONNRESET, ...) is on error.cause.
export function networkError(url, error) {
  const cause = error?.cause;
  const reason = cause?.code || cause?.message || error?.message || 'unknown error';
  return new JwFetchError({
    kind: 'network',
    url,
    message: `Could not reach ${hostOf(url)} (${reason}) for ${url}`,
    hint: 'Check that the machine running jw-mcp is online, then try again.',
    cause: error
  });
}

export function hostOf(url) {
  try {
    return new URL(url).hostname || String(url);
  } catch {
    return String(url);
  }
}

export function seconds(ms) {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}
