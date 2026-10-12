// Offline tests for the shared tool helpers. globalThis.fetch is replaced in
// every test; a test that forgets to stub it fails instead of going online.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { FetchTimeoutError } from '../../src/tools/fetch-with-timeout.js';
import {
  DEFAULT_ALLOW_HOSTS,
  JwFetchError,
  fetchBuffer,
  fetchJson,
  fetchRedirect,
  fetchResource,
  fetchText,
  isAllowedUrl
} from '../../src/tools/http.js';
import { TtlLruCache, cached, isEmptyResult } from '../../src/tools/cache.js';
import {
  ArgError,
  describeValue,
  formatIsoDate,
  requireArgs,
  toBool,
  toEnum,
  toInt,
  toIsoDate,
  toJwUrl,
  toStr
} from '../../src/tools/args.js';
import {
  MAX_RESULT_TOKENS,
  ToolError,
  charsWithinTokens,
  errorResult,
  errorToResult,
  estimateTokens,
  jsonResult,
  pageByTokens,
  pageText,
  textResult,
  wrapTool
} from '../../src/tools/results.js';
import { absoluteUrl, asciiDigits, cleanText, joinText } from '../../src/tools/text.js';
import {
  BUILT_IN_LANGUAGES,
  clearLanguageCache,
  lookupLanguage,
  resolveLanguage,
  wolUrl
} from '../../src/tools/languages.js';

const realFetch = globalThis.fetch;
const offlineGuard = async (url) => {
  throw new Error(`offline test tried to fetch ${url}`);
};

let calls;
function useFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = offlineGuard;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WOL = 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3';
const enc = new TextEncoder();

function text(body, init = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

// Never answers, but rejects when the request is aborted (like real fetch).
function hangUntilAborted(url, init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  });
}

// Headers arrive, then one chunk, then the body stalls forever.
function stalledBody() {
  const body = new ReadableStream({ start: (c) => c.enqueue(enc.encode('{\\rtf1 partial')) });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/rtf' } });
}

async function rejectsWith(promise, props) {
  try {
    await promise;
  } catch (error) {
    for (const [k, v] of Object.entries(props)) {
      if (v instanceof RegExp) assert.match(String(error[k]), v, `error.${k}`);
      else if (typeof v === 'function') assert.ok(error instanceof v, `expected ${v.name}, got ${error?.name}`);
      else assert.equal(error[k], v, `error.${k}`);
    }
    return error;
  }
  assert.fail('expected a rejection');
}

describe('isAllowedUrl', () => {
  it('allows https JW hosts and *.jw-cdn.org subdomains', () => {
    for (const u of [
      'https://wol.jw.org/en/wol/h/r1/lp-e',
      'https://www.jw.org/en/',
      'https://jw.org/finder?wtlocale=E',
      'https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS',
      'https://cfp2.jw-cdn.org/a/b.vtt',
      'https://download-a.akamaihd.jw-cdn.org/x.rtf',
      'https://WOL.JW.ORG/en/'
    ]) assert.equal(isAllowedUrl(u), true, u);
  });

  it('blocks other schemes, hosts, ports, credentials and lookalikes', () => {
    for (const u of [
      'http://wol.jw.org/en/',
      'https://wol.jw.org:8443/en/',
      'https://user:pw@wol.jw.org/',
      'https://evil.com/?u=https://wol.jw.org',
      'https://wol.jw.org.evil.com/',
      'https://eviljw-cdn.org/',
      'https://jw-cdn.org/',
      'https://127.0.0.1/',
      'file:///etc/hostname',
      'wol.jw.org/en/',
      'not a url',
      ''
    ]) assert.equal(isAllowedUrl(u), false, u);
  });

  it('accepts a custom allowlist', () => {
    assert.equal(isAllowedUrl('https://example.org/', ['example.org']), true);
    assert.equal(isAllowedUrl('https://wol.jw.org/', ['example.org']), false);
    assert.ok(DEFAULT_ALLOW_HOSTS.includes('*.jw-cdn.org'));
  });
});

describe('fetchText / fetchJson / fetchBuffer', () => {
  it('returns the body and sends browser-like headers', async () => {
    useFetch(() => text('<p>hello</p>'));
    assert.equal(await fetchText(WOL), '<p>hello</p>');
    const h = calls[0].init.headers;
    assert.match(h.get('user-agent'), /Mozilla/);
    assert.equal(h.get('accept-language'), 'en-US,en;q=0.9');
    assert.match(h.get('accept'), /text\/html/);
    assert.equal(calls[0].init.redirect, 'manual');
  });

  it('accepts a fetch stub that returns synchronously', async () => {
    globalThis.fetch = () => text('sync');
    assert.equal(await fetchText(WOL), 'sync');
  });

  it('lets callers override accept and headers (case-insensitively)', async () => {
    useFetch(() => text('ok'));
    await fetchText(WOL, { accept: 'text/vtt', headers: { 'accept-language': 'es' } });
    assert.equal(calls[0].init.headers.get('accept'), 'text/vtt');
    assert.equal(calls[0].init.headers.get('accept-language'), 'es');
  });

  it('decodes using the declared charset and strips a UTF-8 BOM', async () => {
    useFetch(() => new Response(new Uint8Array([0xe9]), { headers: { 'content-type': 'text/plain; charset=iso-8859-1' } }));
    assert.equal(await fetchText(WOL), 'é');
    useFetch(() => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), { headers: { 'content-type': 'text/plain' } }));
    assert.equal(await fetchText(WOL), 'A');
  });

  it('parses JSON and asks for it', async () => {
    useFetch(() => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }));
    assert.deepEqual(await fetchJson('https://b.jw-cdn.org/apis/x'), { a: 1 });
    assert.equal(calls[0].init.headers.get('accept'), 'application/json');
  });

  it('reports an HTML page instead of JSON as bad_content', async () => {
    useFetch(() => text('<html>Access Denied</html>'));
    await rejectsWith(fetchJson('https://b.jw-cdn.org/apis/x'), {
      constructor: JwFetchError,
      kind: 'bad_content',
      message: /b\.jw-cdn\.org returned an HTML page instead of JSON for https:\/\/b\.jw-cdn\.org\/apis\/x/,
      hint: /try again/
    });
  });

  it('returns a Buffer from fetchBuffer and metadata from fetchResource', async () => {
    useFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/rtf' } }));
    assert.deepEqual([...(await fetchBuffer(WOL))], [1, 2, 3]);
    const r = await fetchResource(WOL);
    assert.equal(r.url, WOL);
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'application/rtf');
    assert.ok(Buffer.isBuffer(r.buffer));
  });
});

