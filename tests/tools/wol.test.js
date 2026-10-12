// Offline tests for the WOL tools (get_daily_text, read_wol_document,
// search_wol). globalThis.fetch is stubbed in every test with small synthetic
// pages that mimic wol.jw.org markup; a test that forgets to stub it fails.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Short timeouts for the stalled-download test; read when http.js loads.
process.env.JW_MCP_FETCH_TIMEOUT_MS = '400';

const { formatIsoDate } = await import('../../src/tools/args.js');
const { clearLanguageCache } = await import('../../src/tools/languages.js');
const { clearWolCache, handleWolTools, parseDocument, wolTools } = await import('../../src/tools/wol-tools.js');
const { estimateTokens, pageText } = await import('../../src/tools/results.js');

const realFetch = globalThis.fetch;
let calls;

function useFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    return handler(String(url), init, calls.length);
  };
}

beforeEach(() => {
  calls = [];
  clearWolCache();
  globalThis.fetch = async (url) => {
    throw new Error(`offline test tried to fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(name, args) {
  const result = await handleWolTools({ params: { name, arguments: args } });
  const text = result.content[0].text;
  return { result, text, json: result.isError ? null : JSON.parse(text) };
}

function html(body, { title = 'Watchtower ONLINE LIBRARY', status = 200, type = 'text/html; charset=utf-8' } = {}) {
  return new Response(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`, {
    status,
    headers: { 'content-type': type }
  });
}

const notFound = () => new Response('Not Found', { status: 404, statusText: 'Not Found' });
const redirect = (location) => new Response(null, { status: 307, headers: { location } });

// ---------------------------------------------------------------------------
// Synthetic WOL pages

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return formatIsoDate(new Date(y, m - 1, d + n));
}

// headingHtml: the h2's inner HTML; closing: add a Memorial Bible reading block (.closingContent).
function dayTab(iso, { sources = [['/en/wol/pc/r1/lp-e/1102099209/10/0', '<em>w99.01</em> 9 ¶6-8']], headingHtml, closing = false } = {}) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const links = sources.map(([href, text]) => `<a href="${href}">${text}</a>`).join('');
  const reading = closing
    ? '<div class="closingContent"><p class="sd"><strong>Memorial Bible reading: (Daytime events: Nisan 13)</strong> <a href="/en/wol/bc/r1/lp-e/1102099209/8/0" class="b"><strong>Matthew 26:17-19;</strong></a><a href="/en/wol/bc/r1/lp-e/1102099209/8/1" class="b"> <strong>Mark 14:12-16</strong></a></p></div>'
    : '';
  return `<div class="tabContent" data-date="${iso}T00:00:00.000Z">
    <header><h2 id="p32" data-pid="32">${headingHtml ?? `${WEEKDAYS[date.getDay()]}, ${MONTHS[m - 1]}&nbsp;${d}`}</h2></header>
    <p id="p33" data-pid="33" class="themeScrp"><em>Sample theme for ${iso}.​—</em><a href="/en/wol/bc/r1/lp-e/1102099209/35/0" class="b"><em>Ps. 1:1</em></a><em>.</em></p>
    <div class="bodyTxt"><p id="p34" data-pid="34" class="sb">Comment for ${iso}. (<a href="/en/wol/bc/r1/lp-e/1102099209/36/0" class="b">Ps. 2:3</a>) More&nbsp;comment. ${links}</p></div>
    ${reading}
    <a href="/en/wol/d/r1/lp-e/1102099209?#h=32:0-35:0">Examining the Scriptures Daily—${y}</a>
  </div>`;
}

// opts apply to all three days; middle applies to the requested day only.
function dailyPage(iso, opts, middle = {}) {
  return html(`<article id="article"><div id="dailyText">${[-1, 0, 1].map((n) => dayTab(addDays(iso, n), n ? opts : { ...opts, ...middle })).join('')}</div></article>`);
}

// /wol/h/r1/lp-e/2026/10/11 -> '2026-10-11'
function dateFromDailyUrl(url) {
  const [y, m, d] = new URL(url).pathname.split('/').slice(-3).map(Number);
  return formatIsoDate(new Date(y, m - 1, d));
}

const ARTICLE = `
<div id="documentCitationInformation"><div>The Sample Magazine—2099</div><div><strong>s99 January pp. 1-2</strong></div></div>
<article id="article" class="article document">
<div class="scalableui">
<header>
<p class="contextTtl" id="p1" data-pid="1"><span id="page8" class="pageNum" data-no="8"></span><strong>STUDY ARTICLE&nbsp;1</strong></p>
<h1 id="p2" data-pid="2"><strong>Sample Article</strong></h1>
</header>
<div class="bodyTxt">
<p id="p20" data-pid="20" class="qu"> <strong>1.</strong> What is the first question?</p>
<div class="gen-field" id="p21" data-pid="21"><label class="dc-screenReaderText">Your answer</label><textarea name="t1"></textarea></div>
<p id="p3" data-pid="3"><span class="parNum" data-pnum="1"></span>FIRST paragraph text.<a id="footnotesource1" class="fn" href="/en/wol/fn/r1/lp-e/2099001/0">a</a> See (<a href="/en/wol/bc/r1/lp-e/2099001/0/0" class="b">Ps.&nbsp;1:1</a>).</p>
<h2 id="p4" data-pid="4"><strong>A SUBHEADING</strong></h2>
<p id="p22" data-pid="22" class="qu"> <strong>2.</strong> Second question?</p>
<p id="p5" data-pid="5"><span class="parNum" data-pnum="2"><strong><sup>2</sup></strong></span> Second paragraph about a <a href="/en/wol/pc/r1/lp-e/2099001/1/0">linked article</a>.</p>
<p id="p23" data-pid="23" class="qu"> <strong>3.</strong> Third question?</p>
<p id="p6" data-pid="6"><span class="parNum" data-pnum="3"><strong><sup>3</sup></strong></span> Third paragraph.​—<a href="/en/wol/bc/r1/lp-e/2099001/1/0" class="b">Prov. 2:1</a>.</p>
<figure><img src="/en/wol/mp/r1/lp-e/s99/1" alt="A long description of the picture"><figcaption class="figcaption"><p id="p7" data-pid="7">A caption (See paragraph 2)</p></figcaption></figure>
<div class="boxContent"><ul><li><p id="p8" data-pid="8">Box item one?</p><div class="gen-field"><label>Your answer</label><textarea></textarea></div></li></ul></div>
</div>
<div class="groupFootnote"><div id="footnote1" class="fn-ref"><p id="p9" data-pid="9"><a href="#footnotesource1" class="fn-symbol">a</a> A footnote with <a href="/en/wol/pc/r1/lp-e/2099001/2/0">another article</a>.</p></div></div>
<div class="pswp"><button class="pswp__button" title="Close (Esc)">Close</button></div>
</div>
</article>
<input type="hidden" id="contentTitle" value="Sample Article">
<input type="hidden" id="parentTitle" value="The Sample Magazine—2099">`;

const BIBLE_CHAPTER = `
<div id="documentCitationInformation"><div>Sample Bible</div><div>Book 3:1-4</div></div>
<article id="article"><div class="scalableui"><header><h1>According to Book</h1></header>
<p id="p17" data-pid="17" class="sb"><span id="v43-3-1-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/1" class="cl vx vp"><strong>3</strong> </a>Verse one text,<a href="/en/wol/bc/r1/lp-e/1/77" class="b">+</a> goes here. </span><span id="v43-3-2-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/2" class="vl vx vp">2 </a>Verse two text.<a class="fn pr" href="/en/wol/fn/r1/lp-e/1/8">*</a> </span></p>
<p id="p18" data-pid="18" class="sb"><span id="v43-3-3-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/3" class="vl vx vp">3 </a>Verse three text. </span><span id="v43-3-4-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/4" class="vl vx vp">4 </a>Verse four text.</span></p>
</div></article>
<input type="hidden" id="contentTitle" value="Book 3">
<input type="hidden" id="parentTitle" value="Sample Bible">`;

function searchItem({ href, title, count, ref, paragraphs }) {
  return `<ul class="results resultContentDocument">
    <li class="caption"><a class="lnk" href="${href}">${title}</a> <span class="count" dir="ltr">(‎${count} occurrences)</span></li>
    <li class="result"><ul class="resultItems"><li class="searchResult"><article><div class="document">${paragraphs.join(' <strong>...</strong> ')}</div></article></li>
    <li class="ref">${ref}</li></ul></li>
  </ul>`;
}

function searchPage(total, items) {
  return html(
    `<article id="article"><div class="scalableui"><form id="searchResultsForm"><div id="resultsHeader"><span id="resultsCount"><span>${total} results ( </span></span></div>
    <div class="resultsContainer"><div class="results">${items.join('')}</div></div></form></div>
    <input type="hidden" id="searchResultsPageSize" value="40"><input type="hidden" id="searchResultsTotal" value="${total}"></article>`,
    { title: 'Search — Watchtower ONLINE LIBRARY' }
  );
}

