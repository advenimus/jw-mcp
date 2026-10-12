// Offline tests for get_bible_verse and get_verse_with_study and their data
// layer (bible-api.js for the jw.org study-Bible JSON, wol-scraper.js for WOL
// chapter pages). globalThis.fetch is stubbed in every test with small
// synthetic responses shaped like jw.org's; a test that forgets to stub it fails.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearBibleCache,
  getBibleData,
  htmlText,
  isOmittedText,
  parseOutline,
  parseRange,
  parseStudyNotes,
  rangePieces,
  stripPronunciationMarks,
  verseHtmlToText
} from '../../src/tools/bible-api.js';
import { joinText } from '../../src/tools/text.js';
import { clearWolChapterCache, getWolChapter, parseWolChapter, publicationName } from '../../src/tools/wol-scraper.js';
import {
  fitStudyResult,
  getBibleVerseImplementation,
  getBibleVerseTool,
  getVerseWithStudyImplementation,
  getVerseWithStudyTool,
  handleScriptureTools
} from '../../src/tools/scripture-tools.js';
import { clearBookNames, parseReference, registerBookNames } from '../../src/tools/bible-books.js';
import { MAX_RESULT_TOKENS, estimateTokens, jsonText } from '../../src/tools/results.js';
import { clearLanguageCache, resolveLanguage } from '../../src/tools/languages.js';

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
  clearBibleCache();
  clearBookNames();
  clearWolChapterCache();
  globalThis.fetch = async (url) => {
    throw new Error(`offline test tried to fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(name, args) {
  const result = await handleScriptureTools({ params: { name, arguments: args } });
  const text = result.content[0].text;
  return { result, text, json: result.isError ? null : JSON.parse(text) };
}

async function ok(name, args) {
  const out = await call(name, args);
  assert.notEqual(out.result.isError, true, out.text);
  return out.json;
}

async function fails(name, args, pattern) {
  const out = await call(name, args);
  assert.equal(out.result.isError, true, out.text);
  if (pattern) assert.match(out.text, pattern);
  return out.text;
}

// ---------------------------------------------------------------------------
// Synthetic study-Bible JSON (same shape as jw.org's, invented text)

const EN_DATA = 'https://www.jw.org/en/library/bible/study-bible/books/json/data/';
const id = (b, c, v) => `${b}${String(c).padStart(3, '0')}${String(v).padStart(3, '0')}`;

// One line is a prose verse (style-b); several are poetry (style-l, then style-z).
function verseHtml(b, c, v, ...lines) {
  const number = v === 1 ? `<span class="chapterNum"><a href='#'>${c} </a></span>` : `<sup class="verseNum"><a href='#'>${v} </a></sup>`;
  const style = (i) => (lines.length === 1 ? 'b' : i ? 'z' : 'l');
  return lines
    .map((line, i) => `<span class="style-${style(i)}">${i ? '' : number} ${line}<xref id="9${i}"></xref></span>`)
    .join('<span class="newblock"></span>');
}

function verse(b, c, v, ...lines) {
  return { vsID: id(b, c, v), bookNumber: b, chapterNumber: c, verseNumber: v, content: verseHtml(b, c, v, ...lines) };
}

const target = (citation, category = { id: '1', label: 'General' }) => ({
  vs: '1001001',
  standardCitation: citation.replace(/ /g, '&nbsp;'),
  abbreviatedCitation: citation,
  category
});

function range(parts = {}) {
  return {
    citation: 'x',
    link: 'https://www.jw.org/en/library/bible/study-bible/books/x/1/',
    validRange: 'x',
    verses: [],
    chapterOutlines: [],
    crossReferences: [],
    footnotes: [],
    superscriptions: [],
    commentaries: [],
    multimedia: [],
    pubReferences: [],
    html: '<span>dropped</span>',
    ...parts
  };
}

const BOOKS_EN = {
  1: { standardName: 'Genesis', standardSingularBookName: 'Genesis', hasStudyNotes: false },
  19: { standardName: 'Psalms', standardSingularBookName: 'Psalm', hasStudyNotes: false },
  40: { standardName: 'Matthew', standardSingularBookName: 'Matthew', hasStudyNotes: true },
  43: { standardName: 'John', standardSingularBookName: 'John', hasStudyNotes: true },
  66: { standardName: 'Revelation', standardSingularBookName: 'Revelation', hasStudyNotes: false }
};

function bibleBody(ranges, { locale = 'en', symbol = 'nwtsty', books = BOOKS_EN } = {}) {
  return {
    status: 200,
    currentLocale: locale,
    ranges,
    editionData: { locale, vernacularAbbreviation: `NWT-${locale}-${symbol}`, pageCSSClassNames: `publications pub-${symbol}`, books }
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const notFound = () => new Response('Not Found', { status: 404, statusText: 'Not Found' });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });

const chapterId = (b, c) => `${id(b, c, 0)}-${id(b, c, 999)}`;

// The whole chapter a request asks for, made from every fixture range in that
// chapter (one fixture is served as it is; several are merged, each item once).
function chapterFixture(fixtures, rid) {
  if (fixtures[rid]) return fixtures[rid];
  const chapter = rid.split('-')[0].slice(0, -3);
  const found = Object.entries(fixtures).filter(([key]) => key.split('-')[0].slice(0, -3) === chapter).map(([, r]) => r);
  if (found.length < 2) return found[0];
  const merged = range();
  const keyOf = { verses: (v) => v.vsID, superscriptions: (x) => `${x.source}|${x.content}` };
  for (const field of ['verses', 'superscriptions', 'crossReferences', 'footnotes', 'commentaries', 'chapterOutlines']) {
    const seen = new Set();
    for (const item of found.flatMap((r) => (Array.isArray(r[field]) ? r[field] : []))) {
      const key = (keyOf[field] ?? ((x) => x.id))(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged[field].push(item);
    }
  }
  return merged;
}

// Answers study-Bible JSON requests the way jw.org does: one whole chapter
// (BBCCC000-BBCCC999) per request, keyed as requested, from `fixtures`
// ({rangeId: range}); a chapter with no fixture is left out.
function bibleServer(fixtures, { base = EN_DATA, options, other } = {}) {
  return (url, init, n) => {
    if (url.startsWith(base)) {
      const ranges = {};
      for (const rid of url.slice(base.length).split(',')) {
        const found = chapterFixture(fixtures, rid);
        if (found) ranges[rid] = found;
      }
      return json(bibleBody(ranges, options));
    }
    if (other) return other(url, init, n);
    throw new Error(`unexpected fetch ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Synthetic WOL chapter page

function wolPage(book, chapter, { verses = {}, superscription, guide = {} } = {}) {
  const spans = [];
  if (superscription) spans.push(`<p><span class="v" id="v${book}-${chapter}-0-1">${superscription}<a class="b">+</a></span></p>`);
  for (const [v, parts] of Object.entries(verses)) {
    parts.forEach((text, i) => {
      const label = i === 0 ? `<a class="vl vp">${v} </a>` : '';
      spans.push(`<p><span class="v" id="v${book}-${chapter}-${v}-${i + 1}">${label}${text}<a class="b">+</a><a class="fn">*</a></span></p>`);
    });
  }
  const sections = Object.entries(guide).map(([v, entries]) => {
    const ps = entries
      .map(([title, source]) => `<div><p class="su"><a href="/en/wol/pc/r1/lp-e/1/${encodeURIComponent(title)}/0">${title}</a></p></div><div><p class="su"><em>${source}</em></p></div>`)
      .join('');
    return `<div class="section" data-key="${book}-${chapter}-${v}"><ul><li class="item ref-rsg"><p class="su"></p>${ps}</li></ul></div>`;
  });
  return new Response(
    `<!DOCTYPE html><html><body><article>${spans.join('')}</article><div id="studyDiscover"><div class="section"><ul class="outline"></ul></div>${sections.join('')}</div></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

// ---------------------------------------------------------------------------

describe('bible-api parsing', () => {
  it('verse HTML becomes the plain verse: no numbers or markers, one poetic line per "\\n"', () => {
    assert.equal(verseHtmlToText(verseHtml(19, 83, 18, 'May people know you,', 'You alone are high.')), 'May people know you,\nYou alone are high.');
    assert.equal(verseHtmlToText(verseHtml(19, 83, 1, 'O God,', 'Do not keep quiet<fn id="5"></fn> or still.')), 'O God,\nDo not keep quiet or still.');
    assert.equal(verseHtmlToText(verseHtml(43, 3, 16, 'For God loved the world.')), 'For God loved the world.');
    // A prose opening line (style-b) before poetic lines is a line of its own.
    assert.equal(
      verseHtmlToText('<span class="style-b"><sup class="verseNum">1 </sup> The vision of Obadiah:</span><span class="parabreak"></span><span class="style-z">This is what Jehovah says,</span><span class="style-z">“We have heard.”</span>'),
      'The vision of Obadiah:\nThis is what Jehovah says,\n“We have heard.”'
    );
    assert.equal(verseHtmlToText('<span class="style-b"><sup class="verseNum"><a>21 </a></sup> ——</span>\r\n<span class="parabreak"></span>'), '——');
    assert.equal(isOmittedText('——'), true);
    assert.equal(isOmittedText('Not omitted.'), false);
  });

  it('splits study notes per term and keeps headings and quoted verse numbers in the right note', () => {
    const notes = parseStudyNotes(
      '<p><strong>first term:</strong> One note.\u200b—See <a>Mt 3:1</a>.</p>\r\n' +
        '<p><strong>second term:</strong> Another note with a <strong>bold</strong> word.</p>\r\n' +
        '<p class="sn"><strong>7:53</strong></p>\r\n' +
        '<p>Heading body.</p>\r\n' +
        '<p><strong><sup>53</sup></strong> <span>Quoted verse.</span></p>'
    );
    assert.deepEqual(notes, [
      { term: 'first term', note: 'One note.—See Mt 3:1.' },
      { term: 'second term', note: 'Another note with a bold word.' },
      { term: '7:53', note: 'Heading body. 53 Quoted verse.' }
    ]);
    assert.deepEqual(parseStudyNotes('<p>Some ancient manuscripts add words here.</p>'), [{ note: 'Some ancient manuscripts add words here.' }]);
  });

  it('reads outline levels and the chapters each entry covers', () => {
    const outline = parseOutline(
      '<ul class="outline partial"><li class="L1"><p class="se"><strong>J. Section (</strong><a data-targetverses="43013001-43017026"><strong>13:1–17:26</strong></a>)</p>' +
        '<ul><li class="L2"><p>Part one (<a data-targetverses="43013001-43013020">13:1-20</a>)</p></li>' +
        '<li class="L2"><p>Part two (<a data-targetverses="43017001-43017026">17:1-26</a>)</p></li></ul></li></ul>'
    );
    assert.deepEqual(outline, [
      { level: 1, text: 'J. Section (13:1–17:26)', chapters: [13, 17] },
      { level: 2, text: 'Part one (13:1-20)', chapters: [13, 13] },
      { level: 2, text: 'Part two (17:1-26)', chapters: [17, 17] }
    ]);
  });

  it('parses a range into per-verse items and drops linked-only notes', () => {
    const parsed = parseRange(
      range({
        verses: [verse(19, 3, 1, 'Line one?', 'Line two?')],
        superscriptions: [{ id: 1, content: '<span class="style-w">A heading.<xref id="3"></xref></span>', source: '19003000' }],
        crossReferences: [
          { id: 3, source: '19003000', targets: [target('2 Samuel 15:14')] },
          { id: 4, source: '19003001', targets: [target('2 Samuel 15:12'), target('Mark 13:10', { id: '2', label: 'Parallel Account' })] },
          { id: 5, source: '19003001', targets: [target('2 Samuel 15:12')] }
        ],
        footnotes: [{ id: 6, content: '<span>Or “a word.”</span>', source: '19003001', anchor: 'fn6' }],
        commentaries: [
          { id: 7, content: null, source: null, label: null },
          { id: 8, content: '<p><strong>term:</strong> Text.</p>', source: '19003001', label: null }
        ]
      })
    );
    assert.deepEqual(parsed.verses, [{ chapter: 3, verse: 1, text: 'Line one?\nLine two?', poetry: true }]);
    assert.deepEqual(parsed.superscriptions, [{ chapter: 3, text: 'A heading.' }]);
    // One entry per "+" marker; the superscription's marker follows "A heading".
    assert.deepEqual(parsed.crossReferences, [
      { chapter: 3, verse: 0, phrase: 'A heading', targets: ['2 Samuel 15:14'] },
      { chapter: 3, verse: 1, targets: ['2 Samuel 15:12', 'Mark 13:10'], categories: { 'Parallel Account': ['Mark 13:10'] } },
      { chapter: 3, verse: 1, targets: ['2 Samuel 15:12'] }
    ]);
    assert.deepEqual(parsed.headings, []);
    assert.deepEqual(parsed.footnotes, [{ id: '6', book: 19, chapter: 3, verse: 1, text: 'Or “a word.”' }]);
    assert.deepEqual(parsed.notes, [{ chapter: 3, verse: 1, term: 'term', note: 'Text.' }]);
    assert.equal(JSON.stringify(parsed).includes('dropped'), false);
  });

  it('ties each cross-reference group to the phrase its marker follows', () => {
    const parsed = parseRange(
      range({
        verses: [{ vsID: '43017003', content: '<span class="style-b"><sup class="verseNum">3 </sup>Line one?<xref id="4"></xref> Line two, and the only true God<xref id="5"></xref>.</span>' }],
        crossReferences: [
          { id: 4, source: '43017003', targets: [target('Luke 10:25-28')] },
          { id: 5, source: '43017003', targets: [target('Acts 17:26, 27'), target('1 John 5:20')] },
          { id: 6, source: '43017003', targets: [target('Ephesians 4:11')] }
        ]
      })
    );
    assert.deepEqual(parsed.verses[0].text, 'Line one? Line two, and the only true God.');
    assert.deepEqual(parsed.crossReferences, [
      { chapter: 17, verse: 3, phrase: 'Line one', targets: ['Luke 10:25-28'] },
      { chapter: 17, verse: 3, phrase: 'and the only true God', targets: ['Acts 17:26, 27', '1 John 5:20'] },
      { chapter: 17, verse: 3, targets: ['Ephesians 4:11'] }
    ]);
  });

  it('keeps acrostic letter headings apart from the psalm superscription', () => {
    const parsed = parseRange(
      range({
        verses: [verse(19, 9, 8, 'He will judge.'), verse(19, 9, 9, 'A secure refuge.')],
        superscriptions: [
          { id: 1, content: '<span class="style-w">A melody.</span>', source: '19009000' },
          { id: 2, content: '<span class="style-s">ב [<em>Beth</em>]</span>', source: '19009009' }
        ]
      })
    );
    assert.deepEqual(parsed.superscriptions, [{ chapter: 9, text: 'A melody.' }]);
    assert.deepEqual(parsed.headings, [{ chapter: 9, verse: 9, text: 'ב [Beth]' }]);
  });

  it('plans one whole-chapter range per chapter, the id jw.org\'s own chapter pages request', () => {
    assert.deepEqual(rangePieces(parseReference('Ps 3:1-2')).map((p) => p.id), ['19003000-19003999']);
    assert.deepEqual(rangePieces(parseReference('Ps 3:0')).map((p) => [p.id, p.from, p.to]), [['19003000-19003999', 0, 0]]);
    assert.deepEqual(rangePieces(parseReference('John 8')).map((p) => [p.id, p.from]), [['43008000-43008999', 12]]);
    assert.deepEqual(rangePieces(parseReference('Matt 5:47–6:2')).map((p) => [p.id, p.from, p.to]), [['40005000-40005999', 47, 48], ['40006000-40006999', 1, 2]]);
    assert.deepEqual(rangePieces(parseReference('John 3:1,3')).map((p) => [p.id, p.from]), [['43003000-43003999', 1], ['43003000-43003999', 3]]);
  });

  it('ties each footnote to the words its marker follows, without losing a cross reference\'s phrase', () => {
    const parsed = parseRange(
      range({
        verses: [{
          vsID: '19023003',
          content: '<span class="style-l"><sup class="verseNum">3 </sup> He rests me.<fn id="1"></fn><xref id="9"></xref></span><span class="parabreak"></span><span class="style-z">He leads me in the ways<fn id="2"></fn> of right.<xref id="8"></xref></span>'
        }],
        crossReferences: [{ id: 9, source: '19023003', targets: [target('Isaiah 40:11')] }],
        footnotes: [
          { id: 1, content: 'Or “my soul.”', source: '19023003' },
          { id: 2, content: 'Lit., “tracks.”', source: '19023003' }
        ]
      })
    );
    assert.deepEqual(parsed.footnotes.map((f) => [f.id, f.phrase, f.text]), [['1', 'He rests me', 'Or “my soul.”'], ['2', 'He leads me in the ways', 'Lit., “tracks.”']]);
    assert.equal(parsed.crossReferences[0].phrase, 'He rests me');
    assert.equal(parsed.verses[0].text, 'He rests me.\nHe leads me in the ways of right.');
  });
});

describe('getBibleData', () => {
  const E = { code: 'E', name: 'English', jwPath: 'en' };

  it('asks for each chapter once, whole, and caches the parsed chapter', async () => {
    const list = Array.from({ length: 14 }, (_, i) => 2 * i + 1);
    useFetch(bibleServer({ [chapterId(43, 3)]: range({ verses: list.map((v) => verse(43, 3, v, `Verse ${v}.`)) }) }));
    const ref = parseReference(`John 3:${list.join(',')}`);
    const data = await getBibleData(ref, E);
    assert.deepEqual(calls, [`${EN_DATA}43003000-43003999`]);
    assert.equal(data.pieces.length, 14);
    assert.equal(data.pieces[13].data.verses.find((v) => v.verse === 27).text, 'Verse 27.');
    assert.deepEqual(data.book, { name: 'John', hasStudyNotes: true });
    assert.deepEqual(data.edition, { symbol: 'nwtsty', studyEdition: true });

    await getBibleData(ref, E);
    await getBibleData(parseReference('John 3:16'), E);
    await getBibleData(parseReference('John 3:17'), E);
    assert.equal(calls.length, 1, 'another verse of the chapter comes from the cache');
    await getBibleData(ref, E, { bypass: true });
    assert.equal(calls.length, 2, 'bypass refetches');
  });

  it('fetches a passage over several chapters one chapter per request, a few at a time', async () => {
    let open = 0;
    let peak = 0;
    const fixtures = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [chapterId(19, 120 + i), range({ verses: [verse(19, 120 + i, 1, 'A song.')] })]));
    const serve = bibleServer(fixtures);
    useFetch(async (url, init, n) => {
      peak = Math.max(peak, ++open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return serve(url, init, n);
    });
    const data = await getBibleData(parseReference('Psalms 120-129'), E);
    assert.equal(data.pieces.length, 10);
    assert.equal(calls.length, 10);
    assert.ok(calls.every((u) => !u.includes(',')), 'no comma-joined ranges');
    assert.ok(peak <= 4, `at most 4 at once, saw ${peak}`);
  });

  it('says so when the language lacks a passage', async () => {
    useFetch(bibleServer({}));
    await assert.rejects(getBibleData(parseReference('Gen 1:1'), E), {
      name: 'ToolError',
      message: /no New World Translation in English \(E\) with Genesis 1 /
    });
  });

  it('finds another language\'s books path through the finder and keeps it', async () => {
    const S_DATA = 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/json/data/';
    useFetch(
      bibleServer(
        { '43003016-43003016': range({ verses: [verse(43, 3, 16, 'Texto.')] }) },
        {
          base: S_DATA,
          options: { locale: 'es', books: { 43: { standardName: 'Juan', standardSingularBookName: 'Juan', hasStudyNotes: true } } },
          other: (url) => {
            assert.equal(url, 'https://www.jw.org/finder?wtlocale=S&prefer=lang&bible=43003016&pub=nwtsty');
            return redirect('https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/#v43003016');
          }
        }
      )
    );
    const S = await resolveLanguage('S');
    const data = await getBibleData(parseReference('John 3:16'), S);
    assert.equal(data.pieces[0].data.verses[0].text, 'Texto.');
    assert.equal(data.book.name, 'Juan');
    clearBibleCache();
    await getBibleData(parseReference('John 3:16'), S);
    assert.equal(calls.filter((u) => u.includes('/finder')).length, 2, 'the path is cached with the data');
  });

  it('reports a language without a Bible instead of serving English', async () => {
    useFetch(() => redirect('https://www.jw.org/en/library/bible/'));
    await assert.rejects(getBibleData(parseReference('John 3:16'), await resolveLanguage('KO')), {
      name: 'ToolError',
      message: /no New World Translation in Korean \(KO\)/
    });
  });
});

describe('wol-scraper', () => {
  it('joins verse segments, strips markers and keeps the superscription as verse 0', () => {
    const res = wolPage(19, 3, { superscription: 'A heading.', verses: { 1: ['Line one,', 'line two.'], 2: ['Next.'] } });
    return res.text().then((html) => {
      const page = parseWolChapter(html, 19, 3);
      assert.deepEqual(page.verses, { 1: 'Line one, line two.', 2: 'Next.' });
      assert.equal(page.superscription, 'A heading.');
    });
  });

  it('pairs each Research Guide title with its citation and names the publication', async () => {
    const html = await wolPage(40, 24, {
      verses: { 14: ['Text.'] },
      guide: { 14: [['Questions From Readers', 'w25.08 p. 31'], ['Questions From Readers', 'w96 7/15 p. 3'], ['Herald', 'it-1 “Herald” par. 2']] }
    }).text();
    const page = parseWolChapter(html, 40, 24, 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/40/24');
    assert.deepEqual(page.articles[14].map((a) => [a.title, a.source, a.publication]), [
      ['Questions From Readers', 'w25.08 p. 31', 'The Watchtower'],
      ['Questions From Readers', 'w96 7/15 p. 3', 'The Watchtower'],
      ['Herald', 'it-1 “Herald” par. 2', 'Insight on the Scriptures, Volume 1']
    ]);
    assert.match(page.articles[14][0].url, /^https:\/\/wol\.jw\.org\/en\/wol\/pc\/r1\/lp-e\//);
    assert.equal(publicationName('wp20 No. 2 p. 9'), 'The Watchtower (public edition)');
    assert.equal(publicationName('g21 No. 1 p. 14'), 'Awake!');
    assert.equal(publicationName('lff lesson 4 points 1-5'), 'Enjoy Life Forever!');
    assert.equal(publicationName('zz 1/1 p. 1'), null);
    assert.equal(publicationName('constructor p. 1'), null);
    assert.equal(publicationName('toString 5'), null);
  });

  it('falls back to the plain NWT page when WOL has no study edition page', async () => {
    useFetch((url) => (url.includes('/nwtsty/') ? notFound() : wolPage(43, 3, { verses: { 16: ['Text.'] } })));
    const page = await getWolChapter(await resolveLanguage('E'), 43, 3);
    assert.equal(page.symbol, 'nwt');
    assert.equal(page.verses[16], 'Text.');
  });
});

describe('scripture tool definitions', () => {
  it('accept a reference or book/chapter/verse, plus langwritten', () => {
    for (const tool of [getBibleVerseTool, getVerseWithStudyTool]) {
      const { properties, required } = tool.inputSchema;
      assert.deepEqual(required, []);
      assert.equal(properties.reference.type, 'string');
      assert.equal(properties.book.type, 'integer');
      assert.equal(properties.chapter.type, 'integer');
      assert.equal(properties.verse.type, 'string');
      assert.equal(properties.langwritten.type, 'string');
    }
    const { fields, limit } = getVerseWithStudyTool.inputSchema.properties;
    assert.ok(fields.items.enum.includes('footnotes'));
    assert.ok(fields.items.enum.includes('chapter_articles'));
    assert.equal(limit.type, 'integer');
    assert.match(getVerseWithStudyTool.description, /read_wol_document/);
  });

  it('the handler ignores other tools and never throws on missing arguments', async () => {
    assert.equal(await handleScriptureTools({ params: { name: 'other_tool', arguments: {} } }), null);
    const out = await handleScriptureTools({ params: { name: 'get_bible_verse' } });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /Missing reference/);
  });
});

const PS83 = {
  '19083018-19083018': range({
    verses: [verse(19, 83, 18, 'May people know that you, whose name is Jehovah,', 'You alone are the Most High over all the earth.')],
    crossReferences: [{ id: 1, source: '19083018', targets: [target('Exodus 6:3')] }]
  })
};

describe('get_bible_verse', () => {
  it('returns the whole verse as plain text with a jw.org link', async () => {
    useFetch(bibleServer(PS83));
    const out = await ok('get_bible_verse', { book: 19, chapter: 83, verse: 18 });
    assert.equal(out.reference, 'Psalm 83:18');
    assert.equal(out.book_name, 'Psalms');
    assert.equal(out.verse, 18);
    // Poetry keeps its printed lines.
    assert.equal(out.text, 'May people know that you, whose name is Jehovah,\nYou alone are the Most High over all the earth.');
    assert.equal(out.url, 'https://www.jw.org/finder?wtlocale=E&prefer=lang&bible=19083018&pub=nwtsty');
    assert.equal(out.langwritten, 'E');
  });

  it('accepts numbers sent as strings, a reference string and the old positional form', async () => {
    useFetch(bibleServer({ '43003016-43003016': range({ verses: [verse(43, 3, 16, 'For God loved the world.')] }) }));
    assert.equal((await ok('get_bible_verse', { book: '43', chapter: '3', verse: '16' })).text, 'For God loved the world.');
    assert.equal((await ok('get_bible_verse', { reference: 'Jn 3:16' })).reference, 'John 3:16');
    const legacy = await getBibleVerseImplementation(43, 3, 16);
    assert.equal(JSON.parse(legacy.content[0].text).text, 'For God loved the world.');
    assert.equal(calls.length, 1, 'one request, then the cache');
  });

  it('returns each verse of a range and numbers the combined text once', async () => {
    useFetch(
      bibleServer({
        '66021003-66021004': range({
          verses: [verse(66, 21, 3, 'Verse three.'), verse(66, 21, 4, 'Verse four.')],
          footnotes: [{ id: 2, content: 'Or “x.”', source: '66021004', anchor: 'fn2' }]
        })
      })
    );
    const out = await ok('get_bible_verse', { reference: 'Rev. 21:3-4' });
    assert.equal(out.reference, 'Revelation 21:3, 4');
    assert.equal(out.verse, '3-4');
    assert.equal(out.text, '3 Verse three. 4 Verse four.');
    // text already has every verse; verses[] carries only what it cannot.
    assert.deepEqual(out.verses, [{ verse: 4, footnotes: [{ note: 'Or “x.”' }] }]);
  });

  it('adds the superscription to verse 1 of a psalm and returns it as verse 0', async () => {
    const fixture = range({
      verses: [verse(19, 3, 1, 'Why are they so many?')],
      superscriptions: [{ id: 1, content: '<span class="style-w">A melody of David.</span>', source: '19003000' }]
    });
    useFetch(bibleServer({ '19003000-19003001': fixture }));
    const one = await ok('get_bible_verse', { reference: 'Psalm 3:1' });
    assert.equal(one.text, 'Why are they so many?');
    assert.equal(one.superscription, 'A melody of David.');
    const zero = await ok('get_bible_verse', { book: 19, chapter: 3, verse: '0' });
    assert.equal(zero.reference, 'Psalm 3:superscription');
    assert.equal(zero.text, 'A melody of David.');
    assert.equal(zero.superscription, undefined);
  });

  it('says a psalm has no superscription instead of returning empty text', async () => {
    useFetch(bibleServer({ '19001000-19001001': range({ verses: [verse(19, 1, 1, 'Happy is the man.')] }) }));
    await fails('get_bible_verse', { reference: 'Psalm 1:0' }, /Psalm 1 has no superscription/);
    await fails('get_verse_with_study', { reference: 'Psalm 1:0' }, /Psalm 1 has no superscription/);
  });

  it('flags a verse the NWT leaves out ("——") with an explanation', async () => {
    useFetch(
      bibleServer({
        '40017021-40017021': range({
          verses: [{ ...verse(40, 17, 21, 'x'), content: '<span class="style-b"><sup class="verseNum"><a>21 </a></sup> ——</span>' }]
        })
      })
    );
    const out = await ok('get_bible_verse', { reference: 'Matthew 17:21' });
    assert.equal(out.text, '');
    assert.equal(out.omitted, true);
    assert.match(out.note, /no text in the NWT/);
    assert.match(out.note, /study note on Matthew 17:21/);
  });

  it('explains John 7:53–8:11 and Mark 16:9-20 without fetching anything', async () => {
    for (const args of [{ reference: 'John 8:7' }, { book: 'John', chapter: '8', verse: '7' }, { reference: 'Mark 16:9-20' }]) {
      const out = await ok('get_bible_verse', args);
      assert.equal(out.omitted, true);
      assert.equal(out.text, '');
      assert.match(out.note, /left out of the NWT because it is not found in the earliest and most reliable manuscripts/);
    }
    const john = await ok('get_bible_verse', { reference: 'John 8:7' });
    assert.equal(john.reference, 'John 8:7');
    assert.match(john.url, /bible=43007052/);
    assert.equal((await ok('get_bible_verse', { reference: 'Mark 16:9-20' })).reference, 'Mark 16:9-20');
  });

  it('explains why a whole John 8 starts at verse 12, and lists verses jw.org left out', async () => {
    const verses = Array.from({ length: 48 }, (_, i) => verse(43, 8, i + 12, `Verse ${i + 12}.`)).filter((v) => v.verseNumber !== 20);
    useFetch(bibleServer({ '43008012-43008059': range({ verses }) }));
    const out = await ok('get_bible_verse', { book: 43, chapter: 8 });
    assert.equal(out.verse, '12-59');
    assert.equal(out.verses, undefined);
    assert.match(out.text, /^12 Verse 12\. 13 Verse 13\./);
    assert.match(out.note, /John 8 starts at verse 12 in the NWT: John 7:53–8:11 is not part of it/);
    assert.match(out.note, /jw\.org returned no text for John 8:20\./);
  });

  it('rejects impossible references before any request', async () => {
    await fails('get_bible_verse', { book: 43, chapter: 22, verse: 1 }, /John has 21 chapters/);
    await fails('get_bible_verse', { book: 43, chapter: 3, verse: 99 }, /John 3 has 36 verses/);
    await fails('get_bible_verse', { book: 43, chapter: 3, verse: '16abc' }, /Invalid "verse"/);
    await fails('get_bible_verse', { langwritten: ['E'], reference: 'John 3:16' }, /Invalid "langwritten"/);
  });

  it('caps the passage size', async () => {
    await fails('get_bible_verse', { reference: 'Psalm 118-119' }, /Psalms 118, 119 has 205 verses in 2 chapters; get_bible_verse returns at most 200 verses/);
  });

  it('falls back to wol.jw.org for the text when the study-Bible data fails', async () => {
    useFetch((url) => {
      if (url.startsWith(EN_DATA)) return notFound();
      assert.equal(url, 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/43/3');
      return wolPage(43, 3, { verses: { 16: ['For God loved', 'the world.'] } });
    });
    const out = await ok('get_bible_verse', { reference: 'John 3:16' });
    assert.equal(out.text, 'For God loved the world.');
    assert.match(out.note, /did not answer \(www\.jw\.org returned 404/);
    assert.match(out.note, /from wol\.jw\.org/);
  });

  it('returns isError with the cause when both sources fail', async () => {
    useFetch(() => notFound());
    await fails('get_bible_verse', { reference: 'John 3:16' }, /www\.jw\.org returned 404 Not Found[\s\S]*Next step:/);
  });
});

const MT24 = {
  '40024014-40024014': range({
    verses: [verse(40, 24, 14, 'This good news will be preached.')],
    crossReferences: [
      { id: 1, source: '40024014', targets: [target('Matthew 9:35')] },
      { id: 2, source: '40024014', targets: [target('Mark 13:10', { id: '2', label: 'Parallel Account' })] }
    ],
    commentaries: [
      { id: 3, content: null, source: null, label: null },
      { id: 4, content: '<p><strong>this good news:</strong> Note A.</p><p><strong>preached:</strong> Note B.</p>', source: '40024014', label: null }
    ],
    chapterOutlines: [
      {
        id: 10,
        content:
          '<ul class="outline partial"><li class="L1"><p>L. Prophecy (<a data-targetverses="40024001-40025046">24:1–25:46</a>)</p>' +
          '<ul><li class="L2"><p>Sign (<a data-targetverses="40024001-40024003">24:1-3</a>)</p></li>' +
          '<li class="L2"><p>Virgins (<a data-targetverses="40025001-40025013">25:1-13</a>)</p></li></ul></li></ul>'
      }
    ]
  })
};

const MT24_GUIDE = {
  1: [['Article One', 'jy chap. 110']],
  14: [
    ['Questions From Readers', 'w25.08 p. 31'],
    ['Questions From Readers', 'w96 7/15 p. 3'],
    ['Herald', 'it-1 “Herald” par. 2'],
    ['Questions From Readers', 'w25.08 p. 31']
  ],
  15: [['Article Two', 'w20.01 p. 1']]
};

function mt24Server() {
  return bibleServer(MT24, {
    other: (url) => {
      assert.equal(url, 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/40/24');
      return wolPage(40, 24, { verses: { 14: ['Text.'] }, guide: MT24_GUIDE });
    }
  });
}

describe('get_verse_with_study', () => {
  it('returns one entry per study note and real cross references', async () => {
    useFetch(mt24Server());
    const out = await ok('get_verse_with_study', { reference: 'Matt. 24:14', fields: ['verses', 'study_notes', 'cross_references', 'combined_text'] });
    assert.equal(out.reference, 'Matthew 24:14');
    assert.equal(out.verse_range, '14');
    assert.deepEqual(out.verses, [{ chapter: 24, verse: 14, text: 'This good news will be preached.' }]);
    assert.equal(out.combined_text, '14 This good news will be preached.');
    assert.deepEqual(out.study_notes, { 14: [{ term: 'this good news', note: 'Note A.' }, { term: 'preached', note: 'Note B.' }] });
    assert.equal(out.study_notes_count, 2);
    assert.equal(out.has_study_notes, true);
    assert.deepEqual(out.cross_references, [
      { chapter: 24, verse: 14, targets: ['Matthew 9:35'] },
      { chapter: 24, verse: 14, targets: ['Mark 13:10'], categories: { 'Parallel Account': ['Mark 13:10'] } }
    ]);
    assert.equal(out.cross_references_count, 2);
    assert.equal(calls.length, 1, 'no WOL page unless articles are asked for');
  });

  it('dedupes Research Guide articles by title and citation and reports the total', async () => {
    useFetch(mt24Server());
    const out = await ok('get_verse_with_study', { book: 40, chapter: 24, verse: '14', fields: ['study_articles'], limit: 2 });
    assert.deepEqual(out.study_articles, [
      { title: 'Questions From Readers', source: 'w25.08 p. 31', publication: 'The Watchtower', url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/1/Questions%20From%20Readers/0' },
      { title: 'Questions From Readers', source: 'w96 7/15 p. 3', publication: 'The Watchtower', url: 'https://wol.jw.org/en/wol/pc/r1/lp-e/1/Questions%20From%20Readers/0' }
    ]);
    assert.equal(out.study_articles_count, 2);
    assert.equal(out.study_articles_total, 3);
    assert.match(out.note, /study_articles shows 2 of 3 Research Guide articles; set limit up to 100 to see the rest/);
    assert.equal(calls.length, 1, 'only the WOL page');
  });

  it('keeps chapter_level bounded: the chapter\'s outline, and chapter articles only when asked', async () => {
    useFetch(mt24Server());
    const out = await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: ['chapter_level'] });
    assert.deepEqual(out.chapter_level, {
      outline: [
        { level: 1, text: 'L. Prophecy (24:1–25:46)' },
        { level: 2, text: 'Sign (24:1-3)' }
      ]
    });
    // 1.3 put the chapter's articles here; the note says where they went.
    assert.match(out.note, /"chapter_articles"/);
    const both = await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: 'chapter_level, chapter_articles', limit: 2 });
    assert.equal(both.note?.includes('chapter_level now holds'), false);
    assert.equal(both.chapter_level.outline.length, 2);
    assert.deepEqual(both.chapter_level.study_articles.map((a) => [a.title, a.verses]), [
      ['Article One', ['1']],
      ['Questions From Readers', ['14']]
    ]);
    assert.equal(both.chapter_level.study_articles_count, 2);
    assert.equal(both.chapter_level.study_articles_total, 5);
    assert.match(both.note, /chapter_level\.study_articles shows 2 of 5 Research Guide articles; set limit up to 100/);
  });

  it('says when a book has no study notes and what to ask for instead', async () => {
    useFetch(bibleServer({ '1001001-1001001': range({ verses: [verse(1, 1, 1, 'In the beginning.')], footnotes: [] }) }));
    const out = await ok('get_verse_with_study', { reference: 'Genesis 1:1' });
    assert.deepEqual(out.study_notes, {});
    assert.equal(out.has_study_notes, false);
    assert.deepEqual(out.footnotes, {});
    assert.match(out.note, /no study notes for Genesis/);
    assert.match(out.note, /study_articles/);
  });

  it('includes the superscription, its cross references and footnotes for verse 1 of a psalm', async () => {
    useFetch(
      bibleServer({
        '19003000-19003002': range({
          verses: [verse(19, 3, 1, 'Line one?'), verse(19, 3, 2, 'Line two.')],
          superscriptions: [{ id: 1, content: '<span class="style-w">A melody.</span>', source: '19003000' }],
          crossReferences: [{ id: 2, source: '19003000', targets: [target('2 Samuel 15:14')] }],
          footnotes: [{ id: 3, content: 'Or “y.”', source: '19003002', anchor: 'fn3' }]
        })
      })
    );
    const out = await ok('get_verse_with_study', {
      reference: 'Psalm 3:1-2',
      fields: ['verses', 'combined_text', 'footnotes', 'cross_references']
    });
    assert.equal(out.superscription, 'A melody.');
    assert.equal(out.combined_text, 'A melody. 1 Line one? 2 Line two.');
    assert.deepEqual(out.footnotes, { 2: [{ note: 'Or “y.”' }] });
    assert.deepEqual(out.cross_references, [{ chapter: 3, verse: 0, targets: ['2 Samuel 15:14'] }]);
  });

  it('returns the study note that explains an omitted passage', async () => {
    useFetch(
      bibleServer({
        '43007052-43007052': range({
          verses: [verse(43, 7, 52, 'Search and see.')],
          commentaries: [
            {
              id: 1,
              source: '43007052',
              content: '<p><strong>about Galilee:</strong> A note on verse 52.</p><p class="sn"><strong>7:53</strong></p><p>Early manuscripts lack Joh 7:53–8:11.</p>'
            }
          ]
        })
      })
    );
    const out = await ok('get_verse_with_study', { reference: 'John 8:3-5' });
    assert.equal(out.omitted, true);
    assert.equal(out.reference, 'John 7:53–8:11');
    assert.deepEqual(out.explanation.study_notes, [{ term: '7:53', note: 'Early manuscripts lack Joh 7:53–8:11.' }]);
    assert.equal(out.explanation.reference, 'John 7:52');
  });

  it('serves repeats from the cache and refetches with fetch: true', async () => {
    useFetch(mt24Server());
    await ok('get_verse_with_study', { reference: 'Matt 24:14' });
    await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: ['verses'] });
    assert.equal(calls.length, 1);
    await ok('get_verse_with_study', { reference: 'Matt 24:14', fetch: true });
    assert.equal(calls.length, 2);
  });

  it('accepts the old positional form', async () => {
    useFetch(mt24Server());
    const result = await getVerseWithStudyImplementation(40, 24, '14', ['verses'], 5, false);
    assert.equal(JSON.parse(result.content[0].text).verses[0].verse, 14);
  });

  it('validates fields, limit and size before fetching', async () => {
    await fails('get_verse_with_study', { reference: 'John 3:16', fields: ['verses', 'pictures'] }, /Invalid "fields": expected one of "verses"/);
    await fails('get_verse_with_study', { reference: 'John 3:16', fields: { a: 1 } }, /Invalid "fields"/);
    await fails('get_verse_with_study', { reference: 'Matthew 26:1-27:10' }, /at most 60 verses in 5 chapters[\s\S]*get_bible_verse/);
    await fails('get_verse_with_study', { reference: 'John 3:16', limit: 'many' }, /Invalid "limit"/);
    await fails('get_verse_with_study', { reference: 'John 3:16', fields: 'cross references' }, /Next step: Field names use underscores/);
    await fails('get_verse_with_study', { reference: 'Psalm 1-6' }, /in 6 chapters/);
    await fails('get_verse_with_study', { book: 40, chapter: 99, verse: '1' }, /Matthew has 28 chapters/);
  });

  it('keeps the study data when only the Research Guide fails, and fails when that was all that was asked', async () => {
    useFetch(bibleServer(MT24, { other: () => new Response('busy', { status: 500 }) }));
    const out = await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: ['verses', 'study_articles'] });
    assert.equal(out.verses.length, 1);
    assert.equal(out.study_articles, undefined);
    assert.match(out.note, /Research Guide articles are unavailable: wol\.jw\.org returned 500/);
    await fails('get_verse_with_study', { reference: 'Matt 24:14', fields: ['study_articles'] }, /wol\.jw\.org returned 500/);
  });

  it('works in another language and labels the reference in it', async () => {
    const S_DATA = 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/json/data/';
    useFetch(
      bibleServer(
        {
          '43003016-43003016': range({
            verses: [verse(43, 3, 16, 'Porque Dios amó tanto al mundo.')],
            commentaries: [{ id: 1, source: '43003016', content: '<p><strong>amó.</strong> Nota uno.</p><p><strong>al mundo.</strong> Nota dos.</p>' }]
          })
        },
        {
          base: S_DATA,
          options: { locale: 'es', books: { 43: { standardName: 'Juan', standardSingularBookName: 'Juan', hasStudyNotes: true } } },
          other: () => redirect('https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/#v43003016')
        }
      )
    );
    const out = await ok('get_verse_with_study', { reference: 'John 3:16', langwritten: 'es' });
    assert.equal(out.reference, 'Juan 3:16');
    assert.equal(out.book_name, 'Juan');
    assert.equal(out.langwritten, 'S');
    assert.deepEqual(out.study_notes, { 16: [{ term: 'amó', note: 'Nota uno.' }, { term: 'al mundo', note: 'Nota dos.' }] });
    assert.equal(out.study_notes_count, 2);
    assert.match(out.url, /wtlocale=S/);
  });

  it('notes a language whose NWT has no study edition', async () => {
    const VT_DATA = 'https://www.jw.org/vi/thu-vien/kinh-thanh/nwt/cac-sach/json/data/';
    useFetch(
      bibleServer(
        { '43003016-43003016': range({ verses: [verse(43, 3, 16, 'Văn bản.')] }) },
        {
          base: VT_DATA,
          options: { locale: 'vi', symbol: 'nwt', books: { 43: { standardName: 'Giăng', hasStudyNotes: false } } },
          other: () => redirect('https://www.jw.org/vi/thu-vien/kinh-thanh/nwt/cac-sach/Gi%C4%83ng/3/#v43003016')
        }
      )
    );
    const out = await ok('get_verse_with_study', { reference: 'John 3:16', langwritten: 'VT' });
    assert.equal(out.has_study_notes, false);
    assert.match(out.note, /no Study Edition .* in Vietnamese/);
  });
});

// ---------------------------------------------------------------------------
// Chinese and Japanese: ruby readings, no spaces between CJK lines

describe('ruby readings and CJK text', () => {
  it('keeps the base characters of pinyin/furigana ruby and adds no space between CJK lines', () => {
    assert.equal(
      verseHtmlToText('<span class="style-b"><sup class="verseNum">16 </sup> “<ruby><rb>上帝</rb><rt>Shàngdì</rt></ruby><ruby><rb>深爱</rb><rt>shēnʼài</rt></ruby>世人。</span>'),
      '“上帝深爱世人。'
    );
    assert.equal(
      verseHtmlToText(
        '<span class="style-l"><sup class="verseNum">18 </sup><ruby><rb>人</rb><rt>ひと</rt></ruby>々を<ruby><rb>知</rb><rt>し</rt></ruby>る。</span>' +
          '<span class="newblock"></span><span class="style-z">エホバ，<ruby><rb>地</rb><rp>(</rp><rt>ち</rt><rp>)</rp></ruby>。</span>'
      ),
      '人々を知る。\nエホバ，地。'
    );
    // Inside one printed line, CJK pieces join with no space.
    assert.equal(
      verseHtmlToText('<span class="style-b"><sup class="verseNum">18 </sup>人々を知る。<span class="newblock"></span>エホバ，地。</span>'),
      '人々を知る。エホバ，地。'
    );
    assert.equal(htmlText('<p><ruby><rb>注</rb><rt>zhù</rt></ruby>脚</p>'), '注脚');
    assert.equal(joinText('エホバ', '地'), 'エホバ地');
    assert.equal(joinText('May people know you,', 'You alone'), 'May people know you, You alone');
    assert.equal(joinText('', 'x'), 'x');
  });

  it('reads Chinese study-note terms wrapped in ruby', () => {
    const notes = parseStudyNotes(
      '<p><ruby><rb><strong>你们</strong></rb><rt><strong>nǐmen</strong></rt></ruby><ruby><rb><strong>的</strong></rb><rt><strong>de</strong></rt></ruby> <ruby><rb>这里</rb><rt>zhèlǐ</rt></ruby>说明。</p>' +
        '<p><ruby><rb><strong>爱</strong></rb><rt><strong>Ài</strong></rt></ruby> <ruby><rb>希腊语</rb><rt>Xīlàyǔ</rt></ruby>。</p>'
    );
    assert.deepEqual(notes, [
      { term: '你们的', note: '这里说明。' },
      { term: '爱', note: '希腊语。' }
    ]);
  });

  it('drops ruby readings from outline entries', () => {
    const outline = parseOutline(
      '<ul class="outline partial"><li class="L1"><p class="se"><span class="itemLabel"><strong>D.</strong> </span><ruby><rb><strong>耶稣</strong></rb><rt><strong>Yēsū</strong></rt></ruby><strong>；</strong>（<a data-targetverses="43002001-43002012">2:1</a>）</p></li></ul>'
    );
    assert.deepEqual(outline, [{ level: 1, text: 'D. 耶稣；（2:1）', chapters: [2, 2] }]);
  });

  it('flags the Chinese "－－－" placeholder of an omitted verse', async () => {
    const CHS_DATA = 'https://www.jw.org/cmn-hans/library/bible/study-bible/books/json/data/';
    useFetch(
      bibleServer(
        {
          '40017020-40017021': range({
            verses: [verse(40, 17, 20, '二十。'), { ...verse(40, 17, 21, 'x'), content: '<span class="style-b"><sup class="verseNum"><a>21 </a></sup> －－－</span>' }]
          })
        },
        {
          base: CHS_DATA,
          options: { locale: 'cmn-hans', books: { 40: { standardName: '马太福音', hasStudyNotes: true } } },
          other: () => redirect('https://www.jw.org/cmn-hans/library/bible/study-bible/books/matthew/17/')
        }
      )
    );
    const out = await ok('get_bible_verse', { reference: 'Matt 17:20-21', langwritten: 'CHS' });
    assert.equal(out.text, '20 二十。');
    assert.deepEqual(out.verses, [{ verse: 21, omitted: true }]);
    assert.match(out.note, /explains why/);
  });
});

describe('study-note terms in every language', () => {
  it('reads terms that end in ".", "?", "!" or nothing; a bold verse number continues the note', () => {
    assert.deepEqual(parseStudyNotes('<p><strong>amó.</strong> Uno.</p><p><strong>al mundo.</strong> Dos.</p>'), [
      { term: 'amó', note: 'Uno.' },
      { term: 'al mundo', note: 'Dos.' }
    ]);
    assert.deepEqual(parseStudyNotes('<p><strong>¿y has visto a Abrahán?</strong> Dos.</p>'), [{ term: '¿y has visto a Abrahán?', note: 'Dos.' }]);
    assert.deepEqual(parseStudyNotes('<p><strong>¡miren!</strong> Tres.</p><p><strong>53</strong> Cita.</p>'), [{ term: '¡miren!', note: 'Tres. 53 Cita.' }]);
    assert.deepEqual(parseStudyNotes('<p><strong>la luce del mondo</strong> La metafora.</p>'), [{ term: 'la luce del mondo', note: 'La metafora.' }]);
    assert.deepEqual(parseStudyNotes('<p><strong>loved:</strong> First use.</p><p><strong>16</strong> For God loved.</p>'), [
      { term: 'loved', note: 'First use. 16 For God loved.' }
    ]);
    assert.deepEqual(parseStudyNotes('<p class="sn"><strong>7:53</strong></p><p>Some text.</p>'), [{ term: '7:53', note: 'Some text.' }]);
  });

  it('recognizes the omitted-verse placeholders of other editions', () => {
    for (const text of ['——', '－－－', '——.', '[.⁠.⁠.]', '[…]', ' — — ']) assert.equal(isOmittedText(text), true, text);
    for (const text of ['...', '[Note]', '', 'Not omitted.', '— and more']) assert.equal(isOmittedText(text), false, text);
  });
});

// ---------------------------------------------------------------------------
// jw.org JSON shape drift

describe('jw.org JSON shape drift', () => {
  it('ignores wrong-typed secondary fields and still returns the verse', async () => {
    useFetch((url) => {
      assert.ok(url.startsWith(EN_DATA), url);
      return json(
        bibleBody({
          [chapterId(43, 3)]: range({
            verses: [verse(43, 3, 16, 'For God loved the world.'), null],
            chapterOutlines: {},
            footnotes: 'x',
            crossReferences: [null, { source: '43003016', targets: {} }],
            commentaries: 5,
            superscriptions: true
          })
        })
      );
    });
    const out = await ok('get_bible_verse', { reference: 'John 3:16' });
    assert.equal(out.text, 'For God loved the world.');
    const study = await ok('get_verse_with_study', { reference: 'John 3:16', fields: ['verses', 'study_notes', 'cross_references', 'chapter_level'] });
    assert.deepEqual(study.study_notes, {});
    assert.deepEqual(study.chapter_level.outline, []);
  });

  it('reads a verse whose content is not a string as empty instead of "[object Object]"', () => {
    const parsed = parseRange(range({ verses: [{ ...verse(43, 3, 16, 'x'), content: {} }, verse(43, 3, 17, 'Seventeen.')] }));
    assert.deepEqual(parsed.verses.map((v) => v.text), ['', 'Seventeen.']);
    assert.throws(() => parseRange(range({ verses: {} })), TypeError);
    assert.throws(() => parseRange(range({ verses: [null, 5] })), TypeError);
  });

  it('falls back to wol.jw.org when the verses are not a list', async () => {
    useFetch((url) => {
      if (url.startsWith(EN_DATA)) return json(bibleBody({ [chapterId(43, 3)]: range({ verses: {} }) }));
      return wolPage(43, 3, { verses: { 16: ['For God loved the world.'] } });
    });
    const out = await ok('get_bible_verse', { reference: 'John 3:16' });
    assert.equal(out.text, 'For God loved the world.');
    assert.match(out.note, /unexpected shape/);
    assert.doesNotMatch(out.note, /bug in jw-mcp/);
  });
});

// ---------------------------------------------------------------------------
// Research Guide citation indexes (es, ja ...)

function guideSection(book, chapter, verse, inner) {
  return `<div class="section" data-key="${book}-${chapter}-${verse}"><ul><li class="item ref-rsg"><div class="subtitle">Guide</div><span class="scalableui"><p class="se"></p>${inner}</span></li></ul></div>`;
}

function wolGuidePage(book, chapter, sections) {
  return new Response(
    `<!DOCTYPE html><html><body><article><p><span class="v" id="v${book}-${chapter}-16-1">Texto.</span></p></article><div id="studyDiscover">${sections.join('')}</div></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

const ES_GUIDE_16 =
  '<p class="su"><a href="/es/wol/pc/r4/lp-s/1/215/0"><em>Preguntas sobre la Biblia,</em> artículos&nbsp;120,</a><a href="/es/wol/pc/r4/lp-s/1/216/0"> 147</a></p>' +
  '<p class="su"><a href="/es/wol/pc/r4/lp-s/1/220/0"><em>Perspicacia,</em> págs.&nbsp;80,</a><a href="/es/wol/pc/r4/lp-s/1/221/0"> 437,</a><a href="/es/wol/pc/r4/lp-s/1/222/0"> 440, 441</a></p>' +
  '<div data-pid="213"><p data-pid="213" class="su"><a href="/es/wol/pc/r4/lp-s/1/225/0"><em>La Atalaya</em> (estudio)<em>,</em></a></p><p data-pid="213" class="sk"><a href="/es/wol/pc/r4/lp-s/1/225/0">2/2017, págs.&nbsp;6, 7</a></p></div>' +
  '<div data-pid="216"><p data-pid="216" class="su"><a href="/es/wol/pc/r4/lp-s/1/228/0"><em>La Atalaya,</em></a></p><p data-pid="216" class="sk"><a href="/es/wol/pc/r4/lp-s/1/228/0">1/5/2014, págs.&nbsp;16</a></p>' +
  '<p data-pid="216" class="sk"><a href="/es/wol/pc/r4/lp-s/1/236/0">15/11/1990, págs.&nbsp;12,</a><a href="/es/wol/pc/r4/lp-s/1/237/0"> 16</a></p></div>';

describe('Research Guide citation indexes', () => {
  it('reads one entry per cited place, with its publication, from an es-style index', async () => {
    const page = await wolGuidePage(43, 3, [guideSection(43, 3, 16, ES_GUIDE_16)]).text();
    const list = parseWolChapter(page, 43, 3, 'https://wol.jw.org/es/wol/b/r4/lp-s/nwtsty/43/3').articles[16];
    assert.deepEqual(list.map((a) => a.source), [
      'Preguntas sobre la Biblia, artículos 120',
      'Preguntas sobre la Biblia, artículos 147',
      'Perspicacia, págs. 80',
      'Perspicacia, págs. 437',
      'Perspicacia, págs. 440, 441',
      'La Atalaya (estudio), 2/2017, págs. 6, 7',
      'La Atalaya, 1/5/2014, págs. 16',
      'La Atalaya, 15/11/1990, págs. 12',
      'La Atalaya, 15/11/1990, págs. 16'
    ]);
    for (const a of list) {
      assert.doesNotMatch(a.title, /^[\d\s,-]+$/);
      assert.equal(a.title, a.source);
      assert.ok(a.publication, a.source);
    }
    assert.equal(new Set(list.map((a) => a.url)).size, list.length, 'a URL is listed once');
    assert.deepEqual([...new Set(list.map((a) => a.publication))], ['Preguntas sobre la Biblia', 'Perspicacia', 'La Atalaya (estudio)', 'La Atalaya']);
    assert.equal(list[1].url, 'https://wol.jw.org/es/wol/pc/r4/lp-s/1/216/0');
  });

  it('reads a ja-style group whose publication is in <strong>', async () => {
    const inner =
      '<p class="su"><a href="/ja/wol/pc/r7/lp-j/1/1113/0"><strong>「いつまでも幸せに暮らせます」</strong>レッスン4</a></p>' +
      '<div data-pid="1395"><p data-pid="1395" class="su"><a href="/ja/wol/pc/r7/lp-j/1/1114/0"><strong>「目ざめよ！」</strong></a></p><p data-pid="1395" class="sk"><a href="/ja/wol/pc/r7/lp-j/1/1114/0">2021 No.&nbsp;1 14ページ</a></p></div>';
    const page = await wolGuidePage(19, 83, [guideSection(19, 83, 18, inner)]).text();
    const list = parseWolChapter(page, 19, 83, 'https://wol.jw.org/ja/wol/b/r7/lp-j/nwtsty/19/83').articles[18];
    assert.deepEqual(list.map((a) => [a.source, a.publication]), [
      ['「いつまでも幸せに暮らせます」レッスン4', '「いつまでも幸せに暮らせます」'],
      ['「目ざめよ！」 2021 No. 1 14ページ', '「目ざめよ！」']
    ]);
  });

  it('keeps the issue day on the later links of a ja/ko issue line', async () => {
    const group = (lang, header, links) =>
      `<div data-pid="1"><p class="su"><a href="/${lang}/wol/pc/1/1/0">${header}</a></p><p class="sk">${links
        .map((text, i) => `<a href="/${lang}/wol/pc/1/${i + 2}/0">${text}</a>`)
        .join('')}</p></div>`;
    const titles = async (inner) => {
      const page = await wolGuidePage(40, 24, [guideSection(40, 24, 14, inner)]).text();
      return parseWolChapter(page, 40, 24, 'https://wol.jw.org/').articles[14].map((a) => a.title);
    };
    assert.deepEqual(await titles(group('ko', '「파수대」', ['2015/5/1, 3,', ' 7면'])), ['「파수대」 2015/5/1, 3', '「파수대」 2015/5/1, 7면']);
    assert.deepEqual(await titles(group('ja', '「ものみの塔」', ['2011/3/1，3，', '4-6，', '7-9ページ'])), [
      '「ものみの塔」 2011/3/1，3',
      '「ものみの塔」 2011/3/1，4-6',
      '「ものみの塔」 2011/3/1，7-9ページ'
    ]);
    assert.deepEqual(await titles(group('es', '<em>La Atalaya,</em>', ['1/4/2009, págs.&nbsp;5, 6,', ' 7, 8'])), [
      'La Atalaya, 1/4/2009, págs. 5, 6',
      'La Atalaya, 1/4/2009, págs. 7, 8'
    ]);
  });

  it('merges the same citation across verses, and keeps citations of different issues apart', async () => {
    const v17 =
      '<p class="su"><a href="/es/wol/pc/r4/lp-s/1/316/0"><em>Preguntas sobre la Biblia,</em> artículos&nbsp;147</a></p>' +
      '<div data-pid="300"><p data-pid="300" class="su"><a href="/es/wol/pc/r4/lp-s/1/328/0"><em>La Atalaya,</em></a></p><p data-pid="300" class="sk"><a href="/es/wol/pc/r4/lp-s/1/328/0">1/1/2020, págs.&nbsp;16</a></p></div>';
    useFetch((url) => {
      assert.equal(url, 'https://wol.jw.org/es/wol/b/r4/lp-s/nwtsty/43/3');
      return wolGuidePage(43, 3, [guideSection(43, 3, 16, ES_GUIDE_16), guideSection(43, 3, 17, v17)]);
    });
    const out = await ok('get_verse_with_study', { reference: 'John 3:16, 17', langwritten: 'S', fields: ['study_articles'], limit: 0 });
    const q147 = out.study_articles.filter((a) => a.source === 'Preguntas sobre la Biblia, artículos 147');
    assert.equal(q147.length, 1);
    assert.deepEqual(q147[0].verses, ['16', '17']);
    const sixteens = out.study_articles.filter((a) => /págs\. 16$/.test(a.source)).map((a) => a.source);
    assert.deepEqual(sixteens, ['La Atalaya, 1/5/2014, págs. 16', 'La Atalaya, 15/11/1990, págs. 16', 'La Atalaya, 1/1/2020, págs. 16']);
    assert.equal(out.study_articles_total, 10);
  });
});

// ---------------------------------------------------------------------------

describe('book names in the langwritten language', () => {
  it('reads "Juan 17:3" with langwritten S, learning the names with one extra request', async () => {
    const S_DATA = 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/json/data/';
    useFetch(
      bibleServer(
        {
          '43003016-43003016': range({ verses: [verse(43, 3, 16, 'Porque Dios amó.')] }),
          '43017003-43017003': range({ verses: [verse(43, 17, 3, 'Esto significa vida.')] })
        },
        {
          base: S_DATA,
          options: { locale: 'es', books: { 43: { standardName: 'Juan', officialAbbreviation: 'Jn', hasStudyNotes: true } } },
          other: () => redirect('https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/')
        }
      )
    );
    const out = await ok('get_bible_verse', { reference: 'Juan 17:3', langwritten: 'S' });
    assert.equal(out.reference, 'Juan 17:3');
    assert.equal(out.text, 'Esto significa vida.');
    assert.equal(calls.filter((u) => u.includes('/finder')).length, 1);
    // The names come with John 3, which a later John 3 lookup reuses.
    assert.deepEqual(calls.filter((u) => u.startsWith(S_DATA)).map((u) => u.slice(S_DATA.length)), ['43003000-43003999', '43017000-43017999']);
    assert.equal((await ok('get_bible_verse', { reference: 'Jn 3:16', langwritten: 'S' })).reference, 'Juan 3:16');
    assert.equal(calls.length, 3);
  });

  it('still fails clearly when the name is unknown in that language too', async () => {
    useFetch((url) => (url.includes('/finder') ? redirect('https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/') : json(bibleBody({}, { books: { 43: { standardName: 'Juan' } } }))));
    await fails('get_bible_verse', { reference: 'Qwertz 3:16', langwritten: 'S' }, /Unknown Bible book "Qwertz"[\s\S]*Next step: Book names are read in English/);
  });
});

describe('JW codes stay codes', () => {
  it('reads a Tamil (TL) request from the Tamil library, never Tagalog', async () => {
    clearLanguageCache();
    useFetch((url) => {
      if (url === 'https://b.jw-cdn.org/apis/mediator/v1/languages/E/all') {
        return json({ languages: [{ code: 'TL', locale: 'ta', name: 'Tamil', vernacular: 'Tamil' }, { code: 'E', locale: 'en', name: 'English' }] });
      }
      if (url === 'https://wol.jw.org/wol/finder?wtlocale=TL') return redirect('https://wol.jw.org/ta/wol/h/r122/lp-tl');
      if (url === 'https://wol.jw.org/ta/wol/b/r122/lp-tl/nwtsty/43/3') return wolPage(43, 3, { verses: { 16: ['Text.'] }, guide: { 16: [['Sample', 'w99.01 p. 1']] } });
      throw new Error(`unexpected ${url}`);
    });
    const out = await ok('get_verse_with_study', { reference: 'John 3:16', langwritten: 'Tamil', fields: ['study_articles'] });
    assert.equal(out.langwritten, 'TL');
    assert.equal(out.study_articles.length, 1);
    assert.ok(!calls.some((u) => u.includes('/tl/') || u.includes('lp-tg')), calls.join('\n'));
    assert.equal((await resolveLanguage('TL', { as: 'code' })).name, 'Tamil');
    assert.equal((await resolveLanguage('TL')).code, 'TG');
    clearLanguageCache();
  });
});

describe('passages without verse numbers', () => {
  it('answers a request wholly inside John 7:53–8:11 without fetching, keeping the end chapter', async () => {
    const out = await ok('get_bible_verse', { reference: 'John 7:53-8:11' });
    assert.equal(out.omitted, true);
    assert.equal(out.verse, '7:53–8:11');
    assert.equal(out.reference, 'John 7:53–8:11');
    assert.equal(calls.length, 0);
  });

  it('reads the numbered verses of a range that runs out of the passage', async () => {
    const verses = Array.from({ length: 9 }, (_, i) => verse(43, 8, i + 12, `Verse ${i + 12}.`));
    useFetch(bibleServer({ '43008012-43008020': range({ verses }) }));
    const out = await ok('get_bible_verse', { reference: 'John 7:53-8:20' });
    assert.equal(out.omitted, undefined);
    assert.equal(out.reference, 'John 8:12-20');
    assert.match(out.text, /^12 Verse 12\. .* 20 Verse 20\.$/);
    assert.match(out.note, /John 7:53–8:11 is not part of the New World Translation, so the passage starts at 8:12/);
  });
});

describe('several references in one call', () => {
  const JOHN = {
    '43003016-43003016': range({ verses: [verse(43, 3, 16, 'For God loved the world.')] }),
    '43017003-43017003': range({ verses: [verse(43, 17, 3, 'This means everlasting life.')] })
  };

  it('get_bible_verse reads a ";" list across books, one request per chapter', async () => {
    useFetch(bibleServer({ ...PS83, ...JOHN }));
    const out = await ok('get_bible_verse', { reference: 'Ps 83:18; John 17:3' });
    assert.equal(out.reference, 'Psalm 83:18; John 17:3');
    assert.equal(out.passages_count, 2);
    assert.deepEqual(out.passages.map((p) => [p.reference, p.book_name]), [['Psalm 83:18', 'Psalms'], ['John 17:3', 'John']]);
    assert.equal(out.passages[1].text, 'This means everlasting life.');
    assert.equal(out.passages[0].langwritten, undefined);
    assert.equal(out.langwritten, 'E');
    assert.deepEqual(calls, [`${EN_DATA}19083000-19083999`, `${EN_DATA}43017000-43017999`]);
  });

  it('gives a part without a book the book before it, and an omitted part its explanation', async () => {
    useFetch(bibleServer(JOHN));
    const out = await ok('get_bible_verse', { reference: 'John 3:16; 17:3; 7:53' });
    assert.deepEqual(out.passages.map((p) => p.reference), ['John 3:16', 'John 17:3', 'John 7:53']);
    assert.equal(out.passages[2].omitted, true);
    assert.match(out.passages[2].note, /not found in the earliest and most reliable manuscripts/);
  });

  it('reports a part that cannot be read in its entry, and fails when none can', async () => {
    useFetch(bibleServer(JOHN));
    const out = await ok('get_bible_verse', { reference: 'John 3:16; Genesis 1:1' });
    assert.equal(out.passages[0].text, 'For God loved the world.');
    assert.equal(out.passages[1].reference, 'Genesis 1:1');
    assert.match(out.passages[1].error, /no New World Translation in English \(E\) with Genesis 1/);
    assert.match(out.note, /1 of 2 references could not be read/);
    await fails('get_bible_verse', { reference: 'Genesis 1:1; Exodus 1:1' }, /no New World Translation in English \(E\) with Genesis 1/);
  });

  it('limits the list', async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => `John 3:${i + 1}`).join('; ');
    await fails('get_bible_verse', { reference: thirteen }, /Too many references \(13\); get_bible_verse reads at most 12/);
    await fails('get_bible_verse', { reference: 'Psalm 119; Psalm 118' }, /Those references have 205 verses; get_bible_verse returns at most 200/);
    await fails('get_bible_verse', { reference: 'John 3:16; 17:3', book: 43 }, /Send the list in "reference" alone/);
    assert.equal(calls.length, 0);
  });

  it('get_verse_with_study reads a list into passages[] too', async () => {
    useFetch(bibleServer({ ...MT24, ...JOHN }));
    const out = await ok('get_verse_with_study', { reference: 'Matt 24:14; John 3:16', fields: ['verses', 'study_notes'] });
    assert.equal(out.passages_count, 2);
    assert.deepEqual(out.passages[0].study_notes, { 14: [{ term: 'this good news', note: 'Note A.' }, { term: 'preached', note: 'Note B.' }] });
    assert.deepEqual(out.passages[1].verses, [{ chapter: 3, verse: 16, text: 'For God loved the world.' }]);
    assert.equal(calls.length, 2, 'one request per chapter');
  });

  it('get_verse_with_study explains an omitted part and reports a Research Guide page that fails', async () => {
    useFetch(
      bibleServer(
        {
          '43007052-43007052': range({
            verses: [verse(43, 7, 52, 'Search and see.')],
            commentaries: [{ id: 1, source: '43007052', content: '<p class="sn"><strong>7:53</strong></p><p>Early manuscripts lack Joh 7:53–8:11.</p>' }]
          })
        },
        {
          other: (url) => {
            if (url === 'https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/40/24') return wolPage(40, 24, { verses: { 14: ['Text.'] }, guide: MT24_GUIDE });
            return new Response('busy', { status: 500 });
          }
        }
      )
    );
    const out = await ok('get_verse_with_study', { reference: 'Matt 24:14; John 3:16; John 8:7', fields: ['study_articles'] });
    assert.deepEqual(out.passages.map((p) => p.reference), ['Matthew 24:14', 'John 3:16', 'John 8:7']);
    assert.equal(out.passages[0].study_articles_total, 3);
    assert.match(out.passages[1].error, /wol\.jw\.org returned 500/);
    assert.equal(out.passages[2].omitted, true);
    assert.deepEqual(out.passages[2].explanation.study_notes, [{ term: '7:53', note: 'Early manuscripts lack Joh 7:53–8:11.' }]);
    assert.match(out.note, /1 of 3 references could not be read/);
  });

  it('get_verse_with_study counts Research Guide chapters across the list', async () => {
    const six = ['Matt 1:1', 'Matt 2:1', 'Matt 3:1', 'Matt 4:1', 'Matt 5:1', 'Matt 6:1'].join('; ');
    await fails('get_verse_with_study', { reference: six, fields: ['study_articles'] }, /span 6 chapters; with study_articles or chapter_articles get_verse_with_study reads at most 5/);
    assert.equal(calls.length, 0);
  });
});

describe('get_verse_with_study passage size and output budget', () => {
  const chapterRange = (b, c, from, to, text = (v) => `Verse ${v}.`) =>
    range({ verses: Array.from({ length: to - from + 1 }, (_, i) => verse(b, c, from + i, text(from + i))) });

  it('reads a whole chapter of more than 60 verses with the default fields, as 1.3.3 did', async () => {
    useFetch(bibleServer({ '40026001-40026075': chapterRange(40, 26, 1, 75) }));
    const out = await ok('get_verse_with_study', { reference: 'Matthew 26' });
    assert.equal(out.verses.length, 75);
    assert.equal(out.verse_range, '1-75');
  });

  it('reads up to 200 verses over two chapters when the fields are text-only', async () => {
    useFetch(bibleServer({ '40026020-40026075': chapterRange(40, 26, 20, 75), '40027001-40027030': chapterRange(40, 27, 1, 30) }));
    const out = await ok('get_verse_with_study', { reference: 'Matthew 26:20–27:30', fields: ['verses', 'combined_text'] });
    assert.equal(out.verses.length, 86);
    await fails('get_verse_with_study', { reference: 'Matthew 26:20–27:30' }, /has 86 verses in 2 chapters; get_verse_with_study returns at most 60 verses in 5 chapters/);
  });

  it('turns a passage too long for one result into an isError with a next step', async () => {
    const long = (v) => `Verse ${v} ${'word '.repeat(400)}`;
    useFetch(bibleServer({ '40024001-40024050': chapterRange(40, 24, 1, 50, long) }));
    await fails('get_verse_with_study', { reference: 'Matthew 24:1-50', fields: ['verses'] }, /too long for one result[\s\S]*Next step: Ask for fewer verses/);
  });

  it('fitStudyResult drops combined_text, then shortens the article lists, and says so', () => {
    const article = (i) => ({ title: `Synthetic article ${i}`, source: `s99 ${i}/1 p. ${i}`, publication: 'Sample', url: `https://wol.jw.org/en/wol/pc/r1/lp-e/1/${i}/0`, verses: ['1'] });
    const make = () => ({
      reference: 'Book 1:1-3',
      verses: [{ chapter: 1, verse: 1, text: 'One.' }],
      combined_text: 'x'.repeat(500),
      study_articles: Array.from({ length: 50 }, (_, i) => article(i)),
      study_articles_count: 50,
      study_articles_total: 70,
      chapter_level: { outline: [], study_articles: Array.from({ length: 50 }, (_, i) => article(i + 100)), study_articles_count: 50, study_articles_total: 90 },
      note: 'Existing note.'
    });
    const small = { reference: 'x', verses: [] };
    assert.deepEqual(fitStudyResult(structuredClone(small), 1000), small);
    const out = fitStudyResult(make(), 1800);
    assert.ok(estimateTokens(jsonText(out)) <= 1800, `about ${estimateTokens(jsonText(out))} tokens`);
    assert.equal(out.combined_text, undefined);
    assert.equal(out.study_articles_count, out.study_articles.length);
    assert.ok(out.study_articles.length > 0 && out.study_articles.length < 50);
    assert.equal(out.chapter_level.study_articles_count, out.chapter_level.study_articles.length);
    assert.equal(out.study_articles_total, 70);
    assert.equal(out.chapter_level.study_articles_total, 90);
    assert.match(out.note, /^Existing note\. Shortened to fit the client's output limit: combined_text \(the same text is in verses\), chapter_level\.study_articles 5 of 90, study_articles \d+ of 70\./);
    assert.throws(() => fitStudyResult({ reference: 'Big', verses: [{ text: 'y'.repeat(5000) }] }, 1000), { name: 'ToolError', message: /about \d+ tokens/ });
    // Link-heavy articles: the budget is in tokens, so the note is only added when the result really fits.
    const links = fitStudyResult({ reference: 'Links', study_articles: Array.from({ length: 400 }, (_, i) => article(i)), study_articles_count: 400 });
    assert.ok(estimateTokens(jsonText(links)) <= MAX_RESULT_TOKENS);
    assert.match(links.note, /Shortened to fit/);
  });
});

describe('Research Guide limit and chapter articles', () => {
  it('clamps limit as 1.3.3 accepted it: 200 or -1 means all (up to 100), 2.5 means 2', async () => {
    useFetch(mt24Server());
    const all = await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: ['study_articles'], limit: 200 });
    assert.equal(all.study_articles_count, 3);
    assert.equal(all.note, undefined);
    const two = await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: ['study_articles'], limit: 2.5 });
    assert.equal(two.study_articles_count, 2);
    assert.equal(getVerseWithStudyTool.inputSchema.properties.limit.maximum, undefined);
    for (const limit of [-1, '-1']) {
      assert.equal((await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: ['study_articles'], limit })).study_articles_count, 3);
    }
  });

  it('says when 100 articles are not all of them, and how to get the rest', async () => {
    const guide = { 14: Array.from({ length: 101 }, (_, i) => [`Article ${i}`, `w99.${i} p. 1`]) };
    useFetch(() => wolPage(40, 24, { verses: { 14: ['Text.'] }, guide }));
    const out = await ok('get_verse_with_study', { reference: 'Matt 24:14', fields: ['study_articles'], limit: 0 });
    assert.equal(out.study_articles_count, 100);
    assert.equal(out.study_articles_total, 101);
    assert.match(out.note, /study_articles shows 100 of 101 Research Guide articles; ask for fewer verses to see the rest/);
  });

  it('does not send the chapter\'s articles twice when the passage is the whole chapter', async () => {
    useFetch(() => wolPage(40, 24, { verses: { 14: ['Text.'] }, guide: MT24_GUIDE }));
    const out = await ok('get_verse_with_study', { reference: 'Matthew 24', fields: ['study_articles', 'chapter_articles'], limit: 0 });
    assert.equal(out.study_articles_total, 5);
    assert.equal(out.chapter_level.study_articles_same_as, 'study_articles');
    assert.equal(out.chapter_level.study_articles, undefined);
    assert.equal(out.chapter_level.study_articles_total, out.study_articles_total);
  });
});

