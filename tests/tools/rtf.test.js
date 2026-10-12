// Offline tests for the RTF parser. Fixtures are short synthetic RTF snippets
// shaped like JW.org's WTS5 exports; none of them come from a real file.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { cleanAndFormatText, parseRTF, parseRTFDocument, rtfToText } from '../../src/tools/rtf-parser.js';
import { ToolError, wrapTool } from '../../src/tools/results.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async (url) => {
    throw new Error(`offline test tried to fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const rtf = (body, head = '') => `{\\rtf1\\ansi\\uc1${head} ${body}}`;
const words = (s) => s.split(/\s+/).filter(Boolean).join(' ');

// A workbook-like week: Title and Heading 1 styles with WTS5's numbering,
// a song link split into a no-break space, a soft line break and fields.
const STYLES = String.raw`{\stylesheet {\s2\ltrpar\qc\f0\fs36\b \sbasedon0\snext21 Title;}{\s4\ltrpar\qc\f2\b \sbasedon0\snext25 Heading 1;}}`;
const WEEK = rtf(String.raw`{\info{\upr{\*\ud{\title \u77?\u97?\u121?\u160?\u53?\u45?\u49?\u49?}}}}`
  + String.raw`\pard\plain \ltrpar\s2\qc {\f0 May 5-11 (Proverbs 12)\par}`
  + String.raw`\pard\plain \ltrpar\ql {\field{\*\fldinst {HYPERLINK "https://www.jw.org/finder?srcid=share&wtlocale=E&lank=pub-sjjm_603_VIDEO" }}{\fldrslt{\cs3\ul Song\u160?103}}}{ and Prayer\par}{Opening Comments (1 minute)\par}\par`
  + String.raw`\pard\plain \ltrpar\s2\qc {Treasures From God\u8217?s Word\par}`
  + String.raw`\pard\plain \ltrpar\s4\qc {1. Listen to Counsel (10 minutes)\par}`
  + String.raw`\pard\plain \ltrpar\ql {They fled.\u8212?Jeremiah 42:1\u8211?43:7; 2 Kings 25:23-26.\par}`
  + String.raw`{Ask yourself.\u8212?}{\field{\*\fldinst {HYPERLINK "https://www.jw.org/finder?wtlocale=E&docid=1102018451&srcid=share" }}{\fldrslt{\ul w25.07 }}}{\field{\*\fldinst {HYPERLINK "https://www.jw.org/finder?wtlocale=E&docid=1102018451&srcid=share" }}{\fldrslt{\ul 5 paragraph\u160?14}}}{.\par}`
  + String.raw`{God communicates.\u8212?2 Timothy 3:16, 17; 2\u160?Pet.}\line{ 1:20, 21.\par}`
  + String.raw`{\field{\*\fldinst {HYPERLINK "https://www.jw.org/finder?wtlocale=E&prefer=lang&bible=43003016&pub=nwtsty" }}{\fldrslt{\ul John 3:16}}}{ is quoted.\par}`
  + String.raw`\pard\plain \ltrpar\s4\qc {2. Spiritual Gems (10 minutes)\par}`
  + String.raw`\pard\plain \ltrpar\ql {What is the point? Rely on Jehovah.\par}`
  + String.raw`\pard\plain \ltrpar\s2\qc {Living as Christians\par}`
  + String.raw`\pard\plain \ltrpar\s4\qc {7. Local Needs (15 minutes)\par 8. Congregation Bible Study (30 minutes)\par}`
  + String.raw`\pard\plain \ltrpar\ql {Song\u160?47 and Prayer\par}`,
String.raw`{\fonttbl{\f0\fcharset0 Times New Roman;}{\f2\fcharset0 Arial;}}` + STYLES);

// A Watchtower-like article: Heading 1 is \s10 here, review questions use
// JW's private-use bullet.
const ARTICLE = rtf(String.raw`\pard\plain \ltrpar\s2 {October 12-18, 2026: Stand Firm!\par}\pard\plain \ltrpar\ql \par`
  + String.raw`{Song 55 Fear Them Not!\par}\par`
  + String.raw`{Question 1. Whom must we all fight against? (Ephesians 6:11, 12)\par}`
  + String.raw`{1 As servants of Jehovah, we do not fight. (Read Ephesians 6:11, 12.) How can we succeed? Above all, rely on Jehovah.\par}`
  + String.raw`\pard\plain \ltrpar\s10 {Satan Tries to Divide Us\par}`
  + String.raw`\pard\plain \ltrpar\ql {2 Saul was impressed. (1 Samuel 18:5) In time, though, Saul was jealous.\u8212?Matthew 5:43, 44; 1 Corinthians 13:4.\par}\par`
  + String.raw`{[Box] How Would You Answer?\par}{\f2\cf12 \u-3062?}{ How does Satan divide us?\par}{\f2\cf12 \u-3062?}{ Why stand firm? [End of box]\par}`,
String.raw`{\stylesheet {\s2\ltrpar Title;}{\s10\ltrpar\b Heading 1;}{\*\cs3 Hyperlink;}}`);

describe('parseRTF keeps the published text', () => {
  const snippets = {
    references: rtf(String.raw`They fled to Egypt.\u8212?Jeremiah 42:1\u8211?43:7; 2 Kings 25:23-26.\par`),
    numberedBooks: rtf(String.raw`Pray often.\u8212?Matthew 7:7, 8; 1 Thessalonians 5:17.\par He was impressed. (1 Samuel 18:5) In time, though.\par`),
    questions: rtf(String.raw`Question 1. Whom must we fight? (Ephesians 6:11, 12)\par 1 We do not fight. (Read Ephesians 6:11, 12.) How can we succeed? Rely on Jehovah.\par Question 6-7. In what ways can we help?\par`),
    spanish: rtf(String.raw`2. \u191?Por qu\u233? lo hicieron? Jerem\u237?as cap\u237?tulo 44 vers\u237?culo 18. \u191?Por qu\u233? no?\par Canci\u243?n\u160?129 Servimos con aguante\par Me bautic\u233? en 1996.\par`),
    russian: rtf(String.raw`\u1048?\u1077?\u1088?\u1077?\u1084?\u1080?\u1103? 44:18. \u1055?\u1086?\u1095?\u1077?\u1084?\u1091? \u1090?\u1072?\u1082??\par`),
    quote: rtf(String.raw`Try asking: \u8220?Did you know that\u160?...\u160??\u8221? or \u8220?Have you heard that?\u8221? 5. Following Up\par`),
    numbers: rtf(String.raw`deported in the summer of 607 B.C.E. This son of Kareah\par It cost $1.50 in 2025. About 8.7 million.\par Insight \u8220?Johanan\u8221? Number 5\par Visit the McDonald Family Farm today.\par`),
    pubRefs: rtf(String.raw`Ask yourself.\u8212?w25.07 5 paragraph 14.\par jr 189 paragraph 16\par Study article for October 5-11\par`),
    renames: rtf(String.raw`Song 103 and Prayer\par Study Article 33\par Song\u160?47\u160?\par The apostle Matthew wrote Matthew 24:14; see 1 Corinthians 13:4,footnote and 2 Corinthians 5:7.\par`),
  };

  it('never adds words: parseRTF and rtfToText have the same word sequence', () => {
    for (const [name, source] of Object.entries({ ...snippets, WEEK, ARTICLE })) {
      const text = parseRTF(source);
      assert.equal(words(text), words(rtfToText(source)), name);
      assert.doesNotMatch(text, /Your answer/, name);
    }
  });

  it('keeps every reference, number and date on its own line, unchanged', () => {
    const lines = Object.values(snippets).flatMap((s) => parseRTF(s).split('\n'));
    for (const expected of [
      'They fled to Egypt.—Jeremiah 42:1–43:7; 2 Kings 25:23-26.',
      'Pray often.—Matthew 7:7, 8; 1 Thessalonians 5:17.',
      'He was impressed. (1 Samuel 18:5) In time, though.',
      'Question 1. Whom must we fight? (Ephesians 6:11, 12)',
      '1 We do not fight. (Read Ephesians 6:11, 12.) How can we succeed? Rely on Jehovah.',
      'Question 6-7. In what ways can we help?',
      '2. ¿Por qué lo hicieron? Jeremías capítulo 44 versículo 18. ¿Por qué no?',
      'Canción 129 Servimos con aguante',
      'Me bauticé en 1996.',
      'Иеремия 44:18. Почему так?',
      'Try asking: “Did you know that ... ?” or “Have you heard that?” 5. Following Up',
      'deported in the summer of 607 B.C.E. This son of Kareah',
      'It cost $1.50 in 2025. About 8.7 million.',
      'Insight “Johanan” Number 5',
      'Visit the McDonald Family Farm today.',
      'Ask yourself.—w25.07 5 paragraph 14.',
      'jr 189 paragraph 16',
      'Study article for October 5-11',
    ]) {
      assert.ok(lines.includes(expected), `missing line: ${expected}`);
    }
    assert.deepEqual(lines.filter((l) => /^[\d:,;.\-–\s]+\)?\.?$/.test(l) && l), []);
  });

  it('keeps song and study-article numbers and book names as printed', () => {
    assert.equal(
      parseRTF(snippets.renames),
      'Song 103 and Prayer\nStudy Article 33\nSong 47\nThe apostle Matthew wrote Matthew 24:14; see 1 Corinthians 13:4,footnote and 2 Corinthians 5:7.'
    );
  });

  it('formats a workbook week: one line per paragraph, blank line before each heading block', () => {
    assert.equal(parseRTF(WEEK), [
      'May 5-11 (Proverbs 12)',
      'Song 103 and Prayer',
      'Opening Comments (1 minute)',
      '',
      'Treasures From God’s Word',
      '1. Listen to Counsel (10 minutes)',
      'They fled.—Jeremiah 42:1–43:7; 2 Kings 25:23-26.',
      'Ask yourself.—w25.07 5 paragraph 14.',
      'God communicates.—2 Timothy 3:16, 17; 2 Pet. 1:20, 21.',
      'John 3:16 is quoted.',
      '',
      '2. Spiritual Gems (10 minutes)',
      'What is the point? Rely on Jehovah.',
      '',
      'Living as Christians',
      '7. Local Needs (15 minutes)',
      '8. Congregation Bible Study (30 minutes)',
      'Song 47 and Prayer',
    ].join('\n'));
  });

  it('formats a Watchtower article: headings by style name, real bullets, empty paragraphs as one blank line', () => {
    assert.equal(parseRTF(ARTICLE), [
      'October 12-18, 2026: Stand Firm!',
      '',
      'Song 55 Fear Them Not!',
      '',
      'Question 1. Whom must we all fight against? (Ephesians 6:11, 12)',
      '1 As servants of Jehovah, we do not fight. (Read Ephesians 6:11, 12.) How can we succeed? Above all, rely on Jehovah.',
      '',
      'Satan Tries to Divide Us',
      '2 Saul was impressed. (1 Samuel 18:5) In time, though, Saul was jealous.—Matthew 5:43, 44; 1 Corinthians 13:4.',
      '',
      '[Box] How Would You Answer?',
      '• How does Satan divide us?',
      '• Why stand firm? [End of box]',
    ].join('\n'));
  });

  it('treats \\outlinelevel and Heading N styles as headings, and resets the style at \\pard', () => {
    const source = rtf(String.raw`Intro\par\pard\outlinelevel1 Part A\par\pard Body A\par{\s7 Part B\par}Body B\par`,
      String.raw`{\stylesheet{\s7\outlinelevel0 Kop 1;}}`);
    assert.equal(parseRTF(source), 'Intro\n\nPart A\nBody A\n\nPart B\nBody B');
    assert.deepEqual(parseRTFDocument(source).headings, ['Part A', 'Part B']);
  });
});

describe('RTF features', () => {
  it('turns \\line soft breaks into a space', () => {
    assert.equal(parseRTF(rtf(String.raw`2 Timothy 3:16, 17; 2\u160?Pet.\line 1:20, 21.\par`)), '2 Timothy 3:16, 17; 2 Pet. 1:20, 21.');
  });

  it('maps symbol-font bullets and keeps other private-use characters', () => {
    assert.equal(parseRTF(rtf(String.raw`{\f2 \u-3062?} One\par{\f3 \u-3913?} Two\par Letter \u-8191?x\par`)), '• One\n• Two\nLetter \uE001x');
  });

  it('skips pictures, including nested groups and \\bin data, without losing text or brace balance', () => {
    assert.equal(parseRTF(rtf(String.raw`A{\pict{\*\picprop x}\pngblip 89504e470d0a}B{\*\shppict{\pict\pngblip\bin2 ZZ}}C{\nonshppict{\pict 00ff}}D\par`)), 'ABCD');
    const bin = Buffer.concat([Buffer.from(String.raw`{\rtf1 A{\*\shppict{\pict\pngblip\bin4 `), Buffer.from([0x7D, 0x7B, 0xFF, 0x5C]), Buffer.from(String.raw`}}B\par}`)]);
    assert.equal(parseRTF(bin), 'AB');
  });

  it('keeps link text, drops form fields and lists useful links once', () => {
    const doc = parseRTFDocument(WEEK);
    assert.doesNotMatch(doc.text, /https?:|HYPERLINK/);
    assert.deepEqual(doc.links, [
      { text: 'Song 103', url: 'https://www.jw.org/finder?wtlocale=E&lank=pub-sjjm_603_VIDEO' },
      { text: 'w25.07 5 paragraph 14', url: 'https://www.jw.org/finder?wtlocale=E&docid=1102018451' },
    ]);
    const all = parseRTFDocument(WEEK, { bibleLinks: true }).links;
    assert.deepEqual(all.at(-1), { text: 'John 3:16', url: 'https://www.jw.org/finder?wtlocale=E&prefer=lang&bible=43003016&pub=nwtsty' });
  });

  it('handles fldinst without a space and keeps each link separate', () => {
    const source = rtf(String.raw`See {\field{\*\fldinst{HYPERLINK "https://www.jw.org/a"}}{\fldrslt{\ul one}}} and {\field{\*\fldinst{HYPERLINK "https://www.jw.org/b"}}{\fldrslt{\ul two}}} end.\par`);
    const doc = parseRTFDocument(source);
    assert.equal(doc.text, 'See one and two end.');
    assert.deepEqual(doc.links.map((l) => l.url), ['https://www.jw.org/a', 'https://www.jw.org/b']);
  });

  it('drops interactive form-field placeholders cleanly', () => {
    const source = rtf(String.raw`What did you learn? {\field{\*\fldinst {FORMTEXT {\*\formfield{\fftype0\ffname Text1}}}}{\fldrslt {\u8194?\u8194?\u8194?\u8194?\u8194?}}}\par Next {\field{\*\fldinst FORMCHECKBOX }{\fldrslt }}item\par`);
    assert.equal(parseRTF(source), 'What did you learn?\nNext item');
  });

  it('removes soft hyphens, hidden text and empty field results', () => {
    assert.equal(parseRTF(rtf(String.raw`Jeho\-vah and Jeho\u173?vah\par Visible {\v hidden note} text, {\v0 shown}\par`)), 'Jehovah and Jehovah\nVisible text, shown');
  });

  it('keeps list numbers and joins table cells', () => {
    assert.equal(parseRTF(rtf(String.raw`{\listtext 1.\tab}First item\par{\listtext 2.\tab}Second item\par`)), '1. First item\n2. Second item');
    assert.equal(
      parseRTF(rtf(String.raw`\trowd\cellx1000\cellx2000 Week\cell Reading\cell\row\trowd\cellx1000\cellx2000 Oct 12\cell Jer 42\cell\row\trowd\cell\cell\row\pard After\par`)),
      'Week | Reading\nOct 12 | Jer 42\nAfter'
    );
  });

  it('decodes \\\'xx bytes with the declared code page and font charset', () => {
    assert.equal(parseRTF(rtf(String.raw`\'93Hello\'94 caf\'e9 \'97 wait\'85\par`, '\\ansicpg1252')), '“Hello” café — wait…');
    const fonts = String.raw`{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset128 MS Mincho;}{\f2\fcharset204 Arial Cyr;}}`;
    assert.equal(parseRTF(rtf(String.raw`{\f1 \'93\'fa\'82\'a0}{\f2  \'cf\'f0\'e8}{\f0  \'93ok\'94}\par`, '\\ansicpg1252' + fonts)), '日あ При “ok”');
    // Any label that means windows-1252 maps 0x80-0x9F the same way.
    assert.equal(rtfToText(rtf(String.raw`\'93x\'94\par`), 'latin1'), '“x”');
    // Raw 8-bit bytes in a Buffer use the code page too.
    const raw = Buffer.concat([Buffer.from('{\\rtf1\\ansi\\ansicpg1251 '), Buffer.from([0xCF, 0xF0, 0xE8]), Buffer.from('\\par}')]);
    assert.equal(parseRTF(raw), 'При');
  });

  it('handles \\uc skip counts and surrogate pairs', () => {
    assert.equal(parseRTF(rtf(String.raw`{\uc2 \u8220\'93\'93Hi\u8221??}\u-10179?\u-8704? ok\par`)), '“Hi”😀 ok');
  });

  it('reads the document title from \\info', () => {
    assert.equal(parseRTFDocument(WEEK).title, 'May 5-11');
    assert.equal(parseRTFDocument(rtf('No info\\par')).title, null);
  });

  it('accepts a BOM, a Buffer and an ArrayBuffer', () => {
    const source = rtf('Hello\\par');
    assert.equal(parseRTF('\uFEFF' + source), 'Hello');
    const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(source)]);
    assert.equal(parseRTF(bytes), 'Hello');
    assert.equal(parseRTF(new Uint8Array(bytes).buffer), 'Hello');
  });

  it('survives truncated or unbalanced input', () => {
    assert.equal(parseRTF('{\\rtf1 Cut off {\\b mid'), 'Cut off mid');
    assert.equal(parseRTF('{\\rtf1 Done\\par} trailing junk'), 'Done');
    assert.equal(parseRTF('{\\rtf1 Done\\par}} more}'), 'Done');
  });
});