// WOL's answer both to a search with no matches and to a page past the last one: the total is blank.
const noResults = () => html(
  `<article id="article"><div class="scalableui"><form id="searchResultsForm"><div id="resultsHeader"><div id="permittedSearch"><h2>Your search did not match any documents.</h2></div></div>
  <div id="noResultsProximity"><span>No results found</span></div></form></div><input type="hidden" id="searchResultsTotal" value=""></article>`
);

function numberedItems(from, count) {
  return Array.from({ length: count }, (_, i) =>
    searchItem({
      href: `/en/wol/d/r1/lp-e/${1000 + from + i}?q=hope&amp;p=par`,
      title: `Result ${from + i}`,
      count: 50 - i,
      ref: `s99 ${from + i}/1 p. 1 - The Sample Magazine—2099`,
      paragraphs: [`<p>Text with <span class="mk">hope</span> number ${from + i}.</p>`]
    })
  );
}

// ---------------------------------------------------------------------------

describe('wol tool definitions', () => {
  it('exports three tools with object schemas and returns null for other tools', async () => {
    assert.deepEqual(
      wolTools.map((t) => t.name),
      ['get_daily_text', 'read_wol_document', 'search_wol']
    );
    for (const tool of wolTools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 80, tool.name);
    }
    assert.deepEqual(wolTools[2].inputSchema.required, ['query']);
    assert.equal(await handleWolTools({ params: { name: 'get_bible_verse', arguments: {} } }), null);
  });
});

describe('get_daily_text', () => {
  it('picks the requested day out of the three on the page', async () => {
    useFetch((url) => dailyPage(dateFromDailyUrl(url)));
    const { result, json } = await call('get_daily_text', { date: '2026-10-11' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, ['https://wol.jw.org/en/wol/h/r1/lp-e/2026/10/11']);
    assert.deepEqual(json, {
      date: '2026-10-11',
      heading: 'Sunday, October 11',
      theme_scripture: 'Sample theme for 2026-10-11.—Ps. 1:1.',
      text: 'Comment for 2026-10-11. (Ps. 2:3) More comment.',
      citation: 'w99.01 9 ¶6-8',
      source_url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/1102099209/10/0',
      source_urls: ['https://wol.jw.org/en/wol/pc/r1/lp-e/1102099209/10/0'],
      publication: 'Examining the Scriptures Daily—2026',
      memorial_reading: null,
      url: 'https://wol.jw.org/en/wol/h/r1/lp-e/2026/10/11'
    });
  });

  it('reads a Memorial-season heading line by line, and the day\'s Memorial Bible reading', async () => {
    const { parseDailyTextPage } = await import('../../src/tools/wol-tools.js');
    const page = await dailyPage('2099-04-02', {}, { headingHtml: 'MEMORIAL DATE<br>After Sundown<br>Thursday, April&nbsp;2', closing: true }).text();
    const days = parseDailyTextPage(page, 'https://wol.jw.org/en/wol/h/r1/lp-e/2099/4/2');
    const day = days.get('2099-04-02');
    assert.equal(day.heading, 'MEMORIAL DATE · After Sundown · Thursday, April 2');
    assert.equal(day.memorial_reading, 'Memorial Bible reading: (Daytime events: Nisan 13) Matthew 26:17-19; Mark 14:12-16');
    assert.equal(day.publication, 'Examining the Scriptures Daily—2099');
    assert.doesNotMatch(day.text, /Memorial Bible reading/);
    const before = days.get('2099-04-01');
    assert.equal(before.memorial_reading, null);
    assert.equal(before.heading, 'Wednesday, April 1');
  });

  it('defaults to today in the server time zone', async () => {
    useFetch((url) => dailyPage(dateFromDailyUrl(url)));
    const before = formatIsoDate(new Date());
    const { json } = await call('get_daily_text', {});
    const after = formatIsoDate(new Date());
    assert.ok([before, after].includes(json.date), json.date);
    assert.equal(dateFromDailyUrl(calls[0]), json.date);
  });

  it('serves the day before and after from the same page without another request', async () => {
    useFetch((url) => dailyPage(dateFromDailyUrl(url)));
    await call('get_daily_text', { date: '2026-12-31' });
    const next = await call('get_daily_text', { date: '2027-01-01' });
    const prev = await call('get_daily_text', { date: '2026-12-30' });
    assert.equal(calls.length, 1);
    assert.equal(next.json.date, '2027-01-01');
    assert.equal(next.json.url, 'https://wol.jw.org/en/wol/h/r1/lp-e/2027/1/1');
    assert.equal(prev.json.heading, 'Wednesday, December 30');
  });

  it('uses the WOL library of the language and joins a two-part citation', async () => {
    useFetch((url) =>
      dailyPage(dateFromDailyUrl(url), {
        sources: [
          ['/es/wol/pc/r4/lp-s/1102099209/11/0', '<em>w99.02</em> 5 párr. 17;'],
          ['/es/wol/pc/r4/lp-s/1102099209/11/1', ' 7 párr. 18']
        ]
      })
    );
    const { json } = await call('get_daily_text', { date: '2026-03-05', langwritten: 'es' });
    assert.deepEqual(calls, ['https://wol.jw.org/es/wol/h/r4/lp-s/2026/3/5']);
    assert.equal(json.citation, 'w99.02 5 párr. 17; 7 párr. 18');
    assert.equal(json.source_url, 'https://wol.jw.org/es/wol/pc/r4/lp-s/1102099209/11/0');
    assert.deepEqual(json.source_urls, [
      'https://wol.jw.org/es/wol/pc/r4/lp-s/1102099209/11/0',
      'https://wol.jw.org/es/wol/pc/r4/lp-s/1102099209/11/1'
    ]);
    assert.ok(!json.text.includes('párr'), json.text);
  });

  it('sources: true returns the cited paragraphs of every source in one call', async () => {
    useFetch((url) => {
      if (url.includes('/wol/h/')) {
        return dailyPage(dateFromDailyUrl(url), {
          sources: [
            ['/en/wol/pc/r1/lp-e/2099009/3/0', '<em>s99</em> 2 ¶2;'],
            ['/en/wol/pc/r1/lp-e/2099009/4/0', ' 3 ¶a']
          ]
        });
      }
      if (url === 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/3/0') return redirect('https://wol.jw.org/en/wol/d/r1/lp-e/2099001#h=5:0-7:0');
      if (url === 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/4/0') return redirect('/en/wol/d/r1/lp-e/2099001#h=9');
      if (url === 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001') return html(ARTICLE);
      return notFound();
    });
    const { result, json } = await call('get_daily_text', { date: '2026-10-11', sources: true });
    assert.equal(result.isError, undefined);
    assert.equal(json.sources.length, 2);
    assert.match(json.sources[0].text, /^2 Second paragraph[^]*\n\n3 Third paragraph/);
    assert.doesNotMatch(json.sources[0].text, /question|▶/);
    assert.match(json.sources[1].text, /^\[a\] A footnote/);
    assert.equal(json.sources[0].url, 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001#h=5:0-7:0');
    assert.equal(json.sources[0].title, 'Sample Article');
    assert.equal(calls.filter((u) => u.includes('/wol/d/')).length, 1, 'one download for both sources');
    const plain = await call('get_daily_text', { date: '2026-10-11' });
    assert.equal(plain.json.sources, undefined, 'the cached entry is not changed');
    const bad = await call('get_daily_text', { date: '2026-10-11', sources: 'sometimes' });
    assert.match(bad.text, /Invalid "sources"/);
  });

  it('explains a date WOL does not have (404)', async () => {
    useFetch(() => notFound());
    const { result, text } = await call('get_daily_text', { date: '2010-06-01' });
    assert.equal(result.isError, true);
    assert.match(text, /no daily text for 2010-06-01 in English/);
    assert.match(text, /Next step: WOL keeps the daily text for recent years only/);
    assert.doesNotMatch(text, /langwritten E/);
  });

  it('explains a page that does not include the date, and a changed layout', async () => {
    useFetch(() => dailyPage('2026-10-20'));
    let r = await call('get_daily_text', { date: '2026-10-11' });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /no daily text for 2026-10-11/);

    clearWolCache();
    useFetch(() => html('<article id="article"><div id="home">Welcome.</div></article>'));
    r = await call('get_daily_text', { date: '2026-10-11' });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /expected layout/);
  });

  it('rejects a bad date or language without fetching', async () => {
    let r = await call('get_daily_text', { date: '2026-02-30' });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /Invalid "date"/);
    r = await call('get_daily_text', { date: 'tomorrow' });
    assert.equal(r.result.isError, true);
    r = await call('get_daily_text', { langwritten: 42 });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /langwritten/);
    assert.equal(calls.length, 0);
  });

  it('reports a language that has no WOL library', async () => {
    clearLanguageCache();
    useFetch((url) => {
      if (url.includes('/apis/mediator/')) {
        return new Response(
          JSON.stringify({ languages: [{ code: 'ZZQ', locale: 'zzq', name: 'Testish', vernacular: 'Testish' }] }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/wol/finder')) return redirect('https://wol.jw.org/en/wol/h/r1/lp-e');
      throw new Error(`unexpected ${url}`);
    });
    const { result, text } = await call('get_daily_text', { date: '2026-10-11', langwritten: 'ZZQ' });
    clearLanguageCache();
    assert.equal(result.isError, true);
    assert.match(text, /Testish \(ZZQ\) has no Watchtower Online Library/);
    assert.ok(!calls.some((u) => u.includes('/wol/h/')));
  });

  it('times out on a stalled page with a readable error', async () => {
    useFetch(() => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('<html>')) }), {
      headers: { 'content-type': 'text/html' }
    }));
    const { result, text } = await call('get_daily_text', { date: '2026-10-11' });
    assert.equal(result.isError, true);
    assert.match(text, /Timed out after 0.4 s reading the response from wol.jw.org/);
  });
});