describe('psalm superscriptions and acrostic letter headings', () => {
  const heading = (source, letter) => ({ id: Number(source.slice(-3)) + 500, content: `<span class="style-s">${letter[0]} [<em>${letter[1]}</em>]</span>`, source });
  const superscription = (source, text) => ({ id: 1, content: `<span class="style-w">${text}</span>`, source });
  const PSALMS = {
    '19009008-19009009': range({ verses: [verse(19, 9, 8, 'He will judge.'), verse(19, 9, 9, 'A secure refuge.')], superscriptions: [heading('19009009', ['ב', 'Beth'])] }),
    '19119000-19119001': range({ verses: [verse(19, 119, 1, 'Happy are those.')], superscriptions: [heading('19119001', ['א', 'Aleph'])] }),
    '19119000-19119002': range({ verses: [verse(19, 119, 1, 'Happy are those.'), verse(19, 119, 2, 'Happy are those who observe.')], superscriptions: [heading('19119001', ['א', 'Aleph'])] }),
    '19119008-19119010': range({
      verses: [verse(19, 119, 8, 'I will observe.'), verse(19, 119, 9, 'How can a young man?'), verse(19, 119, 10, 'With all my heart.')],
      superscriptions: [heading('19119009', ['ב', 'Beth'])]
    }),
    '19119009-19119009': range({ verses: [verse(19, 119, 9, 'How can a young man?')], superscriptions: [heading('19119009', ['ב', 'Beth'])] }),
    '20031010-20031011': range({ verses: [verse(20, 31, 10, 'A capable wife.'), verse(20, 31, 11, 'Her husband trusts.')], superscriptions: [heading('20031010', ['א', 'Aleph'])] }),
    '19002012-19002012': range({ verses: [verse(19, 2, 12, 'Honor the son.')] }),
    '19003000-19003001': range({ verses: [verse(19, 3, 1, 'How many are my foes!')], superscriptions: [superscription('19003000', 'A melody of David.')] }),
    '19003000-19003002': range({ verses: [verse(19, 3, 1, 'How many are my foes!'), verse(19, 3, 2, 'Many are saying.')], superscriptions: [superscription('19003000', 'A melody of David.')] })
  };

  it('puts a letter before the verse it heads, in any book', async () => {
    useFetch(bibleServer(PSALMS));
    const ps9 = await ok('get_bible_verse', { reference: 'Psalm 9:8-9' });
    assert.equal(ps9.text, '8 He will judge. ב [Beth] 9 A secure refuge.');
    assert.equal(ps9.superscription, undefined);
    const ps119 = await ok('get_bible_verse', { reference: 'Psalm 119:8-10' });
    assert.match(ps119.text, /I will observe\. ב \[Beth\] 9 How can a young man\?/);
    const one = await ok('get_bible_verse', { reference: 'Psalm 119:9' });
    assert.equal(one.heading, 'ב [Beth]');
    assert.equal(one.text, 'How can a young man?');
    const pr31 = await ok('get_bible_verse', { reference: 'Proverbs 31:10-11' });
    assert.equal(pr31.text, 'א [Aleph] 10 A capable wife. 11 Her husband trusts.');
    const study = await ok('get_verse_with_study', { reference: 'Psalm 119:8-10', fields: ['verses', 'combined_text'] });
    assert.equal(study.verses.find((v) => v.verse === 9).heading, 'ב [Beth]');
    assert.equal(study.verses.find((v) => v.verse === 8).heading, undefined);
    assert.match(study.combined_text, /ב \[Beth\] 9 How can/);
  });

  it('does not take a psalm\'s first letter for its superscription', async () => {
    useFetch(bibleServer(PSALMS));
    await fails('get_bible_verse', { reference: 'Psalm 119:0' }, /Psalm 119 has no superscription/);
    const start = await ok('get_bible_verse', { reference: 'Psalm 119:1-2' });
    assert.equal(start.superscription, undefined);
    assert.equal(start.text, 'א [Aleph] 1 Happy are those. 2 Happy are those who observe.');
  });

  it('ties a superscription to its psalm when the passage crosses into it', async () => {
    useFetch(bibleServer(PSALMS));
    const across = await ok('get_bible_verse', { reference: 'Psalm 2:12-3:1' });
    assert.equal(across.superscription, undefined);
    assert.deepEqual(across.superscriptions, { 3: 'A melody of David.' });
    const study = await ok('get_verse_with_study', { reference: 'Psalm 2:12-3:1', fields: ['combined_text'] });
    assert.match(study.combined_text, /^2:12 Honor the son\. A melody of David\. 3:1 How many/);
    const inside = await ok('get_bible_verse', { reference: 'Psalm 3:1-2' });
    assert.equal(inside.superscription, 'A melody of David.');
  });

  it('keeps every psalm heading in combined_text when the passage starts at verse 0', async () => {
    useFetch(bibleServer({
      ...PSALMS,
      '19003008-19003008': range({ verses: [verse(19, 3, 8, 'Salvation belongs to Jehovah.')] }),
      '19004000-19004001': range({ verses: [verse(19, 4, 1, 'When I call, answer me.')], superscriptions: [superscription('19004000', 'To the director.')] })
    }));
    for (const reference of ['Psalm 3:0-4:1', 'Psalm 3:8-4:1']) {
      const study = await ok('get_verse_with_study', { reference, fields: ['combined_text'] });
      assert.equal(study.combined_text.split('To the director.').length, 2, reference);
      assert.match(study.combined_text, /To the director\. 4:1 When I call/, reference);
      assert.deepEqual(study.superscriptions, { 4: 'To the director.' }, reference);
    }
    const fromZero = await ok('get_verse_with_study', { reference: 'Psalm 3:0-4:1', fields: ['combined_text'] });
    assert.equal(fromZero.combined_text.split('A melody of David.').length, 2);
  });
});

