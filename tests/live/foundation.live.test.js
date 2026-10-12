// Live checks against JW.org (about 8 requests). Skipped unless JW_MCP_LIVE=1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JwFetchError, fetchJson, fetchRedirect, fetchText } from '../../src/tools/http.js';
import { BUILT_IN_LANGUAGES, clearLanguageCache, resolveLanguage, wolUrl } from '../../src/tools/languages.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';

// WOL's library picker lists every library with its r/lp/locale.
async function wolLibraries() {
  const html = await fetchText('https://wol.jw.org/en/wol/li/r1/lp-e');
  const libs = new Map();
  const re = /data-rsconf="(r\d+)"\s+data-lib="(lp-[^"]+)"\s+data-locale="([^"]+)"[^>]*?data-meps-symbol="([^"]+)"/g;
  for (const m of html.matchAll(re)) libs.set(m[4], { r: m[1], lp: m[2], path: m[3] });
  return libs;
}

describe('built-in language table matches JW.org', { skip }, () => {
  it('every built-in WOL r/lp/path matches the WOL library list', async () => {
    const libs = await wolLibraries();
    assert.ok(libs.size > 500, `parsed ${libs.size} WOL libraries`);
    for (const lang of BUILT_IN_LANGUAGES) {
      assert.deepEqual(lang.wol, libs.get(lang.code), lang.code);
    }
  });

  it('every built-in code, name and jw.org path matches the mediator language list', async () => {
    const { languages } = await fetchJson('https://b.jw-cdn.org/apis/mediator/v1/languages/E/web');
    const byCode = new Map(languages.map((l) => [l.code, l]));
    for (const lang of BUILT_IN_LANGUAGES) {
      const m = byCode.get(lang.code);
      assert.ok(m, `${lang.code} missing from mediator list`);
      assert.equal(lang.jwPath, m.locale.replace(/_/g, '-'), lang.code);
      assert.equal(lang.name, m.name, lang.code);
      assert.equal(lang.rtl, m.isRTL, lang.code);
    }
  });

  it('a built-in entry builds a working WOL Bible URL (Spanish John 3)', async () => {
    const html = await fetchText(wolUrl(await resolveLanguage('es'), 'b', 'nwtsty', 43, 3));
    assert.match(html, /id="v43-3-16/);
  });

  it('jw.org finder sends wtlocale=CHS to the built-in jwPath', async () => {
    const chs = await resolveLanguage('zh-Hans');
    assert.equal(await fetchRedirect(`https://www.jw.org/finder?wtlocale=${chs.code}`), `https://www.jw.org/${chs.jwPath}/`);
  });
});

describe('dynamic language lookup', { skip }, () => {
  it('resolves Swahili from the mediator list and the WOL finder', async () => {
    clearLanguageCache();
    const sw = await resolveLanguage('sw');
    assert.equal(sw.code, 'SW');
    assert.equal(sw.name, 'Swahili');
    assert.equal(sw.wol.lp, 'lp-sw');
    assert.match(sw.wol.r, /^r\d+$/);
  });
});

describe('JW.org errors come back as one readable JwFetchError', { skip }, () => {
  it('pub-media 404 for an even-month workbook', async () => {
    const url = 'https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?pub=mwb&langwritten=E&issue=20261000&fileformat=RTF&output=json';
    await assert.rejects(fetchJson(url), (e) => {
      assert.ok(e instanceof JwFetchError);
      assert.equal(e.kind, 'http');
      assert.equal(e.status, 404);
      assert.match(e.message, /^b\.jw-cdn\.org returned 404/);
      assert.ok(e.message.includes(url));
      assert.doesNotMatch(e.message, /Failed to/);
      assert.ok(e.hint);
      return true;
    });
  });

  it('WOL rejects an out-of-range chapter with a 4xx', async () => {
    await assert.rejects(fetchText('https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/1/99'), (e) => {
      assert.ok(e instanceof JwFetchError);
      assert.equal(e.kind, 'http');
      assert.ok(e.status >= 400 && e.status < 500, `status ${e.status}`);
      assert.match(e.message, /^wol\.jw\.org returned 4\d\d/);
      return true;
    });
  });
});