describe('fetch errors', () => {
  it('turns a 404 into one readable sentence with status, url and hint', async () => {
    useFetch(() => new Response('Not Found', { status: 404, statusText: 'Not Found' }));
    const err = await rejectsWith(fetchText(WOL), { constructor: JwFetchError, kind: 'http', status: 404, url: WOL });
    assert.equal(err.message, `wol.jw.org returned 404 Not Found for ${WOL}`);
    assert.doesNotMatch(err.message, /Failed to/);
    assert.match(err.hint, /Check the reference/);
  });

  it('uses caller hints keyed by status or kind', async () => {
    useFetch(() => new Response('', { status: 404 }));
    await rejectsWith(fetchText(WOL, { hints: { 404: 'Workbooks exist for odd months only.' } }), {
      message: `wol.jw.org returned 404 for ${WOL}`,
      hint: 'Workbooks exist for odd months only.'
    });
    useFetch(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })));
    await rejectsWith(fetchText(WOL, { retries: 0, hints: { network: 'offline?' } }), { kind: 'network', hint: 'offline?' });
  });

  it('says JW.org refused the server on 401/403, not that a link expired', async () => {
    for (const status of [401, 403]) {
      useFetch(() => new Response('Access Denied', { status }));
      const err = await rejectsWith(fetchResource('https://wol.jw.org/en/wol/d/r1/lp-e/1'), { constructor: JwFetchError, status, hint: /refused/ });
      assert.doesNotMatch(err.hint, /expired|links tool/);
    }
    await rejectsWith(fetchResource('https://wol.jw.org/en/wol/d/r1/lp-e/1', { hints: { 403: 'X' } }), { hint: 'X' });
  });

  it('refuses disallowed URLs without fetching', async () => {
    useFetch(() => text('secret'));
    for (const u of ['http://127.0.0.1:8080/secret', 'file:///etc/hostname', 'https://evil.com/', undefined]) {
      await rejectsWith(fetchText(u), { constructor: JwFetchError, kind: 'blocked_host', hint: /Only https links/ });
    }
    assert.equal(calls.length, 0);
  });

  it('reports network failures with the underlying code', async () => {
    useFetch(() => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })));
    await rejectsWith(fetchText(WOL, { retries: 0 }), {
      kind: 'network',
      message: `Could not reach wol.jw.org (ENOTFOUND) for ${WOL}`
    });
  });

  it('times out when no response arrives', async () => {
    useFetch(hangUntilAborted);
    const started = Date.now();
    await rejectsWith(fetchText(WOL, { timeoutMs: 50 }), {
      constructor: FetchTimeoutError,
      kind: 'timeout',
      message: `wol.jw.org did not respond within 0.1 s (${WOL})`,
      hint: /JW_MCP_FETCH_TIMEOUT_MS/
    });
    assert.ok(Date.now() - started < 1000);
  });

  it('times out even if fetch ignores the abort signal', async () => {
    useFetch(() => new Promise(() => {}));
    await rejectsWith(fetchText(WOL, { timeoutMs: 30 }), { kind: 'timeout' });
  });

  it('times out a body that stalls after the headers', async () => {
    useFetch(stalledBody);
    await rejectsWith(fetchText(WOL, { timeoutMs: 50 }), {
      constructor: FetchTimeoutError,
      kind: 'timeout',
      message: /^Timed out after 0\.1 s reading the response from wol\.jw\.org/
    });
  });

  it('honours a deadline shared across requests', async () => {
    useFetch(hangUntilAborted);
    const started = Date.now();
    const err = await rejectsWith(fetchText(WOL, { timeoutMs: 10000, deadline: Date.now() + 40 }), { kind: 'timeout', hint: /time budget/ });
    assert.doesNotMatch(err.hint, /JW_MCP_FETCH_TIMEOUT_MS/, 'raising the setting would not help');
    assert.ok(Date.now() - started < 1000);
    await rejectsWith(fetchText(WOL, { deadline: Date.now() - 1 }), { kind: 'timeout', message: /time budget is used up/ });
    assert.equal(calls.length, 1);
  });

  it('rejects bodies over maxBytes by Content-Length without reading', async () => {
    useFetch(() => new Response('x'.repeat(10), { headers: { 'content-length': '999999' } }));
    await rejectsWith(fetchText(WOL, { maxBytes: 1024 }), {
      kind: 'too_large',
      message: `The response from wol.jw.org is larger than 1 KB (${WOL})`
    });
  });

  it('stops reading a streamed body once it passes maxBytes', async () => {
    let pulls = 0;
    const endless = () =>
      new Response(new ReadableStream({ pull: (c) => { pulls++; c.enqueue(new Uint8Array(400)); } }));
    useFetch(endless);
    await rejectsWith(fetchText(WOL, { maxBytes: 1000 }), { kind: 'too_large' });
    assert.ok(pulls < 10);
  });
});

