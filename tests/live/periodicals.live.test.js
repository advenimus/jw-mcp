// Live checks of the workbook and Watchtower tools against JW.org (about 20
// requests; listings are cached in-process). Skipped unless JW_MCP_LIVE=1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens } from '../../src/tools/results.js';
import { issueForDate } from '../../src/tools/rtf-utils.js';
import { handleWorkbookTools } from '../../src/tools/workbook-tools.js';
import { handleWatchtowerTools } from '../../src/tools/watchtower-tools.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';

async function call(handler, name, args) {
  const result = await handler({ params: { name, arguments: args } });
  const text = result.content[0].text;
  return { result, text, json: result.isError ? null : JSON.parse(text) };
}

const day = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

describe('issue rules match the real listings', { skip }, () => {
  const issues = [
    ['mwb', handleWorkbookTools, 'getWorkbookLinks', 'weekFiles', ['20251100', '20260300', '20260700', '20260900', '20261100']],
    ['w', handleWatchtowerTools, 'getWatchtowerLinks', 'articles', ['20251200', '20260700', '20260800', '20261000']]
  ];
  for (const [pub, handler, tool, key, list] of issues) {
    for (const issue of list) {
      it(`${pub} ${issue}: every dated week maps back to its issue`, async () => {
        const { result, text, json } = await call(handler, tool, { issue });
        assert.equal(result.isError, undefined, text);
        const weeks = json[key].filter((e) => e.week_start);
        assert.ok(weeks.length >= 4, `${weeks.length} weeks`);
        for (const w of weeks) {
          assert.equal(issueForDate(pub, day(w.week_start)), issue, `${w.title}`);
          assert.equal(day(w.week_start).getDay(), 1, `${w.title} starts on a Monday`);
        }
        for (const e of json[key]) {
          assert.equal(e.filesize, undefined);
          assert.doesNotMatch(e.title, /&nbsp;| |​|Download All Files/);
        }
        assert.doesNotMatch(json.formattedDate, /&nbsp;/);
      });
    }
  }

  const dates = [
    ['w', '2026-10-02', '20260700', '2026-09-28'],
    ['w', '2026-10-05', '20260800', '2026-10-05'],
    ['w', '2027-01-03', '20261000', '2026-12-28'],
    ['mwb', '2027-01-03', '20261100', '2026-12-28'],
    ['mwb', '2026-09-01', '20260700', '2026-08-31'],
    ['mwb', '2026-10-11', '20260900', '2026-10-05']
  ];
  for (const [pub, date, issue, monday] of dates) {
    it(`${pub} ${date} -> ${issue}, week of ${monday}`, async () => {
      const [handler, tool] = pub === 'mwb' ? [handleWorkbookTools, 'getWorkbookLinks'] : [handleWatchtowerTools, 'getWatchtowerLinks'];
      const { text, json } = await call(handler, tool, { date });
      assert.ok(json, text);
      assert.equal(json.issue, issue);
      assert.equal(json.current_week?.week_start, monday);
      assert.equal(json.current_week?.is_current_week, true);
    });
  }

  it('marks the Memorial schedule as other and has no week for Memorial week', async () => {
    const { json } = await call(handleWorkbookTools, 'getWorkbookLinks', { date: '2026-04-01' });
    assert.equal(json.issue, '20260300');
    assert.equal(json.current_week, null);
    assert.ok(json.weekFiles.some((e) => e.type === 'other'));
    assert.match(json.note, /Memorial/);
    const content = await call(handleWorkbookTools, 'getWorkbookContent', { date: '2026-04-01' });
    assert.equal(content.result.isError, true);
    assert.match(content.text, /Memorial/);
    assert.match(content.text, /url https:\/\/\S+\/mwb_E_202603_04\.rtf/);
  });
});