describe('pronunciation marks', () => {
  const JER = {
    '24042001-24042001': range({ verses: [verse(24, 42, 1, 'Then Jo·haʹnan the son of Ka·reʹah came.')] }),
    '24042001-24042002': range({ verses: [verse(24, 42, 1, 'Then Jo·haʹnan the son of Ka·reʹah came.'), verse(24, 42, 2, 'They said to Jeremiah.')] })
  };

  it('drops them only for the languages that use them as reading aids', () => {
    assert.equal(stripPronunciationMarks('Ge·henʹna', 'E'), 'Gehenna');
    assert.equal(stripPronunciationMarks('Jọhanan', 'X'), 'Johanan');
    assert.equal(stripPronunciationMarks('Joha̱nan', 'O'), 'Johanan');
    assert.equal(stripPronunciationMarks('Иохана́н', 'U'), 'Иоханан');
    assert.equal(stripPronunciationMarks('Größten', 'X'), 'Größten');
    assert.equal(stripPronunciationMarks('col·lecció', 'AN'), 'col·lecció');
    assert.equal(stripPronunciationMarks('ạ', 'VT'), 'ạ');
    assert.equal(stripPronunciationMarks('Ioanàn', 'I'), 'Ioanàn');
  });

  it('pronunciation_marks: false gives plain names in text, verses[] and combined_text', async () => {
    useFetch(bibleServer(JER));
    const plain = await ok('get_bible_verse', { reference: 'Jeremiah 42:1', pronunciation_marks: false });
    assert.equal(plain.text, 'Then Johanan the son of Kareah came.');
    const marked = await ok('get_bible_verse', { reference: 'Jeremiah 42:1' });
    assert.equal(marked.text, 'Then Jo·haʹnan the son of Ka·reʹah came.');
    const study = await ok('get_verse_with_study', { reference: 'Jeremiah 42:1-2', fields: ['verses', 'combined_text'], pronunciation_marks: 'false' });
    assert.equal(study.verses[0].text, 'Then Johanan the son of Kareah came.');
    assert.match(study.combined_text, /^1 Then Johanan the son of Kareah came\. 2 /);
    await fails('get_bible_verse', { reference: 'Jeremiah 42:1', pronunciation_marks: 'maybe' }, /Invalid "pronunciation_marks"/);
  });
});

