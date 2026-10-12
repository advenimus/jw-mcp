// Offline tests for the workbook (mwb) and Watchtower (w) tools. Every
// request goes to a stubbed globalThis.fetch that mimics the pub-media API and
// the CDN with small synthetic fixtures.

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Short timeouts for the stalled-download test; read when http.js loads.
process.env.JW_MCP_FETCH_TIMEOUT_MS = '400';

const {
  clearPeriodicalCaches,
  decodeTitle,
  issueForDate,
  mondayOf,
  normalizeIssue,
  parseWeekRange
} = await import('../../src/tools/rtf-utils.js');
const { formatIsoDate } = await import('../../src/tools/args.js');
const { clearLanguageCache } = await import('../../src/tools/languages.js');
const { estimateTokens } = await import('../../src/tools/results.js');
const { handleWorkbookTools, workbookTools } = await import('../../src/tools/workbook-tools.js');
const { handleWatchtowerTools, watchtowerTools } = await import('../../src/tools/watchtower-tools.js');

const realFetch = globalThis.fetch;
let calls;

// ---------------------------------------------------------------------------
// Synthetic JW.org

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const day = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

// "October 5-11" / "September 28–October 4"
function enRange(startIso) {
  const start = day(startIso);
  const end = addDays(start, 6);
  const sm = MONTHS[start.getMonth()];
  return start.getMonth() === end.getMonth()
    ? `${sm} ${start.getDate()}-${end.getDate()}`
    : `${sm} ${start.getDate()}–${MONTHS[end.getMonth()]} ${end.getDate()}`;
}

const cdn = (name) => `https://cfp2.jw-cdn.org/a/0f${name.length}/1/o/${name}`;

function file(title, name, track, { mimetype, docid = 0, label = '0p' } = {}) {
  const ext = name.split('.').pop();
  const type = mimetype ?? { rtf: 'application/rtf', txt: 'text/plain', zip: 'application/zip', mp3: 'audio/mpeg', pdf: 'application/pdf', mp4: 'video/mp4', '3gp': 'video/3gpp' }[ext];
  return {
    title,
    file: { url: cdn(name), stream: 'https://jw.org', modifiedDatetime: '2026-01-01 00:00:00', checksum: 'abc' },
    filesize: 1234,
    track,
    docid,
    label,
    mimetype: type
  };
}

function weekly(pub, lang, issue, mondays, { ext = 'rtf', title = (m) => `${enRange(m)} (Sample Book 1-2)` } = {}) {
  return mondays.map((m, i) => file(title(m), `${pub}_${lang}_${issue}_${String(i).padStart(2, '0')}.${ext}`, i));
}

function mondaysFrom(startIso, count) {
  return Array.from({ length: count }, (_, i) => formatIsoDate(addDays(day(startIso), 7 * i)));
}

function audio(pub, lang, issue, mondays, firstTrack = 1, docBase = 900) {
  return mondays.map((m, i) =>
    file(`${enRange(m).replace('-', '-​')}`, `${pub}_${lang}_${issue}_${String(i + firstTrack).padStart(2, '0')}.mp3`, i + firstTrack, {
      docid: docBase + i
    })
  );
}

function listingBody({ pub, lang = 'E', issue, files, pubName, formattedDate, languageName = 'English', locale }) {
  return { pubName, parentPubName: '', pub, issue, formattedDate, languages: { [lang]: { name: languageName, ...(locale && { locale }) } }, files: { [lang]: files } };
}

// A sign-language issue: a video per week in two resolutions, no RTF or TXT.
function signLanguage(pub, issue, mondays) {
  const videos = (label) => mondays.map((m, i) => file(enRange(m), `${pub}_ASL_${issue}_${String(i + 1).padStart(2, '0')}_r${label}.mp4`, i + 1, { label }));
  return {
    JWPUB: [file('Sample', `${pub}_ASL_${issue}.jwpub`, 0, { mimetype: 'application/octet-stream' })],
    MP4: [...videos('240p'), ...videos('720p'), file('References', `${pub}_ASL_${issue}_99_r240P.mp4`, 99, { label: '240p' })],
    '3GP': mondays.map((m, i) => file('Video', `${pub}_ASL_${issue}_${String(i + 1).padStart(2, '0')}.3gp`, i + 1, { label: '144p' }))
  };
}

const mwb202609 = mondaysFrom('2026-09-07', 8);
const mwb202611 = mondaysFrom('2026-11-02', 9);
const mwb202607 = mondaysFrom('2026-07-06', 9);
const w202607 = mondaysFrom('2026-09-07', 4);
const w202608 = mondaysFrom('2026-10-05', 4);
const w202610 = mondaysFrom('2026-12-07', 3);

