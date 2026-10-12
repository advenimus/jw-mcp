// Live checks of the RTF parser on current JW.org workbook weeks and Watchtower
// study articles in English, Spanish and Russian (12 requests). Skipped unless
// JW_MCP_LIVE=1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchBuffer, fetchJson } from '../../src/tools/http.js';
import { parseRTF, parseRTFDocument, rtfToText } from '../../src/tools/rtf-parser.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';

// The Sep-Oct 2026 workbook and the August 2026 study edition cover October 2026.
const ISSUES = { mwb: '20260900', w: '20260800' };
const SONG = { E: /\bSong \d+/g, S: /\bCanción \d+/g, U: /Песня \d+/g };

async function rtfFile(pub, lang, pick) {
  const api = `https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?pub=${pub}&issue=${ISSUES[pub]}&langwritten=${lang}&fileformat=RTF&output=json`;
  const data = await fetchJson(api);
  const files = data.files?.[lang]?.RTF ?? [];
  const file = files.find((f) => pick.test(f.file.url));
  assert.ok(file, `no ${pick} RTF in ${api}`);
  return { url: file.file.url, bytes: await fetchBuffer(file.file.url) };
}

function checkFaithful(bytes, doc) {
  const { text } = doc;
  const raw = rtfToText(bytes);
  const words = (s) => s.split(/\s+/).filter(Boolean).join(' ');
  assert.equal(words(text), words(raw.replace(/\u00AD/g, '')), 'parseRTF must keep the words of rtfToText');
  assert.equal(parseRTF(bytes.toString('utf8')), text, 'string and Buffer input agree');
  assert.ok(text.length > 2000, `text too short: ${text.length}`);
  assert.ok(text.length < bytes.length * 0.4, `text ${text.length} vs RTF ${bytes.length}`);
  assert.equal(/Your answer/i.test(text), /Your answer/i.test(bytes.toString('latin1')));
  assert.doesNotMatch(text, /[\x00-\x08\x0B-\x1F\x7F-\x9F\u00AD\uE000-\uF8FF]/, 'no control, soft hyphen or private-use characters');
  assert.doesNotMatch(text, /\n\n\n/);
  const lines = text.split('\n');
  assert.deepEqual(lines.filter((l) => /^[\d:,;.\-–—\s]+\)?\.?$/.test(l) && l), [], 'no orphan number lines');
  assert.deepEqual(lines.filter((l) => /\d[:\-–]$/.test(l)), [], 'no reference split at end of line');
  assert.ok(doc.title && lines[0].includes(doc.title.slice(0, 10)), `title "${doc.title}" vs first line "${lines[0]}"`);
  for (const heading of doc.headings) {
    const i = lines.indexOf(heading);
    assert.ok(i >= 0, `heading "${heading}" is its own line`);
    assert.ok(i === 0 || lines[i - 1] === '' || doc.headings.includes(lines[i - 1]), `blank line before "${heading}"`);
  }
  const urls = doc.links.map((l) => l.url);
  assert.equal(new Set(urls).size, urls.length, 'links are unique');
  for (const link of doc.links) {
    assert.match(link.url, /^https:\/\/www\.jw\.org\//);
    assert.doesNotMatch(link.url, /[?&]bible=|srcid=/);
    assert.ok(link.text);
  }
  return lines;
}

describe('RTF parser on live workbook weeks', { skip }, () => {
  for (const lang of ['E', 'S', 'U']) {
    it(`mwb ${lang}`, async () => {
      const { url, bytes } = await rtfFile('mwb', lang, /_05\.rtf$/);
      const doc = parseRTFDocument(bytes);
      checkFaithful(bytes, doc);
      assert.equal((doc.text.match(SONG[lang]) || []).length, 3, `3 song numbers in ${url}`);
      assert.ok(doc.headings.length >= 12, `${doc.headings.length} headings in ${url}`);
      assert.equal(doc.headings.filter((h) => /^\d\. /.test(h)).length, 8, 'eight numbered parts');
      assert.ok(doc.links.filter((l) => /lank=pub-sjjm_/.test(l.url)).length >= 3, 'song video links');
      assert.ok(doc.links.some((l) => /docid=/.test(l.url)), 'publication links');
    });
  }
});

describe('RTF parser on live Watchtower study articles', { skip }, () => {
  for (const lang of ['E', 'S', 'U']) {
    it(`w ${lang}`, async () => {
      const { url, bytes } = await rtfFile('w', lang, /_02\.rtf$/);
      const doc = parseRTFDocument(bytes);
      const lines = checkFaithful(bytes, doc);
      assert.equal((doc.text.match(SONG[lang]) || []).length, 2, `opening and closing song in ${url}`);
      assert.ok(doc.headings.length >= 3, `${doc.headings.length} headings in ${url}`);
      assert.ok(lines.filter((l) => /^\d{1,2} \S/.test(l)).length >= 15, 'numbered paragraphs start lines');
      assert.ok(lines.filter((l) => l.startsWith('• ')).length >= 3, 'review questions keep their bullets');
    });
  }
});