describe('one-call content', { skip }, () => {
  it('returns this week\'s workbook with no arguments', async () => {
    const { result, text, json } = await call(handleWorkbookTools, 'getWorkbookContent', undefined);
    assert.equal(result.isError, undefined, text);
    const start = day(json.week_start);
    const today = new Date();
    assert.ok(start <= today && today - start < 7 * 24 * 3600 * 1000, `${json.week_start} is this week`);
    assert.equal(json.fileformat, 'RTF');
    assert.ok(json.parsedText.length > 2000);
  });

  it('returns the Watchtower study for a date', async () => {
    const { json, text } = await call(handleWatchtowerTools, 'getWatchtowerContent', { date: '2026-10-02' });
    assert.ok(json, text);
    assert.equal(json.week_start, '2026-09-28');
    assert.equal(json.issue, '20260700');
    assert.match(json.url, /^https:\/\/cfp2\.jw-cdn\.org\/.*w_E_202607_04\.rtf$/);
    assert.ok(json.parsedText.length > 2000);

    // The same file read by url (cached in-process) has a title and the same week.
    const byUrl = await call(handleWatchtowerTools, 'getWatchtowerContent', { url: json.url });
    assert.match(byUrl.json.title, /\S/);
    assert.equal(byUrl.json.week_start, '2026-09-28');
    assert.equal(byUrl.json.track, undefined);
  });

  it('reads Japanese, which has TXT but no RTF', async () => {
    const { json, text } = await call(handleWorkbookTools, 'getWorkbookContent', { langwritten: 'J', date: '2026-10-11' });
    assert.ok(json, text);
    assert.equal(json.fileformat, 'TXT');
    assert.equal(json.week_start, '2026-10-05');
    assert.match(json.title, /10月5/);
    assert.doesNotMatch(json.parsedText, /^﻿|\r/);
  });
});

describe('errors', { skip }, () => {
  it('says an issue is not published', async () => {
    const { result, text } = await call(handleWorkbookTools, 'getWorkbookLinks', { issue: '20300100' });
    assert.equal(result.isError, true);
    assert.match(text, /issue 20300100 is not on JW\.org/);
  });

  it('lists the formats a language offers when it has no RTF or TXT', async () => {
    const { result, text } = await call(handleWorkbookTools, 'getWorkbookContent', { langwritten: 'CHS', date: '2026-10-11' });
    assert.equal(result.isError, true);
    assert.match(text, /not as RTF or TXT; available formats: .*PDF/);
  });
});

describe('formats, old issues and long files', { skip }, () => {
  it('lists the ASL workbook as MP4 videos with their resolution', async () => {
    const { result, text, json } = await call(handleWorkbookTools, 'getWorkbookLinks', { langwritten: 'ASL', issue: '20260900', fileformat: 'MP4' });
    assert.equal(result.isError, undefined, text);
    assert.equal(json.fileformat, 'MP4');
    assert.ok(json.weekFiles.length > 4);
    assert.ok(json.weekFiles.every((f) => /\.mp4$/.test(f.url)));
    assert.ok(json.weekFiles.some((f) => f.week && /^\d+p$/.test(f.resolution)));
  });

  it('reads the January 15, 2015 study edition by its 1.3.3 issue code', async () => {
    const { result, text, json } = await call(handleWatchtowerTools, 'getWatchtowerLinks', { issue: '20150115' });
    assert.equal(result.isError, undefined, text);
    const studies = json.articles.filter((a) => a.type === 'study');
    assert.ok(studies.length >= 4, `${studies.length} studies`);
    assert.equal(studies[0].week_start, '2015-03-02');
  });

  it('pages a whole book read by url, each page within the token budget', async () => {
    const links = await call(handleWorkbookTools, 'getWorkbookLinks', { pub: 'nwt', fileformat: 'RTF' });
    const psalms = links.json.weekFiles.find((f) => /nwt_19_Ps_E\.rtf$/.test(f.url));
    assert.ok(psalms, 'the Psalms file is listed');
    const first = await call(handleWorkbookTools, 'getWorkbookContent', { url: psalms.url });
    assert.equal(first.result.isError, undefined, first.text);
    assert.notEqual(first.json.next_offset, null);
    const second = await call(handleWorkbookTools, 'getWorkbookContent', { url: psalms.url, offset: first.json.next_offset });
    for (const page of [first, second]) {
      assert.ok(page.text.length < 80000, `${page.text.length} characters`);
      assert.ok(estimateTokens(page.text) <= 22000, `about ${estimateTokens(page.text)} tokens`);
    }
  });
});