describe('cross references and ranges past the chapter end', () => {
  it('counts references, one entry per marker', async () => {
    const data = {
      '43017003-43017004': range({
        verses: [verse(43, 17, 3, 'Everlasting life.'), verse(43, 17, 4, 'I have glorified you.')],
        crossReferences: [
          { id: 1, source: '43017003', targets: [target('Luke 10:25-28')] },
          { id: 2, source: '43017003', targets: [target('Acts 17:26, 27'), target('1 John 5:20')] },
          { id: 3, source: '43017004', targets: [target('John 13:31'), target('John 14:13')] }
        ]
      })
    };
    useFetch(bibleServer(data));
    const out = await ok('get_verse_with_study', { reference: 'John 17:3-4', fields: ['cross_references'] });
    assert.equal(out.cross_references.length, 3);
    assert.equal(out.cross_references_count, 5);
  });

  it('reads "30-40" in a 36-verse chapter as verses 30 to 36, with a note', async () => {
    const chapter = (from, to) => range({ verses: Array.from({ length: to - from + 1 }, (_, i) => verse(43, 3, from + i, `Verse ${from + i}.`)) });
    useFetch(bibleServer({ '43003030-43003036': chapter(30, 36), '43003016-43003036': chapter(16, 36) }));
    const study = await ok('get_verse_with_study', { book: 43, chapter: 3, verse: '30-40', fields: ['verses'] });
    assert.equal(study.reference, 'John 3:30-36');
    assert.equal(study.verses.length, 7);
    assert.match(study.note, /John 3 has 36 verses, so the passage ends at verse 36\./);
    const text = await ok('get_bible_verse', { reference: 'John 3:16-100' });
    assert.equal(text.reference, 'John 3:16-36');
    const link = await ok('get_bible_verse_url', { book: 43, chapter: 3, verse: '16-100' });
    assert.equal(link.reference, 'John 3:16-36');
    assert.match(link.note, /ends at verse 36/);
  });
});