describe('errors', () => {
  it('rejects input that is not RTF with a ToolError and a next step', () => {
    for (const [input, pattern] of [
      ['<!DOCTYPE html><html><body>Not found</body></html>', /HTML or XML page/],
      ['Hello world', /text starting "Hello world"/],
      ['   ', /empty/],
      [null, /string or Buffer/],
      [42, /string or Buffer/],
    ]) {
      assert.throws(() => parseRTF(input), (err) => err instanceof ToolError && pattern.test(err.message) && /getWorkbookLinks/.test(err.hint));
    }
  });

  it('reports an RTF file without text instead of returning nothing', () => {
    assert.throws(() => parseRTF('{\\rtf1{\\fonttbl{\\f0 Arial;}}\\par}'), (err) => err instanceof ToolError && /no readable text/.test(err.message));
  });

  it('becomes an isError result inside wrapTool', async () => {
    const tool = wrapTool(async () => parseRTF('<html></html>'), 'getWorkbookContent');
    const result = await tool();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Invalid RTF format.*\nNext step: /s);
  });
});

describe('rtfToText and cleanAndFormatText', () => {
  it('rtfToText keeps empty paragraphs and raw spacing', () => {
    assert.equal(rtfToText(rtf(String.raw`A\u160?B\par\par C\tab D\par`)), 'A\u00A0B\n\nC\tD');
  });

  it('cleanAndFormatText only normalizes whitespace and invisible characters', () => {
    assert.equal(cleanAndFormatText(' Song\u00A0103 \u00ADand\tPrayer \r\n\n\n\n 1.\u0007 Matthew 5:3 \uFEFF'), 'Song 103 and Prayer\n\n1. Matthew 5:3');
    assert.equal(cleanAndFormatText(''), '');
    assert.equal(cleanAndFormatText(null), '');
  });
});

describe('nested fields', () => {
  it('keeps the outer four links of deeply nested fields and the text once', () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://www.jw.org/finder?docid=${i + 1}`);
    const body = urls.map((u) => `{\\field{\\*\\fldinst HYPERLINK "${u}"}{\\fldrslt `).join('') + 'deep text' + '}}'.repeat(6) + '\\par';
    const doc = parseRTFDocument(rtf(body));
    assert.equal(doc.text, 'deep text');
    assert.deepEqual(doc.links.map((l) => l.url), [urls[3], urls[2], urls[1], urls[0]]);
    assert.ok(doc.links.every((l) => l.text === 'deep text'));
  });

  it('parses thousands of nested fields in linear time', () => {
    const big = '{\\rtf1\\ansi ' +
      '{\\field{\\*\\fldinst HYPERLINK "https://www.jw.org/finder?docid=1"}{\\fldrslt '.repeat(3000) +
      'a\\par '.repeat(20000) + '}}'.repeat(3000) + '}';
    const start = performance.now();
    const doc = parseRTFDocument(big);
    const ms = performance.now() - start;
    assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
    assert.ok(doc.text.startsWith('a\na'));
  });
});