const LISTINGS = {
  'mwb:E:202609': listingBody({
    pub: 'mwb',
    issue: '202609',
    pubName: 'Sample Meeting Workbook',
    formattedDate: 'September–October&nbsp;2026',
    files: {
      PDF: [file('Regular', 'mwb_E_202609.pdf', 0)],
      RTF: [file('Download All Files (ZIP)', 'mwb_E_202609.rtf.zip', 0), ...weekly('mwb', 'E', '202609', mwb202609)],
      MP3: audio('mwb', 'E', '202609', mwb202609),
      BRL: [
        file('Download All Files (ZIP)', 'mwb_f-BR1_E_202609.brl.zip', 0),
        file('Download All Files (ZIP)', 'mwb_f-BR2_E_202609.brl.zip', 0),
        file('Volume 1', 'mwb_f-BR1_E_202609_01.brl', 1, { mimetype: 'application/octet-stream' })
      ]
    }
  }),
  'mwb:E:202611': listingBody({
    pub: 'mwb',
    issue: '202611',
    pubName: 'Sample Meeting Workbook',
    formattedDate: 'November–December 2026',
    files: { RTF: [file('Download All Files (ZIP)', 'mwb_E_202611.rtf.zip', 0), ...weekly('mwb', 'E', '202611', mwb202611)] }
  }),
  // Ends a week early, so the week of Aug 31 is only in the next issue (safety-net test).
  'mwb:E:202607': listingBody({
    pub: 'mwb',
    issue: '202607',
    pubName: 'Sample Meeting Workbook',
    formattedDate: 'July–August 2026',
    files: { RTF: weekly('mwb', 'E', '202607', mwb202607.slice(0, 8)) }
  }),
  // The Memorial week (March 30) has no meeting; the reading schedule sits between the weeks.
  // The audio tracks start at 1, so they do not line up with the text files' tracks.
  'mwb:E:202603': listingBody({
    pub: 'mwb',
    issue: '202603',
    pubName: 'Sample Meeting Workbook',
    formattedDate: 'March–April 2026',
    files: {
      RTF: [
        ...weekly('mwb', 'E', '202603', mondaysFrom('2026-03-02', 4)),
        file('2026 Memorial Reading Schedule', 'mwb_E_202603_04.rtf', 4),
        ...weekly('mwb', 'E', '202603', mondaysFrom('2026-04-06', 4)).map((f, i) => ({ ...f, track: 5 + i }))
      ],
      MP3: audio('mwb', 'E', '202603', [...mondaysFrom('2026-03-02', 4), ...mondaysFrom('2026-04-06', 4)])
    }
  }),
  // Numbered TXT titles ("ファイル N") and no audio: dates and the schedule's title come from English.
  'mwb:J:202603': listingBody({
    pub: 'mwb',
    lang: 'J',
    issue: '202603',
    pubName: 'ワークブック',
    formattedDate: '2026年3月–4月',
    languageName: '日本語',
    files: { TXT: Array.from({ length: 9 }, (_, i) => file(`ファイル ${i}`, `mwb_J_202603_${String(i).padStart(2, '0')}.txt`, i)) }
  }),
  // A TXT-only language with numbered titles; dates come from the audio titles.
  'mwb:J:202609': listingBody({
    pub: 'mwb',
    lang: 'J',
    issue: '202609',
    pubName: 'ワークブック',
    formattedDate: '2026年9月–10月',
    languageName: '日本語',
    files: {
      PDF: [file('Regular', 'mwb_J_202609.pdf', 0)],
      TXT: [
        file('すべてのファイルをダウンロード（ZIP）', 'mwb_J_202609.txt.zip', 0),
        ...weekly('mwb', 'J', '202609', mwb202609, { ext: 'txt', title: (m) => `ファイル ${mwb202609.indexOf(m)}` })
      ],
      MP3: mwb202609.map((m, i) => {
        const s = day(m);
        const e = addDays(s, 6);
        const t = s.getMonth() === e.getMonth() ? `${s.getMonth() + 1}月${s.getDate()}-${e.getDate()}日` : `${s.getMonth() + 1}月${s.getDate()}日-${e.getMonth() + 1}月${e.getDate()}日`;
        return file(t, `mwb_J_202609_${String(i + 1).padStart(2, '0')}.mp3`, i + 1, { docid: 900 + i });
      })
    }
  }),
  // Numbered TXT titles and no audio: dates come from the English edition.
  'mwb:KO:202609': listingBody({
    pub: 'mwb',
    lang: 'KO',
    issue: '202609',
    pubName: '집회 교재',
    formattedDate: '2026년 9-10월',
    languageName: '한국어',
    files: { TXT: weekly('mwb', 'KO', '202609', mwb202609, { ext: 'txt', title: (m) => `기사 ${mwb202609.indexOf(m)}` }) }
  }),
  // Only audio and PDF: nothing the content tools can read.
  'mwb:CHS:202609': listingBody({
    pub: 'mwb',
    lang: 'CHS',
    issue: '202609',
    pubName: '聚会手册',
    formattedDate: '2026年9月－10月',
    languageName: '中文简体',
    files: { PDF: [file('Regular', 'mwb_CHS_202609.pdf', 0)], MP3: audio('mwb', 'CHS', '202609', mwb202609) }
  }),
  'w:E:202607': listingBody({
    pub: 'w',
    issue: '202607',
    pubName: 'Sample Watchtower (Study)',
    formattedDate: 'July&nbsp;2026',
    files: {
      RTF: [
        file('Download All Files (ZIP)', 'w_E_202607.rtf.zip', 0),
        file('In This Issue', 'w_E_202607_00.rtf', 0),
        ...w202607.map((m, i) => file(`${enRange(m)}, 2026: Sample Study ${i + 1}`, `w_E_202607_0${i + 1}.rtf`, i + 1)),
        file('Life Story—Sample', 'w_E_202607_05.rtf', 5)
      ]
    }
  }),
  'w:E:202608': listingBody({
    pub: 'w',
    issue: '202608',
    pubName: 'Sample Watchtower (Study)',
    formattedDate: 'August&nbsp;2026',
    files: {
      RTF: [
        file('Download All Files (ZIP)', 'w_E_202608.rtf.zip', 0),
        file('In This Issue', 'w_E_202608_00.rtf', 0),
        ...w202608.map((m, i) => file(`${enRange(m)}, 2026: Sample Study ${i + 1}`, `w_E_202608_0${i + 1}.rtf`, i + 1)),
        file('Did You Know?', 'w_E_202608_05.rtf', 5)
      ],
      MP3: [
        ...w202608.map((m, i) => file(`Sample Study ${i + 1} (${enRange(m)})`, `w_E_202608_0${i + 1}.mp3`, i + 1, { docid: 700 + i })),
        file('Did You Know?', 'w_E_202608_05.mp3', 5, { docid: 799 })
      ]
    }
  }),
  // A non-study article at track 1, studies at tracks 2-5, one crossing the year.
  'w:E:202610': listingBody({
    pub: 'w',
    issue: '202610',
    pubName: 'Sample Watchtower (Study)',
    formattedDate: 'October 2026',
    files: {
      RTF: [
        file('In This Issue', 'w_E_202610_00.rtf', 0),
        file('1926—One Hundred Years Ago', 'w_E_202610_01.rtf', 1),
        ...w202610.map((m, i) => file(`${enRange(m)}, 2026: Sample Study ${i + 1}`, `w_E_202610_0${i + 2}.rtf`, i + 2)),
        file('December 28, 2026–January 3, 2027: Sample Study 4', 'w_E_202610_05.rtf', 5)
      ]
    }
  }),
  'mwb:ASL:202609': listingBody({
    pub: 'mwb',
    lang: 'ASL',
    issue: '202609',
    pubName: 'Sample Workbook (ASL)',
    formattedDate: 'September–October 2026',
    languageName: 'American Sign Language',
    files: signLanguage('mwb', '202609', ['2026-09-07', '2026-09-14'])
  }),
  'w:ASL:202608': listingBody({
    pub: 'w',
    lang: 'ASL',
    issue: '202608',
    pubName: 'Sample Watchtower (ASL)',
    formattedDate: 'August 2026',
    languageName: 'American Sign Language',
    files: signLanguage('w', '202608', ['2026-10-05', '2026-10-12'])
  }),
  // Before 2016 the study edition is dated the 15th; its studies are in month M+2.
  'w:E:20150115': listingBody({
    pub: 'w',
    issue: '20150115',
    pubName: 'Sample Watchtower (Study)',
    formattedDate: 'January 15, 2015',
    files: {
      RTF: [
        file('Study Articles', 'w_E_20150115_01.rtf', 1),
        ...mondaysFrom('2015-03-02', 4).map((m, i) => file(`Sample Study ${i + 1} (${enRange(m)})`, `w_E_20150115_0${i + 2}.rtf`, i + 2))
      ]
    }
  }),
  // A language outside the built-in table, with Swedish month names.
  'w:Z:202608': listingBody({
    pub: 'w',
    lang: 'Z',
    issue: '202608',
    pubName: 'Sample Vakttornet',
    formattedDate: 'augusti 2026',
    languageName: 'svenska',
    locale: 'sv',
    files: { RTF: [file('5–11 oktober 2026: Exempel', 'w_Z_202608_01.rtf', 1)] }
  }),
  // A whole book through the hidden pub argument: far more files than an issue.
  'nwt:E:': listingBody({
    pub: 'nwt',
    issue: '',
    pubName: 'Sample Bible',
    formattedDate: '',
    files: { RTF: Array.from({ length: 1500 }, (_, i) => file(`Chapter ${i + 1}`, `nwt_E_${i + 1}.rtf`, i + 1)) }
  }),
  'es26:E:': listingBody({
    pub: 'es26',
    issue: '',
    pubName: 'Sample Daily Text 2026',
    formattedDate: '',
    files: { RTF: [file('Download All Files (ZIP)', 'es26_E.rtf.zip', 0), file('January', 'es26_E_01.rtf', 1)] }
  })
};

const SAMPLE_RTF = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\pard Sample week heading\\par\\pard Opening comments (1 min.)\\par}';
const FILES = new Map();
for (const listing of Object.values(LISTINGS)) {
  for (const list of Object.values(Object.values(listing.files)[0])) {
    for (const f of list) {
      if (f.file.url.endsWith('.rtf')) FILES.set(f.file.url, () => body(SAMPLE_RTF, 'application/rtf'));
      if (f.file.url.endsWith('.txt')) FILES.set(f.file.url, () => body('﻿１０月５‐１１日\r\nサンプル   \r\n\r\n\r\n\r\n     開会の言葉\r\n', 'text/plain'));
    }
  }
}

function body(text, type, init = {}) {
  return new Response(text, { status: 200, headers: { 'content-type': type }, ...init });
}

function notFound() {
  return new Response(JSON.stringify([{ title: 'Not Found', status: 404 }]), { status: 404, statusText: 'Not Found' });
}

// Mimics GETPUBMEDIALINKS: only the requested formats come back, and a
// request matching none of them is a 404.
function pubMedia(url) {
  const p = url.searchParams;
  const issue = (p.get('issue') ?? '').replace(/00$/, '');
  const data = LISTINGS[`${p.get('pub')}:${p.get('langwritten').toUpperCase()}:${issue}`];
  if (!data) return notFound();
  const lang = Object.keys(data.files)[0];
  const wanted = p.get('fileformat')?.split(',').map((f) => f.toUpperCase());
  const files = Object.fromEntries(Object.entries(data.files[lang]).filter(([f]) => !wanted || wanted.includes(f)));
  if (!Object.keys(files).length) return notFound();
  return body(JSON.stringify({ ...data, files: { [lang]: files } }), 'application/json');
}