describe('footnotes', () => {
  const PS23 = {
    [chapterId(19, 23)]: range({
      verses: [{
        vsID: '19023003',
        content: '<span class="style-l"><sup class="verseNum">3 </sup> He refreshes me.<fn id="1"></fn></span><span class="parabreak"></span><span class="style-z">He leads me in the paths<fn id="2"></fn> of righteousness.</span>'
      }],
      footnotes: [{ id: 1, content: 'Or “my soul.”', source: '19023003' }, { id: 2, content: 'Lit., “tracks.”', source: '19023003' }]
    })
  };

  it('say which words they explain', async () => {
    useFetch(bibleServer(PS23));
    const one = await ok('get_bible_verse', { reference: 'Psalm 23:3' });
    assert.deepEqual(one.footnotes, [{ phrase: 'He refreshes me', note: 'Or “my soul.”' }, { phrase: 'He leads me in the paths', note: 'Lit., “tracks.”' }]);
    const study = await ok('get_verse_with_study', { reference: 'Psalm 23:3', fields: ['footnotes'] });
    assert.deepEqual(study.footnotes[3].map((f) => f.phrase), ['He refreshes me', 'He leads me in the paths']);
  });

  it('keeps two footnotes of a verse that read alike', async () => {
    const content = '<span class="style-b"><sup class="verseNum">2 </sup> He finished the work he had been doing,<fn id="7"></fn> and he rested from the work he had been doing.<fn id="8"></fn></span>';
    useFetch(bibleServer({
      [chapterId(1, 2)]: range({
        verses: [{ vsID: '1002002', content }],
        footnotes: [{ id: 7, content: 'Or “x.”', source: '1002002' }, { id: 8, content: 'Or “x.”', source: '1002002' }]
      })
    }));
    const out = await ok('get_bible_verse', { reference: 'Genesis 2:2' });
    assert.deepEqual(out.footnotes.map((f) => f.note), ['Or “x.”', 'Or “x.”']);
    assert.deepEqual(out.footnotes.map((f) => f.phrase), ['He finished the work he had been doing', 'and he rested from the work he had been doing']);
    const study = await ok('get_verse_with_study', { reference: 'Genesis 2:2', fields: ['footnotes'] });
    assert.equal(study.footnotes[2].length, 2);
    assert.equal(study.footnotes_count, 2);
  });

  it('returns the footnotes of a superscription that comes with verse 1', async () => {
    const heading = { id: 1, content: '<span class="style-w">A <em>miktam</em> of David.</span>', source: '19003000' };
    const note = { id: 2, content: 'See Glossary.', source: '19003000', anchor: 'fn2' };
    useFetch(bibleServer({
      [chapterId(19, 3)]: range({
        verses: [verse(19, 3, 1, 'Why are they so many?'), verse(19, 3, 2, 'Many say.')],
        superscriptions: [heading],
        footnotes: [note, { id: 3, content: 'Or “x.”', source: '19003002', anchor: 'fn3' }]
      }),
      [chapterId(19, 2)]: range({ verses: [verse(19, 2, 12, 'Honor the son.')] })
    }));
    const one = await ok('get_bible_verse', { reference: 'Psalm 3:1' });
    assert.deepEqual(one.superscription_footnotes, [{ note: 'See Glossary.' }]);
    assert.equal(one.footnotes, undefined);
    const two = await ok('get_bible_verse', { reference: 'Psalm 3:1-2' });
    assert.deepEqual(two.verses, [{ verse: 0, footnotes: [{ note: 'See Glossary.' }] }, { verse: 2, footnotes: [{ note: 'Or “x.”' }] }]);
    const across = await ok('get_bible_verse', { reference: 'Psalm 2:12-3:1' });
    assert.deepEqual(across.verses, [{ chapter: 3, verse: 0, footnotes: [{ note: 'See Glossary.' }] }]);
    const zero = await ok('get_bible_verse', { reference: 'Psalm 3:0-1' });
    assert.deepEqual(zero.verses, [{ verse: 0, footnotes: [{ note: 'See Glossary.' }] }]);
  });
});