describe('redirects', () => {
  it('follows redirects to allowed hosts, resolving relative locations', async () => {
    useFetch((url) =>
      url.endsWith('/finder?wtlocale=S')
        ? new Response(null, { status: 307, headers: { location: '/es/wol/h/r4/lp-s' } })
        : text('home')
    );
    const r = await fetchResource('https://wol.jw.org/wol/finder?wtlocale=S');
    assert.equal(r.url, 'https://wol.jw.org/es/wol/h/r4/lp-s');
    assert.equal(calls.length, 2);
  });

  it('refuses a redirect to a host outside the allowlist', async () => {
    useFetch(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
    await rejectsWith(fetchText('https://www.jw.org/x'), {
      kind: 'blocked_host',
      message: 'www.jw.org redirected to http://169.254.169.254/latest, which is not an allowed JW.org address'
    });
    assert.equal(calls.length, 1);
  });

  it('gives up after too many redirects', async () => {
    useFetch((url, init, n) => new Response(null, { status: 302, headers: { location: `/loop/${n}` } }));
    await rejectsWith(fetchText('https://www.jw.org/start'), { kind: 'http', message: /Too many redirects/ });
    assert.equal(calls.length, 6);
  });

  it('reports an invalid redirect address as bad_content', async () => {
    useFetch(() => new Response(null, { status: 302, headers: { location: 'https://[bad' } }));
    await rejectsWith(fetchText('https://www.jw.org/x'), { kind: 'bad_content', message: /redirected https:\/\/www\.jw\.org\/x to an invalid address/ });
  });

  it('fetchRedirect returns the absolute target without following it', async () => {
    useFetch(() => new Response(null, { status: 307, headers: { location: '/pt-PT/wol/h/r296/lp-tpo' } }));
    assert.equal(await fetchRedirect('https://wol.jw.org/wol/finder?wtlocale=TPO'), 'https://wol.jw.org/pt-PT/wol/h/r296/lp-tpo');
    assert.equal(calls.length, 1);
    useFetch(() => text('no redirect'));
    assert.equal(await fetchRedirect('https://wol.jw.org/wol/finder?wtlocale=E'), null);
  });
});

describe('retries', () => {
  it('retries once on 503 and succeeds', async () => {
    useFetch((url, init, n) => (n === 1 ? new Response('busy', { status: 503 }) : text('ok')));
    assert.equal(await fetchText(WOL, { retryDelayMs: 0 }), 'ok');
    assert.equal(calls.length, 2);
  });

  it('retries once on a network error', async () => {
    useFetch((url, init, n) => (n === 1 ? Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })) : text('ok')));
    assert.equal(await fetchText(WOL, { retryDelayMs: 0 }), 'ok');
  });

  it('gives up after the retry and reports the last status', async () => {
    useFetch(() => new Response('', { status: 502, statusText: 'Bad Gateway' }));
    await rejectsWith(fetchText(WOL, { retryDelayMs: 0 }), { status: 502, hint: /having trouble/ });
    assert.equal(calls.length, 2);
  });

  it('does not retry 404 or when retries is 0', async () => {
    useFetch(() => new Response('', { status: 404 }));
    await rejectsWith(fetchText(WOL), { status: 404 });
    assert.equal(calls.length, 1);
    useFetch(() => new Response('', { status: 503 }));
    await rejectsWith(fetchText(WOL, { retries: 0 }), { status: 503 });
    assert.equal(calls.length, 1);
  });
});

describe('TtlLruCache', () => {
  it('expires entries after their TTL', () => {
    let t = 0;
    const c = new TtlLruCache({ ttlMs: 100, now: () => t });
    c.set('a', 1);
    c.set('b', 2, 500);
    t = 99;
    assert.equal(c.get('a'), 1);
    t = 100;
    assert.equal(c.get('a'), undefined);
    assert.equal(c.get('b'), 2);
    assert.equal(c.has('a'), false);
  });

  it('evicts the least recently used entry', () => {
    const c = new TtlLruCache({ maxEntries: 2 });
    c.set('a', 1).set('b', 2);
    c.get('a');
    c.set('c', 3);
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('c'), 3);
    assert.equal(c.size, 2);
    c.delete('a');
    c.clear();
    assert.equal(c.size, 0);
  });
});

describe('cached', () => {
  it('loads once and serves the cached value', async () => {
    const cache = new TtlLruCache();
    let n = 0;
    const load = async () => ++n;
    assert.equal(await cached('k', 1000, load, { cache }), 1);
    assert.equal(await cached('k', 1000, load, { cache }), 1);
    assert.equal(n, 1);
  });

  it('shares one load between concurrent callers', async () => {
    const cache = new TtlLruCache();
    let n = 0;
    const load = () => new Promise((r) => setTimeout(() => r(`v${++n}`), 10));
    const results = await Promise.all([1, 2, 3].map(() => cached('k', 1000, load, { cache })));
    assert.deepEqual(results, ['v1', 'v1', 'v1']);
    assert.equal(n, 1);
  });

  it('never caches failures', async () => {
    const cache = new TtlLruCache();
    let n = 0;
    const load = async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return 'ok';
    };
    await assert.rejects(cached('k', 1000, load, { cache }), /boom/);
    assert.equal(await cached('k', 1000, load, { cache }), 'ok');
    assert.equal(n, 2);
  });

  it('never caches empty results', async () => {
    for (const empty of [null, undefined, '', [], {}, Buffer.alloc(0), new Map()]) {
      const cache = new TtlLruCache();
      let n = 0;
      const load = async () => (n++ === 0 ? empty : 'full');
      assert.deepEqual(await cached('k', 1000, load, { cache }), empty);
      assert.equal(await cached('k', 1000, load, { cache }), 'full');
    }
    assert.equal(isEmptyResult(0), false);
    assert.equal(isEmptyResult(false), false);
    assert.equal(isEmptyResult({ a: 1 }), false);
  });

  it('bypass reloads and stores the fresh value', async () => {
    const cache = new TtlLruCache();
    let n = 0;
    const load = async () => ++n;
    await cached('k', 1000, load, { cache });
    assert.equal(await cached('k', 1000, load, { cache, bypass: true }), 2);
    assert.equal(await cached('k', 1000, load, { cache }), 2);
  });

  it('retries on its own time budget when the load it joined timed out', async () => {
    const cache = new TtlLruCache();
    let failOwner;
    const owner = cached('k', 1000, () => new Promise((_, reject) => (failOwner = reject)), { cache });
    let joinerLoads = 0;
    const joiner = cached('k', 1000, async () => {
      joinerLoads++;
      return 'fresh';
    }, { cache });
    failOwner(new JwFetchError({ kind: 'timeout', message: 'b.jw-cdn.org did not respond within 0.2 s' }));
    await assert.rejects(owner, { kind: 'timeout' });
    assert.equal(await joiner, 'fresh');
    assert.equal(joinerLoads, 1);
    assert.equal(await cached('k', 1000, async () => 'other', { cache }), 'fresh', 'the retry is cached');
  });

  it('shares any other failure of the load it joined', async () => {
    const cache = new TtlLruCache();
    let failOwner;
    const owner = cached('k', 1000, () => new Promise((_, reject) => (failOwner = reject)), { cache });
    let joinerLoads = 0;
    const joiner = cached('k', 1000, async () => {
      joinerLoads++;
      return 'fresh';
    }, { cache });
    const notFound = new JwFetchError({ kind: 'http', status: 404, message: 'not found' });
    failOwner(notFound);
    await assert.rejects(owner, { status: 404 });
    await assert.rejects(joiner, (e) => e === notFound);
    assert.equal(joinerLoads, 0);
  });

  it('respects the ttl argument', async () => {
    let t = 0;
    const cache = new TtlLruCache({ now: () => t });
    let n = 0;
    const load = async () => ++n;
    await cached('k', 50, load, { cache });
    t = 51;
    assert.equal(await cached('k', 50, load, { cache }), 2);
  });
});

