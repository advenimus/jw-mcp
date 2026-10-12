// Live checks for Bible book data and get_bible_verse_url against JW.org
// (5 requests). Skipped unless JW_MCP_LIVE=1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchJson, fetchRedirect } from '../../src/tools/http.js';
import { CHAPTER_COUNTS, bibleVerseId, getBookInfo, getVerseCount } from '../../src/tools/bible-books.js';
import { getBibleVerseURLImplementation } from '../../src/tools/scripture-tools.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';

async function urlFor(args) {
  const result = await getBibleVerseURLImplementation(args);
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe('get_bible_verse_url links open the right page', { skip }, () => {
  it('a whole chapter opens that chapter, not the books index', async () => {
    const { url } = await urlFor({ book: 40, chapter: 5 });
    const target = await fetchRedirect(url);
    assert.match(target, /\/study-bible\/books\/matthew\/5\/#v40005001-v40005048$/);
  });

  it('a verse range opens the chapter at those verses', async () => {
    const { url } = await urlFor({ reference: 'Jn 3:16-18' });
    assert.match(await fetchRedirect(url), /\/books\/john\/3\/#v43003016-v43003018$/);
  });

  it('langwritten opens the page in that language', async () => {
    const { url } = await urlFor({ reference: 'Ps. 83:18', langwritten: 'es' });
    assert.match(await fetchRedirect(url), /^https:\/\/www\.jw\.org\/es\/.+\/salmos\/83\/#v19083018$/);
  });

  it('the second chapter of a cross-chapter passage gets its own working link', async () => {
    const { links } = await urlFor({ reference: 'Matt. 5:3–6:4' });
    assert.equal(links.length, 2);
    assert.match(await fetchRedirect(links[1].url), /\/books\/matthew\/6\/#v40006001-v40006004$/);
  });
});

describe('book tables match the jw.org study Bible', { skip }, () => {
  it('chapter counts, abbreviations and a sample of chapter ends', async () => {
    // A range (last)-(last+1) comes back clamped to (last) when the chapter
    // ends at `last`. jw.org answers at most 12 ranges per request.
    const sample = [[19, 119], [64, 1], [39, 4], [29, 3], [43, 7], [41, 16], [66, 12], [65, 1], [31, 1], [47, 13], [1, 50], [66, 22]];
    const ranges = sample.map(([b, c]) => {
      const last = getVerseCount(b, c);
      return { b, c, last, key: `${bibleVerseId(b, c, last)}-${bibleVerseId(b, c, last + 1)}` };
    });
    const data = await fetchJson(
      `https://www.jw.org/en/library/bible/study-bible/books/json/data/${ranges.map((r) => r.key).join(',')}`
    );
    for (const { b, c, last, key } of ranges) {
      assert.equal(data.ranges?.[key]?.validRange, bibleVerseId(b, c, last), `${getBookInfo(b).name} ${c} should end at ${last}`);
    }
    const books = data.editionData.books;
    for (let b = 1; b <= 66; b++) {
      const info = getBookInfo(b);
      assert.equal(Number(books[b].chapterCount), CHAPTER_COUNTS[b], `${info.name} chapters`);
      assert.equal(books[b].standardName, info.name);
      assert.equal(books[b].standardAbbreviation, info.abbreviation, `${info.name} abbreviation`);
      assert.equal(books[b].officialAbbreviation, info.shortAbbreviation, `${info.name} short abbreviation`);
    }
  });
});