describe('poetry', () => {
  it('keeps poetic lines in text and puts a verse after poetry on a new line', async () => {
    useFetch(bibleServer({
      [chapterId(19, 23)]: range({
        verses: [verse(19, 23, 1, 'Jehovah is my Shepherd.', 'I will lack nothing.'), verse(19, 23, 2, 'In grassy pastures he makes me lie down.')]
      }),
      [chapterId(43, 3)]: range({ verses: [verse(43, 3, 16, 'For God loved the world.'), verse(43, 3, 17, 'For God sent.')] })
    }));
    const ps = await ok('get_bible_verse', { reference: 'Psalm 23:1-2' });
    assert.equal(ps.text, '1 Jehovah is my Shepherd.\nI will lack nothing.\n2 In grassy pastures he makes me lie down.');
    const study = await ok('get_verse_with_study', { reference: 'Psalm 23:1', fields: ['verses'] });
    assert.equal(study.verses[0].text, 'Jehovah is my Shepherd.\nI will lack nothing.');
    assert.equal(study.verses[0].poetry, undefined);
    assert.equal((await ok('get_bible_verse', { reference: 'John 3:16-17' })).text, '16 For God loved the world. 17 For God sent.');
  });
});

describe('notes and hints', () => {
  it('says why a whole Mark 16 or John 7 stops early, once', async () => {
    const chapter = (b, c, n) => range({ verses: Array.from({ length: n }, (_, i) => verse(b, c, i + 1, `Verse ${i + 1}.`)) });
    useFetch(bibleServer({
      [chapterId(41, 16)]: chapter(41, 16, 8),
      [chapterId(43, 7)]: chapter(43, 7, 52),
      [chapterId(43, 8)]: range({ verses: Array.from({ length: 48 }, (_, i) => verse(43, 8, i + 12, `Verse ${i + 12}.`)) })
    }));
    assert.match((await ok('get_bible_verse', { reference: 'Mark 16' })).note, /Mark 16 ends at verse 8 in the NWT: Mark 16:9-20 is not part of it/);
    assert.match((await ok('get_bible_verse', { reference: 'John 7' })).note, /John 7 ends at verse 52 in the NWT: John 7:53–8:11 is not part of it/);
    const both = await ok('get_bible_verse', { reference: 'John 7-8' });
    assert.equal(both.note.split('7:53–8:11').length - 1, 1, both.note);
    const ranged = await ok('get_bible_verse', { reference: 'Mark 16:1-20' });
    assert.equal(ranged.note.split('Mark 16:9-20').length - 1, 1, ranged.note);
  });

  it('gives a psalm with no heading a hint that fits, and suggests English only for other languages', async () => {
    useFetch(bibleServer({ [chapterId(19, 1)]: range({ verses: [verse(19, 1, 1, 'Happy is the man.')] }) }));
    const text = await fails('get_bible_verse', { reference: 'Psalm 1:0' }, /Psalm 1 has no superscription\.\nNext step: Ask for Psalm 1:1/);
    assert.doesNotMatch(text, /langwritten "E"/);
    const S_DATA = 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/json/data/';
    clearBibleCache();
    useFetch(bibleServer({ [chapterId(43, 3)]: range({ verses: [verse(43, 3, 17, 'Texto.')] }) }, {
      base: S_DATA,
      options: { locale: 'es', books: { 43: { standardName: 'Juan' } } },
      other: () => redirect('https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/')
    }));
    await fails('get_bible_verse', { reference: 'John 3:16', langwritten: 'S' }, /returned no text for John 3:16[\s\S]*try langwritten "E"/);
  });

  it('names where to split a passage over the verse cap', async () => {
    await fails('get_bible_verse', { reference: 'Genesis 1-10' }, /Next step: Ask for Genesis 1-7 \(184 verses\), then call again for Genesis 8-10\./);
    await fails('get_bible_verse', { reference: 'Psalm 118-119' }, /Ask for Psalm 118 \(29 verses\).*Psalm 119/);
    await fails('get_verse_with_study', { reference: 'Matthew 26-27' }, /Ask for Matthew 26 \(75 verses\).*Matthew 27/);
    assert.match(getBibleVerseTool.description, /200 verses/);
    assert.equal(calls.length, 0);
  });

  it('strips pronunciation marks from cross-reference phrases with the verse', async () => {
    useFetch(bibleServer({
      [chapterId(40, 4)]: range({
        verses: [{ vsID: '40004013', content: '<span class="style-b"><sup class="verseNum">13 </sup> Then he came and took up residence in Ca·perʹna·um<xref id="1"></xref> beside the sea.</span>' }],
        crossReferences: [{ id: 1, source: '40004013', targets: [target('John 2:12')] }]
      })
    }));
    const plain = await ok('get_verse_with_study', { reference: 'Matthew 4:13', fields: ['verses', 'cross_references'], pronunciation_marks: false });
    assert.equal(plain.cross_references[0].phrase, 'Then he came and took up residence in Capernaum');
    assert.ok(plain.verses[0].text.includes(plain.cross_references[0].phrase));
    const marked = await ok('get_verse_with_study', { reference: 'Matthew 4:13', fields: ['cross_references'] });
    assert.match(marked.cross_references[0].phrase, /Ca·perʹna·um/);
  });
});