function jwOrg(extra = {}) {
  return (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (extra[url.href]) return extra[url.href](url, init);
    if (url.hostname === 'b.jw-cdn.org' && url.pathname.endsWith('GETPUBMEDIALINKS')) return pubMedia(url);
    if (FILES.has(url.href)) return FILES.get(url.href)();
    return new Response('<Error>AccessDenied</Error>', { status: 403, statusText: 'Forbidden' });
  };
}

function useFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
}

beforeEach(() => {
  calls = [];
  clearPeriodicalCaches();
  globalThis.fetch = async (url) => {
    throw new Error(`offline test tried to fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

async function call(handler, name, args) {
  const result = await handler({ params: { name, arguments: args } });
  assert.ok(result, `${name} returned null`);
  const text = result.content[0].text;
  return { result, text, json: result.isError ? null : JSON.parse(text) };
}
const workbook = (name, args) => call(handleWorkbookTools, name, args);
const watchtower = (name, args) => call(handleWatchtowerTools, name, args);
const pubMediaCalls = () => calls.filter((u) => u.includes('GETPUBMEDIALINKS')).map((u) => new URL(u).searchParams);

// ---------------------------------------------------------------------------

describe('issueForDate', () => {
  const cases = [
    ['2026-10-02', 'w', '20260700'],
    ['2026-10-05', 'w', '20260800'],
    ['2027-01-03', 'w', '20261000'],
    ['2027-01-04', 'w', '20261100'],
    ['2026-03-01', 'w', '20251200'],
    ['2027-01-03', 'mwb', '20261100'],
    ['2027-01-01', 'mwb', '20261100'],
    ['2027-01-04', 'mwb', '20270100'],
    ['2026-09-01', 'mwb', '20260700'],
    ['2026-09-07', 'mwb', '20260900'],
    ['2026-10-11', 'mwb', '20260900'],
    ['2026-11-01', 'mwb', '20260900'],
    ['2026-12-15', 'mwb', '20261100'],
    ['2020-12-29', 'mwb', '20201200'],
    ['2026-10-11', 'es26', null]
  ];
  for (const [date, pub, issue] of cases) {
    it(`${pub} ${date} -> ${issue}`, () => assert.equal(issueForDate(pub, day(date)), issue));
  }

  it('2026-10-11 is in the week of Oct 5-11', () => {
    assert.equal(formatIsoDate(mondayOf(day('2026-10-11'))), '2026-10-05');
    assert.equal(formatIsoDate(mondayOf(day('2026-03-08'))), '2026-03-02'); // DST starts that day
  });

  it('every day of 2026-2027 maps to an odd-month workbook issue that starts on or before its Monday', () => {
    for (let d = day('2026-01-01'); d < day('2028-01-01'); d = addDays(d, 1)) {
      const issue = issueForDate('mwb', d);
      const month = Number(issue.slice(4, 6));
      assert.equal(month % 2, 1, `${formatIsoDate(d)} -> ${issue}`);
      const monday = mondayOf(d);
      const issueStart = new Date(Number(issue.slice(0, 4)), month - 1, 1);
      const months = (monday.getFullYear() - issueStart.getFullYear()) * 12 + monday.getMonth() - issueStart.getMonth();
      assert.ok(months === 0 || months === 1, `${formatIsoDate(d)}: Monday ${formatIsoDate(monday)} vs ${issue}`);
      const wIssue = issueForDate('w', d);
      const wStart = new Date(Number(wIssue.slice(0, 4)), Number(wIssue.slice(4, 6)) - 1 + 2, 1);
      assert.equal(monday.getMonth(), wStart.getMonth(), `${formatIsoDate(d)} -> w ${wIssue}`);
    }
  });
});

describe('normalizeIssue', () => {
  it('accepts YYYYMM00, YYYYMM, YYYY-MM and numbers', () => {
    assert.deepEqual(normalizeIssue('20260900', 'mwb'), { issue: '20260900', note: null });
    assert.equal(normalizeIssue('202609', 'mwb').issue, '20260900');
    assert.equal(normalizeIssue(' 2026-09 ', 'mwb').issue, '20260900');
    assert.equal(normalizeIssue(20260800, 'w').issue, '20260800');
    assert.equal(normalizeIssue(undefined, 'w').issue, null);
    assert.equal(normalizeIssue('', 'w').issue, null);
  });

  it('reads an even-month workbook issue as the odd issue containing it, with a note', () => {
    const r = normalizeIssue('20261000', 'mwb');
    assert.equal(r.issue, '20260900');
    assert.match(r.note, /bimonthly/);
    assert.equal(normalizeIssue('20201200', 'mwb').issue, '20201200'); // monthly before 2021
    assert.equal(normalizeIssue('20261000', 'w').issue, '20261000');
  });

  it('rejects other shapes with a message naming the format', () => {
    for (const bad of ['2026-10-11', 'September 2026', '20261300', '2026091', 'abc', {}]) {
      assert.throws(() => normalizeIssue(bad, 'mwb'), (e) => e.name === 'ArgError' && /YYYYMM00/.test(e.message) && /odd months/.test(e.message), String(bad));
    }
    assert.throws(() => normalizeIssue('2026-10-11', 'mwb'), (e) => /as "date"/.test(e.hint));
  });
});

describe('parseWeekRange', () => {
  const near = (iso) => ({ reference: day(iso) });
  const range = (title, opts) => {
    const r = parseWeekRange(title, opts);
    return r && `${formatIsoDate(r.start)}..${formatIsoDate(r.end)}`;
  };

  it('reads English workbook and Watchtower title formats', () => {
    assert.equal(range('October 5-11 (Book 40-41)', near('2026-10-01')), '2026-10-05..2026-10-11');
    assert.equal(range('September 28–October 4 (Book 38-39)', near('2026-10-01')), '2026-09-28..2026-10-04');
    assert.equal(range('December 28–January 3 (Book 9-10)', near('2026-12-01')), '2026-12-28..2027-01-03');
    assert.equal(range('October 26–November 1, 2026: Sample Title', near('2026-10-15')), '2026-10-26..2026-11-01');
    assert.equal(range('December 28, 2026–January 3, 2027: Sample', near('2026-12-15')), '2026-12-28..2027-01-03');
    assert.equal(range('Sample Title in Old Format (January 5-11)', near('2026-01-15')), '2026-01-05..2026-01-11');
    assert.equal(range('Sample Title (October 26—November 1)', near('2026-10-15')), '2026-10-26..2026-11-01');
    assert.equal(range('May Our Sample Grow (May 4-10)', near('2026-05-15')), '2026-05-04..2026-05-10');
  });

  it('reads other languages', () => {
    const cases = [
      ['es', '5 al 11 de octubre de 2026: Título de muestra', '2026-10-05..2026-10-11'],
      ['es', '26 de octubre a 1 de noviembre (Libro 47, 48)', '2026-10-26..2026-11-01'],
      ['pt', '26 de outubro a 1.º de novembro (Livro 47 a 48)', '2026-10-26..2026-11-01'],
      ['fr', '26 octobre – premier novembre (Livre 47-48)', '2026-10-26..2026-11-01'],
      ['fr', '26 octobre - 1er novembre', '2026-10-26..2026-11-01'],
      ['de', '26. Oktober bis 1. November 2026: Beispiel', '2026-10-26..2026-11-01'],
      ['de', '5.-11. Oktober', '2026-10-05..2026-10-11'],
      ['ru', '26 октября — 1 ноября 2026 года: Пример', '2026-10-26..2026-11-01'],
      ['ru', '5–11 октября (Книга 40, 41)', '2026-10-05..2026-10-11'],
      ['ja', '２０２６年１０月２６日‐１１月１日 サンプル', '2026-10-26..2026-11-01'],
      ['ja', '10月5-11日', '2026-10-05..2026-10-11'],
      ['ko', '9월 21-27일 책 36-37장', '2026-09-21..2026-09-27'],
      ['ko', '2026년 10월 26일–11월 1일: 예시', '2026-10-26..2026-11-01'],
      ['cmn-Hans', '示例（10月26日～11月1日）', '2026-10-26..2026-11-01'],
      ['ar', 'عنوان ٥ إلى ١١ تشرين الأول (أكتوبر)', '2026-10-05..2026-10-11'],
      ['vi', 'Ngày 5-11 tháng 10', '2026-10-05..2026-10-11']
    ];
    for (const [locale, title, want] of cases) {
      assert.equal(range(title, { locale, reference: day('2026-10-15') }), want, `${locale}: ${title}`);
    }
  });

  it('cleans &nbsp;, U+00A0 and zero-width spaces before parsing', () => {
    assert.equal(range('October&nbsp;5-​11', near('2026-10-01')), '2026-10-05..2026-10-11');
    assert.equal(range('October 5-11', near('2026-10-01')), '2026-10-05..2026-10-11');
  });

  it('returns null for titles that are not a Monday–Sunday week', () => {
    for (const title of [
      'In This Issue',
      '1926—One Hundred Years Ago',
      '2026 Memorial Reading Schedule',
      'Download All Files (ZIP)',
      'January',
      'October 6-12 (Book 1-2)', // Tuesday to Monday
      'October 5-18',
      'ファイル 4'
    ]) {
      assert.equal(parseWeekRange(title, { reference: day('2026-10-15') }), null, title);
    }
  });
});

describe('decodeTitle', () => {
  it('decodes entities, drops tags and invisible characters', () => {
    assert.equal(decodeTitle('August&nbsp;2026'), 'August 2026');
    assert.equal(decodeTitle('Сентябрь&nbsp;— октябрь 2026&nbsp;года'), 'Сентябрь — октябрь 2026 года');
    assert.equal(decodeTitle('<strong>Alle Dateien (ZIP)</strong>'), 'Alle Dateien (ZIP)');
    assert.equal(decodeTitle('A&amp;B &#8220;q&#8221; &#x41;'), 'A&B “q” A');
    assert.equal(decodeTitle('October 5-​11‏'), 'October 5-11');
    assert.equal(decodeTitle(null), '');
  });
});

describe('tool definitions', () => {
  it('make every parameter optional and describe the issue scheme', () => {
    const byName = Object.fromEntries([...workbookTools, ...watchtowerTools].map((t) => [t.name, t]));
    for (const name of ['getWorkbookLinks', 'getWorkbookContent', 'getWatchtowerLinks', 'getWatchtowerContent']) {
      assert.deepEqual(byName[name].inputSchema.required, [], name);
      assert.ok(byName[name].inputSchema.properties.date, `${name} has date`);
      assert.doesNotMatch(byName[name].description, /STEP 1|STEP 2/);
    }
    assert.match(byName.getWorkbookLinks.inputSchema.properties.issue.description, /odd months/);
    assert.match(byName.getWatchtowerLinks.inputSchema.properties.issue.description, /M\+2/);
    assert.ok(byName.getWorkbookContent.inputSchema.properties.url);
    assert.ok(byName.getWatchtowerContent.inputSchema.properties.week);
    assert.ok(byName.getWorkbookLinks.inputSchema.properties.fileformat.enum.includes('TXT'));
  });

  it('handlers return null for other tools', async () => {
    assert.equal(await handleWorkbookTools({ params: { name: 'getWatchtowerLinks', arguments: {} } }), null);
    assert.equal(await handleWatchtowerTools({ params: { name: 'get_bible_verse', arguments: {} } }), null);
  });
});

describe('lookup tables ignore Object.prototype names', () => {
  it('leaves "&constructor;" and "&__proto__;" alone', () => {
    assert.equal(decodeTitle('Week &constructor; 5-11'), 'Week &constructor; 5-11');
    assert.equal(decodeTitle('&__proto__;&amp;'), '&__proto__;&');
  });

  it('names an unknown pub "constructor" as a publication code', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookLinks', { pub: 'constructor' });
    assert.equal(result.isError, true);
    assert.match(text, /Publication "constructor"/);
  });
});

describe('getWorkbookLinks', () => {
  it('picks the September issue for 2026-10-11 and marks the Oct 5-11 week', async () => {
    useFetch(jwOrg());
    const { result, json } = await workbook('getWorkbookLinks', { date: '2026-10-11' });
    assert.equal(result.isError, undefined);
    const [params] = pubMediaCalls();
    assert.equal(params.get('issue'), '20260900');
    assert.equal(params.get('pub'), 'mwb');
    assert.equal(params.get('fileformat'), 'RTF,TXT,MP3');
    assert.equal(json.issue, '20260900');
    assert.equal(json.formattedDate, 'September–October 2026');
    assert.equal(json.fileformat, 'RTF');
    assert.equal(json.date, '2026-10-11');
    assert.equal(json.weekFiles.length, 8, 'ZIP removed, no week dropped');
    assert.equal(json.weekFiles[0].title, 'September 7-13 (Sample Book 1-2)');
    assert.deepEqual(json.current_week, {
      title: 'October 5-11 (Sample Book 1-2)',
      type: 'week',
      week: 5,
      week_start: '2026-10-05',
      week_end: '2026-10-11',
      is_current_week: true,
      url: cdn('mwb_E_202609_04.rtf'),
      link: 'https://www.jw.org/finder?wtlocale=E&docid=904'
    });
    assert.equal(json.weekFiles.filter((w) => w.is_current_week).length, 1);
    // track is 0-based here and equal to week in the Watchtower; only week is shown.
    assert.ok(json.weekFiles.every((w) => !('track' in w)));
    for (const w of json.weekFiles) {
      assert.equal(w.filesize, undefined);
      assert.equal(w.checksum, undefined);
      assert.equal(w.modifiedDatetime, undefined);
    }
  });

  it('uses the server-local today when no date is given', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2027, 0, 3, 23, 30) });
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', undefined);
    assert.equal(json.issue, '20261100');
    assert.equal(json.date, '2027-01-03');
    assert.equal(json.current_week.week_start, '2026-12-28');
    assert.equal(json.current_week.week_end, '2027-01-03');
    assert.equal(json.current_week.week, 9);
  });

  it('marks non-week items as "other" and keeps the weeks after them right', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { issue: '20260300', date: '2026-04-08' });
    const schedule = json.weekFiles.find((w) => w.type === 'other');
    assert.deepEqual(schedule, { title: '2026 Memorial Reading Schedule', type: 'other', url: cdn('mwb_E_202603_04.rtf') });
    assert.equal(json.current_week.week_start, '2026-04-06');
    assert.equal(json.current_week.week, 5);
  });

  it('notes a week the issue has no entry for, and what it files there', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { date: '2026-04-01' });
    assert.equal(json.issue, '20260300');
    assert.equal(json.current_week, null);
    assert.match(json.note, /no meeting week for the week of 2026-03-30: no midweek meeting is scheduled that week; the issue files "2026 Memorial Reading Schedule" there instead \(getWorkbookContent with its url reads it\)/);
    // The audio tracks are offset from the text files', so the schedule gets no week's page.
    assert.equal(json.weekFiles.find((w) => w.type === 'other').link, undefined);
  });

  it('titles a numbered file that has no week from the English edition (Japanese)', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { langwritten: 'J', issue: '20260300' });
    const other = json.weekFiles.find((w) => w.type === 'other');
    assert.equal(other.title, '2026 Memorial Reading Schedule (English title)');
    assert.equal(other.url, cdn('mwb_J_202603_04.txt'));
    assert.equal(json.weekFiles.filter((w) => w.type === 'week').length, 8);
  });

  it('types the entries of every per-week format, and none of whole-issue files', async () => {
    useFetch(jwOrg());
    const mp3 = await workbook('getWorkbookLinks', { fileformat: 'MP3', date: '2026-10-11' });
    assert.ok(mp3.json.weekFiles.length > 0);
    for (const w of mp3.json.weekFiles) assert.equal(w.type, w.week ? 'week' : 'other', JSON.stringify(w));
    assert.equal(mp3.json.current_week.type, 'week');
    const asl = await workbook('getWorkbookLinks', { langwritten: 'ASL', fileformat: 'MP4', date: '2026-09-08' });
    assert.equal(asl.json.weekFiles.find((w) => w.title === 'References').type, 'other');
    assert.ok(asl.json.weekFiles.filter((w) => w.week).every((w) => w.type === 'week'));
    const pdf = await workbook('getWorkbookLinks', { fileformat: 'PDF', date: '2026-10-11' });
    assert.ok(pdf.json.weekFiles.every((w) => w.type === undefined));
  });

  it('says when an all-caps ISO tag was read as a built-in language', async () => {
    useFetch(() => notFound());
    await workbook('getWorkbookLinks', { langwritten: 'TL', date: '2026-10-11' });
    assert.equal(pubMediaCalls()[0].get('langwritten'), 'TG', 'TL is Tagalog');
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { langwritten: 'EN', date: '2026-10-11' });
    assert.match(json.note, /^"EN" was read as the ISO tag for English \(JW\.org code E\)\. For Bena, whose JW\.org code is EN, pass langwritten "Bena"\./);
    const content = await workbook('getWorkbookContent', { langwritten: 'EN', date: '2026-10-11' });
    assert.match(content.json.note, /^"EN" was read as the ISO tag/);
  });

  it('reads an even-month issue as the odd one and says so', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { issue: '20261000', date: '2026-10-11' });
    assert.equal(pubMediaCalls()[0].get('issue'), '20260900');
    assert.equal(json.issue, '20260900');
    assert.match(json.note, /bimonthly/);
  });

  it('notes when the date is outside an explicit issue', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { issue: '202611', date: '2026-10-11' });
    assert.equal(json.issue, '20261100');
    assert.equal(json.current_week, null);
    assert.match(json.note, /its week is in issue 20260900/);
  });

  it('accepts lowercase codes, ISO tags and nulls', async () => {
    useFetch(jwOrg());
    const a = await workbook('getWorkbookLinks', { langwritten: 'e', fileformat: 'rtf', date: '2026-10-11', pub: null, issue: null });
    assert.equal(a.json.issue, '20260900');
    const b = await workbook('getWorkbookLinks', { langwritten: 'en', date: '2026-10-11', issue: '' });
    assert.equal(b.json.langwritten, 'E');
  });

  it('falls back to the next issue when the expected one does not hold the week', async () => {
    useFetch(jwOrg());
    // The synthetic July issue stops at Aug 24-30; Aug 31-Sep 6 is put in September.
    LISTINGS['mwb:E:202609'].files.E.RTF.splice(1, 0, file(`${enRange('2026-08-31')} (Sample)`, 'mwb_E_202609_x.rtf', 0));
    try {
      const { json } = await workbook('getWorkbookLinks', { date: '2026-09-01' });
      assert.deepEqual(pubMediaCalls().map((p) => p.get('issue')), ['20260700', '20260900']);
      assert.equal(json.issue, '20260900');
      assert.equal(json.current_week.week_start, '2026-08-31');
      assert.match(json.note, /listed in issue 20260900, not 20260700/);
    } finally {
      LISTINGS['mwb:E:202609'].files.E.RTF.splice(1, 1);
    }
  });

  it('falls back to TXT and labels numbered weeks from the audio titles (Japanese)', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { langwritten: 'J', date: '2026-10-11' });
    assert.equal(json.fileformat, 'TXT');
    assert.equal(json.language, '日本語');
    assert.equal(json.weekFiles.length, 8);
    assert.deepEqual(json.current_week, {
      title: '10月5-11日',
      type: 'week',
      week: 5,
      week_start: '2026-10-05',
      week_end: '2026-10-11',
      is_current_week: true,
      url: cdn('mwb_J_202609_04.txt'),
      link: 'https://www.jw.org/finder?wtlocale=J&docid=904'
    });
    assert.match(json.note, /no RTF files/);
    assert.match(json.note, /matched by track from the English edition/);
  });

  it('takes dates from the English edition when titles and audio carry none', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { langwritten: 'KO', date: '2026-10-11' });
    assert.equal(json.current_week.week_start, '2026-10-05');
    assert.match(json.current_week.title, /2026/);
    assert.ok(pubMediaCalls().some((p) => p.get('langwritten') === 'E' && p.get('fileformat') === 'RTF'));
  });

  it('keeps the single file of formats without a ZIP and drops every ZIP from BRL', async () => {
    useFetch(jwOrg());
    const pdf = await workbook('getWorkbookLinks', { fileformat: 'PDF', date: '2026-10-11' });
    assert.equal(pdf.json.fileformat, 'PDF');
    assert.deepEqual(pdf.json.weekFiles, [{ title: 'Regular', url: cdn('mwb_E_202609.pdf') }]);
    assert.match(pdf.json.note, /download links/);
    assert.equal(pdf.json.current_week, undefined, 'no weeks in a PDF listing');
    const brl = await workbook('getWorkbookLinks', { fileformat: 'brl', date: '2026-10-11' });
    assert.deepEqual(brl.json.weekFiles.map((f) => f.title), ['Volume 1']);
  });

  it('omits issue for publications without a schedule', async () => {
    useFetch(jwOrg());
    const { json } = await watchtower('getWatchtowerLinks', { pub: 'es26' });
    assert.equal(pubMediaCalls()[0].get('issue'), null);
    assert.equal(json.issue, null);
    assert.deepEqual(json.articles, [{ title: 'January', url: cdn('es26_E_01.rtf') }]);
    assert.equal(json.current_week, undefined);
  });

  it('says an issue is not published yet', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookLinks', { issue: '20270300' });
    assert.equal(result.isError, true);
    assert.match(text, /Meeting Workbook issue 20270300 is not on JW\.org \(not published yet/);
    assert.match(text, /Next step: .*odd months/);
  });

  it('says when the issue for the date is not published yet', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookContent', { date: '2027-03-10' });
    assert.equal(result.isError, true);
    assert.match(text, /issue 20270300 \(the issue for the week of 2027-03-08\) is not on JW\.org/);
  });

  it('lists the formats a language does offer', async () => {
    useFetch(jwOrg());
    const chs = await workbook('getWorkbookLinks', { langwritten: 'CHS', date: '2026-10-11' });
    assert.equal(chs.result.isError, true);
    assert.match(chs.text, /exists in Chinese Mandarin \(Simplified\) \(CHS\) but not as RTF or TXT; available formats: PDF, MP3/);
    const epub = await workbook('getWorkbookLinks', { fileformat: 'EPUB', date: '2026-10-11' });
    assert.equal(epub.result.isError, true);
    assert.match(epub.text, /not as EPUB; available formats: PDF, RTF, MP3, BRL/);
  });

  it('says when an issue exists in English but not in the language', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookLinks', { langwritten: 'S', issue: '20260900' });
    assert.equal(result.isError, true);
    assert.match(text, /issue 20260900 is not available in Spanish \(S\)/);
  });

  it('rejects bad arguments without fetching', async () => {
    useFetch(jwOrg());
    for (const [args, pattern] of [
      [{ issue: '2026-09-15' }, /Invalid "issue": expected an issue as YYYYMM00/],
      [{ date: '10/11/2026' }, /Invalid "date": expected a date as YYYY-MM-DD/],
      [{ fileformat: 'DOCX' }, /Invalid "fileformat"/],
      [{ langwritten: 42 }, /Invalid "langwritten"/],
      [{ pub: 'w; drop' }, /Invalid "pub"/]
    ]) {
      const { result, text } = await workbook('getWorkbookLinks', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text, pattern);
    }
    assert.equal(calls.length, 0);
  });
});

describe('getWatchtowerLinks', () => {
  it('2026-10-02 is in the July issue (week of Sep 28)', async () => {
    useFetch(jwOrg());
    const { json } = await watchtower('getWatchtowerLinks', { date: '2026-10-02' });
    assert.equal(pubMediaCalls()[0].get('issue'), '20260700');
    assert.equal(json.issue, '20260700');
    assert.equal(json.formattedDate, 'July 2026');
    assert.equal(json.current_week.title, 'September 28–October 4, 2026: Sample Study 4');
    assert.equal(json.current_week.week, 4);
    assert.equal(json.current_week.type, 'study');
  });

  it('2026-10-05 is in the August issue; non-study articles are typed "other"', async () => {
    useFetch(jwOrg());
    const { json } = await watchtower('getWatchtowerLinks', { date: '2026-10-05' });
    assert.equal(json.issue, '20260800');
    assert.equal(json.current_week.title, 'October 5-11, 2026: Sample Study 1', 'U+00A0 cleaned');
    assert.equal(json.current_week.link, 'https://www.jw.org/finder?wtlocale=E&docid=700');
    assert.deepEqual(
      json.articles.map((a) => [a.week, a.type]),
      [[undefined, 'other'], [1, 'study'], [2, 'study'], [3, 'study'], [4, 'study'], [undefined, 'other']]
    );
    // The audio shares the text files' tracks here, so the "other" article gets its page too.
    assert.equal(json.articles[5].link, 'https://www.jw.org/finder?wtlocale=E&docid=799');
    assert.equal(json.articles[0].link, undefined);
  });

  it('finds studies after a non-study first article and across the year end', async () => {
    useFetch(jwOrg());
    const { json } = await watchtower('getWatchtowerLinks', { date: '2027-01-03' });
    assert.equal(json.issue, '20261000');
    assert.equal(json.articles[1].type, 'other');
    assert.match(json.current_week.url, /w_E_202610_05\.rtf$/);
    assert.equal(json.current_week.week, 4);
    assert.equal(json.current_week.week_end, '2027-01-03');
  });
});

describe('getWorkbookContent / getWatchtowerContent (one call)', () => {
  it('returns this week with no arguments at all', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 11, 9) });
    useFetch(jwOrg());
    const { result, json } = await workbook('getWorkbookContent', undefined);
    assert.equal(result.isError, undefined);
    assert.equal(json.title, 'October 5-11 (Sample Book 1-2)');
    assert.equal(json.week_start, '2026-10-05');
    assert.equal(json.week_end, '2026-10-11');
    assert.equal(json.issue, '20260900');
    assert.equal(json.fileformat, 'RTF');
    assert.equal(json.url, cdn('mwb_E_202609_04.rtf'));
    assert.match(json.parsedText, /Sample week heading/);
    assert.equal(calls.length, 2, 'one listing and one file');
  });

  it('follows each song video link with the song\'s lyrics page', async () => {
    const SONG_RTF = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}}\pard Sample week heading\par\pard {\field{\*\fldinst {HYPERLINK "https://www.jw.org/finder?srcid=share&wtlocale=E&lank=pub-sjjm_603_VIDEO" }}{\fldrslt{\ul Song 103}}} and Prayer\par\pard See {\field{\*\fldinst {HYPERLINK "https://www.jw.org/finder?wtlocale=E&docid=1102018451" }}{\fldrslt{\ul w25.07 5}}}.\par}`;
    useFetch(jwOrg({ [cdn('mwb_E_202609_04.rtf')]: () => body(SONG_RTF, 'application/rtf') }));
    const { json } = await workbook('getWorkbookContent', { date: '2026-10-07' });
    assert.deepEqual(json.links, [
      { text: 'Song 103', url: 'https://www.jw.org/finder?wtlocale=E&lank=pub-sjjm_603_VIDEO' },
      { text: 'Song 103 lyrics', url: 'https://www.jw.org/finder?wtlocale=E&docid=1102016903' },
      { text: 'w25.07 5', url: 'https://www.jw.org/finder?wtlocale=E&docid=1102018451' }
    ]);
  });

  it('takes date, or issue + week', async () => {
    useFetch(jwOrg());
    const a = await watchtower('getWatchtowerContent', { date: '2026-10-02' });
    assert.equal(a.json.title, 'September 28–October 4, 2026: Sample Study 4');
    const b = await watchtower('getWatchtowerContent', { issue: '20260800', week: 2 });
    assert.equal(b.json.week_start, '2026-10-12');
    assert.equal(b.json.url, cdn('w_E_202608_02.rtf'));
    const c = await workbook('getWorkbookContent', { week: '5', date: '2026-10-11' });
    assert.equal(c.json.week_start, '2026-10-05');
  });

  it('rejects a week that does not hold the date, naming the week that does', async () => {
    useFetch(jwOrg());
    const a = await workbook('getWorkbookContent', { week: 3, date: '2026-10-11' });
    assert.equal(a.result.isError, true);
    assert.match(a.text, /Invalid "week"/);
    assert.match(a.text, /2026-10-11 is in week 5 \(October 5-11/);
    assert.match(a.text, /date and week are alternatives/);
    const b = await watchtower('getWatchtowerContent', { date: '2026-10-12', week: 1 });
    assert.equal(b.result.isError, true);
    assert.match(b.text, /2026-10-12 is in week 2 /);
  });

  it('reads TXT weeks, stripping the BOM and CRLFs (Japanese)', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookContent', { langwritten: 'ja', date: '2026-10-07' });
    assert.equal(json.fileformat, 'TXT');
    assert.equal(json.title, '10月5-11日');
    assert.equal(json.parsedText, '１０月５‐１１日\nサンプル\n\n     開会の言葉');
  });

  it('explains a week number beyond the issue', async () => {
    useFetch(jwOrg());
    const { result, text } = await watchtower('getWatchtowerContent', { issue: '20260800', week: 9 });
    assert.equal(result.isError, true);
    assert.match(text, /Invalid "week": expected a number from 1 to 4/);
    assert.match(text, /1\) 2026-10-05 October 5-11/);
  });

  it('asks for week or date when an explicit issue does not hold today', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 11, 9) });
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookContent', { issue: '20261100' });
    assert.equal(result.isError, true);
    assert.match(text, /covers 2026-11-02 to 2027-01-03, which does not include today \(2026-10-11\)/);
    assert.match(text, /Next step: Pass week \(1-9\)/);
  });

  it('names the right issue when an explicit issue and the date disagree', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookContent', { issue: '20261100', date: '2026-10-07' });
    assert.equal(result.isError, true);
    assert.match(text, /covers 2026-11-02 to 2027-01-03; the week of 2026-10-07 is in issue 20260900/);
    assert.match(text, /Next step: Leave issue out/);
  });

  it('says the issue has no meeting for a week it skips, and how to read what it files there', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookContent', { date: '2026-04-02' });
    assert.equal(result.isError, true);
    assert.match(text, /has no meeting week for 2026-03-30 to 2026-04-05: no midweek meeting is scheduled that week; the issue files "2026 Memorial Reading Schedule" there instead\./);
    assert.ok(text.includes(`call getWorkbookContent with url ${cdn('mwb_E_202603_04.rtf')}`), text);
  });
});