describe('args', () => {
  it('requireArgs treats undefined and null as {}', () => {
    assert.deepEqual(requireArgs(undefined), {});
    assert.deepEqual(requireArgs(null), {});
    const a = { x: 1 };
    assert.equal(requireArgs(a), a);
    assert.throws(() => requireArgs([1]), ArgError);
    assert.throws(() => requireArgs('x'), /Invalid "arguments": expected an object of named parameters, got "x"/);
  });

  it('toInt accepts numbers and numeric strings', () => {
    assert.equal(toInt(16, 'verse'), 16);
    assert.equal(toInt('16', 'verse'), 16);
    assert.equal(toInt(' 16 ', 'verse'), 16);
    assert.equal(toInt('16.0', 'verse'), 16);
    assert.equal(toInt('-3', 'n'), -3);
  });

  it('toInt enforces integers and ranges with a clear message', () => {
    assert.throws(() => toInt('abc', 'chapter', { min: 1, max: 150 }), {
      name: 'ArgError',
      param: 'chapter',
      message: 'Invalid "chapter": expected an integer from 1 to 150, got "abc".'
    });
    assert.throws(() => toInt(1.5, 'n'), /expected an integer, got 1\.5/);
    assert.throws(() => toInt(0, 'n', { min: 1 }), /at least 1/);
    assert.throws(() => toInt(9, 'n', { max: 5 }), /no greater than 5/);
    assert.throws(() => toInt('0x10', 'n'), ArgError);
    assert.throws(() => toInt('1e3', 'n'), ArgError);
    assert.throws(() => toInt(true, 'n'), /got true/);
    assert.throws(() => toInt(NaN, 'n'), ArgError);
  });

  it('toInt handles missing values', () => {
    assert.throws(() => toInt(undefined, 'book', { min: 1, max: 66 }), {
      message: 'Missing required "book": expected an integer from 1 to 66.'
    });
    assert.throws(() => toInt('  ', 'book'), /Missing required "book"/);
    assert.equal(toInt(null, 'limit', { default: 5 }), 5);
    assert.equal(toInt('', 'limit', { optional: true }), undefined);
  });

  it('toEnum returns the canonical value', () => {
    assert.equal(toEnum('rtf', 'fileformat', ['RTF', 'TXT']), 'RTF');
    assert.equal(toEnum(undefined, 'format', ['text', 'vtt'], { default: 'text' }), 'text');
    assert.throws(() => toEnum('pdf', 'fileformat', ['RTF', 'TXT']), {
      message: 'Invalid "fileformat": expected one of "RTF", "TXT", got "pdf".'
    });
    assert.throws(() => toEnum('rtf', 'f', ['RTF'], { caseInsensitive: false }), ArgError);
  });

  it('toStr and toBool', () => {
    assert.equal(toStr('  pub-x  ', 'video_id'), 'pub-x');
    assert.equal(toStr(42, 'q'), '42');
    assert.throws(() => toStr({}, 'q'), /Invalid "q"/);
    assert.throws(() => toStr('abc', 'q', { maxLength: 2 }), ArgError);
    assert.throws(() => toStr('abc', 'id', { pattern: /^\d+$/, patternText: 'digits' }), /expected digits/);
    assert.equal(toBool('yes', 'b'), true);
    assert.equal(toBool(false, 'b'), false);
    assert.equal(toBool(undefined, 'b', { default: true }), true);
    assert.throws(() => toBool('maybe', 'b'), /true or false/);
  });

  it('toIsoDate returns local midnight and defaults to today (local)', () => {
    const now = new Date(2026, 9, 11, 23, 30); // 11:30 pm local: must stay the 11th
    const today = toIsoDate(undefined, 'date', { now });
    assert.deepEqual([today.getFullYear(), today.getMonth(), today.getDate(), today.getHours()], [2026, 9, 11, 0]);
    assert.equal(formatIsoDate(toIsoDate('', 'date', { now })), '2026-10-11');
    assert.equal(formatIsoDate(toIsoDate('today', 'date', { now })), '2026-10-11');
    assert.equal(formatIsoDate(toIsoDate('2026-02-28')), '2026-02-28');
    assert.equal(toIsoDate('2026-02-28').getHours(), 0);
    assert.equal(formatIsoDate(toIsoDate('2026-10-11T22:00:00Z')), '2026-10-11');
    assert.equal(formatIsoDate(toIsoDate(new Date(2026, 0, 5, 15))), '2026-01-05');
  });

  it('toIsoDate rejects impossible or malformed dates', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '10/11/2026', '20261011', '0026-01-01', 20261011, new Date('x')]) {
      assert.throws(() => toIsoDate(bad, 'date'), /expected a date as YYYY-MM-DD/, String(bad));
    }
  });

  it('toIsoDate errors give the server\'s date to count a relative date from', () => {
    let err;
    try {
      toIsoDate('next week', 'date', { now: new Date(2026, 9, 12, 1) });
    } catch (e) {
      err = e;
    }
    assert.equal(err?.name, 'ArgError');
    assert.match(err.hint, /Today on this server is Monday 2026-10-12/);
    assert.match(err.hint, /a week from today is 2026-10-19/);
    assert.doesNotMatch(err.message, /e\.g\. 2026-10-11/);
  });

  it('every ArgError has a next step, by default naming the parameter', () => {
    assert.equal(new ArgError('x', 'y', 'z').hint, 'Fix "x" and call again.');
    assert.equal(new ArgError('x', undefined, 'z').hint, 'Add "x" and call again.');
    assert.equal(new ArgError('x', 'y', 'z', { hint: 'Custom.' }).hint, 'Custom.');
    assert.match(errorToResult(new ArgError('fields', 'cross', 'a field')).content[0].text, /\nNext step: Fix "fields" and call again\.$/);
  });

  it('toJwUrl normalises and checks JW links', () => {
    assert.equal(toJwUrl('wol.jw.org/en/wol/d/r1/lp-e/2026'), 'https://wol.jw.org/en/wol/d/r1/lp-e/2026');
    assert.equal(toJwUrl('http://www.jw.org/en/'), 'https://www.jw.org/en/');
    assert.equal(toJwUrl(' https://cfp2.jw-cdn.org/a.rtf '), 'https://cfp2.jw-cdn.org/a.rtf');
    assert.throws(() => toJwUrl('http://127.0.0.1:8080/secret'), { name: 'ArgError', param: 'url' });
    assert.throws(() => toJwUrl('file:///etc/hostname'), /an https link on wol\.jw\.org/);
    assert.throws(() => toJwUrl(undefined), /Missing required "url"/);
    assert.equal(toJwUrl(undefined, 'url', { optional: true }), undefined);
  });

  it('toJwUrl refuses links over 2000 characters, padded or not, without echoing them', () => {
    for (const value of ['https://wol.jw.org/' + 'a'.repeat(2000), ' '.repeat(3000) + 'https://wol.jw.org/en']) {
      assert.throws(() => toJwUrl(value), (e) => {
        assert.equal(e.name, 'ArgError');
        assert.equal(e.tooLong, true);
        assert.match(e.message, /links are at most 2000 characters, got \d+\./);
        assert.ok(e.message.length < 300);
        return true;
      });
    }
    // Percent-encoding can push a link over the limit.
    assert.throws(() => toJwUrl('https://wol.jw.org/' + '日'.repeat(500)), { tooLong: true });
    const rtf = 'https://cfp2.jw-cdn.org/a/3f9a69f/1/o/mwb_E_202609_02.rtf';
    assert.equal(toJwUrl(rtf), rtf);
  });

  it('describeValue keeps messages short', () => {
    assert.equal(describeValue('x'.repeat(100)).length, 60);
    assert.equal(describeValue(undefined), 'nothing');
    assert.equal(describeValue([1]), 'array [1]');
    assert.equal(describeValue({ a: 1 }), 'object {"a":1}');
  });

  it('handles arguments nested too deeply for JSON', () => {
    const deep = JSON.parse('['.repeat(20000) + ']'.repeat(20000));
    assert.equal(describeValue(deep), 'array (too deeply nested to show)');
    assert.throws(() => toBool(deep, 'fetch'), { name: 'ArgError', param: 'fetch' });
    assert.throws(() => toStr(deep, 'reference'), { name: 'ArgError', param: 'reference' });
    assert.throws(() => toInt(deep, 'limit'), { name: 'ArgError', param: 'limit' });
  });
});

