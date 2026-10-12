// Offline tests for the RTF parser. Fixtures are short synthetic RTF snippets
// shaped like JW.org's WTS5 exports; none of them come from a real file.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanAndFormatText, parseRTF, rtfToText } from '../../src/tools/rtf-parser.js';

const rtf = (body) => `{\\rtf1\\ansi\\uc1 ${body}}`;
const words = (s) => s.split(/\s+/).filter(Boolean).join(' ');

const snippets = {
  references: rtf(String.raw`They fled to Egypt.\u8212?Jeremiah 42:1\u8211?43:7; 2 Kings 25:23-26.\par`),
  numberedBooks: rtf(String.raw`Pray often.\u8212?Matthew 7:7, 8; 1 Thessalonians 5:17.\par He was impressed. (1 Samuel 18:5) In time, though.\par`),
  questions: rtf(String.raw`Question 1. Whom must we fight? (Ephesians 6:11, 12)\par 1 We do not fight. (Read Ephesians 6:11, 12.) How can we succeed? Rely on Jehovah.\par Question 6-7. In what ways can we help?\par`),
  spanish: rtf(String.raw`2. \u191?Por qu\u233? lo hicieron? Jerem\u237?as cap\u237?tulo 44 vers\u237?culo 18. \u191?Por qu\u233? no?\par Canci\u243?n\u160?129 Servimos con aguante\par Me bautic\u233? en 1996.\par`),
  quote: rtf(String.raw`Try asking: \u8220?Did you know that\u160?...\u160??\u8221? or \u8220?Have you heard that?\u8221? 5. Following Up\par`),
  numbers: rtf(String.raw`deported in the summer of 607 B.C.E. This son of Kareah\par It cost $1.50 in 2025. About 8.7 million.\par Insight \u8220?Johanan\u8221? Number 5\par Visit the McDonald Family Farm today.\par`),
  pubRefs: rtf(String.raw`Ask yourself.\u8212?w25.07 5 paragraph 14.\par jr 189 paragraph 16\par Study article for October 5-11\par`),
  renames: rtf(String.raw`Song 103 and Prayer\par Study Article 33\par Song\u160?47\u160?\par The apostle Matthew wrote Matthew 24:14; see 1 Corinthians 13:4,footnote and 2 Corinthians 5:7.\par`),
  softWrap: rtf(String.raw`{God communicates.\u8212?2 Timothy 3:16, 17; 2\u160?Pet.}\line{ 1:20, 21.\par}`),
};

describe('parseRTF keeps the published text', () => {
  it('never adds words: parseRTF and rtfToText have the same word sequence', () => {
    for (const [name, source] of Object.entries(snippets)) {
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
    // No line is a stray fragment of a reference ("16-", "23.").
    assert.deepEqual(lines.filter((l) => /^[\d:,;.\-–\s]+\)?\.?$/.test(l) && l), []);
  });

  it('keeps song and study-article numbers and book names as printed', () => {
    assert.equal(
      parseRTF(snippets.renames),
      'Song 103 and Prayer\nStudy Article 33\nSong 47\nThe apostle Matthew wrote Matthew 24:14; see 1 Corinthians 13:4,footnote and 2 Corinthians 5:7.'
    );
  });

  it('joins a print-layout line wrap (\\line) with a space', () => {
    assert.equal(parseRTF(snippets.softWrap), 'God communicates.—2 Timothy 3:16, 17; 2 Pet. 1:20, 21.');
  });
});

describe('cleanAndFormatText', () => {
  it('only normalizes whitespace and strips invisible characters', () => {
    assert.equal(cleanAndFormatText(''), '');
    assert.equal(cleanAndFormatText(null), '');
    assert.equal(
      cleanAndFormatText('  Song 103 \t and­ Prayer\r\n\r\n\r\n\u0007Opening﻿ Comments (1 minute)  '),
      'Song 103 and Prayer\n\nOpening Comments (1 minute)'
    );
  });
});

describe('parseRTF input checks', () => {
  it('rejects empty input and non-RTF text', () => {
    assert.throws(() => parseRTF(''), /non-empty string/);
    assert.throws(() => parseRTF('<!DOCTYPE html><html></html>'), /must start with/);
  });
});