describe('";" lists', () => {
  const LIST = {
    [chapterId(43, 3)]: range({ verses: [verse(43, 3, 16, 'For God loved the world.')] }),
    [chapterId(43, 17)]: range({ verses: [verse(43, 17, 3, 'This means everlasting life.')] }),
    [chapterId(45, 5)]: range({ verses: [verse(45, 5, 8, 'God recommends his love.')] })
  };

  it('reads the full-width "；" CJK text separates references with', async () => {
    useFetch(bibleServer(LIST));
    for (const name of ['get_bible_verse', 'get_verse_with_study']) {
      const out = await ok(name, { reference: 'John 3:16；John 17:3', ...(name === 'get_verse_with_study' && { fields: ['verses'] }) });
      assert.equal(out.passages_count, 2, name);
    }
    const short = await ok('get_bible_verse', { reference: 'John 3:16；17:3' });
    assert.deepEqual(short.passages.map((p) => p.reference), ['John 3:16', 'John 17:3']);
  });

  it('reads an array of references as a list', async () => {
    useFetch(bibleServer(LIST));
    const out = await ok('get_bible_verse', { reference: ['John 3:16', 'Romans 5:8'] });
    assert.equal(out.reference, 'John 3:16; Romans 5:8');
    assert.equal(out.passages[1].text, 'God recommends his love.');
  });

  it('returns the readable references and an error entry for each bad one', async () => {
    useFetch(bibleServer(LIST));
    const out = await ok('get_bible_verse', { reference: 'John 3:16; John 3:99; Rom 5:8' });
    assert.equal(out.passages_count, 3);
    assert.equal(out.passages[1].reference, 'John 3:99');
    assert.match(out.passages[1].error, /no verse 99/);
    assert.ok(out.passages[1].hint);
    assert.equal(out.passages[2].text, 'God recommends his love.');
    assert.match(out.note, /1 of 3 references could not be read/);
    assert.equal((await ok('get_bible_verse', { reference: 'John 3:16; 3:99' })).passages[1].reference, 'John 3:99');
    const third = await ok('get_bible_verse', { reference: 'Rom 5:8; John 3:99; 3:16' });
    assert.equal(third.passages[2].reference, 'John 3:16');
    assert.equal(third.passages[2].text, 'For God loved the world.');
    await fails('get_bible_verse', { reference: 'John 3:99; Hezekiah 2:1' }, /no verse 99/);
    const study = await ok('get_verse_with_study', { reference: 'Rom 5:8; 3 John 15; John 3:16', fields: ['verses'] });
    assert.match(study.passages[1].error, /3 John has 14 verses/);
    assert.equal(study.passages[2].verses[0].text, 'For God loved the world.');
  });
});

describe('omitted passages in another language', () => {
  const S_DATA = 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/json/data/';
  const spanish = () => bibleServer({
    [chapterId(43, 3)]: range({ verses: [verse(43, 3, 16, 'Porque Dios amó.')] }),
    [chapterId(43, 7)]: range({
      verses: [verse(43, 7, 52, 'Investiga.')],
      commentaries: [{ id: 1, source: '43007052', content: '<p class="sn"><strong>7:53</strong></p><p>Nota.</p>' }]
    })
  }, {
    base: S_DATA,
    options: { locale: 'es', books: { 41: { standardName: 'Marcos' }, 43: { standardName: 'Juan' } } },
    other: () => redirect('https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/')
  });

  it('name the book in langwritten', async () => {
    useFetch(spanish());
    const one = await ok('get_bible_verse', { reference: 'Juan 8:7', langwritten: 'S' });
    assert.deepEqual([one.reference, one.book_name, one.omitted], ['Juan 8:7', 'Juan', true]);
    assert.equal((await ok('get_bible_verse', { reference: 'Juan 7:53-8:11', langwritten: 'S' })).reference, 'Juan 7:53–8:11');
    assert.equal((await ok('get_bible_verse', { book: 43, chapter: 8, verse: '7', langwritten: 'S' })).reference, 'Juan 8:7');
    assert.equal((await ok('get_bible_verse', { reference: 'Juan 3:16; 8:7', langwritten: 'S' })).reference, 'Juan 3:16; Juan 8:7');
    assert.equal((await ok('get_verse_with_study', { reference: 'Juan 8:7', langwritten: 'S' })).reference, 'Juan 8:7');
  });

  it('stay English, with no request, in English', async () => {
    const out = await ok('get_bible_verse', { reference: 'John 8:7' });
    assert.equal(out.book_name, 'John');
    assert.equal(calls.length, 0);
  });
});

describe('when jw.org struggles', () => {
  const REFS = 'Mark 16; Malachi 4; Jonah 2-4; Hosea 3; Ezekiel 15; Jeremiah 45; Isaiah 4; Psalms 120-134; Job 25; Esther 10; 1 Chronicles 20; Leviticus 12';

  it('falls back to WOL a few pages at a time and stops at the first failure', async () => {
    let open = 0;
    let peak = 0;
    useFetch(async (url) => {
      const wol = url.startsWith('https://wol.jw.org/');
      if (wol) peak = Math.max(peak, ++open);
      await new Promise((r) => setTimeout(r, 10));
      if (wol) open--;
      return new Response('busy', { status: 503 });
    });
    await fails('get_bible_verse', { reference: REFS }, /503/);
    const wolCalls = calls.filter((u) => u.startsWith('https://wol.jw.org/'));
    assert.ok(peak <= 4, `peak ${peak}`);
    assert.ok(wolCalls.length <= 8, `${wolCalls.length} WOL requests`);
  });

  it('sends nothing to WOL after a rate limit, and says to wait', async () => {
    useFetch(() => new Response('slow down', { status: 429 }));
    await fails('get_bible_verse', { reference: REFS }, /429[\s\S]*Wait a minute/);
    assert.deepEqual(calls.filter((u) => u.startsWith('https://wol.jw.org/')), []);
    clearBibleCache();
    await fails('get_bible_verse', { reference: 'John 3:16' }, /429[\s\S]*Wait a minute/);
    assert.deepEqual(calls.filter((u) => u.startsWith('https://wol.jw.org/')), []);
  });
});