describe('text helpers', () => {
  it('asciiDigits turns any decimal digits into ASCII', () => {
    assert.equal(asciiDigits('روما ٥:٨ ۱۲ १२ 34'), 'روما 5:8 12 12 34');
    assert.equal(asciiDigits(16), '16');
  });

  it('cleanText drops invisible marks; joinText joins CJK tight', () => {
    assert.equal(cleanText('a\u2066b\u2069 \u200e c'), 'ab c');
    assert.equal(joinText('神は', '世を愛した'), '神は世を愛した');
    assert.equal(joinText('日本', 'Hello'), '日本 Hello');
    assert.equal(absoluteUrl('/x', 'https://wol.jw.org/en/'), 'https://wol.jw.org/x');
    assert.equal(absoluteUrl('http://[bad', 'https://wol.jw.org/'), null);
  });
});

describe('result size', () => {
  it('estimates tokens: prose is cheaper than links, CJK about one a character', () => {
    const prose = 'In the beginning was the Word, and the Word was with God. '.repeat(20);
    const links = '[Article](https://wol.jw.org/en/wol/pc/r1/lp-e/1200029055/12/0) w94 12/15 pp. 24-25\n'.repeat(13);
    const cjk = '初めに言葉と呼ばれる方がいた'.repeat(80);
    assert.ok(Math.abs(prose.length - links.length) < 200, 'similar lengths');
    assert.ok(estimateTokens(links) > 1.5 * estimateTokens(prose), `${estimateTokens(links)} vs ${estimateTokens(prose)}`);
    assert.ok(estimateTokens(cjk) >= cjk.length && estimateTokens(cjk) <= cjk.length * 1.1);
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('"a\\nb"'), estimateTokens(JSON.stringify('a\nb')));
  });

  it('charsWithinTokens counts text as it will be JSON-escaped', () => {
    const cjk = '言葉'.repeat(1000);
    assert.equal(charsWithinTokens(cjk, 0, 100), 100);
    assert.equal(charsWithinTokens(cjk, 10, 100, 50), 50);
    assert.equal(charsWithinTokens('a'.repeat(1000), 0, 10), 40, 'a long word is cut inside');
    assert.ok(charsWithinTokens('\n'.repeat(100), 0, 25) <= 10, 'line breaks cost their escapes');
    assert.equal(charsWithinTokens('short', 0, 1000), 5);
    const text = 'Some words here. '.repeat(500);
    const n = charsWithinTokens(text, 0, 300);
    assert.ok(estimateTokens(JSON.stringify(text.slice(0, n))) <= 302);
  });

  it('pageText cuts at a paragraph break, else a line break, never inside a surrogate pair', () => {
    assert.deepEqual(pageText('aaaa\n\nbbbb\n\ncccc', 0, 12), { text: 'aaaa\n\nbbbb', next_offset: 12 });
    assert.deepEqual(pageText('aaaa\n\nbbbb\n\ncccc', 12, 12), { text: 'cccc', next_offset: null });
    assert.deepEqual(pageText('line one\nline two\nline three', 0, 20), { text: 'line one\nline two', next_offset: 18 });
    assert.deepEqual(pageText('abcdefghij', 0, 4), { text: 'abcd', next_offset: 4 });
    assert.deepEqual(pageText('ab\ud83d\ude00cd', 0, 3), { text: 'ab', next_offset: 2 });
    assert.deepEqual(pageText('abcd\n\n\n', 0, 5), { text: 'abcd', next_offset: null }, 'trailing breaks end the text');
    assert.throws(() => pageText('abc', 3, 10), { name: 'ArgError', param: 'offset' });
  });

  it('pageByTokens keeps a CJK page within the token budget and pages through the whole text', () => {
    const para = '神は世を深く愛したので，独り子を与えた。'.repeat(25);
    const text = Array.from({ length: 100 }, () => para).join('\n\n');
    let offset = 0;
    const pages = [];
    while (offset !== null) {
      const part = pageByTokens(text, offset, 80000, 5000);
      assert.ok(estimateTokens(JSON.stringify(part.text)) <= 5100);
      pages.push(part.text);
      offset = part.next_offset;
    }
    assert.ok(pages.length > 5);
    assert.equal(pages.join('\n\n'), text);
    assert.ok(MAX_RESULT_TOKENS < 25000);
  });
});

