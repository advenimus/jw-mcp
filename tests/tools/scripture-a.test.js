// Offline tests for Bible book data, reference parsing and validation, and
// the search_bible_books and get_bible_verse_url tools. globalThis.fetch
// throws in every test: nothing here may touch the network.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BIBLE_BOOKS,
  BOOK_ABBREVIATIONS,
  CHAPTER_COUNTS,
  VERSE_COUNTS,
  bibleVerseId,
  clearBookNames,
  finderUrl,
  formatReference,
  getBookInfo,
  getBookName,
  getBookNumber,
  getChapterCount,
  getFirstVerse,
  getOmission,
  getVerseCount,
  hasBookNames,
  listVerses,
  looksLikeReference,
  parseReference,
  parseReferences,
  referenceFromArgs,
  referenceFromParts,
  referencesFromArgs,
  registerBookNames,
  searchBooks,
  toBook,
  tryParseReference,
  validateReference,
  verseLinks
} from '../../src/tools/bible-books.js';
import {
  getBibleVerseImplementation,
  getBibleVerseURLImplementation,
  getBibleVerseURLTool,
  handleScriptureTools,
  searchBibleBooksImplementation,
  searchBibleBooksTool
} from '../../src/tools/scripture-tools.js';
import { clearBibleCache } from '../../src/tools/bible-api.js';
import { callTool } from '../../src/mcp-server.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async (url) => {
    throw new Error(`offline test tried to fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FINDER = 'https://www.jw.org/finder?wtlocale=E&prefer=lang&bible=';
const segs = (ref) => ref.segments.map((s) => [s.chapter, s.verse, s.endChapter, s.endVerse]);
const json = (result) => {
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const errorText = (result) => {
  assert.equal(result.isError, true, `expected isError, got ${result.content[0].text}`);
  return result.content[0].text;
};

describe('book and verse tables', () => {
  it('has 66 books and 1,189 chapters', () => {
    assert.equal(Object.keys(BIBLE_BOOKS).length, 66);
    assert.equal(Object.values(CHAPTER_COUNTS).reduce((a, b) => a + b, 0), 1189);
    for (let b = 1; b <= 66; b++) assert.equal(VERSE_COUNTS[b].length, CHAPTER_COUNTS[b], BIBLE_BOOKS[b]);
  });

  it('matches NWT chapter counts that differ from Hebrew numbering', () => {
    assert.equal(getChapterCount(39), 4); // Malachi
    assert.equal(getChapterCount(29), 3); // Joel
    assert.equal(getChapterCount(19), 150);
    for (const b of [31, 57, 63, 64, 65]) assert.equal(getChapterCount(b), 1, BIBLE_BOOKS[b]);
    assert.equal(getChapterCount(67), null);
  });

  it('has NWT verse counts, including the chapters that differ between translations', () => {
    const expected = [
      [19, 119, 176], [64, 1, 14], [65, 1, 25], [31, 1, 21], [43, 3, 36], [43, 7, 52], [43, 8, 59],
      [41, 16, 8], [66, 12, 17], [47, 13, 14], [39, 4, 6], [29, 2, 32], [27, 4, 37], [1, 50, 26]
    ];
    for (const [b, c, n] of expected) assert.equal(getVerseCount(b, c), n, `${BIBLE_BOOKS[b]} ${c}`);
    assert.equal(getVerseCount(43, 22), null);
    const total = Object.values(VERSE_COUNTS).flat().reduce((a, b) => a + b, 0);
    assert.equal(total, 31102 - 1 - 12); // English total minus John 7:53 and Mark 16:9-20
  });

  it('knows John 8 starts at verse 12 and which verses the NWT omits', () => {
    assert.equal(getFirstVerse(43, 8), 12);
    assert.equal(getFirstVerse(43, 3), 1);
    assert.deepEqual(getOmission(40, 17, 21), {
      reference: 'Matthew 17:21',
      numbered: true,
      studyNote: 'Matthew 17:21',
      reason: 'Left out of the NWT because it is not found in the earliest and most reliable manuscripts.'
    });
    assert.equal(getOmission(43, 8, 3).reference, 'John 7:53–8:11');
    assert.equal(getOmission(43, 8, 3).studyNote, 'John 7:52');
    assert.equal(getOmission(41, 16, 12).studyNote, 'Mark 16:8');
    assert.equal(getOmission(43, 3, 16), null);
    assert.equal(getOmission(43, 8, 12), null);
  });

  it('describes a book', () => {
    assert.deepEqual(getBookInfo(19), {
      number: 19,
      name: 'Psalms',
      singularName: 'Psalm',
      abbreviation: 'Ps.',
      shortAbbreviation: 'Ps',
      chapters: 150,
      testament: 'Old Testament',
      division: 'Hebrew-Aramaic Scriptures'
    });
    assert.equal(getBookInfo(0), null);
    assert.equal(getBookName(43), 'John');
    assert.equal(getBookName(99), null);
  });
});

describe('book lookup', () => {
  it('resolves every abbreviation key to its own book, as the top search hit too', () => {
    for (const [abbr, book] of Object.entries(BOOK_ABBREVIATIONS)) {
      assert.equal(getBookNumber(abbr), book, abbr);
      assert.equal(searchBooks(abbr, 1)[0]?.number, book, `search "${abbr}"`);
    }
  });

  it('resolves every JW.org abbreviation, with and without the period', () => {
    for (let book = 1; book <= 66; book++) {
      const { abbreviation, shortAbbreviation, name } = getBookInfo(book);
      for (const q of [name, abbreviation, abbreviation.replace(/\.$/, ''), shortAbbreviation, name.toUpperCase()]) {
        assert.equal(getBookNumber(q), book, q);
        assert.equal(searchBooks(q, 1)[0]?.number, book, `search "${q}"`);
      }
    }
  });

  it('ranks common shorthand ahead of prefix matches', () => {
    const top = (q) => searchBooks(q, 1)[0]?.name;
    assert.equal(top('Jn'), 'John');
    assert.equal(top('jud'), 'Jude');
    assert.equal(top('Ca'), 'Song of Solomon');
    assert.equal(top('phil'), 'Philippians');
    assert.equal(top('ez'), 'Ezra');
    assert.deepEqual(searchBooks('john').map((r) => r.name), ['John', '1 John', '2 John', '3 John']);
    assert.deepEqual(searchBooks('sam').map((r) => r.name), ['1 Samuel', '2 Samuel']);
  });

  it('understands alternate names, ordinals, Roman numerals and dotted forms', () => {
    const cases = {
      'Song of Songs': 22, Canticles: 22, 'I John': 62, 'First John': 62, '1st John': 62, '1John': 62,
      'II Kings': 12, 'Second Kings': 12, 'III John': 64, 'Ps.': 19, Psalm: 19, 'Pss.': 19, '1 Cor.': 46,
      '1Co': 46, 'Rev.': 66, Revelations: 66, 'Song of Sol.': 22, '1 Chron.': 13, Zephan: 36, 'Génesis': 1
    };
    for (const [q, book] of Object.entries(cases)) {
      assert.equal(getBookNumber(q), book, q);
      assert.equal(searchBooks(q, 1)[0]?.number, book, `search "${q}"`);
    }
  });

  it('no longer reads "1 John" or "1 Cor." as book 1', () => {
    assert.equal(getBookNumber('1 John'), 62);
    assert.equal(getBookNumber('2 Kings'), 12);
    assert.equal(getBookNumber('1 Cor.'), 46);
  });

  it('accepts book numbers only as whole numbers 1-66', () => {
    assert.equal(getBookNumber(40), 40);
    assert.equal(getBookNumber('40'), 40);
    for (const bad of [0, 67, 1.5, '1.5', '0', 'xyz', 'jo', '', null, undefined, true]) {
      assert.equal(getBookNumber(bad), null, String(bad));
    }
    assert.deepEqual(searchBooks('40'), [{ number: 40, name: 'Matthew', score: 100 }]);
    assert.deepEqual(searchBooks('67'), []);
    assert.deepEqual(searchBooks(''), []);
    assert.deepEqual(searchBooks(null), []);
  });

  it('suggests near misses when nothing else matches', () => {
    assert.deepEqual(searchBooks('Jhon', 2), [
      { number: 43, name: 'John', score: 50, guess: true },
      { number: 32, name: 'Jonah', score: 45, guess: true }
    ]);
    assert.equal(searchBooks('Mathew', 1)[0].name, 'Matthew');
    assert.equal(searchBooks('Genisis', 1)[0].name, 'Genesis');
    assert.deepEqual(searchBooks('xyz'), []);
    assert.equal(getBookNumber('Jhon'), null);
    // Two edits only between words of 5+ letters: "Tobit" is not "Tit." (Titus).
    assert.deepEqual(searchBooks('Tobit'), []);
    assert.deepEqual(searchBooks('Jacob'), []);
    assert.deepEqual(searchBooks('Nephi'), []);
    assert.deepEqual(searchBooks('Jonas').map((b) => b.name), ['Jonah']);
    assert.equal(searchBooks('John')[0].guess, undefined);
  });

  it('ignores a trailing chapter and verse when searching', () => {
    assert.equal(searchBooks('1 Cor. 13:4-7', 1)[0].name, '1 Corinthians');
    assert.equal(searchBooks('Psalm 23', 1)[0].name, 'Psalms');
  });

  it('toBook coerces names and numeric strings and explains failures', () => {
    assert.equal(toBook('43'), 43);
    assert.equal(toBook(' John '), 43);
    assert.throws(() => toBook('Jhon'), (e) => e.name === 'ArgError' && /got "Jhon"/.test(e.message) && /John \(43\)/.test(e.hint));
    assert.throws(() => toBook(1.5), /expected a Bible book number from 1 to 66/);
    assert.throws(() => toBook(undefined), /Missing required "book"/);
  });
});

describe('parseReference', () => {
  const cases = [
    ['John 3:16', 43, 'John 3:16', [[3, 16, 3, 16]], '16'],
    ['Jn 3:16-18', 43, 'John 3:16-18', [[3, 16, 3, 18]], '16-18'],
    ['Ps 83:18', 19, 'Psalm 83:18', [[83, 18, 83, 18]], '18'],
    ['1 Cor. 13:4-7', 46, '1 Corinthians 13:4-7', [[13, 4, 13, 7]], '4-7'],
    ['Psalm 23', 19, 'Psalm 23', [[23, null, 23, null]], ''],
    ['Jude 25', 65, 'Jude 25', [[1, 25, 1, 25]], '25'],
    ['Obadiah 1:21', 31, 'Obadiah 21', [[1, 21, 1, 21]], '21'],
    ['Philem. 10', 57, 'Philemon 10', [[1, 10, 1, 10]], '10'],
    ['Jude', 65, 'Jude', [[1, null, 1, null]], ''],
    ['John 3:16–18', 43, 'John 3:16-18', [[3, 16, 3, 18]], '16-18'],
    ['John 3:16 — 18', 43, 'John 3:16-18', [[3, 16, 3, 18]], '16-18'],
    ['John 3:16 to 18', 43, 'John 3:16-18', [[3, 16, 3, 18]], '16-18'],
    ['John 3:1,3,5', 43, 'John 3:1, 3, 5', [[3, 1, 3, 1], [3, 3, 3, 3], [3, 5, 3, 5]], '1,3,5'],
    ['John 3:5, 1, 3, 2', 43, 'John 3:1-3, 5', [[3, 1, 3, 3], [3, 5, 3, 5]], '1-3,5'],
    ['Rev. 21:3, 4', 66, 'Revelation 21:3, 4', [[21, 3, 21, 4]], '3-4'],
    ['Matt 5:3–6:4', 40, 'Matthew 5:3–6:4', [[5, 3, 6, 4]], null],
    ['Matthew 5-7', 40, 'Matthew 5-7', [[5, null, 7, null]], null],
    ['Psalm 23, 24', 19, 'Psalms 23, 24', [[23, null, 24, null]], null],
    ['John 3:16, 4:1', 43, 'John 3:16; 4:1', [[3, 16, 3, 16], [4, 1, 4, 1]], null],
    ['1John4:8', 62, '1 John 4:8', [[4, 8, 4, 8]], '8'],
    ['I John 4:8', 62, '1 John 4:8', [[4, 8, 4, 8]], '8'],
    ['Song of Songs 2:1', 22, 'Song of Solomon 2:1', [[2, 1, 2, 1]], '1'],
    ['Ps.\u00a083:18', 19, 'Psalm 83:18', [[83, 18, 83, 18]], '18'],
    ['Prov.\u202f18:10;', 20, 'Proverbs 18:10', [[18, 10, 18, 10]], '10'],
    ['1Th 5:14', 52, '1 Thessalonians 5:14', [[5, 14, 5, 14]], '14'],
    ['John 3.16', 43, 'John 3:16', [[3, 16, 3, 16]], '16'],
    ['(Isa. 46:9-11)', 23, 'Isaiah 46:9-11', [[46, 9, 46, 11]], '9-11'],
    ['Ps 119:176', 19, 'Psalm 119:176', [[119, 176, 119, 176]], '176'],
    ['Ps 3:0', 19, 'Psalm 3:superscription', [[3, 0, 3, 0]], '0'],
    ['Ps 51:0-2', 19, 'Psalm 51:superscription-2', [[51, 0, 51, 2]], '0-2'],
    ['Genesis 1:1-2:3', 1, 'Genesis 1:1–2:3', [[1, 1, 2, 3]], null]
  ];
  for (const [input, book, reference, segments, verseSpec] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => {
      const ref = parseReference(input);
      assert.equal(ref.book, book);
      assert.equal(ref.reference, reference);
      assert.deepEqual(segs(ref), segments);
      assert.equal(ref.verseSpec, verseSpec);
    });
  }

  it('keeps the legacy fields', () => {
    const ref = parseReference('Matthew 24:14-16');
    assert.equal(ref.bookName, 'Matthew');
    assert.equal(ref.chapter, 24);
    assert.equal(ref.verse, 14);
    assert.equal(ref.verseEnd, 16);
    assert.equal(parseReference('John 3:16').verseEnd, null);
    assert.equal(parseReference('Psalm 23').verse, null);
  });

  it('reads ";" lists and carries the book over', () => {
    const refs = parseReferences('Ps. 83:18; Matt. 6:9, 10; 24:14');
    assert.deepEqual(refs.map((r) => r.reference), ['Psalm 83:18', 'Matthew 6:9, 10', 'Matthew 24:14']);
    assert.throws(() => parseReference('John 3:16; 4:1'), /Expected one reference, got 2/);
  });

  it('notes omitted verses and moves a range that starts in John 8:1-11', () => {
    const ref = parseReference('Matt. 17:20-22');
    assert.equal(ref.notes.length, 1);
    assert.match(ref.notes[0], /Matthew 17:21 has no text in the NWT/);
    const john8 = parseReference('John 8:1-20');
    assert.equal(john8.reference, 'John 8:12-20');
    assert.match(john8.notes[0], /John 7:53–8:11 is not part of the New World Translation/);
  });

  it('trims a range that runs into or out of a passage without verse numbers', () => {
    const cases = [
      ['Mark 16:1-20', 'Mark 16:1-8', /ends at 16:8/],
      ['John 7:37-53', 'John 7:37-52', /ends at 7:52/],
      ['John 7:50-8:5', 'John 7:50-52', /ends at 7:52/],
      ['John 7:53-8:20', 'John 8:12-20', /starts at 8:12/],
      ['John 7:53–8:59', 'John 8:12-59', /starts at 8:12/]
    ];
    for (const [input, reference, note] of cases) {
      const ref = parseReference(input);
      assert.equal(ref.reference, reference, input);
      assert.match(ref.notes.join(' '), note, input);
    }
    // Wholly inside: still not in the NWT.
    for (const input of ['John 7:53-8:11', 'John 8:3-5', 'Mark 16:9-20']) {
      assert.throws(() => parseReference(input), /is not part of the New World Translation, because/, input);
    }
    const past = parseReference('John 7:53-8:70');
    assert.equal(past.reference, 'John 8:12-59');
    assert.match(past.notes.join(' '), /John 8 has 59 verses, so the passage ends at verse 59\./);
    // Nothing follows Mark 16:9-20, so a range that starts inside it is rejected, not moved to "Mark 17".
    for (const input of ['Mark 16:10-25', 'Mark 16:9-21', 'Mark 16:10-16:30']) {
      assert.throws(() => parseReference(input), (e) => {
        assert.match(e.message, /Mark 16:9-20 is not part of the New World Translation, because/, input);
        assert.match(e.hint, /Mark 16 has verses 1-8/, input);
        assert.doesNotMatch(`${e.message} ${e.hint}`, /null|Mark 17/, input);
        return true;
      });
    }
  });

  it('reads a range that runs past the end of the chapter as "to the end"', () => {
    const cases = [
      ['John 3:16-100', 'John 3:16-36', /John 3 has 36 verses, so the passage ends at verse 36\./],
      ['Matthew 5:1-50', 'Matthew 5:1-48', /ends at verse 48/],
      ['John 3:16-4:100', 'John 3:16–4:54', /John 4 has 54 verses/],
      ['Jude 20-30', 'Jude 20-25', /Jude has 25 verses, so the passage ends at verse 25\./],
      ['3 John 13-15', '3 John 13, 14', /closing greeting of 3 John/]
    ];
    for (const [input, reference, note] of cases) {
      const ref = parseReference(input);
      assert.equal(ref.reference, reference, input);
      assert.match(ref.notes.join(' '), note, input);
    }
    assert.equal(referenceFromParts(43, 3, '30-40').reference, 'John 3:30-36');
    assert.throws(() => parseReference('John 3:37'), /no verse 37/);
    assert.throws(() => referenceFromParts(43, 3, '40-50'), /no verse 40/);
  });

  it('ignores a trailing NWT tag, and names other trailing words in the hint', () => {
    const cases = [
      ['John 3:16 NWT', ['John 3:16']],
      ['Romans 8:38-39 (NWT)', ['Romans 8:38, 39']],
      ['John 3:16, NWT', ['John 3:16']],
      ['(John 3:16 NWT)', ['John 3:16']],
      ['John 3:16 New World Translation', ['John 3:16']],
      ['Ps 83:18 nwtsty', ['Psalm 83:18']],
      ['Jude NWT', ['Jude']],
      ['John 3:16 (NWT); Ps 83:18 NWT', ['John 3:16', 'Psalm 83:18']],
      ['John 3:16; 4:1 NWT', ['John 3:16', 'John 4:1']]
    ];
    for (const [input, want] of cases) assert.deepEqual(parseReferences(input).map((r) => r.reference), want, input);
    for (const [input, hint] of [['John 3:16 KJV', /Drop "KJV" after "John 3:16"/], ['Romans 8:38-39 (ESV)', /Drop "ESV" after "Romans 8:38-39"/]]) {
      assert.throws(() => parseReference(input), (e) => /expected a Bible reference like/.test(e.message) && hint.test(e.hint), input);
    }
    assert.throws(() => parseReference('John 3:16NWTX'), /expected a Bible reference like/);
  });

  it('keeps messages short for a reference padded with whitespace', () => {
    for (const input of [' '.repeat(100000) + 'x', ' '.repeat(100000) + 'John']) {
      assert.throws(() => parseReference(input), (e) => e.name === 'ArgError' && e.message.length < 300);
    }
  });

  const errors = [
    ['John 22:1', /John has 21 chapters, so there is no chapter 22\./, /chapter from 1 to 21/],
    ['John 3:37', /John 3 has 36 verses, so there is no verse 37\./, /verse from 1 to 36/],
    ['Jude 2:1', /Jude has only one chapter/, /Did you mean Jude 2\?/],
    ['3 John 15', /3 John has 14 verses/, /part of verse 14/],
    ['Rev 12:18', /Revelation 12 has 17 verses/, /part of 13:1/],
    ['Mark 16:9', /Mark 16:9-20 is not part of the New World Translation/, /study note on Mark 16:8/],
    ['John 7:53', /John 7:53–8:11 is not part of/, /study note on John 7:52/],
    ['John 8:7', /John 7:53–8:11 is not part of/, /John 8 has verses 12-59/],
    ['John 3:0', /Verse 0 exists only in Psalms/, /start at 1/],
    ['John 0:1', /chapter from 1 to 21/, null],
    ['John 3:18-16', /ends before it starts/, /"16-18"/],
    ['Matthew 7-5', /ends before it starts/, null],
    ['John', /has no chapter/, /John 1/],
    ['Jhon 3:16', /Unknown Bible book "Jhon"/, /John \(43\)/],
    ['Xyz 3:16', /Unknown Bible book "Xyz"/, /Book names are read in English \(or in the langwritten language once known\)/],
    ['John 3:16abc', /expected a Bible reference like/, null],
    ['John 3:16 b', /expected a Bible reference like/, null],
    ['Jude 25b', /expected a Bible reference like/, /part-verse letter/],
    ['John 3:16 KJV', /expected a Bible reference like/, /serve only the New World Translation/],
    ['1C 13:4', /Unknown Bible book "1C"/, null],
    ['John 3:16-', /expected a Bible reference like/, null],
    ['John 3:1,,3', /expected a Bible reference like/, null],
    ['3:16', /expected a Bible reference like/, null],
    ['', /Missing required "reference"/, null]
  ];
  for (const [input, message, hint] of errors) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.throws(
        () => parseReference(input),
        (e) => e.name === 'ArgError' && e.param === 'reference' && message.test(e.message) && (!hint || hint.test(e.hint ?? ''))
      );
      assert.equal(tryParseReference(input), null);
    });
  }
});

describe('referenceFromParts and validateReference', () => {
  it('coerces numeric strings and book names', () => {
    assert.equal(referenceFromParts('43', '3', '16').reference, 'John 3:16');
    assert.equal(referenceFromParts('John', 3, 16).reference, 'John 3:16');
    assert.equal(referenceFromParts(43, '3.0', ' 16 ').reference, 'John 3:16');
    assert.equal(referenceFromParts(43, 3, [1, 3, 5]).reference, 'John 3:1, 3, 5');
    assert.equal(referenceFromParts(43, 3, '14–16').reference, 'John 3:14-16');
    assert.equal(referenceFromParts(65, undefined, 25).reference, 'Jude 25');
    assert.equal(referenceFromParts(40, 5).reference, 'Matthew 5');
    assert.equal(referenceFromParts(19, 3, 0).reference, 'Psalm 3:superscription');
  });

  const bad = [
    [[1.5, 1, 1], 'book', /got 1\.5/],
    [[43, 3.5, 1], 'chapter', /a chapter from 1 to 21/],
    [[43, 'abc', 1], 'chapter', /got "abc"/],
    [[43, Infinity, 1], 'chapter', /a chapter from 1 to 21/],
    [[43, undefined, 1], 'chapter', /Missing required "chapter"/],
    [[43, 999, 1], 'chapter', /John has 21 chapters/],
    [[65, 25, 1], 'chapter', /Jude has only one chapter/],
    [[43, 3, 16.5], 'verse', /got 16\.5/],
    [[43, 3, NaN], 'verse', /expected a verse like/],
    [[43, 3, '16abc'], 'verse', /got "16abc"/],
    [[43, 3, '3:16'], 'verse', /got "3:16"/],
    [[43, 3, '16-'], 'verse', /got "16-"/],
    [[43, 3, '16-17-18'], 'verse', /got "16-17-18"/],
    [[43, 3, '1,2,,3'], 'verse', /got "1,2,,3"/],
    [[43, 3, true], 'verse', /got true/],
    [[43, 3, 999], 'verse', /John 3 has 36 verses/],
    [[43, 3, '18-16'], 'verse', /ends before it starts/],
    [[43, 3, 0], 'verse', /Verse 0 exists only in Psalms/]
  ];
  for (const [[book, chapter, verse], param, message] of bad) {
    it(`rejects ${String(book)}, ${String(chapter)}, ${JSON.stringify(verse) ?? String(verse)} on "${param}"`, () => {
      assert.throws(() => referenceFromParts(book, chapter, verse), (e) => e.name === 'ArgError' && e.param === param && message.test(e.message));
      // 1.3's contract: invalid input is {valid: false, error}, not an exception.
      const result = validateReference(book, chapter, verse);
      assert.equal(result.valid, false);
      assert.match(result.error, message);
    });
  }

  it('explains where to put a chapter sent in the verse', () => {
    assert.throws(() => referenceFromParts(43, 3, '3:16'), (e) => /reference/.test(e.hint));
  });

  it('returns valid: true for callers of the old {valid, error} contract', () => {
    const result = validateReference(43, 3, '14-16');
    assert.equal(result.valid, true);
    assert.equal(result.error, null);
    assert.equal(result.reference, 'John 3:14-16');
  });
});

describe('book names in other languages', () => {
  beforeEach(() => clearBookNames());
  afterEach(() => clearBookNames());

  const SPANISH = {
    19: { standardName: 'Salmos', standardSingularBookName: 'Salmo', standardAbbreviation: 'Sal.' },
    43: { standardName: 'Juan', officialAbbreviation: 'Jn' },
    62: { standardName: '1 Juan', officialAbbreviation: '1 Jn' },
    66: { standardName: 'Apocalipsis', standardAbbreviation: 'Apoc.' }
  };

  it('parses names registered for a language, and formats them back', () => {
    registerBookNames('S', SPANISH);
    assert.ok(hasBookNames('S'));
    assert.equal(parseReference('Juan 3:16', { lang: 'S' }).book, 43);
    assert.equal(parseReference('Salmo 23', { lang: 'S' }).book, 19);
    assert.equal(parseReference('Sal. 83:18', { lang: 'S' }).book, 19);
    assert.equal(parseReference('1 Juan 5:20', { lang: 'S' }).book, 62);
    const rev = parseReference('Apocalipsis 21:3, 4', { lang: 'S' });
    assert.equal(rev.book, 66);
    assert.equal(formatReference(rev, 'S'), 'Apocalipsis 21:3, 4');
    assert.equal(parseReference('Apoc 1:1', { lang: 'S' }).book, 66, 'a unique prefix of a local name');
    // English names keep working in the language, and local names need it.
    assert.equal(parseReference('John 3:16', { lang: 'S' }).book, 43);
    assert.throws(() => parseReference('Juan 3:16'), (e) => e.unknownBook === true && /Unknown Bible book "Juan"/.test(e.message));
    assert.deepEqual(parseReferences('Juan 3:16; 4:1', { lang: 'S' }).map((r) => r.reference), ['John 3:16', 'John 4:1']);
    assert.equal(referenceFromArgs({ book: 'Juan', chapter: 3, verse: 16 }, { lang: 'S' }).book, 43);
    assert.equal(toBook('Salmos', 'book', 'S'), 19);
  });

  it('tries the language\'s own names before English abbreviations', () => {
    registerBookNames('F', { 26: { standardName: 'Ézéchiel', officialAbbreviation: 'Éz' }, 15: { standardName: 'Esdras', officialAbbreviation: 'Esd' } });
    assert.equal(parseReference('Éz 37:1', { lang: 'F' }).book, 26);
    assert.throws(() => parseReference('Éz 37:1', { lang: 'E' }), /Ezra has 10 chapters/);
  });

  it('keeps accented abbreviations apart (Portuguese Jo is John, Jó is Job)', () => {
    registerBookNames('T', { 18: { standardName: 'Jó', officialAbbreviation: 'Jó' }, 43: { standardName: 'João', officialAbbreviation: 'Jo' } });
    assert.equal(getBookNumber('Jo', 'T'), 43);
    assert.equal(getBookNumber('Jó', 'T'), 18);
    assert.equal(getBookNumber('João', 'T'), 43);
  });

  it('ignores ruby readings in registered names', () => {
    registerBookNames('J', { 43: { standardName: '<ruby><rb>ヨハネ</rb><rt>よはね</rt></ruby>' } });
    assert.equal(getBookNumber('ヨハネ', 'J'), 43);
  });

  it('says what to do with an unknown name instead of sending the model to search_bible_books', () => {
    assert.throws(() => parseReference('Qwertz 3:16'), (e) => /Book names are read in English/.test(e.hint) && !/search_bible_books/.test(e.hint));
  });
});

describe('long arguments are refused before any regex work', () => {
  const quick = async (name, args) => {
    const start = performance.now();
    const result = await callTool({ params: { name, arguments: args } });
    const ms = performance.now() - start;
    assert.equal(result.isError, true, `${name} ${result.content[0].text.slice(0, 100)}`);
    assert.ok(ms < 100, `${name} took ${ms.toFixed(1)} ms`);
    return result.content[0].text;
  };

  it('rejects a huge verse, book or verse list in milliseconds', async () => {
    const spaced = '1' + ' '.repeat(200000) + '1';
    assert.match(await quick('get_bible_verse_url', { book: 43, chapter: 3, verse: spaced }), /characters long; the limit is 1000/);
    assert.match(await quick('get_bible_verse_url', { book: 'a'.repeat(200000) }), /Invalid "book"/);
    assert.match(await quick('get_bible_verse_url', { book: 43, chapter: 3, verse: Array(100000).fill('1 ') }), /"verse" is \d+ characters long/);
    assert.match(await quick('get_bible_verse', { book: 43, chapter: 3, verse: spaced }), /"verse" is 200002 characters long/);
    assert.match(await quick('get_verse_with_study', { book: 43, chapter: 3, verse: spaced }), /"verse" is 200002 characters long/);
    assert.match(await quick('get_bible_verse', { book: 'John' + ' '.repeat(200000) + '3' }), /Invalid "book"/);
    assert.match(await quick('get_bible_verse', { reference: 'John ' + '3'.repeat(200000) }), /Invalid "reference"/);
  });

  it('looksLikeReference is linear and right', () => {
    assert.equal(looksLikeReference('John 3'), true);
    assert.equal(looksLikeReference('3 John'), false);
    assert.equal(looksLikeReference('1 John 5'), true);
    assert.equal(looksLikeReference(43), false);
    const start = performance.now();
    looksLikeReference('a' + ' '.repeat(500000));
    assert.ok(performance.now() - start < 50);
  });

  it('still reads spacing, "through" and long verse lists', () => {
    assert.equal(referenceFromParts(43, 3, '16  through\t18').reference, 'John 3:16-18');
    assert.equal(referenceFromParts(43, 3, '1 , 3 , 5 - 7').reference, 'John 3:1, 3, 5-7');
    assert.equal(referenceFromParts(19, 119, Array.from({ length: 176 }, (_, i) => i + 1)).reference, 'Psalm 119:1-176');
  });
});

describe('referencesFromArgs', () => {
  it('takes reference or parts, and a whole reference sent as book', () => {
    assert.equal(referenceFromArgs({ reference: 'Ps 83:18' }).reference, 'Psalm 83:18');
    assert.equal(referenceFromArgs({ book: 19, chapter: 83, verse: 18 }).reference, 'Psalm 83:18');
    assert.equal(referenceFromArgs({ book: 'Ps 83:18' }).reference, 'Psalm 83:18');
    assert.equal(referenceFromArgs({ reference: 'John 3:16', book: 43, chapter: 3 }).reference, 'John 3:16');
    assert.equal(referencesFromArgs({ reference: 'John 3:16; 17:3' }).length, 2);
  });

  it('rejects missing, conflicting and multiple references', () => {
    assert.throws(() => referencesFromArgs(undefined), /Missing reference/);
    assert.throws(() => referencesFromArgs({}), /Missing reference/);
    assert.throws(() => referencesFromArgs({ reference: 'John 3:16', book: 40 }), /disagrees/);
    assert.throws(() => referenceFromArgs({ reference: 'John 3:16; 17:3' }), /Expected one reference/);
    assert.throws(() => referencesFromArgs({ book: 'John' }), /Missing required "chapter"/);
  });
});

describe('formatReference', () => {
  it('keeps the legacy (book, chapter, verse) form', () => {
    assert.equal(formatReference(40, 24, 14), 'Matthew 24:14');
    assert.equal(formatReference(40, 24, '14-16'), 'Matthew 24:14-16');
    assert.equal(formatReference(99, 1, 1), '');
  });

  it('uses JW style', () => {
    assert.equal(formatReference(19, 83, 18), 'Psalm 83:18');
    assert.equal(formatReference(19, 23), 'Psalm 23');
    assert.equal(formatReference(19, 3, 0), 'Psalm 3:superscription');
    assert.equal(formatReference(66, 21, '3-4'), 'Revelation 21:3, 4');
    assert.equal(formatReference(66, 21, '4,3'), 'Revelation 21:3, 4');
    assert.equal(formatReference(43, 3, '1,3,5'), 'John 3:1, 3, 5');
    assert.equal(formatReference(65, 1, 25), 'Jude 25');
    assert.equal(formatReference(parseReference('Psalms 23-25')), 'Psalms 23-25');
  });

  it('uses registered localized names', () => {
    registerBookNames('S', { 19: { standardName: 'Salmos', standardSingularBookName: 'Salmo' }, 43: { standardName: 'Juan' } });
    assert.equal(formatReference(19, 83, 18, 'S'), 'Salmo 83:18');
    assert.equal(formatReference(parseReference('John 3:16'), 'S'), 'Juan 3:16');
    assert.equal(formatReference(40, 5, 1, 'S'), 'Matthew 5:1');
    assert.equal(formatReference(43, 3, 16), 'John 3:16');
  });
});

describe('links and ids', () => {
  it('builds BBCCCVVV ids and finder URLs', () => {
    assert.equal(bibleVerseId(19, 83, 18), '19083018');
    assert.equal(bibleVerseId(1, 1), '1001000');
    assert.equal(finderUrl('43003016', 'S'), 'https://www.jw.org/finder?wtlocale=S&prefer=lang&bible=43003016&pub=nwtsty');
  });

  it('links a chapter with verse slot 000, one link per passage and per chapter', () => {
    const urls = (text) => verseLinks(parseReference(text)).map((l) => [l.reference, l.url.slice(FINDER.length, -'&pub=nwtsty'.length)]);
    assert.deepEqual(urls('Matthew 5'), [['Matthew 5', '40005000']]);
    assert.deepEqual(urls('Genesis 1'), [['Genesis 1', '1001000']]);
    assert.deepEqual(urls('John 3:16-18'), [['John 3:16-18', '43003016-43003018']]);
    assert.deepEqual(urls('John 3:1,3,5'), [['John 3:1', '43003001'], ['John 3:3', '43003003'], ['John 3:5', '43003005']]);
    assert.deepEqual(urls('Matt 5:3–6:4'), [['Matthew 5:3-48', '40005003-40005048'], ['Matthew 6:1-4', '40006001-40006004']]);
    assert.deepEqual(urls('Matthew 5-6'), [['Matthew 5', '40005000'], ['Matthew 6', '40006000']]);
    assert.deepEqual(urls('Ps 3:0'), [['Psalm 3:superscription', '19003000']]);
    assert.deepEqual(urls('Ps 3:0-2'), [['Psalm 3:superscription-2', '19003001-19003002']]);
    assert.deepEqual(urls('John 7:52–8:12'), [['John 7:52', '43007052'], ['John 8:12', '43008012']]);
  });

  it('lists the verses a reference covers', () => {
    assert.deepEqual(listVerses(parseReference('John 3:16-18')), [16, 17, 18].map((verse) => ({ chapter: 3, verse })));
    const john8 = listVerses(parseReference('John 8'));
    assert.equal(john8.length, 48);
    assert.deepEqual(john8[0], { chapter: 8, verse: 12 });
    assert.equal(listVerses(parseReference('Jude')).length, 25);
  });
});

describe('search_bible_books tool', () => {
  it('declares integer limits and returns ranked books with chapter counts', async () => {
    assert.equal(searchBibleBooksTool.inputSchema.properties.limit.type, 'integer');
    const out = json(await searchBibleBooksImplementation({ query: 'Jn', limit: '2' }));
    assert.equal(out.results_count, 2);
    assert.deepEqual(out.books[0], {
      number: 43,
      name: 'John',
      testament: 'New Testament',
      division: 'Christian Greek Scriptures',
      chapters: 21,
      abbreviations: ['John', 'Joh'],
      relevance_score: 95
    });
    assert.equal(out.books[1].name, 'Jonah');
  });

  it('adds the parsed reference when the query is a full reference', async () => {
    const out = json(await searchBibleBooksImplementation({ query: '1 Cor. 13:4-7' }));
    assert.equal(out.books[0].number, 46);
    assert.deepEqual(out.parsed_reference, { reference: '1 Corinthians 13:4-7', book: 46, chapter: 13, verse: '4-7' });
    assert.equal(json(await searchBibleBooksImplementation({ query: '1 John' })).parsed_reference, undefined);
  });

  it('still accepts the positional (query, limit) call', async () => {
    const out = json(await searchBibleBooksImplementation('matt', 1));
    assert.deepEqual(out.books.map((b) => b.name), ['Matthew']);
    assert.equal(json(await searchBibleBooksImplementation(40)).books[0].name, 'Matthew');
  });

  it('returns isError for no match and bad arguments', async () => {
    assert.match(errorText(await searchBibleBooksImplementation({ query: 'xyz' })), /No Bible book matches "xyz"\.\nNext step: /);
    assert.match(errorText(await searchBibleBooksImplementation({})), /Missing required "query"/);
    assert.match(errorText(await searchBibleBooksImplementation(undefined)), /Missing required "query"/);
    assert.match(errorText(await searchBibleBooksImplementation({ query: 'john', limit: 'many' })), /Invalid "limit"/);
    assert.match(errorText(await searchBibleBooksImplementation({ query: 'Juan' })), /pass langwritten \(e\.g\. "S" for "Juan"\)/);
  });

  it('takes a limit above 66, 0 or less as "every match" and floors a decimal, as 1.3.3 took any number', async () => {
    assert.equal(searchBibleBooksTool.inputSchema.properties.limit.maximum, undefined);
    for (const limit of [2.7, '2.7']) assert.equal(json(await searchBibleBooksImplementation({ query: 'john', limit })).results_count, 2);
    for (const limit of [100, '100', 0, -1]) {
      const out = json(await searchBibleBooksImplementation({ query: 'john', limit }));
      assert.equal(out.results_count, 4);
    }
  });

  it('matches a language\'s book names with langwritten, learning them once', async () => {
    clearBookNames();
    clearBibleCache();
    const DATA = 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/json/data/43003000-43003999';
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url).startsWith('https://www.jw.org/finder')) {
        return new Response(null, { status: 302, headers: { location: 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/' } });
      }
      if (String(url) === DATA) {
        return new Response(JSON.stringify({ ranges: { '43003000-43003999': { verses: [] } }, editionData: { books: { 43: { standardName: 'Juan', officialAbbreviation: 'Jn' } } } }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = json(await searchBibleBooksImplementation({ query: 'Juan 3:16', langwritten: 'S' }));
    assert.equal(out.books[0].number, 43);
    assert.equal(out.books[0].local_name, 'Juan');
    assert.equal(out.parsed_reference.book, 43);
    json(await searchBibleBooksImplementation({ query: 'Jn', langwritten: 'S' }));
    assert.equal(fetched.length, 2, fetched.join('\n'));
    clearBookNames();
  });

  it('works through the handler', async () => {
    const out = json(await handleScriptureTools({ params: { name: 'search_bible_books', arguments: { query: 'Canticles' } } }));
    assert.equal(out.books[0].number, 22);
  });
});

describe('get_bible_verse_url tool', () => {
  it('accepts reference or book/chapter, with integer schema hints', () => {
    const { properties, required } = getBibleVerseURLTool.inputSchema;
    assert.deepEqual(required, []);
    assert.equal(properties.book.type, 'integer');
    assert.equal(properties.book.maximum, 66);
    assert.equal(properties.chapter.type, 'integer');
    assert.equal(properties.reference.type, 'string');
    assert.equal(properties.langwritten.type, 'string');
  });

  it('links a whole chapter with verse slot 000 and labels it', async () => {
    assert.deepEqual(json(await getBibleVerseURLImplementation({ book: 40, chapter: 5 })), {
      reference: 'Matthew 5',
      url: `${FINDER}40005000&pub=nwtsty`,
      markdown: `[Matthew 5](${FINDER}40005000&pub=nwtsty)`,
      langwritten: 'E'
    });
  });

  it('links a verse and a range', async () => {
    assert.equal(json(await getBibleVerseURLImplementation({ book: 19, chapter: 83, verse: '18' })).url, `${FINDER}19083018&pub=nwtsty`);
    const range = json(await getBibleVerseURLImplementation({ book: 23, chapter: 46, verse: '9–11' }));
    assert.equal(range.reference, 'Isaiah 46:9-11');
    assert.equal(range.url, `${FINDER}23046009-23046011&pub=nwtsty`);
    assert.equal(json(await getBibleVerseURLImplementation({ book: 43, chapter: 3, verse: '1,2,3' })).url, `${FINDER}43003001-43003003&pub=nwtsty`);
    assert.equal(json(await getBibleVerseURLImplementation({ book: 43, chapter: 3, verse: ' 16 ' })).url, `${FINDER}43003016&pub=nwtsty`);
  });

  it('returns one link per passage for a non-contiguous list instead of dropping verses', async () => {
    const out = json(await getBibleVerseURLImplementation({ book: 43, chapter: 3, verse: '1,3,5' }));
    assert.equal(out.reference, 'John 3:1, 3, 5');
    assert.deepEqual(out.links.map((l) => l.reference), ['John 3:1', 'John 3:3', 'John 3:5']);
    assert.equal(out.url, out.links[0].url);
    assert.match(out.note, /one passage in one chapter/);
  });

  it('takes a reference string, ";" lists and a language', async () => {
    const out = json(await getBibleVerseURLImplementation({ reference: 'Ps. 83:18; John 17:3', langwritten: 'es' }));
    assert.equal(out.reference, 'Psalm 83:18; John 17:3');
    assert.equal(out.langwritten, 'S');
    assert.deepEqual(out.links.map((l) => l.url), [
      'https://www.jw.org/finder?wtlocale=S&prefer=lang&bible=19083018&pub=nwtsty',
      'https://www.jw.org/finder?wtlocale=S&prefer=lang&bible=43017003&pub=nwtsty'
    ]);
    const cross = json(await getBibleVerseURLImplementation({ reference: 'Matt. 5:3–6:4' }));
    assert.deepEqual(cross.links.map((l) => l.reference), ['Matthew 5:3-48', 'Matthew 6:1-4']);
  });

  it('reads book names in the langwritten language, learning them on the first miss', async () => {
    clearBookNames();
    clearBibleCache();
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url).startsWith('https://www.jw.org/finder')) {
        return new Response(null, { status: 302, headers: { location: 'https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/juan/3/' } });
      }
      return new Response(
        JSON.stringify({ ranges: { 43003016: { verses: [] } }, editionData: { books: { 19: { standardName: 'Salmos', standardSingularBookName: 'Salmo' }, 43: { standardName: 'Juan' } } } }),
        { headers: { 'content-type': 'application/json' } }
      );
    };
    const out = json(await getBibleVerseURLImplementation({ reference: 'Juan 3:16; Salmo 83:18', langwritten: 'S' }));
    assert.deepEqual(out.links.map((l) => l.url.split('bible=')[1]), ['43003016&pub=nwtsty', '19083018&pub=nwtsty']);
    assert.equal(fetched.length, 2);
    json(await getBibleVerseURLImplementation({ reference: 'Juan 17:3', langwritten: 'S' }));
    assert.equal(fetched.length, 2, 'names are learned once');
    clearBookNames();
  });

  it('links a psalm superscription to the psalm and says so', async () => {
    const out = json(await getBibleVerseURLImplementation({ book: 19, chapter: 51, verse: 0 }));
    assert.equal(out.url, `${FINDER}19051000&pub=nwtsty`);
    assert.match(out.note, /superscription/);
  });

  it('passes on notes about omitted verses', async () => {
    const out = json(await getBibleVerseURLImplementation({ reference: 'Acts 8:36-38' }));
    assert.match(out.note, /Acts 8:37 has no text in the NWT/);
  });

  const bad = [
    [{ book: 43, chapter: 3, verse: '16-' }, /Invalid "verse"/],
    [{ book: 43, chapter: 3, verse: '18-16' }, /ends before it starts/],
    [{ book: 43, chapter: 3, verse: 'abc' }, /Invalid "verse"/],
    [{ book: 43, chapter: 3, verse: '16abc' }, /Invalid "verse"/],
    [{ book: 43, chapter: 3, verse: '3:16' }, /Invalid "verse"[\s\S]*Next step: Put the chapter/],
    [{ book: 43, chapter: 3, verse: '1000' }, /John 3 has 36 verses/],
    [{ book: 43, chapter: 3, verse: '16-17-18' }, /Invalid "verse"/],
    [{ book: 43, chapter: 3, verse: '1,2,,3' }, /Invalid "verse"/],
    [{ book: 43, chapter: 3, verse: 0 }, /Verse 0 exists only in Psalms/],
    [{ book: 43, chapter: 999, verse: '1' }, /John has 21 chapters/],
    [{ book: 1.5, chapter: 2.5 }, /Invalid "book"/],
    [{ book: 1, chapter: 99 }, /Genesis has 50 chapters/],
    [{ book: 65, chapter: 25, verse: 1 }, /Jude has only one chapter[\s\S]*Did you mean Jude 25/],
    [{ reference: 'Mark 16:9' }, /not part of the New World Translation/],
    [{ reference: 'Jhon 3:16' }, /Unknown Bible book "Jhon"[\s\S]*John \(43\)/],
    [{ reference: 'Juan 3:16' }, /Unknown Bible book "Juan"[\s\S]*Next step: Book names are read in English/],
    [{ reference: 'John 3:16', book: 40 }, /disagrees/],
    [{ book: 43, chapter: 3, langwritten: 7 }, /Invalid "langwritten"/],
    [{}, /Missing reference/]
  ];
  for (const [args, message] of bad) {
    it(`returns isError for ${JSON.stringify(args)}`, async () => {
      assert.match(errorText(await getBibleVerseURLImplementation(args)), message);
    });
  }

  it('returns isError instead of throwing when called with no arguments', async () => {
    assert.match(errorText(await getBibleVerseURLImplementation()), /Missing reference/);
    assert.match(errorText(await getBibleVerseURLImplementation(null)), /Missing reference/);
  });

  it('still accepts the positional (book, chapter, verse) call used by the handler', async () => {
    assert.equal(json(await getBibleVerseURLImplementation(40, 5)).url, `${FINDER}40005000&pub=nwtsty`);
    assert.equal(json(await getBibleVerseURLImplementation('43', '3', '16')).reference, 'John 3:16');
    assert.match(errorText(await getBibleVerseURLImplementation(43, 3, 'abc')), /Invalid "verse"/);
    const viaHandler = json(await handleScriptureTools({ params: { name: 'get_bible_verse_url', arguments: { book: 40, chapter: 5 } } }));
    assert.equal(viaHandler.url, `${FINDER}40005000&pub=nwtsty`);
  });
});

describe('part-verse letters', () => {
  it('reads "16b", "16-17a" and "16ff" as whole verses, with a note', () => {
    const a = parseReference('John 3:16a');
    assert.equal(a.reference, 'John 3:16');
    assert.match(a.notes[0], /Part-verse letters \("a"\) were ignored/);
    assert.equal(referenceFromParts(43, 3, '16b').reference, 'John 3:16');
    assert.match(referenceFromParts(43, 3, '16b').notes[0], /Part-verse letters \("b"\)/);
    assert.equal(referenceFromParts(43, 3, '16-17a').verseSpec, '16-17');
    assert.match(referenceFromParts(43, 3, '16ff').notes[0], /send an end verse/);
    assert.equal(parseReference('Gen 1:1, 3b, 5ff').reference, 'Genesis 1:1, 3, 5');
    assert.equal(parseReferences('John 3:16; 4:1b')[1].reference, 'John 4:1');
  });

  it('keeps refusing what is not a part-verse letter', () => {
    assert.throws(() => referenceFromParts(43, 3, '16abc'), /Invalid "verse"/);
    assert.throws(() => parseReference('1C 13:4'), /Unknown Bible book "1C"/);
    assert.throws(() => parseReference('John 3:16 KJV'), (e) => /serve only the New World Translation/.test(e.hint));
  });

  it('passes the note through the tools', async () => {
    const out = json(await getBibleVerseURLImplementation({ reference: 'Matt. 24:14a' }));
    assert.equal(out.reference, 'Matthew 24:14');
    assert.match(out.note, /Part-verse letters/);
  });
});

describe('reference lists written another way', () => {
  it('says to use ";" when a comma or "and" joins two books', () => {
    assert.throws(() => parseReferences('John 3:16, Romans 5:8'), (e) => e.hint.includes('"John 3:16; Romans 5:8"'));
    assert.throws(() => parseReferences('John 3:16 and 1 John 4:8'), (e) => e.hint.includes('"John 3:16; 1 John 4:8"'));
    assert.equal(parseReferences('Acts 17:26, 27')[0].reference, 'Acts 17:26, 27');
    assert.throws(() => parseReferences('John 3:16, KJV'), (e) => /Drop ", KJV"/.test(e.hint));
  });

  it('reads an array of references as a ";" list', async () => {
    const out = json(await getBibleVerseURLImplementation({ reference: ['John 3:16', 'Romans 5:8'] }));
    assert.equal(out.reference, 'John 3:16; Romans 5:8');
    assert.equal(out.links.length, 2);
    assert.match(errorText(await getBibleVerseURLImplementation({ reference: [] })), /Invalid "reference"/);
    assert.match(errorText(await getBibleVerseURLImplementation({ reference: ['John 3:16', 1] })), /Invalid "reference"/);
  });
});

describe('book names do not depend on call order', () => {
  beforeEach(() => {
    clearBookNames();
    clearBibleCache();
  });
  afterEach(() => clearBookNames());

  it('reads French "Éz 1:1" as Ezekiel on the first call', async () => {
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url).includes('/finder?')) {
        return new Response(null, { status: 302, headers: { location: 'https://www.jw.org/fr/bibliothèque/bible/bible-d-etude/livres/jean/3/' } });
      }
      if (String(url).includes('/json/data/')) {
        const books = { 15: { standardName: 'Esdras', officialAbbreviation: 'Esd' }, 26: { standardName: 'Ézéchiel', officialAbbreviation: 'Éz' } };
        return new Response(JSON.stringify({ ranges: {}, editionData: { books } }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    const first = json(await getBibleVerseURLImplementation({ reference: 'Éz 1:1', langwritten: 'F' }));
    assert.match(first.url, /bible=26001001/);
    assert.equal(json(await getBibleVerseURLImplementation({ reference: 'Éz 1:1', langwritten: 'F' })).url, first.url);
    assert.equal(fetched.filter((u) => u.includes('/json/data/')).length, 1, 'the names are learned once');
  });

  it('lets a local name as written beat an English alias, and English beat an accent-folded local name', () => {
    registerBookNames('VT', { 4: { standardName: 'Dân-số Ký', officialAbbreviation: 'Dân' }, 27: { standardName: 'Đa-ni-ên', officialAbbreviation: 'Đa' } });
    assert.equal(getBookNumber('Dan.', 'VT'), 27);
    assert.equal(getBookNumber('Dân', 'VT'), 4);
    assert.equal(getBookNumber('Đa', 'VT'), 27);
    registerBookNames('O', { 7: { standardName: 'Rechters', officialAbbreviation: 'Re' } });
    assert.equal(getBookNumber('Re', 'O'), 7);
    assert.equal(getBookNumber('Re'), 66);
  });
});

describe('echoed arguments stay short', () => {
  it('caps a huge book or chapter in the disagreement error, and a huge tool name', async () => {
    for (const extra of [{ book: 'x'.repeat(300000) }, { chapter: '9'.repeat(300000) }]) {
      for (const name of ['get_bible_verse', 'get_verse_with_study', 'get_bible_verse_url']) {
        const result = await callTool({ params: { name, arguments: { reference: 'John 3:16', ...extra } } });
        assert.equal(result.isError, true);
        assert.ok(result.content[0].text.length < 500, `${name}: ${result.content[0].text.length} characters`);
      }
    }
    const unknown = await callTool({ params: { name: 'x'.repeat(300000), arguments: {} } });
    assert.equal(unknown.isError, true);
    assert.ok(unknown.content[0].text.length < 1000, `${unknown.content[0].text.length} characters`);
  });

  it('keeps the disagreement message readable', () => {
    assert.throws(() => referencesFromArgs({ reference: 'John 3:16', book: 'Romans', chapter: 3 }), /disagrees with book\/chapter \(Romans 3\)/);
  });
});

describe('search_bible_books spelling guesses', () => {
  it('marks near misses as guesses with a note, and finds nothing for a name that is no book', async () => {
    const moses = json(await searchBibleBooksImplementation({ query: 'Moses' }));
    assert.equal(moses.books[0].name, 'Hosea');
    assert.equal(moses.books[0].match, 'spelling_guess');
    assert.match(moses.note, /No Bible book is named "Moses"/);
    const mary = json(await searchBibleBooksImplementation({ query: 'Mary' }));
    assert.deepEqual([mary.books[0].name, mary.books[0].match], ['Mark', 'spelling_guess']);
    assert.match(errorText(await searchBibleBooksImplementation({ query: 'Tobit' })), /No Bible book matches "Tobit"/);
    assert.equal(json(await searchBibleBooksImplementation({ query: 'Jhon' })).books[0].match, 'spelling_guess');
    const john = json(await searchBibleBooksImplementation({ query: 'John' }));
    assert.equal(john.note, undefined);
    assert.equal(john.books[0].match, undefined);
    const tobit = errorText(await getBibleVerseImplementation({ reference: 'Tobit 1:1' }));
    assert.doesNotMatch(tobit, /Titus/);
  });

  it('contacts jw.org for another language\'s book names, so it is not a local-only tool', async () => {
    clearBookNames();
    clearBibleCache();
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      throw new Error('offline');
    };
    json(await searchBibleBooksImplementation({ query: 'John', langwritten: 'S' }));
    assert.ok(fetched.some((u) => u.startsWith('https://www.jw.org/')), fetched.join('\n'));
  });
});

describe('language codes read another way', () => {
  it('says when "TL" was read as Tagalog and how to get Tamil', async () => {
    const out = json(await getBibleVerseURLImplementation({ reference: 'John 3:16', langwritten: 'TL' }));
    assert.equal(out.langwritten, 'TG');
    assert.match(out.note, /"TL" was read as the ISO tag for Tagalog[\s\S]*pass langwritten "Tamil"/);
    assert.equal(json(await getBibleVerseURLImplementation({ reference: 'John 3:16', langwritten: 'TG' })).note, undefined);
  });
});

describe('Arabic and Korean citations as the tools print them', () => {
  afterEach(() => clearBookNames());

  it('reads Arabic-Indic digits, the Arabic comma and semicolon', () => {
    clearBookNames();
    registerBookNames('A', { 43: { standardName: 'يوحنا' }, 45: { standardName: 'روما' }, 62: { standardName: '١ يوحنا' } });
    assert.equal(parseReference('روما ٥:٨', { lang: 'A' }).reference, 'Romans 5:8');
    assert.equal(parseReference('١ يوحنا ٤:٩، ١٠', { lang: 'A' }).reference, '1 John 4:9, 10');
    assert.equal(parseReference('1 يوحنا 4:19', { lang: 'A' }).reference, '1 John 4:19');
    assert.deepEqual(parseReferences('روما ٥:٨؛ يوحنا ٦:٤٠', { lang: 'A' }).map((r) => r.reference), ['Romans 5:8', 'John 6:40']);
    assert.equal(referenceFromParts(43, 3, '١٦').reference, 'John 3:16');
    assert.equal(referenceFromParts(43, '٣', '١٦').reference, 'John 3:16');
    assert.equal(getBookNumber('1 يوحنا', 'A'), 62);
    assert.equal(getBookNumber('١ يوحنا', 'A'), 62);
    assert.equal(looksLikeReference('روما ٥:٨'), true);
    assert.equal(searchBooks('روما ٥:٨', 3, { lang: 'A' })[0].number, 45);
  });

  it('reads Korean names with a digit inside ("요한 1서", "요1")', () => {
    clearBookNames();
    registerBookNames('KO', {
      43: { standardName: '요한복음', officialAbbreviation: '요' },
      62: { standardName: '요한 1서', officialAbbreviation: '요1' },
      63: { standardName: '요한 2서', officialAbbreviation: '요2' }
    });
    const read = (s) => parseReferences(s, { lang: 'KO' }).map((r) => [r.book, r.reference]);
    assert.deepEqual(read('요한 1서 4:9, 10'), [[62, '1 John 4:9, 10']]);
    assert.deepEqual(read('요한1서 4:9'), [[62, '1 John 4:9']], 'also without the space');
    assert.deepEqual(read('요1 4:8'), [[62, '1 John 4:8']]);
    assert.deepEqual(read('요2 5'), [[63, '2 John 5']]);
    assert.deepEqual(read('요한 2서'), [[63, '2 John']]);
    assert.deepEqual(read('요14:8'), [[43, 'John 14:8']], 'a digit right after "요1" is part of the chapter');
    assert.deepEqual(read('요1:1'), [[43, 'John 1:1']]);
    assert.deepEqual(read('요 3:16'), [[43, 'John 3:16']]);
    assert.deepEqual(read('요한복음 17:3; 요한 1서 4:19'), [[43, 'John 17:3'], [62, '1 John 4:19']]);
    assert.throws(() => parseReferences('요한 1서', { lang: 'KO' }), /has no chapter/);
  });
});

describe('", ftn." citations from study notes', () => {
  it('reads "Eph 4:11, ftn." as the verse, flagged, with a note', () => {
    const [eph] = parseReferences('Eph 4:11, ftn.');
    assert.equal(eph.reference, 'Ephesians 4:11');
    assert.equal(eph.footnote, true);
    assert.match(eph.notes.join(' '), /"ftn\." \(jw\.org's "see the footnote"\) after Ephesians 4:11 was read as that verse/);
    assert.equal(parseReferences('2Ti 4:5, ftn.')[0].reference, '2 Timothy 4:5');
  });

  it('reads a ";" list that mixes them, and a bare "; ftn." part', () => {
    assert.deepEqual(parseReferences('Ac 21:8; Eph 4:11, ftn.; 2Ti 4:5, ftn.').map((r) => [r.reference, Boolean(r.footnote)]), [
      ['Acts 21:8', false],
      ['Ephesians 4:11', true],
      ['2 Timothy 4:5', true]
    ]);
    assert.deepEqual(parseReferences('2Pe 1:13; ftn.').map((r) => r.reference), ['2 Peter 1:13']);
    assert.deepEqual(parseReferences('Job 4:18, ftn.; 33:23, ftn.').map((r) => r.reference), ['Job 4:18', 'Job 33:23']);
    assert.throws(() => parseReferences('ftn.'), /Invalid "reference"/);
  });

  it('gives numbered books the specific hint, and names a translation only for a translation', () => {
    assert.throws(() => parseReferences('1 Cor 13:4 NIV'), (e) => /Drop "NIV" after "1 Cor 13:4".*New World Translation/.test(e.hint));
    assert.throws(() => parseReferences('John 3:16 hello'), (e) => /Drop "hello" after "John 3:16"/.test(e.hint) && !/New World/.test(e.hint));
    assert.throws(() => parseReferences('John 3:16, KJV'), (e) => /Drop ", KJV".*New World Translation/.test(e.hint));
  });
});

describe('verse sent with reference', () => {
  const refs = (args) => referencesFromArgs(args).map((r) => r.reference);

  it('picks verses of a whole-chapter reference', () => {
    assert.deepEqual(refs({ reference: 'Psalm 83', verse: '18' }), ['Psalm 83:18']);
    assert.deepEqual(refs({ reference: 'Jude', verse: '25' }), ['Jude 25']);
    assert.equal(referencesFromArgs({ reference: 'Psalm 83', verse: '0' })[0].verseSpec, '0');
    assert.deepEqual(refs({ reference: 'Psalm 83:18', verse: '18' }), ['Psalm 83:18'], 'the same verses agree');
    assert.deepEqual(refs({ reference: 'Psalm 83:18', verse: 18 }), ['Psalm 83:18']);
  });

  it('rejects verses that disagree with the reference, as for book and chapter', () => {
    for (const args of [{ reference: 'Psalm 83:18', verse: '1' }, { reference: 'Psalm 83:18', verse: '0' }, { reference: 'Psalm 83-84', verse: '1' }, { reference: 'Psalm 83; John 3', verse: '1' }]) {
      assert.throws(() => referencesFromArgs(args), (e) => e.name === 'ArgError' && /disagrees with verse/.test(e.message) && /whole chapter in "reference"/.test(e.hint), JSON.stringify(args));
    }
    assert.throws(() => referencesFromArgs({ reference: 'Psalm 83', verse: '99' }), /no verse 99/);
  });

  it('get_bible_verse_url applies it too', async () => {
    const out = json(await getBibleVerseURLImplementation({ reference: 'Psalm 83', verse: '18' }));
    assert.equal(out.reference, 'Psalm 83:18');
    assert.equal(out.url, `${FINDER}19083018&pub=nwtsty`);
  });
});