describe('getWorkbookContent / getWatchtowerContent (url)', () => {
  it('reads an RTF url as before', async () => {
    useFetch(jwOrg());
    const url = cdn('mwb_E_202609_04.rtf');
    const { result, json } = await workbook('getWorkbookContent', { url });
    assert.equal(result.isError, undefined);
    assert.equal(json.url, url);
    assert.equal(json.issue, '20260900');
    assert.equal(json.langwritten, 'E');
    assert.equal(json.track, undefined);
    assert.equal(json.title, 'Sample week heading', 'no \\info title: the first line');
    assert.equal(json.week_start, undefined);
    assert.equal(json.fileformat, 'RTF');
    assert.match(json.parsedText, /Sample week heading\nOpening comments/);
    // The issue's listing (cached, shared with the other modes) gives pubName, language and link.
    assert.deepEqual(calls, [url, 'https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?output=json&pub=mwb&langwritten=E&issue=20260900&fileformat=RTF%2CTXT%2CMP3']);
    assert.equal(json.pubName, 'Sample Meeting Workbook');
    assert.equal(json.language, 'English');
    assert.equal(json.link, 'https://www.jw.org/finder?wtlocale=E&docid=904');
    assert.deepEqual(Object.keys(json).slice(0, 9), ['title', 'issue', 'pubName', 'language', 'langwritten', 'fileformat', 'url', 'link', 'parsedText']);
  });

  it('still reads a url when its issue listing cannot be loaded, and says what is missing', async () => {
    const url = cdn('mwb_E_202609_04.rtf');
    const site = jwOrg();
    useFetch((u, init) => (u.includes('GETPUBMEDIALINKS') ? new Response('busy', { status: 500 }) : site(u, init)));
    const { result, json } = await workbook('getWorkbookContent', { url });
    assert.equal(result.isError, undefined);
    assert.equal(json.pubName, undefined);
    assert.match(json.note, /pubName, language and link are left out: the issue 20260900 listing could not be loaded/);
  });

  it('refuses a WOL or finder link without fetching', async () => {
    useFetch(() => {
      throw new Error('must not fetch');
    });
    for (const url of ['https://wol.jw.org/en/wol/d/r1/lp-e/2026521', 'https://www.jw.org/finder?wtlocale=E&docid=904']) {
      const { result, text } = await watchtower('getWatchtowerContent', { url });
      assert.equal(result.isError, true);
      assert.match(text, /Next step: Leave url out and pass date/);
    }
    assert.equal(calls.length, 0);
  });

  it('gives the title, and the week dates when the title names a week', async () => {
    const titled = cdn('mwb_E_202609_99.rtf');
    const cover = cdn('mwb_E_202609_00.rtf');
    const rtf = (title, first) => `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\info{\\title ${title}}}\\pard ${first}\\par\\pard Opening comments (1 min.)\\par}`;
    useFetch(
      jwOrg({
        [titled]: () => new Response(rtf('October 5-11 (Sample Book 1-2)', 'OCTOBER 5-11'), { headers: { 'content-type': 'application/rtf' } }),
        [cover]: () => new Response(rtf('Sample Workbook Cover', 'Cover line'), { headers: { 'content-type': 'application/rtf' } })
      })
    );
    const week = await workbook('getWorkbookContent', { url: titled });
    assert.equal(week.json.title, 'October 5-11 (Sample Book 1-2)', 'the \\info title wins over the first line');
    assert.equal(week.json.week_start, '2026-10-05');
    assert.equal(week.json.week_end, '2026-10-11');
    const other = await workbook('getWorkbookContent', { url: cover });
    assert.equal(other.json.title, 'Sample Workbook Cover');
    assert.equal(other.json.week_start, undefined);
  });

  it('dates a Japanese TXT file from its first line', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookContent', { url: cdn('mwb_J_202609_04.txt') });
    assert.equal(json.title, '１０月５‐１１日');
    assert.equal(json.week_start, '2026-10-05');
    assert.equal(json.week_end, '2026-10-11');
  });

  it('says a jw.org page link is the "link" field, not the file url, without fetching', async () => {
    useFetch(() => {
      throw new Error('must not fetch');
    });
    const { result, text } = await watchtower('getWatchtowerContent', { url: 'https://www.jw.org/finder?wtlocale=E&docid=904' });
    assert.equal(result.isError, true);
    assert.match(text, /jw\.org page link \(the "link" field\), not a file\. Pass the "url" field/);
    assert.match(text, /Next step: /);
    assert.equal(calls.length, 0);
  });

  it('refuses a url over 2000 characters without fetching or echoing it', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookContent', { url: `https://cfp2.jw-cdn.org/a/${'x'.repeat(3000)}/mwb_E_202609_01.rtf` });
    assert.equal(result.isError, true);
    assert.match(text, /at most 2000 characters/);
    assert.ok(text.length < 300, `${text.length} characters`);
    assert.equal(calls.length, 0);
  });

  it('upgrades http:// on the CDN to https://', async () => {
    useFetch(jwOrg());
    const { json } = await watchtower('getWatchtowerContent', { url: cdn('w_E_202608_01.rtf').replace('https:', 'http:') });
    assert.equal(json.url, cdn('w_E_202608_01.rtf'));
  });

  it('refuses hosts other than the JW CDN without fetching', async () => {
    useFetch(jwOrg());
    for (const url of [
      'http://127.0.0.1:8080/internal.rtf',
      'https://169.254.169.254/latest.rtf',
      'https://evil.example/x.rtf',
      'https://cfp2.jw-cdn.org.evil.example/x.rtf',
      'https://wol.jw.org/en/wol/d/r1/lp-e/123.rtf',
      'file:///etc/passwd',
      'not a url'
    ]) {
      const { result, text } = await workbook('getWorkbookContent', { url });
      assert.equal(result.isError, true, url);
      assert.match(text, /Invalid "url": expected an https link to an \.rtf or \.txt file on cfp2\.jw-cdn\.org/, url);
      assert.match(text, /Next step: Leave url out/);
    }
    assert.equal(calls.length, 0);
  });

  it('refuses non-text files before downloading them', async () => {
    useFetch(jwOrg());
    for (const [name, kind] of [['mwb_E_202609.pdf', 'PDF'], ['mwb_E_202609.rtf.zip', 'ZIP'], ['mwb_E_202609_01.mp3', 'MP3']]) {
      const { result, text } = await workbook('getWorkbookContent', { url: cdn(name) });
      assert.equal(result.isError, true);
      assert.match(text, new RegExp(`reads RTF or TXT files only, and .* is a ${kind} file`));
    }
    assert.equal(calls.length, 0);
  });

  it('refuses a redirect off the CDN', async () => {
    const url = cdn('w_E_202608_09.rtf');
    useFetch(jwOrg({ [url]: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.rtf' } }) }));
    const { result, text } = await watchtower('getWatchtowerContent', { url });
    assert.equal(result.isError, true);
    assert.match(text, /redirected to http:\/\/127\.0\.0\.1\/secret\.rtf, which is not an allowed JW\.org address/);
    assert.equal(calls.length, 1);
  });

  it('caps the download size', async () => {
    const url = cdn('w_E_202608_08.rtf');
    useFetch(jwOrg({ [url]: () => body(`{\\rtf1 ${'x'.repeat(3 * 1024 * 1024)}}`, 'application/rtf') }));
    const { result, text } = await watchtower('getWatchtowerContent', { url });
    assert.equal(result.isError, true);
    assert.match(text, /larger than 2 MB/);
  });

  it('times out a stalled download', async () => {
    const url = cdn('w_E_202608_07.rtf');
    const stalled = () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{\\rtf1 ')) }), { status: 200 });
    useFetch(jwOrg({ [url]: stalled }));
    const { result, text } = await watchtower('getWatchtowerContent', { url });
    assert.equal(result.isError, true);
    assert.match(text, /Timed out after 0\.4 s reading the response from cfp2\.jw-cdn\.org/);
  });

  it('explains a missing CDN file (403)', async () => {
    useFetch(jwOrg());
    const { result, text } = await workbook('getWorkbookContent', { url: cdn('mwb_E_209901_00.rtf') });
    assert.equal(result.isError, true);
    assert.match(text, /cfp2\.jw-cdn\.org returned 403 Forbidden/);
    assert.match(text, /answers 403 or 404 when a file does not exist/);
    assert.doesNotMatch(text, /Failed to fetch RTF content: Failed/);
  });

  it('reports a file that is neither RTF nor TXT', async () => {
    const url = cdn('w_E_202608_06.rtf');
    useFetch(jwOrg({ [url]: () => body('<html>maintenance</html>', 'text/html') }));
    const { result, text } = await watchtower('getWatchtowerContent', { url });
    assert.equal(result.isError, true);
    assert.match(text, /is not an RTF or TXT file \(content type text\/html\)/);
  });

  it('treats a missing arguments object as "this week", not a crash', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 6, 9) });
    useFetch(jwOrg());
    const result = await handleWatchtowerTools({ params: { name: 'getWatchtowerContent' } });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).week_start, '2026-10-05');
  });
});

