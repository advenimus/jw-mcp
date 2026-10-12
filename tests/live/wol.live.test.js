// Live checks of the WOL tools against wol.jw.org (about 42 requests; pages
// are cached in-process). Skipped unless JW_MCP_LIVE=1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatIsoDate } from '../../src/tools/args.js';
import { estimateTokens } from '../../src/tools/results.js';
import { handleWolTools } from '../../src/tools/wol-tools.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';

async function call(name, args) {
  const result = await handleWolTools({ params: { name, arguments: args } });
  const text = result.content[0].text;
  return { result, text, json: result.isError ? null : JSON.parse(text) };
}

const today = new Date();
const TODAY = formatIsoDate(today);
const TOMORROW = formatIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));

describe('get_daily_text (live)', { skip }, () => {
  let todayText;

  it('returns today\'s text in English, and tomorrow from the same page', async () => {
    const { result, text, json } = await call('get_daily_text', {});
    assert.equal(result.isError, undefined, text);
    todayText = json;
    assert.equal(json.date, TODAY);
    assert.equal(json.url, `https://wol.jw.org/en/wol/h/r1/lp-e/${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`);
    assert.match(json.heading, new RegExp(`\\b${today.getDate()}\\b`));
    assert.match(json.theme_scripture, /—.*\d+:\d+/);
    assert.ok(json.text.length > 300, json.text);
    assert.doesNotMatch(json.text, /\bw\d\d\.\d\d \d+ ¶/, 'citation removed from the comment');
    assert.match(json.citation, /^(w|g|ws|wp)\d\d/);
    assert.match(json.source_url, /^https:\/\/wol\.jw\.org\/en\/wol\/pc\/r1\/lp-e\/\d+\/\d+\/\d+$/);
    assert.ok(Array.isArray(json.source_urls) && json.source_urls.length >= 1, JSON.stringify(json.source_urls));
    assert.equal(json.source_urls[0], json.source_url);
    assert.match(json.publication, /^Examining the Scriptures Daily—\d{4}$/);

    const next = await call('get_daily_text', { date: TOMORROW });
    assert.equal(next.json.date, TOMORROW);
    assert.notEqual(next.json.text, json.text);
  });

  it('returns Spanish and other dates', async () => {
    const es = await call('get_daily_text', { date: '2026-01-01', langwritten: 'S' });
    assert.equal(es.result.isError, undefined, es.text);
    assert.match(es.json.heading, /1 de enero/i);
    assert.match(es.json.publication, /Examinemos las Escrituras/);
    assert.ok(es.json.citation, 'has a source citation');

    const old = await call('get_daily_text', { date: '2025-06-01' });
    assert.equal(old.result.isError, undefined, old.text);
    assert.match(old.json.heading, /June 1$/);
    assert.match(old.json.publication, /2025$/);
  });

  it('explains a year WOL does not have', async () => {
    const { result, text } = await call('get_daily_text', { date: '2010-06-01' });
    assert.equal(result.isError, true);
    assert.match(text, /no daily text for 2010-06-01 in English/);
  });

  it('opens the source of the daily text with read_wol_document', async () => {
    assert.ok(todayText, 'needs the first test');
    const { result, text, json } = await call('read_wol_document', { url: todayText.source_url, cited_only: true });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.showing, 'cited paragraphs only');
    assert.match(json.url, /^https:\/\/wol\.jw\.org\/en\/wol\/d\/r1\/lp-e\/\d+#h=/);
    assert.match(json.text, /^\d+ \S/, 'starts with a paragraph number');
    assert.ok(json.text.length > 200 && json.text.length < 6000, `${json.text.length} chars`);
  });

  it('returns the source paragraphs in the same call with sources: true', async () => {
    const { result, text, json } = await call('get_daily_text', { sources: true });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.sources.length, json.source_urls.length);
    for (const source of json.sources) assert.match(source.text, /^\d+ \S/);
  });
});

