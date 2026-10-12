// Live checks for get_bible_verse and get_verse_with_study against jw.org and
// wol.jw.org (about 46 requests). Skipped unless JW_MCP_LIVE=1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleScriptureTools } from '../../src/tools/scripture-tools.js';
import { clearBookNames } from '../../src/tools/bible-books.js';
import { clearBibleCache } from '../../src/tools/bible-api.js';
import { MAX_RESULT_TOKENS, estimateTokens } from '../../src/tools/results.js';
import { handleWolTools } from '../../src/tools/wol-tools.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';

async function ok(name, args) {
  const result = await handleScriptureTools({ params: { name, arguments: args } });
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe('get_bible_verse (live)', { skip }, () => {
  it('reads "Juan 3:16" with langwritten S in a fresh state', async () => {
    clearBookNames();
    clearBibleCache();
    const out = await ok('get_bible_verse', { reference: 'Juan 3:16', langwritten: 'S' });
    assert.equal(out.reference, 'Juan 3:16');
    assert.match(out.text, /Porque Dios amó tanto al mundo/);
  });

  it('Psalm 83:18 comes back whole, both poetic lines, without numbers or markers', async () => {
    const out = await ok('get_bible_verse', { reference: 'Psalm 83:18' });
    assert.equal(out.reference, 'Psalm 83:18');
    assert.match(out.text, /^May people know that you, whose name is Jehovah,/);
    assert.match(out.text, /You alone are the Most High over all the earth\.$/);
    assert.doesNotMatch(out.text, /[+*]/);
  });

  it('Psalm 3:1 includes the superscription', async () => {
    const out = await ok('get_bible_verse', { book: 19, chapter: 3, verse: 1 });
    assert.match(out.text, /^O Jehovah, why have my adversaries become so numerous\?/);
    assert.match(out.superscription, /^A melody of David when he was fleeing from his son Ab/);
  });

  it('Psalm 83:1 returns its lines, its footnote with the words it explains, and the superscription', async () => {
    const out = await ok('get_bible_verse', { reference: 'Ps 83:1' });
    assert.equal(out.text, 'O God, do not be silent;\nDo not keep quiet or still, O Divine One.');
    assert.equal(out.footnotes.length, 1);
    assert.equal(out.footnotes[0].note, 'Or “keep speechless.”');
    assert.ok(out.footnotes[0].phrase, JSON.stringify(out.footnotes));
    assert.match(out.superscription, /^A song\. A melody of A/);
  });

  it('a second verse of the same chapter needs no new request, and both read the whole chapter id', async () => {
    const real = globalThis.fetch;
    const seen = [];
    globalThis.fetch = (url, init) => {
      seen.push(String(url));
      return real(url, init);
    };
    try {
      await ok('get_bible_verse', { book: 14, chapter: 6, verse: 2 });
      await ok('get_bible_verse', { book: 14, chapter: 6, verse: 3 });
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(seen, ['https://www.jw.org/en/library/bible/study-bible/books/json/data/14006000-14006999']);
  });

  it('reads French "Éz 1:1" as Ezekiel on the first French call', async () => {
    const out = await ok('get_bible_verse_url', { reference: 'Éz 1:1', langwritten: 'F' });
    assert.match(out.url, /bible=26001001/);
  });

  it('reads a Chinese "；" list', async () => {
    const out = await ok('get_bible_verse', { reference: '约3:13；诗90:2', langwritten: 'CHS' });
    assert.equal(out.passages_count, 2);
  });

  it('accepts book, chapter and verse sent as strings', async () => {
    const out = await ok('get_bible_verse', { book: '43', chapter: '3', verse: '16' });
    assert.equal(out.reference, 'John 3:16');
    assert.match(out.text, /^“For God loved the world so much that he gave his only-begotten Son,/);
  });

  it('Matthew 17:21 is flagged as left out of the NWT', async () => {
    const out = await ok('get_bible_verse', { reference: 'Matt. 17:21' });
    assert.equal(out.omitted, true);
    assert.equal(out.text, '');
    assert.match(out.note, /earliest and most reliable manuscripts/);
  });

  it('John 8:7 is explained as part of John 7:53–8:11', async () => {
    const out = await ok('get_bible_verse', { reference: 'John 8:7' });
    assert.equal(out.omitted, true);
    assert.match(out.note, /John 7:53–8:11 is left out of the NWT/);
  });

  it('Revelation 21:3-4 returns both verses', async () => {
    const out = await ok('get_bible_verse', { reference: 'Rev. 21:3-4' });
    assert.equal(out.reference, 'Revelation 21:3, 4');
    assert.equal(out.verses, undefined, 'no footnotes: text alone carries both verses');
    assert.match(out.text, /^3 With that I heard a loud voice from the throne say/);
    assert.match(out.text, / 4 And he will wipe out every tear from their eyes,/);
  });

  it('John 3:16 in Spanish', async () => {
    const out = await ok('get_bible_verse', { reference: 'John 3:16', langwritten: 'S' });
    assert.equal(out.reference, 'Juan 3:16');
    assert.equal(out.book_name, 'Juan');
    assert.match(out.text, /Porque Dios amó tanto al mundo que entregó a su Hijo unigénito/);
    assert.match(out.url, /wtlocale=S/);
  });

  it('Chinese and Japanese text has no pinyin or furigana and no space inside a line', async () => {
    const chs = await ok('get_bible_verse', { reference: 'John 3:16', langwritten: 'CHS' });
    assert.match(chs.text, /^“上帝深爱世人/);
    assert.doesNotMatch(chs.text, /[A-Za-zàáǎèéěìíǐòóǒùúǔ]/);
    // A psalm keeps its poetic lines.
    const ja = await ok('get_bible_verse', { reference: 'Ps. 83:18', langwritten: 'J' });
    assert.match(ja.text, /^人々があなたのことを知りますように。\nエホバという名/);
    assert.doesNotMatch(ja.text, / /);
  });

  it('reads a verse\'s cross references as one ";" list', async () => {
    const out = await ok('get_bible_verse', { reference: 'Luke 10:25-28; Acts 17:26, 27; 1 John 5:20' });
    assert.equal(out.passages_count, 3);
    for (const p of out.passages) assert.ok(p.text && !p.error, JSON.stringify(p));
  });
});

describe('get_verse_with_study (live)', { skip }, () => {
  it('John 17:3 has its study note, six cross-reference targets and the chapter outline', async () => {
    const out = await ok('get_verse_with_study', {
      reference: 'John 17:3',
      fields: ['verses', 'study_notes', 'cross_references', 'chapter_level']
    });
    assert.equal(out.has_study_notes, true);
    assert.ok(out.study_notes['3'].some((n) => n.term === 'their coming to know you'), JSON.stringify(out.study_notes));
    const targets = out.cross_references.flatMap((c) => c.targets);
    assert.equal(targets.length, 6);
    assert.ok(targets.includes('Luke 10:25-28'));
    assert.ok(out.chapter_level.outline.some((o) => o.text.includes('(17:1-26)')));
  });

  it('Matthew 24:14 has separate study notes and Research Guide articles with citations', async () => {
    const out = await ok('get_verse_with_study', { reference: 'Matthew 24:14', fields: ['study_notes', 'study_articles'] });
    assert.ok(out.study_notes['14'].length >= 5, JSON.stringify(out.study_notes));
    assert.ok(out.study_notes['14'].every((n) => n.term && n.note));
    assert.equal(out.study_articles.length, 5);
    assert.ok(out.study_articles_total > 5);
    for (const a of out.study_articles) {
      assert.ok(a.title && a.source, JSON.stringify(a));
      assert.match(a.url, /^https:\/\/wol\.jw\.org\/en\/wol\/pc\//);
    }
    const keys = out.study_articles.map((a) => `${a.title}|${a.source}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(out.study_articles.some((a) => a.publication === 'The Watchtower'));
  });

  it('Spanish study notes have their terms', async () => {
    const out = await ok('get_verse_with_study', { reference: 'John 3:16', langwritten: 'es', fields: ['study_notes'] });
    assert.deepEqual(out.study_notes['16'].map((n) => n.term), ['amó', 'al mundo', 'Hijo unigénito', 'que demuestre tener fe en él']);
    assert.equal(out.study_notes_count, 4);
  });

  it('Spanish Research Guide entries are whole citations with their publication', async () => {
    const out = await ok('get_verse_with_study', { reference: 'John 3:16', langwritten: 'es', fields: ['study_articles'], limit: 0 });
    assert.ok(out.study_articles.length > 10);
    for (const a of out.study_articles) {
      assert.doesNotMatch(a.title, /^[\d\s,-]+$/, a.title);
      assert.ok(a.publication, JSON.stringify(a));
    }
    assert.equal(new Set(out.study_articles.map((a) => a.url)).size, out.study_articles.length);
  });

  it('a long passage with every field stays within the client output limit', async () => {
    const fields = ['verses', 'study_notes', 'study_articles', 'cross_references', 'chapter_level', 'combined_text', 'footnotes', 'chapter_articles'];
    const result = await handleScriptureTools({ params: { name: 'get_verse_with_study', arguments: { reference: 'John 1:1-30', fields, limit: 0 } } });
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.ok(estimateTokens(result.content[0].text) <= MAX_RESULT_TOKENS, `about ${estimateTokens(result.content[0].text)} tokens`);
    assert.match(JSON.parse(result.content[0].text).note, /Shortened/);
    // 60 verses of John 1-2 with every field are too long even without the articles: an error that says how to split.
    const tooLong = await handleScriptureTools({ params: { name: 'get_verse_with_study', arguments: { reference: 'John 1:1-2:9', fields, limit: 0 } } });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0].text, /too long for one result \(about \d+ tokens\)\.\nNext step: Ask for fewer verses/);
  });

  it('Matthew 26 with every field and limit 100 stays within the token budget', async () => {
    const fields = ['verses', 'study_notes', 'study_articles', 'cross_references', 'chapter_level', 'combined_text', 'footnotes', 'chapter_articles'];
    const result = await handleScriptureTools({ params: { name: 'get_verse_with_study', arguments: { reference: 'Matthew 26', fields, limit: 100 } } });
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.ok(estimateTokens(result.content[0].text) <= MAX_RESULT_TOKENS, `about ${estimateTokens(result.content[0].text)} tokens`);
  });

  it('a link-heavy Research Guide page read with max_chars 80000 stays within the token budget', async () => {
    const result = await handleWolTools({ params: { name: 'read_wol_document', arguments: { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1200029055', max_chars: 80000 } } });
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.ok(estimateTokens(result.content[0].text) <= MAX_RESULT_TOKENS, `about ${estimateTokens(result.content[0].text)} tokens`);
    assert.notEqual(JSON.parse(result.content[0].text).next_offset, null);
  });

  it('Psalm 119 has letter headings, not a superscription', async () => {
    const out = await ok('get_bible_verse', { reference: 'Psalm 119:9-10' });
    assert.match(out.text, /^ב \[Beth\] 9 /);
    const zero = await handleScriptureTools({ params: { name: 'get_bible_verse', arguments: { reference: 'Psalm 119:0' } } });
    assert.equal(zero.isError, true);
    assert.match(zero.content[0].text, /has no superscription/);
  });

  it('pronunciation_marks: false gives the names as the workbook prints them', async () => {
    const out = await ok('get_bible_verse', { reference: 'Jeremiah 42:1', pronunciation_marks: false });
    assert.match(out.text, /Johanan the son of Kareah, Jezaniah the son of Hoshaiah/);
  });

  it('John 17:3 keeps one cross-reference group per phrase', async () => {
    const out = await ok('get_verse_with_study', { reference: 'John 17:3', fields: ['cross_references'] });
    assert.equal(out.cross_references.length, 3);
    const acts = out.cross_references.find((x) => x.targets.some((t) => /^Acts 17:26/.test(t)));
    assert.equal(acts.phrase, 'the only true God');
    assert.equal(out.cross_references_count, out.cross_references.reduce((n, x) => n + x.targets.length, 0));
  });

  it('Japanese Research Guide citations keep the issue day on every page link', async () => {
    const out = await ok('get_verse_with_study', { reference: 'Matthew 24:14', fields: ['study_articles'], langwritten: 'J', limit: 100 });
    assert.ok(out.study_articles.length > 5);
    for (const a of out.study_articles) assert.doesNotMatch(a.title, /\d+\/\d+\/ \d/, a.title);
  });

  it('Genesis 1:1 says the book has no study notes', async () => {
    const out = await ok('get_verse_with_study', { book: 1, chapter: 1, verse: '1' });
    assert.equal(out.verses[0].text, 'In the beginning God created the heavens and the earth.');
    assert.equal(out.has_study_notes, false);
    assert.match(out.note, /no study notes for Genesis/);
  });

  it('John 8:7 returns the study note on John 7:52 that explains the omission', async () => {
    const out = await ok('get_verse_with_study', { reference: 'John 8:7' });
    assert.equal(out.omitted, true);
    assert.equal(out.explanation.reference, 'John 7:52');
    assert.ok(out.explanation.study_notes.some((n) => /earliest authoritative manuscripts/.test(n.note)), JSON.stringify(out.explanation));
  });
});

describe('round 4 scripture fixes (live)', { skip }, () => {
  it('lists John 17:3\'s cross references in the order of their markers', async () => {
    const out = await ok('get_verse_with_study', { reference: 'John 17:3', fields: ['cross_references'] });
    assert.deepEqual(out.cross_references.map((x) => x.phrase), ['This means everlasting life', 'the only true God', 'Jesus Christ']);
  });

  it('reads back every Arabic and Korean cross-reference target the tool returns', async () => {
    for (const lang of ['A', 'KO']) {
      const out = await ok('get_verse_with_study', { reference: 'John 3:16', langwritten: lang, fields: ['cross_references'] });
      const targets = out.cross_references.flatMap((x) => x.targets);
      assert.ok(targets.length >= 5, `${lang}: ${targets.length} targets`);
      const links = await ok('get_bible_verse_url', { reference: targets.join('; '), langwritten: lang });
      assert.equal(links.reference.split('; ').length, targets.length, `${lang}: ${links.reference}`);
    }
  });

  it('reads the study notes\' ", ftn." citations', async () => {
    const out = await ok('get_bible_verse', { reference: 'Ac 21:8; Eph 4:11, ftn.; 2Ti 4:5, ftn.' });
    assert.equal(out.passages_count, 3);
    assert.ok(out.passages.every((p) => !p.error), JSON.stringify(out.passages.map((p) => p.error)));
    assert.match(out.passages[1].note, /"ftn\."/);
  });
});