describe('fitStudyResult, past the article lists', () => {
  const verses = (n) => Array.from({ length: n }, (_, i) => ({ chapter: 1, verse: i + 1, text: `Verse ${i + 1} ${'word '.repeat(20)}` }));
  const xrefs = (n) => Array.from({ length: n }, (_, i) => ({ chapter: 1, verse: i + 1, phrase: 'a phrase', targets: Array.from({ length: 5 }, (_, j) => `Genesis ${i + 1}:${j + 1}`) }));

  it('shortens the cross references and says where it stopped', () => {
    const result = { reference: 'Book 1:1-20', book_name: 'Book', verses: verses(20), study_notes: { 1: [{ term: 't', note: 'n' }] }, cross_references: xrefs(20), cross_references_count: 100 };
    const base = estimateTokens(jsonText({ ...result, cross_references: [] }));
    const max = base + 600;
    const out = fitStudyResult(structuredClone(result), max);
    assert.ok(estimateTokens(jsonText(out)) <= max);
    const kept = out.cross_references.length;
    assert.ok(kept > 0 && kept < 20, `${kept} markers kept`);
    assert.equal(out.cross_references_count, kept * 5);
    assert.match(out.note, new RegExp(`cross_references through verse 1:${kept} \\(${kept} of 20 markers\\)`));
    assert.match(out.note, /request the shortened fields on their own/);
  });

  it('leaves out the chapter outline when that is what it takes', () => {
    const outline = Array.from({ length: 200 }, (_, i) => ({ level: 2, text: `Outline entry ${i} ${'word '.repeat(10)}` }));
    const result = { reference: 'Book 1:1-5', book_name: 'Book', verses: verses(5), chapter_level: { outline } };
    const out = fitStudyResult(result, estimateTokens(jsonText({ ...result, chapter_level: undefined })) + 300);
    assert.equal(out.chapter_level, undefined);
    assert.match(out.note, /chapter_level\.outline left out/);
  });

  it('names the largest fields and a verse range that fits when even that is too long', () => {
    const notes = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i + 1), [{ term: 't', note: 'note '.repeat(60) }]]));
    const result = { reference: 'Book 1:1-40', book_name: 'Book', verses: verses(40), study_notes: notes };
    const max = Math.floor(estimateTokens(jsonText(result)) / 2);
    assert.throws(() => fitStudyResult(result, max), (e) =>
      e.name === 'ToolError' &&
      /too long for one result \(about \d+ tokens\)\.$/.test(e.message) &&
      /largest: study_notes about \d+/.test(e.hint) &&
      /Book 1:1-\d+ fits with these fields/.test(e.hint));
  });
});

describe('round 4: order, languages and fallbacks', () => {
  it('lists cross references and footnotes in the order of their markers, not the JSON order', () => {
    const parsed = parseRange(range({
      verses: [
        { vsID: '43017003', content: '<span class="style-b"><sup class="verseNum">3 </sup>This means life,<xref id="904"></xref> to know you, the only true God,<xref id="919"></xref><fn id="950"></fn> and Jesus Christ.<xref id="938"></xref><fn id="960"></fn></span>' },
        { vsID: '43017004', content: '<span class="style-b"><sup class="verseNum">4 </sup>I have glorified you.<xref id="970"></xref></span>' }
      ],
      crossReferences: [
        { id: 970, source: '43017004', targets: [target('A 1:1')] },
        { id: 999, source: '43017003', targets: [target('Z 1:1')] },
        { id: 938, source: '43017003', targets: [target('B 1:1')] },
        { id: 919, source: '43017003', targets: [target('C 1:1')] },
        { id: 904, source: '43017003', targets: [target('D 1:1')] }
      ],
      footnotes: [
        { id: 960, content: 'Second.', source: '43017003' },
        { id: 950, content: 'First.', source: '43017003' }
      ]
    }));
    assert.deepEqual(parsed.crossReferences.map((x) => [x.verse, x.phrase ?? null]), [
      [3, 'This means life'],
      [3, 'the only true God'],
      [3, 'and Jesus Christ'],
      [3, null],
      [4, 'I have glorified you']
    ]);
    assert.deepEqual(parsed.footnotes.map((f) => f.id), ['950', '960']);
    assert.ok(parsed.crossReferences.every((x) => !('id' in x)));
  });

  it('reads an Arabic ";" list written with Arabic-Indic digits and "؛"', async () => {
    const AR = 'https://www.jw.org/ar/library/bible/study-bible/books/json/data/';
    const books = { 43: { standardName: 'يوحنا', hasStudyNotes: true }, 45: { standardName: 'روما', hasStudyNotes: true } };
    registerBookNames('A', books);
    useFetch(bibleServer(
      { '45005008-45005008': range({ verses: [verse(45, 5, 8, 'Verse text eight.')] }), '43006040-43006040': range({ verses: [verse(43, 6, 40, 'Verse text forty.')] }) },
      { base: AR, options: { locale: 'ar', books }, other: () => redirect('https://www.jw.org/ar/library/bible/study-bible/books/romans/5/') }
    ));
    const out = await ok('get_bible_verse', { reference: 'روما ٥:٨؛ يوحنا ٦:٤٠', langwritten: 'A' });
    assert.equal(out.passages_count, 2);
    assert.deepEqual(out.passages.map((p) => p.text), ['Verse text eight.', 'Verse text forty.']);
    assert.equal(out.passages[0].reference, 'روما 5:8');
  });

  it('reads "Eph 4:11, ftn." as the verse with its footnotes, and says when it has none', async () => {
    useFetch(bibleServer({
      '49004011-49004011': range({
        verses: [{ vsID: '49004011', content: '<span class="style-b"><sup class="verseNum">11 </sup>He gave some as evangelizers,<fn id="70"></fn> others.</span>' }],
        footnotes: [{ id: 70, content: 'Or “preachers.”', source: '49004011' }]
      }),
      '55004005-55004005': range({ verses: [verse(55, 4, 5, 'Do the work of an evangelizer.')] })
    }));
    const eph = await ok('get_bible_verse', { reference: 'Eph 4:11, ftn.' });
    assert.equal(eph.reference, 'Ephesians 4:11');
    assert.deepEqual(eph.footnotes, [{ phrase: 'He gave some as evangelizers', note: 'Or “preachers.”' }]);
    assert.match(eph.note, /"ftn\." \(jw\.org's "see the footnote"\) after Ephesians 4:11 was read as that verse/);
    assert.doesNotMatch(eph.note, /has no footnote/);
    const tim = await ok('get_bible_verse', { reference: '2Ti 4:5, ftn.' });
    assert.match(tim.note, /jw\.org's NWT has no footnote on 2 Timothy 4:5 now/);
    const study = await ok('get_verse_with_study', { reference: '2Ti 4:5, ftn.', fields: ['verses'] });
    assert.deepEqual(study.footnotes, {});
    assert.match(study.note, /no footnote on 2 Timothy 4:5 now/);
    const list = await ok('get_bible_verse', { reference: 'Eph 4:11, ftn.; 2Ti 4:5; ftn.' });
    assert.equal(list.passages_count, 2);
  });

  it('gives book_name in the langwritten language whichever fields are asked for', async () => {
    registerBookNames('S', { 43: 'Juan' });
    useFetch((url) => (url.startsWith('https://wol.jw.org/') ? wolPage(43, 17, { verses: { 3: ['Texto.'] } }) : notFound()));
    const es = await ok('get_verse_with_study', { reference: 'John 17:3', langwritten: 'S', fields: ['study_articles'] });
    assert.equal(es.book_name, 'Juan');
    assert.match(es.reference, /^Juan 17:3/);
    const en = await ok('get_verse_with_study', { reference: 'John 17:3', fields: ['study_articles'] });
    assert.equal(en.book_name, 'John');
  });

  it('answers a whole-chapter reference plus verse inside an omitted passage without fetching', async () => {
    const out = await ok('get_bible_verse', { reference: 'John 8', verse: '1-11' });
    assert.equal(out.omitted, true);
    assert.equal(out.reference, 'John 7:53–8:11');
    assert.equal(calls.length, 0);
  });

  it('keeps poetry lines and joins CJK segments tight in the WOL text fallback', async () => {
    const page = `<!DOCTYPE html><html><body><article>
<p class="sl"><span class="v" id="v19-83-1-1"><a class="vl vp">1 </a>一行目です。</span></p>
<p class="sz"><span class="v" id="v19-83-1-2">二行目です。</span></p>
<p class="sl"><span class="v" id="v19-83-2-1"><a class="vl vp">2 </a>三行目です。</span></p>
<p class="sz"><span class="v" id="v19-83-2-2">四行目です。</span></p>
<p class="sb"><span class="v" id="v19-83-3-1"><a class="vl vp">3 </a>散文の前半。</span></p>
<p class="sb"><span class="v" id="v19-83-3-2">散文の後半。</span></p>
</article></body></html>`;
    const parsed = parseWolChapter(page, 19, 83);
    assert.deepEqual(parsed.poetry, [1, 2]);
    assert.equal(parsed.verses[1], '一行目です。\n二行目です。');
    assert.equal(parsed.verses[3], '散文の前半。散文の後半。');
    useFetch((url) => (url.startsWith('https://wol.jw.org/ja/wol/b/') ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response('busy', { status: 503 })));
    const out = await ok('get_bible_verse', { book: 19, chapter: 83, verse: '1-3', langwritten: 'J' });
    assert.equal(out.text, '1 一行目です。\n二行目です。\n2 三行目です。\n四行目です。\n3 散文の前半。散文の後半。');
    assert.match(out.note, /text comes from wol\.jw\.org/);
  });

  it('keeps an Arabic item\'s topic-guide citations and cleans its index part', () => {
    const pair = (href, title, cite) =>
      `<div><p class="su"><a href="${href}">${title}</a></p></div><div><p class="su"><em>${cite}</em></p></div>`;
    const item =
      '<p class="su"></p>' +
      pair('/ar/wol/pc/r39/lp-a/1/184/0', 'المصالحة', 'بص «المصالحة» ف ٤') +
      pair('/ar/wol/pc/r39/lp-a/1/185/0', 'عنوان', 'ب٢٤/‏٨ ص ٢-‏٦') +
      '<p class="su"></p><p class="se"></p>' +
      '<p class="su"><a href="/ar/wol/pc/r39/lp-a/2/146/0"><em>انت تسأل</em>،‏ المقالات&nbsp;١٢٠،‏</a><a href="/ar/wol/pc/r39/lp-a/2/147/0"> ١٤٧</a></p>' +
      '<div data-pid="172"><p data-pid="172" class="su"><a href="/ar/wol/pc/r39/lp-a/2/154/0"><em>برج المراقبة</em>،‏</a></p>' +
      '<p data-pid="172" class="sk"><a href="/ar/wol/pc/r39/lp-a/2/162/0">١٥/‏١١/‏١٩٩٠،‏ ص ١٢،‏</a><a href="/ar/wol/pc/r39/lp-a/2/163/0"> ١٦</a></p></div>';
    const html = `<html><body><span class="v" id="v43-3-16-1">نص.</span>${guideSection(43, 3, 16, item)}</body></html>`;
    const list = parseWolChapter(html, 43, 3, 'https://wol.jw.org/ar/wol/b/r39/lp-a/nwt/43/3').articles[16];
    assert.deepEqual(list.map((a) => [a.title, a.source, a.publication]), [
      ['المصالحة', 'بص «المصالحة» ف ٤', null],
      ['عنوان', 'ب٢٤/٨ ص ٢-٦', null],
      ['انت تسأل، المقالات ١٢٠', 'انت تسأل، المقالات ١٢٠', 'انت تسأل'],
      ['انت تسأل، المقالات ١٤٧', 'انت تسأل، المقالات ١٤٧', 'انت تسأل'],
      ['برج المراقبة، ١٥/١١/١٩٩٠، ص ١٢', 'برج المراقبة، ١٥/١١/١٩٩٠، ص ١٢', 'برج المراقبة'],
      ['برج المراقبة، ١٥/١١/١٩٩٠، ص ١٦', 'برج المراقبة، ١٥/١١/١٩٩٠، ص ١٦', 'برج المراقبة']
    ]);
  });
});

describe('fitStudyResult keeps the default articles', () => {
  const article = (i) => ({ title: `Synthetic article ${i}`, source: `s99 ${i}/1 p. ${i}`, publication: 'Sample', url: `https://wol.jw.org/en/wol/pc/r1/lp-e/1/${i}/0` });
  const xrefs = (n) => Array.from({ length: n }, (_, i) => ({ chapter: 1, verse: i + 1, phrase: 'a phrase', targets: Array.from({ length: 5 }, (_, j) => `Genesis ${i + 1}:${j + 1}`) }));
  const verses = [{ chapter: 1, verse: 1, text: 'One.' }];

  it('cuts the cross references before the 5 requested articles', () => {
    const result = {
      reference: 'Book 1:1-40', verses, study_articles: Array.from({ length: 5 }, (_, i) => article(i)), study_articles_count: 5, study_articles_total: 9,
      cross_references: xrefs(40), cross_references_count: 200,
      note: 'study_articles shows 5 of 9 Research Guide articles; set limit up to 100 to see the rest.'
    };
    const max = estimateTokens(jsonText({ ...result, cross_references: xrefs(10) }));
    const out = fitStudyResult(structuredClone(result), max);
    assert.equal(out.study_articles.length, 5);
    assert.ok(out.cross_references.length < 40);
    assert.match(out.note, /^study_articles shows 5 of 9 Research Guide articles; set limit up to 100 to see the rest\. Shortened to fit the client's output limit: cross_references through verse/);
  });

  it('drops the "shows N of M; set limit" sentence once the list itself is cut', () => {
    const result = {
      reference: 'Book 1:1', verses, study_articles: Array.from({ length: 50 }, (_, i) => article(i)), study_articles_count: 50, study_articles_total: 70,
      note: 'Existing note. study_articles shows 50 of 70 Research Guide articles; set limit up to 100 to see the rest.'
    };
    const out = fitStudyResult(structuredClone(result), estimateTokens(jsonText({ ...result, study_articles: [] })) + 700);
    assert.ok(out.study_articles.length >= 5 && out.study_articles.length < 50, `${out.study_articles.length} kept`);
    assert.equal(out.study_articles_count, out.study_articles.length);
    assert.doesNotMatch(out.note, /shows 50 of/);
    assert.match(out.note, new RegExp(`^Existing note\\. Shortened to fit the client's output limit: study_articles ${out.study_articles.length} of 70\\.`));
  });
});