describe('read_wol_document (live)', { skip }, () => {
  it('reads a study_articles link from get_verse_with_study', async () => {
    const { result, text, json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/1200029049/3271/0' });
    assert.equal(result.isError, undefined, text);
    assert.match(json.title, /Judgments/);
    assert.match(json.citation, /^w24 May pp\. \d+-\d+$/);
    assert.match(json.url, /\/wol\/d\/r1\/lp-e\/2024405#h=/);
    assert.ok(json.cited.chars > 300, JSON.stringify(json.cited));
    assert.match(json.text, /^# .*Judgments/m);
    assert.match(json.text, /\n\n1 \S/, 'paragraph 1 is numbered');
    assert.match(json.text, /\n\n\[a\] /, 'footnotes kept');
    assert.doesNotMatch(json.text, /Your answer/);
    assert.equal(json.next_offset, null);
  });

  it('reads a docid in Spanish and pages a long Insight article', async () => {
    const es = await call('read_wol_document', { docid: '2025241', langwritten: 'es', links: false });
    assert.equal(es.result.isError, undefined, es.text);
    assert.equal(es.json.url, 'https://wol.jw.org/es/wol/d/r4/lp-s/2025241');
    assert.match(es.json.citation, /^w25/);
    assert.doesNotMatch(es.json.text, /\]\(https:/);

    const first = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1200003709', max_chars: 5000 });
    assert.equal(first.json.title, 'Resurrection');
    assert.ok(first.json.total_chars > 20000, `${first.json.total_chars}`);
    assert.ok(first.json.next_offset > 2500 && first.json.next_offset <= 5002);
    const second = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1200003709', max_chars: 5000, offset: first.json.next_offset });
    assert.match(second.json.text, /^\d+ \S/);
  });

  it('marks the cited paragraph of a /wol/pc/ link and names its number', async () => {
    const { result, text, json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/1200029052/1808/0' });
    assert.equal(result.isError, undefined, text);
    assert.deepEqual(json.cited.paragraphs, [3]);
    assert.ok(json.text.slice(json.cited.offset).startsWith('▶ 3 '), json.text.slice(json.cited.offset, json.cited.offset + 40));
  });

  it('pages the Japanese Insight article "Jesus Christ" by tokens, and English as before', async () => {
    const ja = await call('read_wol_document', { docid: '1200002451', langwritten: 'J' });
    assert.equal(ja.result.isError, undefined, ja.text);
    assert.ok(ja.json.text.length <= 23000, `${ja.json.text.length} characters`);
    assert.ok(estimateTokens(ja.text) <= 22000, `about ${estimateTokens(ja.text)} tokens`);
    assert.notEqual(ja.json.next_offset, null);
    const en = await call('read_wol_document', { docid: '1200002451', langwritten: 'E' });
    assert.equal(en.json.next_offset, 29335);
  });

  it('leaves out image toggles ("Printed Edition")', async () => {
    const { result, text, json } = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=E&docid=1102025912', max_chars: 3000 });
    assert.equal(result.isError, undefined, text);
    assert.doesNotMatch(json.text, /Printed Edition/);
  });

  it('opens a jw.org finder?docid= link as the workbook tools return it', async () => {
    const { result, text, json } = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=E&docid=1102018451' });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.title, 'Enthusiasm');
  });

  it('reads a Research Guide citation of several paragraph ranges', async () => {
    const url = 'https://wol.jw.org/en/wol/pc/r1/lp-e/1200029052/59/0';
    const { result, text, json } = await call('read_wol_document', { url, cited_only: true });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.title, 'Jesus Christ');
    assert.match(json.publication, /Insight/);
    assert.match(json.text, /^69 /);
    assert.match(json.text, /\n\n83 /);
  });

  it('marks the subheadings of an older article', async () => {
    const { json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2005322' });
    assert.match(json.text, /^## Publicly Declaring the Resurrection Hope$/m);
  });

  it('reports a document that does not exist', async () => {
    const { result, text } = await call('read_wol_document', { docid: '9999999999' });
    assert.equal(result.isError, true);
    assert.match(text, /wol\.jw\.org/);
    assert.match(text, /Next step:/);
  });
});

describe('search_wol (live)', { skip }, () => {
  let words;

  it('finds documents for words, ranked by occurrences', async () => {
    const { result, text, json } = await call('search_wol', { query: 'resurrection hope', limit: 5 });
    assert.equal(result.isError, undefined, text);
    words = json;
    assert.ok(json.total > 200, `${json.total}`);
    assert.equal(json.results.length, 5);
    assert.equal(json.next_page, 2);
    for (const r of json.results) {
      assert.match(r.url, /^https:\/\/wol\.jw\.org\/en\/wol\/d\/r1\/lp-e\/\d+$/);
      assert.ok(r.title && r.citation && r.snippet, JSON.stringify(r));
      assert.ok(Number.isInteger(r.occurrences));
    }
    const counts = json.results.map((r) => r.occurrences);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  });

  it('a quoted phrase narrows and | widens the search; scope article widens it', async () => {
    const phrase = await call('search_wol', { query: '"resurrection hope"', limit: 1 });
    const either = await call('search_wol', { query: 'resurrection | hope', limit: 1 });
    const article = await call('search_wol', { query: 'resurrection hope', limit: 1, scope: 'article' });
    assert.ok(phrase.json.total < words.total, `${phrase.json.total} < ${words.total}`);
    assert.ok(either.json.total > words.total, `${either.json.total} > ${words.total}`);
    assert.ok(article.json.total > words.total, `${article.json.total} > ${words.total}`);
  });

  it('finds publications citing a verse, filters by publication, and searches Spanish', async () => {
    const verse = await call('search_wol', { query: 'John 3:16', limit: 10 });
    assert.ok(verse.json.total > 100);
    assert.ok(verse.json.results.some((r) => /3:16/.test(r.snippet ?? '')), JSON.stringify(verse.json.results.map((r) => r.snippet)));

    const insight = await call('search_wol', { query: 'resurrection', publications: ['insight'], limit: 5 });
    // WOL files a few related documents (e.g. "Glossary") under Insight too.
    const fromInsight = insight.json.results.filter((r) => /^it-[12] /.test(r.citation));
    assert.ok(fromInsight.length >= insight.json.results.length - 1, JSON.stringify(insight.json.results.map((r) => r.citation)));
    assert.ok(insight.json.total < words.total);

    const es = await call('search_wol', { query: 'esperanza de la resurrección', langwritten: 'S', limit: 3 });
    assert.ok(es.json.total > 100);
    assert.match(es.json.results[0].url, /^https:\/\/wol\.jw\.org\/es\/wol\/d\/r4\/lp-s\/\d+$/);
  });

  it('reports no matches without an error, and a result opens with read_wol_document', async () => {
    const none = await call('search_wol', { query: 'xyzzyqwertplugh' });
    assert.equal(none.result.isError, undefined, none.text);
    assert.equal(none.json.total, 0);
    const spanish = await call('search_wol', { query: 'esperanza de la resurrección', limit: 1 });
    assert.equal(spanish.json.total, 0);
    assert.match(spanish.json.note, /English library[\s\S]*langwritten/);
    const past = await call('search_wol', { query: 'Gehenna', page: 200, limit: 40 });
    assert.ok(past.json.total > 100, JSON.stringify(past.json));
    assert.doesNotMatch(past.json.note, /No matches/);

    const top = words.results[0];
    const doc = await call('read_wol_document', { url: top.url, max_chars: 2000 });
    assert.equal(doc.result.isError, undefined, doc.text);
    assert.equal(doc.json.title, top.title);
  });
});

describe('read_wol_document links in another form (live)', { skip }, () => {
  it('reads a /wol/d/ link in langwritten', async () => {
    const { result, text, json } = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2026521', langwritten: 'S', max_chars: 1000 });
    assert.equal(result.isError, undefined, text);
    assert.match(json.url, /\/lp-s\/2026521/);
  });

  it('opens a jw.org article link in one call', async () => {
    const { result, text, json } = await call('read_wol_document', {
      url: 'https://www.jw.org/en/library/magazines/watchtower-study-august-2026/You-Can-Win-the-Battle/',
      max_chars: 1000
    });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.title, 'You Can Win the Battle!');
    assert.match(json.url, /\/lp-e\/2026521/);
  });
});

describe('round 4 WOL fixes (live)', { skip }, () => {
  it('reads the Memorial date heading and that day\'s Memorial Bible reading', async () => {
    const { result, text, json } = await call('get_daily_text', { date: '2026-04-02' });
    assert.equal(result.isError, undefined, text);
    assert.match(json.heading, /MEMORIAL DATE · After Sundown · Thursday, April 2/);
    assert.match(json.memorial_reading, /Nisan\s*13.*Matthew 26:17-19.*John 13:1-5/s);
    const before = await call('get_daily_text', { date: '2026-04-01' });
    assert.match(before.json.memorial_reading, /Nisan\s*12/);
  });

  it('brings the footnote a daily text source paragraph marks', async () => {
    const { result, text, json } = await call('get_daily_text', { date: '2026-10-10', sources: true });
    assert.equal(result.isError, undefined, text);
    assert.match(json.sources[0].text, /\[c\] John chapter 6 uses words/);
  });

  it('finds a title pasted with its em dash, and returns the glossary card on its own', async () => {
    const dash = await call('search_wol', { query: '"Baptism—How to Get Ready"', limit: 2 });
    assert.ok(dash.json.total > 0, JSON.stringify(dash.json));
    assert.equal(dash.json.searched, '"Baptism How to Get Ready"');
    const card = await call('search_wol', { query: 'resurrection', publications: ['watchtower'], limit: 40 });
    assert.equal(card.json.results.length, 40);
    assert.ok(card.json.results.every((r) => r.citation !== 'Glossary'), JSON.stringify(card.json.results[0]));
    assert.equal(card.json.glossary?.title, 'Resurrection');
    assert.ok(card.json.glossary.definition.length > 100);
  });

  it('cites just the verse of a #v= link, and keeps a Bible chapter\'s footnotes', async () => {
    const john = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3#v=43:3:16', cited_only: true });
    assert.equal(john.result.isError, undefined, john.text);
    assert.match(john.json.text, /^16 “For God loved the world/);
    assert.doesNotMatch(john.json.text, /\b17 For God did not send/);
    const psalm = await call('read_wol_document', { url: 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/19/23' });
    assert.match(psalm.json.text, /\[\*\d\] Psalm 23:2: Or possibly, “to tranquil waters\.”/);
  });

  it('opens a song video link as the song\'s lyrics page', async () => {
    const { result, text, json } = await call('read_wol_document', { url: 'https://www.jw.org/finder?wtlocale=E&lank=pub-sjjm_129_VIDEO', max_chars: 1000 });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.title, 'We Will Keep Enduring');
    assert.match(json.note, /video of song 129/);
  });
});
