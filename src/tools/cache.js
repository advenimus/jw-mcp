// Small in-memory TTL + LRU cache, plus cached() for "load once, share the
// result" fetches. Failures and empty results are never stored.

export class TtlLruCache {
  constructor({ maxEntries = 100, ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map(); // insertion order = recency order (oldest first)
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    return this;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

/** null, undefined, '', and empty arrays, buffers, Maps, Sets and plain objects. */
export function isEmptyResult(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (Object.getPrototypeOf(value) === Object.prototype) return Object.keys(value).length === 0;
  return false;
}

export const defaultCache = new TtlLruCache({ maxEntries: 100 });
const inflightByCache = new WeakMap();

/**
 * Return the cached value for key, or run loader() once and cache its result
 * for ttlMs. Concurrent calls for the same key share one loader run.
 * Options: bypass (skip the read and reload; the fresh value is still stored),
 * cache (a TtlLruCache; default shared one), isEmpty (what not to store).
 */
export async function cached(key, ttlMs, loader, { bypass = false, cache = defaultCache, isEmpty = isEmptyResult } = {}) {
  if (!bypass) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }

  let inflight = inflightByCache.get(cache);
  if (!inflight) {
    inflight = new Map();
    inflightByCache.set(cache, inflight);
  }
  if (!bypass && inflight.has(key)) {
    const shared = inflight.get(key);
    try {
      return await shared;
    } catch (error) {
      // That load ran on another call's time budget; retry on this caller's own.
      if (error?.kind !== 'timeout') throw error;
    }
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    // Another caller that joined the same load may already be retrying it.
    if (inflight.has(key)) return inflight.get(key);
  }

  const promise = (async () => {
    const value = await loader();
    if (!isEmpty(value)) cache.set(key, value, ttlMs);
    return value;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key);
  }
}