describe('results', () => {
  it('builds text, JSON and error results', () => {
    assert.deepEqual(textResult('hi'), { content: [{ type: 'text', text: 'hi' }] });
    assert.deepEqual(jsonResult({ a: 1 }), { content: [{ type: 'text', text: '{"a":1}' }] });
    assert.doesNotMatch(jsonResult({ a: [1, { b: 2 }] }).content[0].text, /\n/);
    assert.deepEqual(errorResult('Nope'), { content: [{ type: 'text', text: 'Nope' }], isError: true });
    assert.equal(errorResult('Nope', 'Try X').content[0].text, 'Nope\nNext step: Try X');
  });

  it('wrapTool converts ArgError, JwFetchError and ToolError into isError results', async () => {
    const argFail = wrapTool(() => toInt('x', 'chapter', { min: 1 }));
    assert.deepEqual(await argFail(), {
      content: [{ type: 'text', text: 'Invalid "chapter": expected an integer of at least 1, got "x".\nNext step: Fix "chapter" and call again.' }],
      isError: true
    });

    useFetch(() => new Response('', { status: 404, statusText: 'Not Found' }));
    const fetchFail = wrapTool(() => fetchText(WOL, { hints: { 404: 'Try 20260900.' } }));
    const r = await fetchFail();
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, `wol.jw.org returned 404 Not Found for ${WOL}\nNext step: Try 20260900.`);

    const toolFail = wrapTool(() => {
      throw new ToolError('Genesis has 50 chapters.', 'Ask for chapter 1-50.');
    });
    assert.equal((await toolFail()).content[0].text, 'Genesis has 50 chapters.\nNext step: Ask for chapter 1-50.');
  });

  it('wrapTool reports unexpected errors as a jw-mcp bug', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const r = await wrapTool(function getThing() {
        return undefined.x;
      })();
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /^getThing failed unexpectedly: Cannot read properties of undefined/);
      assert.match(r.content[0].text, /bug in jw-mcp/);
      assert.match(errorToResult('weird', 'x').content[0].text, /x failed unexpectedly: weird/);
    } finally {
      console.error = original;
    }
  });

  it('wrapTool passes results through or wraps plain values', async () => {
    const mcp = { content: [{ type: 'text', text: 'x' }] };
    assert.equal(await wrapTool(async () => mcp)(), mcp);
    assert.equal(await wrapTool(() => null)(), null);
    assert.deepEqual(await wrapTool(() => 'plain')(), textResult('plain'));
    assert.deepEqual(await wrapTool(() => ({ a: 1 }))(), jsonResult({ a: 1 }));
    assert.deepEqual(await wrapTool((a, b) => a + b)(2, 3), jsonResult(5));
  });
});

// Synthetic stand-ins for the mediator language list and the WOL finder.
const DIRECTORY = {
  languages: [
    { code: 'E', locale: 'en', name: 'English', vernacular: 'English', isRTL: false, isSignLanguage: false },
    { code: 'D', locale: 'da', name: 'Danish', vernacular: 'Dansk', isRTL: false, isSignLanguage: false },
    { code: 'DA', locale: 'dua', name: 'Douala', vernacular: 'Duala', isRTL: false, isSignLanguage: false },
    { code: 'SW', locale: 'sw', name: 'Swahili', vernacular: 'Kiswahili', isRTL: false, isSignLanguage: false },
    { code: 'ACD', locale: 'fr_x_acd', name: 'Acadian', vernacular: 'Acadien', isRTL: false, isSignLanguage: false },
    { code: 'ASL', locale: 'ase', name: 'American Sign Language', vernacular: 'ASL', isRTL: false, isSignLanguage: true },
    { code: 'UD', locale: 'ur', name: 'Urdu', vernacular: 'اردو', isRTL: true, isSignLanguage: false },
    { code: 'T', locale: 'pt', name: 'Portuguese (Brazil)', vernacular: 'Português (Brasil)', isRTL: false, isSignLanguage: false },
    { code: 'CHC', locale: 'yue-hant', name: 'Chinese Cantonese (Traditional)', vernacular: '中文繁體（廣東話）', isRTL: false, isSignLanguage: false },
    { code: 'CNS', locale: 'yue-hans', name: 'Chinese Cantonese (Simplified)', vernacular: '中文简体（广东话）', isRTL: false, isSignLanguage: false },
    { code: 'TL', locale: 'ta', name: 'Tamil', vernacular: 'தமிழ்', isRTL: false, isSignLanguage: false },
    { code: 'RU', locale: 'rn', name: 'Kirundi', vernacular: 'Ikirundi', isRTL: false, isSignLanguage: false }
  ]
};
const WOL_LIBRARIES = { SW: '/sw/wol/h/r13/lp-sw', D: '/da/wol/h/r9/lp-d', ASL: '/ase/wol/h/r337/lp-asl' };

