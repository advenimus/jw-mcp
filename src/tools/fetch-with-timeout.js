import fetch from 'node-fetch';

// node-fetch v3 dropped the `timeout` option that v2 supported — passing it is
// silently ignored, so an unresponsive host hangs the request forever (and with
// it the whole stdio server). AbortSignal is the only supported mechanism.
const FALLBACK_TIMEOUT_MS = 30000;

// Overridable so slow networks (and tests) can adjust without a code change.
export const DEFAULT_TIMEOUT_MS =
  Number(process.env.JW_MCP_FETCH_TIMEOUT_MS) > 0
    ? Number(process.env.JW_MCP_FETCH_TIMEOUT_MS)
    : FALLBACK_TIMEOUT_MS;

export class FetchTimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`Request timed out after ${timeoutMs}ms: ${url}`);
    this.name = 'FetchTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // node-fetch raises AbortError; a native abort raises TimeoutError.
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw error;
  }
}