describe('sign-language editions (MP4, 3GP)', () => {
  it('lists the MP4 files of a week together, with their resolution', async () => {
    useFetch(jwOrg());
    const { result, json } = await workbook('getWorkbookLinks', { langwritten: 'ASL', issue: '20260900', fileformat: 'mp4', date: '2026-09-16' });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(json.fileformat, 'MP4');
    const weeks = json.weekFiles.filter((f) => f.week);
    assert.deepEqual(weeks.map((f) => [f.week, f.resolution]), [[1, '240p'], [1, '720p'], [2, '240p'], [2, '720p']]);
    assert.equal(weeks[1].week_start, '2026-09-07');
    assert.equal(json.current_week.week, 2);
    assert.match(json.current_week.url, /\.mp4$/);
    const references = json.weekFiles.find((f) => f.title === 'References');
    assert.equal(references.week, undefined);
    assert.equal(references.resolution, '240p');
  });

  it('lists 3GP files, and names only accepted formats when RTF is missing', async () => {
    useFetch(jwOrg());
    const small = await workbook('getWorkbookLinks', { langwritten: 'ASL', issue: '20260900', fileformat: '3GP' });
    assert.equal(small.json.fileformat, '3GP');
    assert.ok(small.json.weekFiles.every((f) => /\.3gp$/.test(f.url) && f.resolution === '144p'));
    const plain = await workbook('getWorkbookLinks', { langwritten: 'ASL', issue: '20260900' });
    assert.equal(plain.result.isError, true);
    assert.match(plain.text, /available formats: JWPUB, MP4, 3GP\./);
    const [format] = /MP4/.exec(plain.text);
    const next = await workbook('getWorkbookLinks', { langwritten: 'ASL', issue: '20260900', fileformat: format });
    assert.equal(next.result.isError, undefined);
  });

  it('works the same for the Watchtower', async () => {
    useFetch(jwOrg());
    const { result, json } = await watchtower('getWatchtowerLinks', { langwritten: 'ASL', issue: '20260800', fileformat: 'MP4' });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(json.articles.filter((a) => a.week === 2).length, 2);
  });
});