function directoryFetch(url) {
  if (url.startsWith('https://b.jw-cdn.org/apis/mediator/v1/languages/')) {
    return new Response(JSON.stringify(DIRECTORY), { headers: { 'content-type': 'application/json' } });
  }
  const m = /^https:\/\/wol\.jw\.org\/wol\/finder\?wtlocale=(\w+)$/.exec(url);
  if (m) {
    // WOL redirects unknown languages to English.
    return new Response(null, { status: 307, headers: { location: WOL_LIBRARIES[m[1]] ?? '/en/wol/h/r1/lp-e' } });
  }
  return new Response('', { status: 404 });
}

describe('languages: built-in table', () => {
  beforeEach(() => clearLanguageCache());

  it('resolves built-in languages without any network access', async () => {
    const cases = {
      E: 'E', e: 'E', en: 'E', 'en-US': 'E', EN: 'E', English: 'E', ENGLISH: 'E',
      S: 'S', s: 'S', es: 'S', ES: 'S', 'es-MX': 'S', 'es-419': 'S', Spanish: 'S', espanol: 'S', 'español': 'S',
      F: 'F', fr: 'F', 'fr-CA': 'F', FR: 'F',
      T: 'T', pt: 'T', 'pt-BR': 'T', pt_BR: 'T', Portuguese: 'T',
      TPO: 'TPO', tpo: 'TPO', 'pt-PT': 'TPO', pt_pt: 'TPO',
      X: 'X', de: 'X', German: 'X', I: 'I', it: 'I', O: 'O', nl: 'O', J: 'J', ja: 'J', JA: 'J',
      KO: 'KO', ko: 'KO', CHS: 'CHS', chs: 'CHS', 'zh-Hans': 'CHS', 'zh-CN': 'CHS', zh: 'CHS', 'cmn-Hans': 'CHS', Chinese: 'CHS',
      CH: 'CH', CHT: 'CH', cht: 'CH', 'zh-Hant': 'CH', 'zh-TW': 'CH', 'zh-Hant-TW': 'CH',
      U: 'U', ru: 'U', RU: 'U', P: 'P', pl: 'P', TG: 'TG', tg: 'TG', tl: 'TG', fil: 'TG',
      K: 'K', uk: 'K', VT: 'VT', vi: 'VT', IN: 'IN', id: 'IN', A: 'A', ar: 'A'
    };
    for (const [input, code] of Object.entries(cases)) {
      assert.equal((await resolveLanguage(input)).code, code, input);
      assert.equal(lookupLanguage(input)?.code, code, input);
    }
    assert.equal(calls.length, 0);
  });

  it('returns the full shape for a built-in language', async () => {
    assert.deepEqual(await resolveLanguage('e'), {
      code: 'E', iso: 'en', name: 'English', vernacular: 'English', jwPath: 'en', rtl: false, signLanguage: false,
      wol: { r: 'r1', lp: 'lp-e', path: 'en' }
    });
    const chs = await resolveLanguage('CHS');
    assert.equal(chs.jwPath, 'cmn-hans');
    assert.deepEqual(chs.wol, { r: 'r23', lp: 'lp-chs', path: 'cmn-Hans' });
    assert.deepEqual((await resolveLanguage('TPO')).wol, { r: 'r296', lp: 'lp-tpo', path: 'pt-PT' });
    assert.equal((await resolveLanguage('A')).rtl, true);
  });

  it('wolUrl builds WOL links from an entry', async () => {
    assert.equal(wolUrl(await resolveLanguage('es'), 'b', 'nwtsty', 43, 3), 'https://wol.jw.org/es/wol/b/r4/lp-s/nwtsty/43/3');
    assert.equal(wolUrl(await resolveLanguage('CHS'), 'h'), 'https://wol.jw.org/cmn-Hans/wol/h/r23/lp-chs');
    assert.equal(wolUrl(await resolveLanguage('E'), 'dt', 2026, 10, 11), 'https://wol.jw.org/en/wol/dt/r1/lp-e/2026/10/11');
  });

  it('has well-formed built-in entries', () => {
    const codes = BUILT_IN_LANGUAGES.map((l) => l.code);
    for (const c of ['E', 'S', 'F', 'T', 'TPO', 'X', 'I', 'O', 'J', 'KO', 'CHS', 'CH', 'U', 'P']) assert.ok(codes.includes(c), c);
    assert.equal(new Set(codes).size, codes.length);
    for (const l of BUILT_IN_LANGUAGES) {
      assert.match(l.wol.r, /^r\d+$/);
      assert.equal(l.wol.lp, `lp-${l.code.toLowerCase()}`);
      assert.equal(l.jwPath, l.iso.toLowerCase());
      assert.ok(Object.isFrozen(l) && Object.isFrozen(l.wol));
    }
  });

  it('rejects non-strings and blanks with an ArgError naming the parameter', async () => {
    for (const bad of [5, {}, '', '   ', 'x'.repeat(41)]) {
      await assert.rejects(resolveLanguage(bad, { name: 'lang' }), (e) => e instanceof ArgError && e.param === 'lang' && /JW\.org language code/.test(e.message));
    }
    assert.equal(lookupLanguage(5), null);
    assert.equal(calls.length, 0);
  });
});