describe('read_wol_document', () => {
  function wolSite(url) {
    if (url === 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/3/0') return redirect('https://wol.jw.org/en/wol/d/r1/lp-e/2099001#h=5:0-7:0');
    if (url === 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/4/0') return redirect('/en/wol/d/r1/lp-e/2099001#h=9');
    if (url === 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001') return html(ARTICLE, { title: 'Sample Article — Watchtower ONLINE LIBRARY' });
    if (url === 'https://wol.jw.org/es/wol/d/r4/lp-s/2099001') return html(ARTICLE);
    if (url === 'https://wol.jw.org/en/wol/bc/r1/lp-e/2099001/0/0') return redirect('https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3#v=43:3:3');
    if (url === 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3') return html(BIBLE_CHAPTER);
    return notFound();
  }

  it('follows a /wol/pc/ citation link and returns clean text with paragraph numbers', async () => {
    useFetch(wolSite);
    const { result, json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/3/0' });
    assert.equal(result.isError, undefined);
    assert.equal(json.title, 'Sample Article');
    assert.equal(json.publication, 'The Sample Magazine—2099');
    assert.equal(json.citation, 's99 January pp. 1-2');
    assert.equal(json.url, 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001#h=5:0-7:0');
    assert.equal(json.offset, 0);
    assert.equal(json.next_offset, null);
    assert.equal(json.total_chars, json.text.length);
    assert.equal(
      json.text,
      [
        'STUDY ARTICLE 1',
        '# Sample Article',
        '1. What is the first question?',
        '1 FIRST paragraph text.[a] See (Ps. 1:1).',
        '## A SUBHEADING',
        '2. Second question?',
        '▶ 2 Second paragraph about a [linked article](https://wol.jw.org/en/wol/pc/r1/lp-e/2099001/1/0).',
        '3. Third question?',
        '▶ 3 Third paragraph.—Prov. 2:1.',
        '🖼 A caption (See paragraph 2)',
        '- Box item one?',
        '[a] A footnote with [another article](https://wol.jw.org/en/wol/pc/r1/lp-e/2099001/2/0).'
      ].join('\n\n')
    );
    // #h=5:0-7:0 cites paragraphs 2 and 3 (pids 5 and 6); ▶ marks them.
    assert.deepEqual(json.cited.paragraphs, [2, 3]);
    const cited = json.text.slice(json.cited.offset, json.cited.offset + json.cited.chars);
    assert.ok(cited.startsWith('▶ 2 Second paragraph'), cited);
    assert.ok(cited.endsWith('▶ 3 Third paragraph.—Prov. 2:1.'), cited);
  });

  it('cited_only returns just the cited paragraphs, without interleaved questions', async () => {
    useFetch(wolSite);
    const { json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/3/0', cited_only: true });
    assert.equal(json.showing, 'cited paragraphs only');
    assert.equal(
      json.text,
      '2 Second paragraph about a [linked article](https://wol.jw.org/en/wol/pc/r1/lp-e/2099001/1/0).\n\n3 Third paragraph.—Prov. 2:1.'
    );
    const single = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/4/0', cited_only: true });
    assert.match(single.json.text, /^\[a\] A footnote/);
  });

  it('downloads a document once for several citation links into it', async () => {
    useFetch(wolSite);
    await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/3/0' });
    await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/4/0' });
    await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001?q=sample&p=par' });
    assert.equal(calls.filter((u) => u.includes('/wol/d/')).length, 1, calls.join('\n'));
  });

  it('links:false gives plain text; a link without a citation returns the whole document', async () => {
    useFetch(wolSite);
    const { json } = await call('read_wol_document', { url: 'wol.jw.org/en/wol/d/r1/lp-e/2099001', links: false, cited_only: true });
    assert.equal(json.url, 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001');
    assert.match(json.text, /about a linked article\./);
    assert.doesNotMatch(json.text, /\]\(/);
    assert.equal(json.cited, undefined);
    assert.match(json.note, /whole document/);
  });

  it('reads a docid in the requested language', async () => {
    useFetch(wolSite);
    const { json } = await call('read_wol_document', { docid: 2099001, langwritten: 'S' });
    assert.deepEqual(calls, ['https://wol.jw.org/es/wol/d/r4/lp-s/2099001']);
    assert.equal(json.title, 'Sample Article');
  });

  it('reads a Bible chapter: verse numbers kept, markers dropped, #v= cites the verse', async () => {
    useFetch(wolSite);
    const { json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/bc/r1/lp-e/2099001/0/0' });
    assert.equal(json.title, 'Book 3');
    assert.equal(json.citation, 'Book 3:1-4');
    assert.equal(
      json.text,
      '# According to Book\n\n1 Verse one text, goes here. 2 Verse two text.\n\n▶ 3 Verse three text. 4 Verse four text.'
    );
    assert.equal(json.cited.paragraphs, undefined, 'a Bible chapter has no paragraph numbers');
    const cited = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/bc/r1/lp-e/2099001/0/0', cited_only: true });
    assert.equal(cited.json.text, '3 Verse three text.');
  });

  it('pages long documents at paragraph breaks', async () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `<p id="p${i + 3}" data-pid="${i + 3}">Paragraph ${i + 1} ${'lorem ipsum '.repeat(10)}</p>`);
    useFetch(() => html(`<article id="article"><h1>Long</h1>${paragraphs.join('')}</article>`));
    const url = 'https://wol.jw.org/en/wol/d/r1/lp-e/2099002';
    const first = await call('read_wol_document', { url, max_chars: 1000 });
    assert.ok(first.json.text.length <= 1000);
    assert.ok(first.json.text.length > 500);
    assert.match(first.json.text, /lorem ipsum$/);
    const parts = [first.json.text];
    let next = first.json.next_offset;
    while (next !== null) {
      const { json } = await call('read_wol_document', { url, max_chars: 1000, offset: next });
      assert.equal(json.offset, next);
      parts.push(json.text);
      next = json.next_offset;
    }
    assert.equal(parts.join('\n\n'), (await call('read_wol_document', { url, max_chars: 80000 })).json.text);
    assert.equal(calls.length, 1);

    const past = await call('read_wol_document', { url, offset: 999999 });
    assert.equal(past.result.isError, true);
    assert.match(past.text, /Invalid "offset"/);
  });

  it('rejects links it cannot read, without fetching', async () => {
    const cases = [
      [{}, /Missing required "url"/],
      [{ url: 'https://www.jw.org/en/' }, /search_wol for its title/],
      [{ url: 'https://evil.example/wol/d/r1/lp-e/1' }, /Invalid "url"/],
      [{ url: 'https://wol.jw.org/en/wol/s/r1/lp-e?q=hope' }, /Use search_wol/],
      [{ url: 'https://wol.jw.org/en/wol/h/r1/lp-e/2026/10/11' }, /Use get_daily_text/],
      [{ url: 'https://wol.jw.org/en/' }, /Invalid "url"/],
      [{ docid: '12a' }, /Invalid "docid"/],
      [{ url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1', max_chars: 10 }, /Invalid "max_chars"/],
      [{ url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1', max_chars: 100000 }, /expected an integer from 1000 to 80000/],
      [{ url: 'https://www.jw.org/finder?wtlocale=E&bible=43003016&pub=nwtsty' }, /Use get_bible_verse or get_verse_with_study/],
      [{ url: 'https://www.jw.org/finder?wtlocale=E&lank=pub-jwb-142_1_VIDEO' }, /That is a video; use get_jw_captions/],
      [{ url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1', cited_only: 'maybe' }, /Invalid "cited_only"/]
    ];
    for (const [args, re] of cases) {
      const { result, text } = await call('read_wol_document', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text, re, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);
  });

  it('opens a jw.org finder link with docid= in WOL, in the wtlocale (or langwritten) language', async () => {
    const page = () => html('<div id="article"><h1>Enthusiasm</h1><p data-pid="1">Sample lesson text.</p></div>');
    useFetch((url) => (url.includes('/wol/d/') ? page() : notFound()));
    const en = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=E&docid=1102018451&srcid=share' });
    assert.equal(en.result.isError, undefined, en.text);
    assert.equal(en.json.title, 'Enthusiasm');
    assert.deepEqual(calls, ['https://wol.jw.org/en/wol/d/r1/lp-e/1102018451']);
    await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=S&docid=1102018451' });
    assert.equal(calls.at(-1), 'https://wol.jw.org/es/wol/d/r4/lp-s/1102018451');
    await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=S&docid=1102018452', langwritten: 'F' });
    assert.equal(calls.at(-1), 'https://wol.jw.org/fr/wol/d/r30/lp-f/1102018452');
  });

  it('reads a finder link\'s wtlocale as a JW code (TL is Tamil, not Tagalog)', async () => {
    clearLanguageCache();
    useFetch((url) => {
      if (url === 'https://b.jw-cdn.org/apis/mediator/v1/languages/E/all') {
        return new Response(JSON.stringify({ languages: [{ code: 'TL', locale: 'ta', name: 'Tamil', vernacular: 'Tamil' }] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://wol.jw.org/wol/finder?wtlocale=TL') return redirect('https://wol.jw.org/ta/wol/h/r122/lp-tl');
      if (url === 'https://wol.jw.org/ta/wol/d/r122/lp-tl/1102018451') return html('<div id="article"><h1>Tamil lesson</h1><p data-pid="1">Text.</p></div>');
      return notFound();
    });
    const { result, text, json } = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=TL&docid=1102018451' });
    clearLanguageCache();
    assert.equal(result.isError, undefined, text);
    assert.equal(json.title, 'Tamil lesson');
    assert.ok(!calls.some((u) => u.includes('/tl/') || u.includes('lp-tg')), calls.join('\n'));
  });

  it('says a finder docid WOL does not have is probably a jw.org web page', async () => {
    useFetch(() => notFound());
    const { result, text } = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=E&docid=1011750' });
    assert.equal(result.isError, true);
    assert.match(text, /Next step: WOL has no document with that docid; it is probably a jw\.org web page/);
  });

  it('reads a citation of several paragraph ranges (an excerpt list) from its document', async () => {
    const LIST = 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/59/0';
    const card = (hash) =>
      `<li class="linkCard"><a href="/en/wol/d/r1/lp-e/2099001${hash}"><div class="cardLine1">Sample Article</div><div class="cardLine2">The Sample Magazine—2099</div></a></li>`;
    useFetch((url) => {
      if (url === LIST) return html(`<div id="article"><ul>${card('#h=5:0-6:0')}</ul><p>Excerpt one.</p><ul>${card('#h=9:0-10:0')}</ul><p>Excerpt two.</p></div>`);
      if (url === 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001') return html(ARTICLE);
      return notFound();
    });
    const only = await call('read_wol_document', { url: LIST, cited_only: true });
    assert.equal(only.result.isError, undefined, only.text);
    assert.equal(only.json.title, 'Sample Article');
    assert.equal(only.json.publication, 'The Sample Magazine—2099');
    assert.equal(only.json.citation, 's99 January pp. 1-2');
    assert.equal(only.json.showing, 'cited paragraphs only');
    assert.equal(only.json.note, undefined);
    assert.equal(
      only.json.text,
      '2 Second paragraph about a [linked article](https://wol.jw.org/en/wol/pc/r1/lp-e/2099001/1/0).\n\n[a] A footnote with [another article](https://wol.jw.org/en/wol/pc/r1/lp-e/2099001/2/0).'
    );
    const whole = await call('read_wol_document', { url: LIST });
    assert.equal(whole.json.url, 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001#h=5:0-6:0');
    assert.ok(whole.json.cited.chars > 0);
    assert.match(whole.json.text, /^STUDY ARTICLE 1/);
    assert.equal(calls.length, 2, calls.join('\n'));
  });

  it('reads an excerpt list whose cards point into different documents as it is', async () => {
    const LIST = 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099009/60/0';
    useFetch((url) =>
      url === LIST
        ? html(
            '<div id="article"><ul><li class="linkCard"><a href="/en/wol/d/r1/lp-e/2099001#h=5"><div class="cardLine1">First Title</div><div class="cardLine2">First Book</div></a></li></ul><p>Excerpt one.</p>' +
              '<ul><li class="linkCard"><a href="/en/wol/d/r1/lp-e/2099002#h=3"><div class="cardLine1">Second Title</div></a></li></ul><p>Excerpt two.</p></div>'
          )
        : notFound()
    );
    const { result, json, text } = await call('read_wol_document', { url: LIST });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.title, 'First Title');
    assert.equal(json.publication, 'First Book');
    assert.match(json.text, /Excerpt one\.[\s\S]*Excerpt two\./);
  });

  it('marks the class-styled title, subheadings and box titles of older publications as headings', async () => {
    const OLD = `<div id="article"><p class="st" data-pid="1"><span class="pageNum" data-no="8"></span><strong>Title</strong></p><p class="ss" data-pid="2"><strong>Sub</strong></p><p class="sb" data-pid="3"><span class="parNum" data-pnum="1"></span>Body.</p><p class="so" data-pid="4"><strong>Do You Recall?</strong></p><p class="so" data-pid="5">• A question?</p><p class="se" data-pid="6"><strong>[Picture on page 8]</strong></p><p class="pubRefs" data-pid="7"><strong>FOCUS</strong></p></div>`;
    useFetch(() => html(OLD));
    const { json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2005322' });
    assert.deepEqual(json.text.split('\n\n'), ['# Title', '## Sub', '1 Body.', '## Do You Recall?', '• A question?', '[Picture on page 8]', 'FOCUS']);
  });

  it('treats a page type named like an Object.prototype key as an ordinary page', async () => {
    useFetch(() => notFound());
    const { result, text } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/constructor/r1/lp-e/1' });
    assert.equal(result.isError, true);
    assert.doesNotMatch(text, /native code/);
  });

  it('turns 404s, off-site redirects, non-HTML and pages without an article into errors', async () => {
    useFetch((url) => {
      if (url.endsWith('/pc/r1/lp-e/1/0/0')) return redirect('https://www.jw.org/en/library/');
      if (url.endsWith('/d/r1/lp-e/3')) return new Response('GIF89a', { headers: { 'content-type': 'image/gif' } });
      if (url.endsWith('/d/r1/lp-e/4')) return html('<div id="content">No article here</div>');
      if (url.endsWith('/d/r1/lp-e/5')) return html('<article id="article"><div class="gen-field"><label>Your answer</label></div></article>');
      return notFound();
    });
    const expect = [
      ['https://wol.jw.org/en/wol/d/r1/lp-e/2', /404 Not Found[\s\S]*Next step: Check the link/],
      ['https://wol.jw.org/en/wol/pc/r1/lp-e/1/0/0', /outside wol\.jw\.org/],
      ['https://wol.jw.org/en/wol/d/r1/lp-e/3', /not a WOL page \(it is image\/gif\)/],
      ['https://wol.jw.org/en/wol/d/r1/lp-e/4', /has no article to read/],
      ['https://wol.jw.org/en/wol/d/r1/lp-e/5', /has no readable text/]
    ];
    for (const [url, re] of expect) {
      const { result, text } = await call('read_wol_document', { url });
      assert.equal(result.isError, true, url);
      assert.match(text, re, url);
    }
  });
});

describe('parseDocument', () => {
  it('renders table rows as cells separated by |, and skips media widgets', () => {
    const doc = parseDocument(
      `<html><body><article id="article"><table><tr><th>Name</th><th>Meaning</th></tr><tr><td>Abel</td><td>Exhalation</td></tr></table>
      <div class="pswp"><div class="pswp__caption">x</div></div><video><source src="a.mp4"></video></article></body></html>`,
      'https://wol.jw.org/en/wol/d/r1/lp-e/1'
    );
    assert.deepEqual(
      doc.blocks.map((b) => b.text),
      ['Name | Meaning', 'Abel | Exhalation']
    );
    assert.equal(doc.title, null);
  });

  it('skips image toggles and hidden elements', () => {
    const doc = parseDocument(
      `<html><body><article id="article"><header><h1><strong>A Title</strong></h1></header>
      <div class="clearfix alternatePresentation clickable"><div class="thumbnail"><img src="/a"></div><div class="title">Printed Edition</div></div>
      <div class="clearfix alternatePresentation clickable hidden"><div class="title">Printed Edition</div></div>
      <div class="bodyTxt"><p id="p3" data-pid="3">First paragraph.</p><p class="hidden">Template {X}</p></div></article></body></html>`,
      'https://wol.jw.org/en/wol/d/r1/lp-e/1'
    );
    assert.deepEqual(doc.blocks.map((b) => b.text), ['# A Title', 'First paragraph.']);
  });
});

describe('pageText', () => {
  it('cuts at the last paragraph break past the halfway point', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc';
    assert.deepEqual(pageText(text, 0, 12), { text: 'aaaa\n\nbbbb', next_offset: 12 });
    assert.deepEqual(pageText(text, 12, 12), { text: 'cccc', next_offset: null });
    assert.deepEqual(pageText('abcdefghij', 0, 4), { text: 'abcd', next_offset: 4 });
  });
});

describe('read_wol_document: result size', () => {
  const pages = async (url, args = {}) => {
    const out = [];
    let offset = 0;
    while (offset !== null && out.length < 40) {
      const { result, json, text } = await call('read_wol_document', { url, ...args, offset });
      assert.equal(result.isError, undefined, text);
      out.push({ json, tokens: estimateTokens(text) });
      offset = json.next_offset;
    }
    return out;
  };

  it('keeps a default page of Japanese text under about 21K estimated tokens', async () => {
    // A short made-up kana/kanji sentence, repeated into about 45K characters of paragraphs.
    const sentence = '神の言葉を毎日読むことは大切です。';
    const paragraphs = Array.from({ length: 150 }, (_, i) => `<p id="p${i + 3}" data-pid="${i + 3}">${sentence.repeat(18)}</p>`);
    useFetch(() => html(`<article id="article"><h1>テスト</h1>${paragraphs.join('')}</article>`));
    const url = 'https://wol.jw.org/ja/wol/d/r7/lp-j/2099003';
    const all = await pages(url);
    assert.ok(all.length >= 3, `${all.length} pages`);
    for (const { tokens } of all) assert.ok(tokens <= 21000, `a page of about ${tokens} tokens`);
    assert.notEqual(all[0].json.next_offset, null);
    const whole = (await call('read_wol_document', { url, max_chars: 80000, offset: 0 })).json.total_chars;
    assert.equal(all.map((p) => p.json.text).join('\n\n').length, whole);
  });

  it('pages a 30K-character English document exactly as before', async () => {
    const paragraphs = Array.from({ length: 100 }, (_, i) => `<p id="p${i + 3}" data-pid="${i + 3}">Paragraph ${i + 1} ${'lorem ipsum '.repeat(24)}</p>`);
    useFetch(() => html(`<article id="article"><h1>Long</h1>${paragraphs.join('')}</article>`));
    const url = 'https://wol.jw.org/en/wol/d/r1/lp-e/2099004';
    const [first] = await pages(url);
    const text = (await call('read_wol_document', { url, max_chars: 80000 })).json.text;
    assert.deepEqual(first.json.text, pageText(text, 0, 30000).text);
    assert.equal(first.json.note, undefined);
  });

  it('shortens a link-heavy page read with max_chars 80000 to fit, and the pages still add up', async () => {
    const entries = Array.from({ length: 900 }, (_, i) => `<p id="p${i + 3}" data-pid="${i + 3}"><a href="/en/wol/pc/r1/lp-e/1200029055/${i}/0">Topic ${i}</a> it-1 p. ${i}</p>`);
    useFetch(() => html(`<article id="article"><h1>Guide</h1>${entries.join('')}</article>`));
    const url = 'https://wol.jw.org/en/wol/d/r1/lp-e/1200029055';
    const all = await pages(url, { max_chars: 80000 });
    for (const { tokens } of all) assert.ok(tokens <= 22000, `a page of about ${tokens} tokens`);
    assert.ok(all.length >= 2);
    const full = (await call('read_wol_document', { url, links: true, max_chars: 80000, offset: 0 })).json.total_chars;
    assert.equal(all.map((p) => p.json.text).join('\n\n').length, full);
  });
});

describe('read_wol_document: finder links and long links', () => {
  afterEach(() => clearLanguageCache());

  it('blames the link, not langwritten, for a bad wtlocale', async () => {
    clearLanguageCache();
    useFetch((url) => {
      if (url.includes('/mediator/v1/languages/')) {
        return new Response(JSON.stringify({ languages: [{ code: 'ZZQ', locale: 'zzq', name: 'Testish', vernacular: 'Testish' }] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/wol/finder')) return redirect('https://wol.jw.org/en/wol/h/r1/lp-e');
      throw new Error(`unexpected ${url}`);
    });
    const bad = await call('read_wol_document', { url: 'https://www.jw.org/finder?docid=2025241&wtlocale=XYZQ' });
    assert.equal(bad.result.isError, true);
    assert.match(bad.text, /The link's wtlocale="XYZQ" is not a JW\.org language code/);
    assert.match(bad.text, /Next step: Pass langwritten/);
    assert.doesNotMatch(bad.text, /Invalid "langwritten"/);
    const noWol = await call('read_wol_document', { url: 'https://www.jw.org/finder?docid=2025241&wtlocale=ZZQ' });
    assert.match(noWol.text, /wtlocale=ZZQ is Testish, which has no Watchtower Online Library/);
    assert.ok(!calls.some((u) => u.includes('/wol/d/')));
  });

  it('refuses a link over 2000 characters, or with a huge fragment, without fetching', async () => {
    useFetch(() => {
      throw new Error('must not fetch');
    });
    for (const url of [`https://wol.jw.org/en/wol/d/r1/lp-e/2025241?x=${'a'.repeat(3000)}`, `https://wol.jw.org/en/wol/d/r1/lp-e/2025241#x=${'a'.repeat(3000)}`]) {
      const { result, text } = await call('read_wol_document', { url });
      assert.equal(result.isError, true);
      assert.match(text, /at most 2000 characters/);
      assert.ok(text.length < 300, `${text.length} characters`);
    }
    assert.equal(calls.length, 0);
  });
});

describe('search_wol', () => {
  it('builds the WOL search request and parses ranked results', async () => {
    useFetch(() =>
      searchPage(1212, [
        searchItem({
          href: '/en/wol/d/r1/lp-e/2099322?q=resurrection+hope&amp;p=par',
          title: 'A Sample Article',
          count: 59,
          ref: 's99 5/1 pp. 8-13 - The Sample Magazine—2099',
          paragraphs: [
            '<p><strong>Declaring the</strong> <span class="mk"><strong>Resurrection Hope</strong></span></p>',
            '<p class="qu">15. A question? </p><div class="gen-field"><label>Your answer</label><textarea></textarea></div><p>The <span class="mk">hope</span> is sure,<a class="b" href="/x">+</a> as noted.<a class="fn" href="/y">c</a></p>'
          ]
        }),
        searchItem({ href: '/en/wol/d/r1/lp-e/1200003709?q=x', title: 'Resurrection', count: 1234, ref: 'it-2 “Resurrection” - Insight, Volume 2', paragraphs: [`<p>${'word '.repeat(100)}</p>`] })
      ])
    );
    const { result, json } = await call('search_wol', { query: 'resurrection hope' });
    assert.equal(result.isError, undefined);
    const url = new URL(calls[0]);
    assert.equal(url.origin + url.pathname, 'https://wol.jw.org/en/wol/s/r1/lp-e');
    assert.equal(url.searchParams.get('q'), 'resurrection hope');
    assert.equal(url.searchParams.get('p'), 'par');
    assert.equal(url.searchParams.get('r'), 'occ');
    assert.equal(url.searchParams.has('pg'), false);
    assert.equal(json.total, 1212);
    assert.equal(json.page, 1);
    assert.equal(json.next_page, undefined, 'only two results on the page');
    assert.deepEqual(json.results[0], {
      title: 'A Sample Article',
      citation: 's99 5/1 pp. 8-13 - The Sample Magazine—2099',
      url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2099322',
      occurrences: 59,
      snippet: 'Declaring the Resurrection Hope … 15. A question? … The hope is sure, as noted.'
    });
    assert.equal(json.results[1].occurrences, 1234);
    assert.ok(json.results[1].snippet.length <= 280);
    assert.ok(json.results[1].snippet.endsWith('…'));
  });

  it('maps scope, sort, publications and language onto WOL parameters', async () => {
    useFetch(() => searchPage(3, numberedItems(1, 3)));
    await call('search_wol', {
      query: '"exact phrase"',
      langwritten: 'Spanish',
      scope: 'Sentence',
      sort: 'newest',
      publications: ['watchtower', 'it', 'watchtower']
    });
    const url = new URL(calls[0]);
    assert.equal(url.pathname, '/es/wol/s/r4/lp-s');
    assert.equal(url.searchParams.get('q'), '"exact phrase"');
    assert.equal(url.searchParams.get('p'), 'sen');
    assert.equal(url.searchParams.get('r'), 'newest');
    assert.deepEqual(url.searchParams.getAll('fc[]'), ['w', 'it']);

    await call('search_wol', { query: 'hope', scope: 'article', sort: 'oldest', publications: 'insight, awake' });
    const second = new URL(calls[1]);
    assert.equal(second.searchParams.get('p'), 'doc');
    assert.equal(second.searchParams.get('r'), 'oldest');
    assert.deepEqual(second.searchParams.getAll('fc[]'), ['it', 'g']);
  });

  it('pages through results across WOL pages of 40', async () => {
    useFetch((url) => {
      const pg = Number(new URL(url).searchParams.get('pg') ?? 1);
      return pg > 3 ? noResults() : searchPage(100, numberedItems((pg - 1) * 40 + 1, pg < 3 ? 40 : 20));
    });
    const { json } = await call('search_wol', { query: 'hope', limit: 30, page: 2 });
    assert.deepEqual(
      json.results.map((r) => r.title),
      Array.from({ length: 30 }, (_, i) => `Result ${31 + i}`)
    );
    assert.equal(json.next_page, 3);
    assert.deepEqual(
      calls.map((u) => new URL(u).searchParams.get('pg')),
      [null, '2']
    );
    const last = await call('search_wol', { query: 'hope', limit: 30, page: 4 });
    assert.deepEqual(
      last.json.results.map((r) => r.title),
      Array.from({ length: 10 }, (_, i) => `Result ${91 + i}`)
    );
    assert.equal(last.json.next_page, undefined);
    const beyond = await call('search_wol', { query: 'hope', limit: 40, page: 9 });
    assert.equal(beyond.result.isError, undefined);
    assert.deepEqual(beyond.json.results, []);
    assert.match(beyond.json.note, /there are 100 in all/);
    assert.equal(beyond.json.total, 100);
  });

  it('takes the total from page 1 for a page past the end, and says no matches only when page 1 has none', async () => {
    useFetch((url) => {
      const u = new URL(url);
      const pg = Number(u.searchParams.get('pg') ?? 1);
      if (u.searchParams.get('q') === 'nothing') return noResults();
      return pg > 3 ? noResults() : searchPage(100, numberedItems((pg - 1) * 40 + 1, pg < 3 ? 40 : 20));
    });
    const past = await call('search_wol', { query: 'hope', limit: 40, page: 9 });
    assert.deepEqual(calls.map((u) => new URL(u).searchParams.get('pg')), ['9', null]);
    assert.equal(past.json.total, 100);
    assert.doesNotMatch(past.json.note, /No matches/);
    const none = await call('search_wol', { query: 'nothing', limit: 40, page: 2 });
    assert.equal(none.json.total, 0);
    assert.match(none.json.note, /No matches/);
  });

  it('reports no matches as an empty result with a suggestion', async () => {
    useFetch(() => noResults());
    const { result, json } = await call('search_wol', { query: 'xyzzy' });
    assert.equal(result.isError, undefined);
    assert.equal(json.total, 0);
    assert.deepEqual(json.results, []);
    assert.match(json.note, /No matches in the English library/);
    assert.match(json.note, /pass its langwritten \(e\.g\. "S" for Spanish\)/);
    const spanish = await call('search_wol', { query: 'xyzzy', langwritten: 'S' });
    assert.match(spanish.json.note, /Spanish library[\s\S]*"E" for English/);
  });

  it('caches a search page', async () => {
    useFetch(() => searchPage(3, numberedItems(1, 3)));
    await call('search_wol', { query: 'hope', limit: 2 });
    const again = await call('search_wol', { query: 'hope', limit: 3 });
    assert.equal(calls.length, 1);
    assert.equal(again.json.results.length, 3);
  });

  it('rejects bad arguments without fetching', async () => {
    const cases = [
      [{}, /Missing required "query"/],
      [{ query: '   ' }, /Missing required "query"/],
      [{ query: 'x'.repeat(257) }, /Invalid "query"/],
      [{ query: 'hope', limit: 41 }, /Invalid "limit"/],
      [{ query: 'hope', page: 0 }, /Invalid "page"/],
      [{ query: 'hope', scope: 'chapter' }, /Invalid "scope"/],
      [{ query: 'hope', sort: 'best' }, /Invalid "sort"/],
      [{ query: 'hope', publications: ['magazines'] }, /Invalid "publications"/],
      [{ query: 'hope', publications: 7 }, /Invalid "publications"/],
      [{ query: 'hope', langwritten: 42 }, /langwritten/]
    ];
    useFetch((url) => {
      throw new Error(`should not fetch ${url}`);
    });
    for (const [args, re] of cases) {
      const { result, text } = await call('search_wol', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text, re, JSON.stringify(args));
    }
  });

  it('turns an unexpected page or an HTTP failure into an error', async () => {
    useFetch(() => html('<div>Maintenance</div>'));
    let r = await call('search_wol', { query: 'hope' });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /unexpected page/);

    clearWolCache();
    useFetch(() => new Response('busy', { status: 429, statusText: 'Too Many Requests' }));
    r = await call('search_wol', { query: 'hope' });
    assert.equal(r.result.isError, true);
    assert.match(r.text, /429 Too Many Requests[\s\S]*Next step: JW.org is rate-limiting/);
  });
});

describe('read_wol_document: langwritten with a WOL link', () => {
  const doc = (title) => html(`<div id="article"><h1>${title}</h1><p data-pid="5">Sample paragraph.</p></div>`);

  it('reads a /wol/d/ link in langwritten, keeping the docid and #h= range', async () => {
    useFetch((url) => (url === 'https://wol.jw.org/es/wol/d/r4/lp-s/2099001' ? doc('Título') : notFound()));
    const out = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001#h=5', langwritten: 'S' });
    assert.equal(out.result.isError, undefined, out.text);
    assert.deepEqual(calls, ['https://wol.jw.org/es/wol/d/r4/lp-s/2099001']);
    assert.ok(out.json.url.endsWith('/es/wol/d/r4/lp-s/2099001#h=5'), out.json.url);
    assert.equal(out.json.note, undefined);
  });

  it('leaves a link already in that language alone, and says when WOL lacks the translation', async () => {
    useFetch((url) => (url === 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001' ? doc('Title') : notFound()));
    const same = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001', langwritten: 'en' });
    assert.equal(same.json.title, 'Title');
    const missing = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001', langwritten: 'S' });
    assert.equal(missing.result.isError, true);
    assert.match(missing.text, /WOL has no Spanish edition of document 2099001/);
  });

  it('reads other link types as given, with a note', async () => {
    useFetch((url) => (url === 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3' ? doc('John 3') : notFound()));
    const out = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3', langwritten: 'S' });
    assert.deepEqual(calls, ['https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3']);
    assert.match(out.json.note, /langwritten S was not applied/);
  });

  it('rejects a bad langwritten with a url instead of ignoring it', async () => {
    const out = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2099001', langwritten: 42 });
    assert.equal(out.result.isError, true);
    assert.match(out.text, /Invalid "langwritten"/);
    assert.equal(calls.length, 0);
  });
});

describe('read_wol_document: jw.org article links', () => {
  const PAGE = 'https://www.jw.org/en/library/magazines/watchtower-study-august-2026/You-Can-Win-the-Battle/';
  const jwPage = (body, status = 200) =>
    new Response(`<!DOCTYPE html><html><head><title>x</title></head>${body}<a href="/finder?docid=1001">Terms</a></body></html>`, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  const doc = html('<div id="article"><h1>You Can Win the Battle!</h1><p data-pid="1">Sample text.</p></div>');

  it('opens the document the page shows, in the page\'s language, in one call', async () => {
    useFetch((url) => {
      if (url === PAGE) return jwPage('<body id="mid2026521" class="ml-E docId-2026521 PublicationArticle"><div data-page-id="mid1102016929"></div>');
      if (url === 'https://wol.jw.org/en/wol/d/r1/lp-e/2026521') return doc;
      return notFound();
    });
    const out = await call('read_wol_document', { url: PAGE });
    assert.equal(out.result.isError, undefined, out.text);
    assert.equal(out.json.title, 'You Can Win the Battle!');
    assert.ok(!calls.some((u) => u.includes('1102016929') || u.includes('1001')), calls.join('\n'));
    await call('read_wol_document', { url: PAGE });
    assert.equal(calls.filter((u) => u === PAGE).length, 1, 'the page lookup is cached');
  });

  it('follows the page language, a Bible chapter page, and langwritten', async () => {
    useFetch((url) => {
      if (url.includes('/es/biblioteca/')) return jwPage('<body class="ml-S docId-2026521">');
      if (url.includes('/en/library/bible/')) return jwPage('<body class="ml-E" data-insight-context-id="bc-43003_nwtsty">');
      if (url.startsWith('https://wol.jw.org/')) return html('<div id="article"><h1>Doc</h1><p data-pid="1">Text.</p></div>');
      return notFound();
    });
    await call('read_wol_document', { url: 'https://www.jw.org/es/biblioteca/revistas/x/' });
    assert.equal(calls.at(-1), 'https://wol.jw.org/es/wol/d/r4/lp-s/2026521');
    await call('read_wol_document', { url: 'https://www.jw.org/en/library/bible/study-bible/books/john/3/' });
    assert.equal(calls.at(-1), 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3');
    await call('read_wol_document', { url: 'https://www.jw.org/es/biblioteca/revistas/x/', langwritten: 'E' });
    assert.equal(calls.at(-1), 'https://wol.jw.org/en/wol/d/r1/lp-e/2026521');
  });

  it('says what to do when the page names no document, does not exist, or WOL lacks it', async () => {
    useFetch((url) => {
      if (url.endsWith('/none/')) return jwPage('<body class="ml-E home">');
      if (url.endsWith('/gone/')) return jwPage('<body>', 404);
      if (url.endsWith('/index/')) return jwPage('<body id="mid1011202" class="ml-E">');
      return notFound();
    });
    const none = await call('read_wol_document', { url: 'https://www.jw.org/en/library/none/' });
    assert.equal(none.result.isError, true);
    assert.match(none.text, /search_wol for its title/);
    const gone = await call('read_wol_document', { url: 'https://www.jw.org/en/library/gone/' });
    assert.equal(gone.result.isError, true);
    assert.match(gone.text, /That jw\.org page does not exist/);
    const index = await call('read_wol_document', { url: 'https://www.jw.org/en/bible-teachings/index/' });
    assert.equal(index.result.isError, true);
    assert.match(index.text, /probably a jw\.org web page/);
  });
});

describe('WOL tools: one time limit per call', () => {
  const slow = (handler) => useFetch(async (url, init, n) => {
    await new Promise((r) => setTimeout(r, 300));
    return handler(url, init, n);
  });

  it('get_daily_text with sources ends in a timeout result within about twice the request timeout', async () => {
    slow((url) => {
      if (url.includes('/wol/h/')) {
        return dailyPage(dateFromDailyUrl(url), { sources: [['/en/wol/pc/r1/lp-e/2099009/3/0', 'a'], ['/en/wol/pc/r1/lp-e/2099010/4/0', 'b']] });
      }
      if (url.includes('/2099009/')) return redirect('https://wol.jw.org/en/wol/d/r1/lp-e/2099001#h=5');
      if (url.includes('/2099010/')) return redirect('https://wol.jw.org/en/wol/d/r1/lp-e/2099002#h=5');
      return html('<div id="article"><h1>Doc</h1><p data-pid="5">Text.</p></div>');
    });
    const start = Date.now();
    const { result, text } = await call('get_daily_text', { date: '2026-10-11', sources: true });
    assert.equal(result.isError, true, text);
    assert.match(text, /0\.\d s|time budget/);
    assert.ok(Date.now() - start < 1300, `${Date.now() - start} ms`);
  });

  it('read_wol_document on a finder link in a language outside the built-in table does too', async () => {
    clearLanguageCache();
    slow((url) => {
      if (url.includes('/mediator/v1/languages/')) {
        return new Response(JSON.stringify({ languages: [{ code: 'TL', locale: 'ta', name: 'Tamil', vernacular: 'Tamil' }] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/wol/finder')) return redirect('https://wol.jw.org/ta/wol/h/r122/lp-tl');
      return html('<div id="article"><h1>Doc</h1><p data-pid="1">Text.</p></div>');
    });
    const start = Date.now();
    const { result, text } = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=TL&docid=2026521' });
    clearLanguageCache();
    assert.equal(result.isError, true, text);
    assert.ok(Date.now() - start < 1300, `${Date.now() - start} ms`);
  });
});

describe('WOL tools: language notes', () => {
  it('say when "TL" was read as Tagalog', async () => {
    useFetch(() => dailyPage('2026-10-11'));
    const daily = await call('get_daily_text', { date: '2026-10-11', langwritten: 'TL' });
    assert.match(daily.json.note, /"TL" was read as the ISO tag for Tagalog/);
    assert.ok(calls[0].includes('/lp-tg/'), calls[0]);
    useFetch(() => noResults());
    const search = await call('search_wol', { query: 'pag-asa', langwritten: 'TL' });
    assert.match(search.json.note, /^"TL" was read as the ISO tag for Tagalog/);
  });
});

describe('read_wol_document: verse citations and footnotes', () => {
  // One <p> holds several verses, as on WOL Bible pages; verse 21 is two poetry lines; 22-23 are CJK with no space between verses.
  const CHAPTER = `<article id="article"><h1>Book 3</h1>
<p id="p10" data-pid="10" class="sb"><span id="v43-3-16-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/16" class="vl vx vp">16 </a>Sixteen text. </span><span id="v43-3-17-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/17" class="vl vx vp">17 </a>Seventeen text. </span><span id="v43-3-18-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/18" class="vl vx vp">18 </a>Eighteen text.</span></p>
<p id="p11" data-pid="11" class="sb"><span id="v43-3-19-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/19" class="vl vx vp">19 </a>Nineteen text. </span><span id="v43-3-20-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/20" class="vl vx vp">20 </a>Twenty text.</span></p>
<p id="p12" data-pid="12" class="sl"><span id="v43-3-21-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/21" class="vl vx vp">21 </a>Poetry line one,</span></p>
<p id="p13" data-pid="13" class="sz"><span id="v43-3-21-2" class="v">poetry line two.</span></p>
<p id="p14" data-pid="14" class="sb"><span id="v43-3-22-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/22" class="vl vx vp">22</a>二十二。</span><span id="v43-3-23-1" class="v"><a href="/en/wol/dx/r1/lp-e/1/23" class="vl vx vp">23</a>文字。</span></p>
</article>`;
  const BASE = 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3';
  const read = (hash, args = {}) => call('read_wol_document', { url: BASE + hash, ...args });

  it('cites just the verses of a #v= range, not their whole paragraph', async () => {
    useFetch((url) => (url === BASE ? html(CHAPTER) : notFound()));
    const only = async (hash) => (await read(hash, { cited_only: true })).json.text;
    assert.equal(await only('#v=43:3:16'), '16 Sixteen text.');
    assert.equal(await only('#v=43:3:18-43:3:19'), '18 Eighteen text.\n\n19 Nineteen text.');
    assert.equal(await only('#v=43:3:21'), '21 Poetry line one,\n\npoetry line two.');
    assert.equal(await only('#v=43:3:23'), '23文字。');
    const whole = await read('#v=43:3:17');
    const { offset, chars } = whole.json.cited;
    assert.equal(whole.json.text.slice(offset, offset + chars), '▶ 17 Seventeen text.');
    assert.match(whole.json.text, /16 Sixteen text\. ▶ 17 Seventeen text\. 18 Eighteen/);
    const range = await read('#v=43:3:18-43:3:19');
    assert.equal(range.json.text.slice(range.json.cited.offset, range.json.cited.offset + range.json.cited.chars), '▶ 18 Eighteen text.\n\n▶ 19 Nineteen text.');
    assert.equal(calls.length, 1);
  });

  it('keeps a Bible chapter\'s footnotes, tied to their verse, and brings them with cited verses', async () => {
    const page = `<article id="article"><h1>Psalm 3</h1>
<p class="sb" id="p2" data-pid="2"><span class="v" id="v19-3-1-1"><a class="cl" href="#">3</a> Verse one.</span></p>
<p class="sb" id="p3" data-pid="3"><span class="v" id="v19-3-2-1"><a class="vl" href="#">2 </a>He leads me to rest.<a id="footnotesource7" data-fnid="7" class="fn pr" href="/en/wol/fn/r1/lp-e/1/6">*</a> <a class="b" href="/en/wol/bc/r1/lp-e/1/0/0">+</a></span> <span class="v" id="v19-3-3-1"><a class="vl" href="#">3 </a>Verse three.</span></p>
</article>
<div id="studyDiscover"><div class="section"><h3 class="title">Psalm 3:2</h3>
<div class="group footnote"><div class="header"><h4 class="title"><span>Footnotes</span></h4></div>
<ul class="content"><li class="item footnote" data-extract-id="verseFootnote-7"><span class="marker"><span>*</span></span><span><p id="p90" data-pid="90">Or “quiet waters.”</p></span></li></ul></div></div></div>`;
    const url = 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/19/3';
    useFetch((u) => (u === url ? html(page) : notFound()));
    const whole = await call('read_wol_document', { url });
    assert.match(whole.json.text, /He leads me to rest\.\[\*1\] 3 Verse three\./);
    assert.match(whole.json.text, /\n\n## Footnotes\n\n\[\*1\] Psalm 3:2: Or “quiet waters\.”$/);
    const cited = await call('read_wol_document', { url: `${url}#v=19:3:2`, cited_only: true });
    assert.equal(cited.json.text, '2 He leads me to rest.[*1]\n\n[*1] Psalm 3:2: Or “quiet waters.”');
    const other = await call('read_wol_document', { url: `${url}#v=19:3:3`, cited_only: true });
    assert.equal(other.json.text, '3 Verse three.');
  });

  // Footnotes sit at the end of an article; cited paragraphs bring the ones they mark.
  const NOTED = `<article id="article"><h1 data-pid="1">Test Article</h1>
<p data-pid="5"><span class="parNum" data-pnum="1"></span> First paragraph.</p>
<p data-pid="6"><span class="parNum" data-pnum="2"></span> Cited paragraph with a note.<a id="footnotesource1" data-fnid="1" class="fn" href="/en/wol/fn/r1/lp-e/2099100/0">a</a> More text here.</p>
<p data-pid="7"><span class="parNum" data-pnum="3"></span> Uncited paragraph.<a id="footnotesource2" data-fnid="2" class="fn" href="/en/wol/fn/r1/lp-e/2099100/1">b</a></p>
<div class="groupFootnote"><div id="footnote1" data-fnid="1" class="fn-ref"><p data-pid="30"><a href="#footnotesource1" class="fn-symbol">a</a> Footnote A text.</p></div>
<div id="footnote2" data-fnid="2" class="fn-ref"><p data-pid="31"><a href="#footnotesource2" class="fn-symbol">b</a> Footnote B text.</p></div></div>
</article>`;
  const notedSite = (url) => {
    if (url.includes('/wol/h/')) return dailyPage(dateFromDailyUrl(url), { sources: [['/en/wol/pc/r1/lp-e/2099100/0/0', '<em>s99</em> 2 ¶2']] });
    if (url === 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099100/0/0') return redirect('https://wol.jw.org/en/wol/d/r1/lp-e/2099100#h=6');
    if (url === 'https://wol.jw.org/en/wol/d/r1/lp-e/2099100') return html(NOTED);
    return notFound();
  };

  it('cited_only adds the footnotes the cited paragraphs mark, and only those', async () => {
    useFetch(notedSite);
    const { json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099100/0/0', cited_only: true });
    assert.equal(json.text, '2 Cited paragraph with a note.[a] More text here.\n\n[a] Footnote A text.');
    const whole = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/2099100/0/0' });
    assert.equal(whole.json.text.slice(whole.json.cited.offset, whole.json.cited.offset + whole.json.cited.chars), '▶ 2 Cited paragraph with a note.[a] More text here.');
  });

  it('get_daily_text sources carry the footnotes of the cited paragraphs', async () => {
    useFetch(notedSite);
    const { json } = await call('get_daily_text', { date: '2026-10-10', sources: true });
    assert.match(json.sources[0].text, /\n\n\[a\] Footnote A text\.$/);
    assert.doesNotMatch(json.sources[0].text, /Footnote B/);
  });

  it('labels pictures with a marker, not an English word', async () => {
    useFetch(() => new Response('<!DOCTYPE html><html lang="ja"><body><article id="article"><h1>記事</h1><figure><figcaption><p data-pid="7">ヨナタンはダビデを支えた。</p></figcaption></figure></article></body></html>', { headers: { 'content-type': 'text/html' } }));
    const { json } = await call('read_wol_document', { docid: '2099005', langwritten: 'J' });
    assert.equal(json.text, '# 記事\n\n🖼 ヨナタンはダビデを支えた。');
  });

  it('opens a song video link as the song\'s lyrics page', async () => {
    useFetch((url) => (url.includes('/wol/d/') ? html('<div id="article"><h1>Shepherds—Gifts in Men</h1><p data-pid="1">Sample lyric line.</p></div>') : notFound()));
    const en = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=E&lank=pub-sjjm_603_VIDEO' });
    assert.equal(en.result.isError, undefined, en.text);
    assert.deepEqual(calls, ['https://wol.jw.org/en/wol/d/r1/lp-e/1102016903']);
    assert.match(en.json.note, /video of song 103, which has no captions; this is the song's lyrics page/);
    await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=S&lank=pub-sjjm_152_VIDEO' });
    assert.equal(calls.at(-1), 'https://wol.jw.org/es/wol/d/r4/lp-s/1102022952');
  });

  it('points a daily text page link at get_daily_text and its source_urls', async () => {
    const { result, text } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/h/r1/lp-e/2026/10/12' });
    assert.equal(result.isError, true);
    assert.match(text, /Use get_daily_text with the date instead \(sources: true adds the cited paragraphs\), or read_wol_document on its source_urls/);
    assert.equal(calls.length, 0);
  });
});

describe('search_wol: pasted titles and the glossary card', () => {
  it('drops punctuation WOL would treat as part of a word, and says so', async () => {
    useFetch(() => searchPage(5, numberedItems(1, 5)));
    const dash = await call('search_wol', { query: '"Shepherds—Gifts in Men"', publications: ['songbooks'] });
    assert.equal(new URL(calls[0]).searchParams.get('q'), '"Shepherds Gifts in Men"');
    assert.equal(dash.json.query, '"Shepherds—Gifts in Men"');
    assert.equal(dash.json.searched, '"Shepherds Gifts in Men"');
    assert.match(dash.json.note, /^Searched for "Shepherds Gifts in Men": WOL matches words only, so "—" was removed\.$/);
    const question = await call('search_wol', { query: '"Is It Real to You?"' });
    assert.equal(new URL(calls[1]).searchParams.get('q'), '"Is It Real to You"');
    assert.match(question.json.note, /one-character wildcard/);
    for (const query of ['John 17:1–3', 'John 3:16, 17', '!sin hope', 'wom?n', 'self-control']) {
      const { json } = await call('search_wol', { query });
      assert.equal(new URL(calls.at(-1)).searchParams.get('q'), query);
      assert.equal(json.searched, undefined, query);
      assert.equal(json.note, undefined, query);
    }
    const bare = await call('search_wol', { query: '—' });
    assert.equal(bare.result.isError, true);
    assert.match(bare.text, /Invalid "query"[\s\S]*Next step: WOL matches words/);
  });

  it('says what was removed next to a no-match note', async () => {
    useFetch(() => noResults());
    const { json } = await call('search_wol', { query: 'Baptism—How to Get Ready' });
    assert.match(json.note, /^Searched for Baptism How to Get Ready: [^]*No matches in the English library/);
  });

  // WOL page 1: the glossary card, then 40 documents; page 2: 40 more.
  const topicCard = `<ul class="results resultContentTopic"><li class="caption"><a class="lnk" href="/en/wol/d/r1/lp-e/1001077254?q=resurrection">Resurrection</a></li>
    <li class="result"><ul class="resultItems"><li class="definition"><article><div class="bodyTxt"><p>A sample one-sentence definition of the word.</p></div></article></li><li class="ref">Glossary</li></ul></li></ul>`;
  const glossarySite = (url) => {
    const pg = Number(new URL(url).searchParams.get('pg') ?? 1);
    if (pg === 1) return searchPage(80, [topicCard, ...numberedItems(1, 40)]);
    if (pg === 2) return searchPage(80, numberedItems(41, 40));
    return noResults();
  };
  const titles = (json) => json.results.map((r) => r.title);

  it('returns the glossary card separately, so every document is reachable', async () => {
    useFetch(glossarySite);
    const p1 = await call('search_wol', { query: 'resurrection', publications: ['watchtower'], limit: 40 });
    assert.equal(p1.json.results.length, 40);
    assert.ok(p1.json.results.every((r) => r.citation !== 'Glossary'));
    assert.deepEqual(p1.json.glossary, {
      title: 'Resurrection',
      url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1001077254',
      definition: 'A sample one-sentence definition of the word.'
    });
    assert.equal(p1.json.next_page, 2);
    const p2 = await call('search_wol', { query: 'resurrection', publications: ['watchtower'], limit: 40, page: 2 });
    assert.equal(p2.json.results[0].title, 'Result 41');
    assert.equal(p2.json.glossary, undefined);
    const p4 = await call('search_wol', { query: 'resurrection', publications: ['watchtower'], limit: 10, page: 4 });
    assert.equal(titles(p4.json).at(-1), 'Result 40');
    const p5 = await call('search_wol', { query: 'resurrection', publications: ['watchtower'], limit: 10, page: 5 });
    assert.equal(titles(p5.json)[0], 'Result 41');
    const across = await call('search_wol', { query: 'resurrection', publications: ['watchtower'], limit: 30, page: 2 });
    assert.deepEqual(titles(across.json), Array.from({ length: 30 }, (_, i) => `Result ${31 + i}`));
    assert.equal(across.json.next_page, 3);
  });
});