describe('study editions before 2016 (YYYYMM15)', () => {
  it('reads the issue code 1.3.3 took, and finds its studies two months later', async () => {
    useFetch(jwOrg());
    const { result, json } = await watchtower('getWatchtowerLinks', { issue: '20150115' });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(json.issue, '20150115');
    const studies = json.articles.filter((a) => a.type === 'study');
    assert.equal(studies[0].week_start, '2015-03-02');
    assert.equal(studies.length, 4);
    assert.equal(pubMediaCalls()[0].get('issue'), '20150115');
  });

  it('reads YYYYMM00 and a date as the YYYYMM15 issue', async () => {
    useFetch(jwOrg());
    const { json } = await watchtower('getWatchtowerLinks', { issue: '20150100' });
    assert.equal(pubMediaCalls()[0].get('issue'), '20150115');
    assert.match(json.note, /read as 20150115/);
    clearPeriodicalCaches();
    useFetch(jwOrg());
    const byDate = await watchtower('getWatchtowerContent', { date: '2015-03-04' });
    assert.equal(byDate.result.isError, undefined, byDate.text);
    assert.equal(pubMediaCalls()[0].get('issue'), '20150115');
    assert.equal(byDate.json.week_start, '2015-03-02');
  });

  it('does not call a past issue "not published yet"', async () => {
    useFetch(jwOrg());
    const { result, text } = await watchtower('getWatchtowerLinks', { issue: '20150101' });
    assert.equal(result.isError, true);
    assert.match(text, /no such issue/);
    assert.doesNotMatch(text, /not published yet/);
    assert.match(text, /Next step: Study-edition issue codes are YYYYMM00 from 2016 and YYYYMM15 before that/);
  });

  it('keeps the issue of a dated file read by url', async () => {
    const url = 'https://cfp2.jw-cdn.org/a/x/1/o/w_E_20150115_03.rtf';
    useFetch(jwOrg({ [url]: () => body('{\\rtf1\\ansi{\\info{\\title Sample Study 2 (March 9-15)}}\\pard Sample text.\\par}', 'application/rtf') }));
    const { json } = await watchtower('getWatchtowerContent', { url });
    assert.equal(json.issue, '20150115');
    assert.equal(json.week_start, '2015-03-09');
  });
});