describe('languages: dynamic lookup', () => {
  beforeEach(() => clearLanguageCache());

  it('resolves other languages from the language list and WOL finder', async () => {
    useFetch(directoryFetch);
    assert.deepEqual(await resolveLanguage('SW'), {
      code: 'SW', iso: 'sw', name: 'Swahili', vernacular: 'Kiswahili', jwPath: 'sw', rtl: false, signLanguage: false,
      wol: { r: 'r13', lp: 'lp-sw', path: 'sw' }
    });
    assert.equal((await resolveLanguage('Kiswahili')).code, 'SW');
    assert.equal(calls.filter((c) => c.url.includes('/languages/')).length, 1, 'language list fetched once');
    assert.equal(calls.filter((c) => c.url.includes('finder')).length, 1, 'finder cached per language');
  });

  it('reads lowercase as ISO and uppercase as a JW code', async () => {
    useFetch(directoryFetch);
    assert.equal((await resolveLanguage('da', { wol: false })).code, 'D');
    assert.equal((await resolveLanguage('DA', { wol: false })).code, 'DA');
    assert.equal((await resolveLanguage('Douala', { wol: false })).code, 'DA');
    assert.equal((await resolveLanguage('ur', { wol: false })).rtl, true);
  });

  it('never falls back from a private-use tag to its base language', async () => {
    useFetch(directoryFetch);
    const acd = await resolveLanguage('fr-x-acd', { wol: false });
    assert.equal(acd.code, 'ACD');
    assert.equal(acd.jwPath, 'fr-x-acd');
  });

  it('sets wol to null when WOL has no library (finder falls back to English)', async () => {
    useFetch(directoryFetch);
    const r = await resolveLanguage('DA');
    assert.equal(r.wol, null);
    assert.equal((await resolveLanguage('ASL')).signLanguage, true);
  });

  it('wolUrl refuses a language without a WOL library', async () => {
    useFetch(directoryFetch);
    assert.throws(() => wolUrl({ code: 'SW', name: 'Swahili' }, 'h'), /resolved with \{ wol: false \}/);
    const douala = await resolveLanguage('DA');
    assert.throws(() => wolUrl(douala, 'h'), {
      name: 'ArgError',
      param: 'langwritten',
      message: 'Douala (DA) has no Watchtower Online Library on wol.jw.org.'
    });
  });

  it('skips the WOL lookup with wol: false', async () => {
    useFetch(directoryFetch);
    const r = await resolveLanguage('SW', { wol: false });
    assert.equal(r.wol, undefined);
    assert.equal(calls.filter((c) => c.url.includes('finder')).length, 0);
  });

  it('makes lookupLanguage aware of the list once loaded', async () => {
    useFetch(directoryFetch);
    assert.equal(lookupLanguage('SW'), null);
    await resolveLanguage('SW', { wol: false });
    assert.equal(lookupLanguage('SW').code, 'SW');
  });

  it('shares one list download between concurrent lookups', async () => {
    useFetch(directoryFetch);
    await Promise.all(['SW', 'da', 'DA', 'ur'].map((q) => resolveLanguage(q, { wol: false })));
    assert.equal(calls.length, 1);
  });

  it('throws an ArgError for an unknown language', async () => {
    useFetch(directoryFetch);
    await assert.rejects(resolveLanguage('Klingon'), {
      name: 'ArgError',
      message: /^Invalid "langwritten": expected a JW\.org language code such as E \(English\).*got "Klingon"\.$/
    });
  });

  it('surfaces a failed list download as a JwFetchError and retries next time', async () => {
    useFetch(() => new Response('', { status: 500 }));
    await assert.rejects(resolveLanguage('SW'), { name: 'JwFetchError', kind: 'http', status: 500 });
    useFetch(directoryFetch);
    assert.equal((await resolveLanguage('SW', { wol: false })).code, 'SW');
  });

  it('reads everyday names with qualifiers in any order, and suggests names for a miss', async () => {
    useFetch(directoryFetch);
    const code = async (q) => (await resolveLanguage(q, { wol: false })).code;
    assert.equal(await code('Traditional Chinese'), 'CH');
    assert.equal(await code('Chinese (Traditional)'), 'CH');
    assert.equal(await code('Brazilian Portuguese'), 'T');
    assert.equal(await code('Portuguese Brazil'), 'T');
    assert.equal(calls.length, 0, 'built-in names need no list');
    assert.equal(await code('Cantonese'), 'CHC');
    assert.equal(await code('yue'), 'CHC');
    assert.equal(await code('Cantonese Simplified'), 'CNS');
    await assert.rejects(resolveLanguage('Brazil'), { name: 'ArgError', message: /Did you mean T \(Portuguese \(Brazil\)\)/ });
    await assert.rejects(resolveLanguage('Cantonish'), (e) => /Did you mean CHC \(Chinese Cantonese \(Traditional\)\), CNS/.test(e.message) && /e\.g\. "CHC"/.test(e.hint));
  });

  it('notes an all-caps ISO tag that is also another language\'s JW code', async () => {
    useFetch(directoryFetch);
    const tl = await resolveLanguage('TL', { wol: false });
    assert.equal(tl.code, 'TG');
    assert.match(tl.note, /"TL" was read as the ISO tag for Tagalog \(JW\.org code TG\)\. For Tamil, whose JW\.org code is TL, pass langwritten "Tamil"\./);
    const ru = await resolveLanguage('RU', { wol: false });
    assert.equal(ru.code, 'U');
    assert.match(ru.note, /For Kirundi/);
    for (const q of ['Tamil', 'ta']) {
      const ta = await resolveLanguage(q, { wol: false });
      assert.deepEqual([ta.code, ta.note], ['TL', undefined], q);
    }
    assert.equal((await resolveLanguage('TL', { as: 'code', wol: false })).code, 'TL');
    assert.equal((await resolveLanguage('TL', { as: 'code', wol: false })).note, undefined);
    for (const q of ['E', 'tl', 'TG', 'KO']) assert.equal((await resolveLanguage(q)).note, undefined, q);
  });

  it('reports an unexpected finder answer', async () => {
    useFetch((url) => (url.includes('finder') ? text('no redirect') : directoryFetch(url)));
    await assert.rejects(resolveLanguage('SW'), { name: 'JwFetchError', kind: 'bad_content', message: /unexpected address/ });
  });
});

describe('JW_MCP_FETCH_TIMEOUT_MS', () => {
  const moduleUrl = new URL('../../src/tools/fetch-with-timeout.js', import.meta.url).href;

  it('caps the setting at 600000 ms, with a warning on stderr', () => {
    for (const value of ['3000000000', 'Infinity', '1e300']) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(moduleUrl)}); console.log(m.DEFAULT_TIMEOUT_MS);`], {
        env: { ...process.env, JW_MCP_FETCH_TIMEOUT_MS: value },
        encoding: 'utf8'
      });
      assert.equal(r.stdout.trim(), '600000', value);
      assert.match(r.stderr, /JW_MCP_FETCH_TIMEOUT_MS=\S+ is above the 600000 ms maximum; using 600000/);
    }
  });

  it('treats a timeoutMs beyond setTimeout\'s range as a long wait, not 1 ms', async () => {
    useFetch(() => new Promise((resolve) => setTimeout(() => resolve(text('ok')), 50)));
    assert.equal(await fetchText(WOL, { timeoutMs: 3e9 }), 'ok');
  });
});