describe('long files and long listings', () => {
  const BIG = cdn('mwb_E_202609_90.txt');
  const bigText = Array.from({ length: 7500 }, (_, i) => `Line ${i + 1} sample text`).join('\n');

  it('pages a long url read at line ends, and the pages rebuild the text', async () => {
    useFetch(jwOrg({ [BIG]: () => body(bigText, 'text/plain') }));
    const first = await workbook('getWorkbookContent', { url: BIG });
    assert.equal(first.result.isError, undefined, first.text);
    assert.ok(first.json.parsedText.length <= 60000);
    assert.equal(first.json.total_chars, bigText.length);
    assert.equal(first.json.offset, 0);
    assert.equal(typeof first.json.next_offset, 'number');
    assert.match(first.json.note, /call getWorkbookContent again with the same arguments and offset = next_offset/);
    assert.ok(estimateTokens(first.text) <= 22000);
    let offset = 0;
    let rebuilt = '';
    for (let i = 0; i < 20 && offset !== null; i++) {
      const { json } = await workbook('getWorkbookContent', { url: BIG, offset });
      assert.equal(bigText.slice(offset, offset + json.parsedText.length), json.parsedText);
      assert.match(json.parsedText, /text$/, 'cut at a line end');
      rebuilt += (rebuilt ? '\n' : '') + json.parsedText;
      offset = json.next_offset;
    }
    assert.equal(offset, null);
    assert.equal(rebuilt, bigText);
    assert.equal(calls.filter((u) => u === BIG).length, 1, 'later pages come from the cache');
  });

  it('rejects an offset past the end and a max_chars over 80000', async () => {
    useFetch(jwOrg({ [BIG]: () => body(bigText, 'text/plain') }));
    const past = await workbook('getWorkbookContent', { url: BIG, offset: bigText.length });
    assert.equal(past.result.isError, true);
    assert.match(past.text, /Invalid "offset"[^]*Next step: /);
    const big = await watchtower('getWatchtowerContent', { max_chars: 90000 });
    assert.equal(big.result.isError, true);
    assert.match(big.text, /Invalid "max_chars": expected an integer from 1000 to 80000/);
    assert.equal(calls.length, 1);
  });

  it('keeps the old shape for a short file', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookContent', { url: cdn('mwb_E_202609_04.rtf') });
    for (const key of ['offset', 'next_offset', 'total_chars', 'note']) assert.equal(json[key], undefined, key);
  });

  it('caps a listing at 200 files and says how many there are', async () => {
    useFetch(jwOrg());
    const { json } = await workbook('getWorkbookLinks', { pub: 'nwt' });
    assert.equal(json.weekFiles.length, 200);
    assert.equal(json.total_entries, 1500);
    assert.match(json.note, /Showing the first 200 of 1500 files/);
  });
});

describe('languages outside the built-in table', () => {
  const DIRECTORY = 'https://b.jw-cdn.org/apis/mediator/v1/languages/E/all';
  const SW_URL = 'https://cfp2.jw-cdn.org/a/abc/1/o/mwb_SW_202609_05.rtf';
  const swRtf = () => body('{\\rtf1\\ansi{\\info{\\title Oktoba 12-18 (Yeremia 42-44)}}\\pard Sample text.\\par}', 'application/rtf');
  const directory = (languages) => () => body(JSON.stringify({ languages }), 'application/json');
  beforeEach(() => clearLanguageCache());
  afterEach(() => clearLanguageCache());

  it('dates a url read in a language the process has not looked up yet', async () => {
    useFetch(jwOrg({ [DIRECTORY]: directory([{ code: 'SW', locale: 'sw', name: 'Swahili' }]), [SW_URL]: swRtf }));
    const { json } = await workbook('getWorkbookContent', { url: SW_URL });
    assert.equal(json.title, 'Oktoba 12-18 (Yeremia 42-44)');
    assert.equal(json.week_start, '2026-10-12');
    assert.equal(json.week_end, '2026-10-18');
  });

  it('still reads the url when the language list fails or lacks the code', async () => {
    for (const answer of [() => new Response('busy', { status: 503 }), directory([{ code: 'XX', locale: 'xx', name: 'Other' }])]) {
      clearLanguageCache();
      clearPeriodicalCaches();
      useFetch(jwOrg({ [DIRECTORY]: answer, [SW_URL]: swRtf }));
      const { result, json } = await workbook('getWorkbookContent', { url: SW_URL });
      assert.equal(result.isError, undefined);
      assert.equal(json.title, 'Oktoba 12-18 (Yeremia 42-44)');
      assert.equal(json.week_start, undefined);
    }
  });

  it('asks pub-media with a JW code when the language list is down', async () => {
    useFetch(jwOrg({ [DIRECTORY]: () => new Response('busy', { status: 503 }) }));
    const { result, json } = await watchtower('getWatchtowerLinks', { langwritten: 'Z', issue: '20260800' });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(json.langwritten, 'Z');
    assert.equal(pubMediaCalls()[0].get('langwritten'), 'Z');
    assert.equal(json.articles[0].week_start, '2026-10-05', 'month names from the listing\'s locale');
    const named = await watchtower('getWatchtowerLinks', { langwritten: 'svenska', issue: '20260800' });
    assert.equal(named.result.isError, true);
    assert.match(named.text, /b\.jw-cdn\.org returned 503/);
  });
});
