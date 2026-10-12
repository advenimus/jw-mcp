// Shared code for the periodical tools: the CLM meeting workbook (mwb) and
// the Watchtower study edition (w). Works out which issue holds a meeting
// week, reads week dates out of localized file titles, loads the pub-media
// listing, and downloads one RTF/TXT file as plain text.

import { ArgError, formatIsoDate, isMissing, requireArgs, toEnum, toInt, toIsoDate, toJwUrl, toStr } from './args.js';
import { TtlLruCache, cached } from './cache.js';
import { DEFAULT_TIMEOUT_MS, JwFetchError, fetchJson, fetchResource } from './http.js';
import { resolveLanguage } from './languages.js';
import { ToolError, pageByTokens } from './results.js';
import { parseRTFDocument } from './rtf-parser.js';
import { songOfKey, songbookDocid } from './songbook.js';
import { asciiDigits } from './text.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// One call may make several requests. 50 s stays inside the MCP client's 60 s
// default; a raised JW_MCP_FETCH_TIMEOUT_MS raises it, as for the other tools.
const TOOL_BUDGET_MS = Math.max(50 * 1000, 2 * DEFAULT_TIMEOUT_MS);
const PUB_MEDIA_URL = 'https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS';
const CDN_HOSTS = Object.freeze(['*.jw-cdn.org']);
// Week files are 5-120 KB.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_FORMATS = ['RTF', 'TXT'];
// MP4/3GP are the sign-language editions (ASL, BSL ...), which have no RTF/TXT.
export const FILE_FORMATS = Object.freeze(['RTF', 'TXT', 'PDF', 'EPUB', 'JWPUB', 'MP3', 'MP4', '3GP', 'BRL', 'DAISY']);
// The workbook has been bimonthly (odd months only) since January 2021.
const BIMONTHLY_FROM = 2021;
// Until 2016 the Watchtower study edition was dated the 15th (issue YYYYMM15).
const W_MONTHLY_FROM = 2016;
// parsedText pages; the token budget (PAGE_TOKENS) also ends a page.
const DEFAULT_MAX_CHARS = 60000;
const MAX_MAX_CHARS = 80000;
// Real issues list about 20 files; only the hidden pub argument reaches more.
const MAX_LIST_ENTRIES = 200;

const PUBS = {
  __proto__: null,
  mwb: {
    name: 'Meeting Workbook',
    weekType: 'week',
    one: 'meeting week',
    many: 'meeting weeks',
    skipped: 'no midweek meeting is scheduled that week',
    notPublishedHint:
      'Workbook issues appear on JW.org about two months before they are used, and only for odd months (YYYY0100, YYYY0300 ... YYYY1100). Leave issue and date out for the current week, or pick an earlier issue.',
    pastHint: 'The workbook started with the January 2016 issue (20160100); issues are YYYYMM00, odd months only from 2021.'
  },
  w: {
    name: 'Watchtower study edition',
    weekType: 'study',
    one: 'study article',
    many: 'study articles',
    notPublishedHint:
      'Watchtower study issues appear about two to three months before their study weeks. Leave issue and date out for the current study, or pick an earlier issue.',
    pastHint:
      'Study-edition issue codes are YYYYMM00 from 2016 and YYYYMM15 before that (e.g. 20150115); RTF/TXT text exists only from mid-2014, older issues list with fileformat JWPUB.'
  }
};

export const WORKBOOK_TOOLS = Object.freeze({
  pub: 'mwb',
  linksTool: 'getWorkbookLinks',
  contentTool: 'getWorkbookContent',
  listKey: 'weekFiles'
});

export const WATCHTOWER_TOOLS = Object.freeze({
  pub: 'w',
  linksTool: 'getWatchtowerLinks',
  contentTool: 'getWatchtowerContent',
  listKey: 'articles'
});

// ---------------------------------------------------------------------------
// Weeks and issues (all dates are local midnight)

function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function daysBetween(a, b) {
  return Math.round((b - a) / DAY_MS);
}

/** Monday of the Mon–Sun week that contains date. */
export function mondayOf(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

function firstMonday(year, monthIndex) {
  const first = new Date(year, monthIndex, 1);
  return addDays(first, (8 - first.getDay()) % 7);
}

function issueCode(year, monthIndex, pub) {
  const d = new Date(year, monthIndex, 1);
  const day = pub === 'w' && d.getFullYear() < W_MONTHLY_FROM ? '15' : '00';
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${day}`;
}

function issueParts(issue) {
  return { year: Number(issue.slice(0, 4)), month: Number(issue.slice(4, 6)) - 1 };
}

function monthsPerIssue(pub, year) {
  return pub === 'mwb' && year >= BIMONTHLY_FROM ? 2 : 1;
}

/**
 * The issue (YYYYMM00; YYYYMM15 for study editions before 2016) holding the
 * Mon–Sun meeting week that contains date, or null for a publication without
 * a weekly schedule. A week belongs to the month of its Monday. mwb: that
 * month, rounded down to an odd month since 2021 (Dec 28–Jan 3 is in the
 * November issue). w: issue M holds the study weeks whose Monday is in month M+2.
 */
export function issueForDate(pub, date) {
  const monday = mondayOf(date);
  const year = monday.getFullYear();
  const month = monday.getMonth();
  if (pub === 'mwb') return issueCode(year, monthsPerIssue(pub, year) === 2 ? month - (month % 2) : month, pub);
  if (pub === 'w') return issueCode(year, month - 2, pub);
  return null;
}

/** Mondays [first, next) whose weeks an issue covers, and a mid-point for resolving title years. */
function issueSpan(pub, issue) {
  const { year, month } = issueParts(issue);
  const start = pub === 'w' ? month + 2 : month;
  const first = firstMonday(year, start);
  const next = firstMonday(year, start + monthsPerIssue(pub, year));
  return { first, next, reference: addDays(first, Math.floor(daysBetween(first, next) / 2)) };
}

function shiftIssue(pub, issue, step) {
  const { year, month } = issueParts(issue);
  return issueCode(year, month + step * monthsPerIssue(pub, year), pub);
}

const ISSUE_TEXT = 'an issue as YYYYMM00, e.g. 20260800 (YYYYMM15 for study editions before 2016, e.g. 20150115)';
const WORKBOOK_ISSUE_TEXT = 'an issue as YYYYMM00, e.g. 20260900 (workbook issues are odd months: 01, 03, 05, 07, 09, 11)';

/**
 * Accepts YYYYMM00, YYYYMM or YYYY-MM, and the dated codes pub-media uses for
 * older issues (YYYYMM15, YYYYMM01). An even-month workbook issue from 2021 on
 * becomes the odd-month issue that contains it, and a Watchtower study issue
 * before 2016 its YYYYMM15 code, with a note saying so. Returns { issue: null }
 * when missing.
 */
export function normalizeIssue(value, pub) {
  if (isMissing(value)) return { issue: null, note: null };
  const s = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  const m = /^(\d{4})-?(\d{2})(00|01|15)?$/.exec(s);
  const year = Number(m?.[1]);
  const month = Number(m?.[2]);
  if (!m || month < 1 || month > 12 || year < 1950 || year > 2199) {
    const hint = /^\d{4}-\d{2}-\d{2}/.test(s)
      ? 'That looks like a day: pass it as "date" (YYYY-MM-DD) instead, or leave issue out.'
      : 'Leave issue out to get the issue for today (or for "date").';
    throw new ArgError('issue', value, pub === 'mwb' ? WORKBOOK_ISSUE_TEXT : ISSUE_TEXT, { hint });
  }
  // Dated issues (study edition YYYYMM15 before 2016, public edition YYYYMM01) pass through.
  if (m[3] === '01' || m[3] === '15') return { issue: `${m[1]}${m[2]}${m[3]}`, note: null };
  const issue = issueCode(year, month - 1, pub);
  if (issue.endsWith('15')) {
    return { issue, note: `Study editions before ${W_MONTHLY_FROM} are dated the 15th, so issue ${m[1]}${m[2]}00 was read as ${issue}.` };
  }
  if (pub === 'mwb' && year >= BIMONTHLY_FROM && month % 2 === 0) {
    const odd = issueCode(year, month - 2, pub);
    return {
      issue: odd,
      note: `Workbook issues are bimonthly (odd months only), so issue ${issue} was read as ${odd}, the issue that covers that month.`
    };
  }
  return { issue, note: null };
}

// ---------------------------------------------------------------------------
// Week dates in titles, e.g. "October 5-11 (Jeremiah 40-41)",
// "26 de octubre a 1 de noviembre de 2026: …", "５‐１１日", "10월 26일–11월 1일".

const ENTITIES = { __proto__: null, nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** Decode the HTML entities, tags and invisible characters JW.org leaves in titles. */
export function decodeTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/[   ]/g, ' ')
    .replace(/[​‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarks(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

function intlLocale(iso) {
  return String(iso || 'en').replace(/^cmn(?=-|$)/i, 'zh');
}

const monthTables = new Map();

// Month name -> 1..12 for English plus the language's own names, standalone
// and in date context ("октябрь" and "октября"). Names containing digits or
// spaces (CJK "10月", Vietnamese "tháng 10") are handled by markers instead.
function monthTable(iso) {
  const tag = intlLocale(iso);
  let table = monthTables.get(tag);
  if (table) return table;
  table = new Map();
  for (const locale of new Set(['en', tag])) {
    let formats;
    try {
      if (!Intl.DateTimeFormat.supportedLocalesOf(locale).length) continue;
      formats = [
        new Intl.DateTimeFormat(locale, { month: 'long' }),
        new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' })
      ];
    } catch {
      continue;
    }
    for (let m = 0; m < 12; m++) {
      for (const format of formats) {
        for (const part of format.formatToParts(new Date(2026, m, 15))) {
          const name = part.type === 'month' ? part.value.toLowerCase() : '';
          if (!name || /[\d\s]/.test(name)) continue;
          table.set(name, m + 1);
          table.set(stripMarks(name), m + 1);
        }
      }
    }
  }
  monthTables.set(tag, table);
  return table;
}

const NUMBER_MARKERS = { 年: 'year', 년: 'year', 月: 'month', 월: 'month', 日: 'day', 일: 'day' };
const MONTH_PREFIXES = new Set(['tháng']);
const DAY_WORDS = { __proto__: null, premier: 1, primero: 1, primeiro: 1 };
// Short words may sit inside a date ("de", "al", "bis", "года", "تشرين");
// a longer word ends it.
const MAX_FILLER_LENGTH = 6;
const TOKEN = /(\d+)\s*([年년月월日일])?|([\p{L}\p{M}]+)|(:)/gu;

function tokenize(text, table) {
  const tokens = [];
  let monthNext = false;
  for (const [, digits, marker, word, colon] of text.matchAll(TOKEN)) {
    if (colon) {
      tokens.push({ kind: 'break' });
    } else if (word) {
      const w = word.toLowerCase();
      if (MONTH_PREFIXES.has(w)) {
        monthNext = true;
        continue;
      }
      const month = table.get(w) ?? table.get(stripMarks(w));
      if (month) tokens.push({ kind: 'month', value: month });
      else if (DAY_WORDS[w]) tokens.push({ kind: 'day', value: DAY_WORDS[w] });
      else tokens.push({ kind: 'word', long: [...word].length > MAX_FILLER_LENGTH });
    } else {
      const value = Number(digits);
      const kind = NUMBER_MARKERS[marker] ?? (monthNext ? 'month' : digits.length === 4 ? 'year' : 'day');
      const valid = kind === 'year' || (value >= 1 && value <= (kind === 'month' ? 12 : 31));
      tokens.push(valid ? { kind, value } : { kind: 'break' });
    }
    monthNext = false;
  }
  return tokens;
}

// Runs of day/month tokens with at most two short words between them.
function dateRuns(tokens) {
  const runs = [];
  let current = [];
  let fillers = 0;
  const close = () => {
    if (current.length) runs.push(current);
    current = [];
  };
  for (const t of tokens) {
    if (t.kind === 'break') {
      close();
    } else if (t.kind === 'word') {
      if (current.length && (t.long || ++fillers > 2)) close();
    } else {
      fillers = 0;
      if (t.kind !== 'year') current.push(t);
    }
  }
  close();
  return runs;
}

// Years in titles are optional and sometimes not Gregorian, so the year is
// the one that makes the range a Monday–Sunday week within half a year of
// the reference.
function resolveRange(tokens, reference) {
  const days = tokens.filter((t) => t.kind === 'day').map((t) => t.value);
  const months = tokens.filter((t) => t.kind === 'month').map((t) => t.value);
  if (days.length !== 2 || !months.length) return null;
  const [d1, d2] = days;
  const m1 = months[0];
  const m2 = months[1] ?? m1;
  let best = null;
  for (let y = reference.getFullYear() - 1; y <= reference.getFullYear() + 1; y++) {
    const start = new Date(y, m1 - 1, d1);
    const end = new Date(m2 < m1 ? y + 1 : y, m2 - 1, d2);
    if (start.getDate() !== d1 || end.getDate() !== d2) continue;
    if (start.getDay() !== 1 || daysBetween(start, end) !== 6) continue;
    if (Math.abs(daysBetween(reference, start)) > 183) continue;
    if (!best || Math.abs(start - reference) < Math.abs(best.start - reference)) best = { start, end };
  }
  return best;
}

/**
 * The Mon–Sun week named in a title, as { start, end } local Dates, or null.
 * locale: the language's ISO tag (for month names). reference: a date near
 * the expected week, used to pick the year.
 */
export function parseWeekRange(title, { locale = 'en', reference = new Date() } = {}) {
  const text = asciiDigits(decodeTitle(title).normalize('NFKC'));
  // A week is 2 days and 1-2 months, so try every 3- and 4-token window of
  // each run, earliest first: "Study 1 (October 5-11)" has the run
  // [1, October, 5, 11], and the week is the window [October, 5, 11].
  for (const run of dateRuns(tokenize(text, monthTable(locale)))) {
    for (let i = 0; i < run.length; i++) {
      for (let j = i + 3; j <= Math.min(run.length, i + 4); j++) {
        const range = resolveRange(run.slice(i, j), reference);
        if (range) return range;
      }
    }
  }
  return null;
}

function rangeLabel(range, iso) {
  try {
    return new Intl.DateTimeFormat(intlLocale(iso), { dateStyle: 'long' }).formatRange(range.start, range.end);
  } catch {
    return `${formatIsoDate(range.start)} – ${formatIsoDate(range.end)}`;
  }
}

function contains(range, date) {
  return Boolean(range) && range.start <= date && date <= range.end;
}

// ---------------------------------------------------------------------------
// The pub-media listing

const listingCache = new TtlLruCache({ maxEntries: 60, ttlMs: HOUR_MS });

function pubMediaUrl({ pub, langCode, issue, formats }) {
  const params = new URLSearchParams({ output: 'json', pub, langwritten: langCode });
  if (issue) params.set('issue', issue);
  if (formats) params.set('fileformat', formats.join(','));
  return `${PUB_MEDIA_URL}?${params}`;
}

function compactListing(data, url) {
  if (!data || typeof data !== 'object' || !data.files || typeof data.files !== 'object') {
    throw new JwFetchError({
      kind: 'bad_content',
      url,
      message: `b.jw-cdn.org returned an unexpected publication listing for ${url}`,
      hint: 'JW.org may be changing its API; try again later.'
    });
  }
  const key = Object.keys(data.files)[0];
  const files = {};
  for (const [format, list] of Object.entries(data.files[key] ?? {})) {
    files[format.toUpperCase()] = (Array.isArray(list) ? list : [])
      .filter((f) => typeof f?.file?.url === 'string')
      .map((f) => ({
        title: decodeTitle(f.title),
        url: f.file.url,
        track: Number(f.track) || 0,
        mimetype: String(f.mimetype ?? ''),
        docid: Number(f.docid) || 0,
        // Video resolution ("240p"); documents carry "0p".
        label: /^[1-9]\d*p$/.test(f.label ?? '') ? f.label : null
      }));
  }
  const issue = String(data.issue ?? '');
  return {
    pubName: decodeTitle(data.pubName),
    formattedDate: decodeTitle(data.formattedDate),
    issue: /^\d{6}$/.test(issue) ? `${issue}00` : /^\d{8}$/.test(issue) ? issue : null,
    languageName: decodeTitle(data.languages?.[key]?.name) || null,
    languageLocale: decodeTitle(data.languages?.[key]?.locale) || null,
    files
  };
}

function fetchListing({ pub, langCode, issue, formats, deadline }) {
  const key = ['periodicals', pub, langCode, issue ?? '-', formats?.join(',') ?? '*'].join(':');
  return cached(
    key,
    HOUR_MS,
    async () => {
      const url = pubMediaUrl({ pub, langCode, issue, formats });
      return compactListing(await fetchJson(url, { deadline }), url);
    },
    { cache: listingCache }
  );
}

function isMissingListing(error) {
  return error instanceof JwFetchError && error.kind === 'http' && (error.status === 404 || error.status === 400);
}

// null when JW.org has no such listing; other failures propagate.
async function probeListing(ctx, langCode, issue) {
  try {
    return await fetchListing({ pub: ctx.pub, langCode, issue, formats: null, deadline: ctx.deadline });
  } catch (error) {
    if (isMissingListing(error)) return null;
    throw error;
  }
}

function describe(ctx, issue) {
  const name = PUBS[ctx.pub]?.name ?? `Publication "${ctx.pub}"`;
  if (!issue) return name;
  const forDate = ctx.autoIssue ? ` (the issue for the week of ${formatIsoDate(mondayOf(ctx.target))})` : '';
  return `${name} issue ${issue}${forDate}`;
}

function formatsError(ctx, issue, listing, wanted) {
  // Only formats this tool accepts, so the hint never names one it rejects.
  const available = Object.keys(listing.files).filter((f) => listing.files[f].length && FILE_FORMATS.includes(f));
  const textOnly = wanted.every((f) => TEXT_FORMATS.includes(f));
  return new ToolError(
    `${describe(ctx, issue)} exists in ${ctx.lang.name} (${ctx.lang.code}) but not as ${wanted.join(' or ')}; ` +
      `available formats: ${available.join(', ') || 'none'}.`,
    textOnly
      ? `${ctx.tools.contentTool} reads only RTF and TXT. Try another language (E, S, F ...), or call ${ctx.tools.linksTool} with one of the available formats as fileformat to get download links.`
      : 'Pass one of the available formats as fileformat.'
  );
}

async function missingListingError(ctx, issue, wanted, error) {
  if (error.status === 400) {
    return new ToolError(
      `JW.org rejected the request for ${describe(ctx, issue)} in ${ctx.lang.name} (${ctx.lang.code}) (HTTP 400).`,
      'Check the issue (YYYYMM00, e.g. 20260900) and the language code.'
    );
  }
  const all = await probeListing(ctx, ctx.lang.code, issue);
  if (all) return formatsError(ctx, issue, all, wanted);
  if (ctx.lang.code !== 'E' && (await probeListing(ctx, 'E', issue))) {
    return new ToolError(
      `${describe(ctx, issue)} is not available in ${ctx.lang.name} (${ctx.lang.code}).`,
      'Try another language, such as E (English).'
    );
  }
  // An issue at or before the current one is not "not published yet".
  const current = issue && issueForDate(ctx.pub, new Date());
  const past = Boolean(current) && issue.slice(0, 6) <= current.slice(0, 6);
  return new ToolError(
    `${describe(ctx, issue)} is not on JW.org${issue ? (past ? ' (no such issue)' : ' (not published yet, or no such issue)') : ''}.`,
    (past ? PUBS[ctx.pub]?.pastHint : PUBS[ctx.pub]?.notPublishedHint) ??
      'Check the publication code and the issue. Undated publications (books, yearly texts) take no issue.'
  );
}

async function loadListing(ctx, issue, request, wanted) {
  try {
    return await fetchListing({ pub: ctx.pub, langCode: ctx.lang.code, issue, formats: request, deadline: ctx.deadline });
  } catch (error) {
    if (isMissingListing(error)) throw await missingListingError(ctx, issue, wanted, error);
    throw error;
  }
}

function isZip(file) {
  return file.mimetype === 'application/zip' || /\.zip(?:$|[?#])/i.test(file.url);
}

// Drops the "Download All Files (ZIP)" bundles, unless a format has nothing else (DAISY).
function withoutZips(files) {
  const real = files.filter((f) => !isZip(f));
  return (real.length ? real : files).slice().sort((a, b) => a.track - b.track);
}

// ---------------------------------------------------------------------------
// One issue as a list of entries with week dates

async function datesFromEnglish(view, ctx, reference) {
  if (ctx.lang.code === 'E') return false;
  let english;
  try {
    english = await fetchListing({ pub: ctx.pub, langCode: 'E', issue: view.issue, formats: ['RTF'], deadline: ctx.deadline });
  } catch (error) {
    if (error instanceof ToolError || error instanceof JwFetchError) return false;
    throw error;
  }
  const byTrack = new Map();
  // Undated English titles ("2026 Memorial Bible Reading Schedule") name the numbered files ("ファイル 4").
  const titles = new Map();
  for (const f of withoutZips(english.files.RTF ?? [])) {
    const range = parseWeekRange(f.title, { locale: 'en', reference });
    if (range) byTrack.set(f.track, range);
    else if (f.title) titles.set(f.track, f.title);
  }
  let found = false;
  for (const entry of view.entries) {
    entry.range = byTrack.get(entry.track) ?? null;
    if (!entry.range && titles.has(entry.track)) entry.englishTitle = titles.get(entry.track);
    found ||= Boolean(entry.range);
  }
  return found;
}

// Last resort: consecutive weeks from the issue's first Monday, in track order.
function datesFromSchedule(view, ctx, span) {
  const candidates = ctx.pub === 'w' ? view.entries.filter((e) => e.track > 0) : view.entries;
  let monday = span.first;
  for (const entry of candidates) {
    if (monday >= span.next) break;
    entry.range = { start: monday, end: addDays(monday, 6) };
    monday = addDays(monday, 7);
  }
}

// The language for month names: a code resolved without the language list
// (periodicalLanguage) takes the locale pub-media reports.
function titleLocale(ctx, listing) {
  return ctx.lang.iso === 'und' ? listing.languageLocale || 'en' : ctx.lang.iso;
}

async function addWeekDates(view, ctx, textMode) {
  const span = issueSpan(ctx.pub, view.issue);
  const locale = titleLocale(ctx, view.listing);
  const parse = (title) => parseWeekRange(title, { locale, reference: span.reference });
  for (const entry of view.entries) entry.range = parse(entry.title);

  let source = 'title';
  if (textMode && !view.entries.some((e) => e.range)) {
    if (await datesFromEnglish(view, ctx, span.reference)) {
      source = 'english';
      view.notes.push(
        `The ${ctx.lang.name} file titles carry no dates, so week dates were matched by track from the English edition.`
      );
    } else {
      source = 'schedule';
      datesFromSchedule(view, ctx, span);
      view.notes.push(
        'The file titles carry no dates, so week dates are estimated from the issue schedule; check the first line of the text.'
      );
    }
  }

  // Video formats list each week once per resolution; those share a week number.
  const dated = view.entries.filter((e) => e.range).sort((a, b) => a.range.start - b.range.start || a.track - b.track);
  const starts = [...new Set(dated.map((e) => e.range.start.getTime()))];
  for (const entry of dated) entry.week = starts.indexOf(entry.range.start.getTime()) + 1;
  view.weeks = dated.filter((e, i) => i === 0 || e.week !== dated[i - 1].week);
  // Whole-issue files (PDF, EPUB ...) have no dates, so they get no type.
  if (textMode || view.weeks.length) {
    for (const entry of view.entries) entry.type = entry.range ? PUBS[ctx.pub].weekType : 'other';
  }
  for (const entry of view.entries) {
    if (entry.englishTitle && !entry.range) entry.title = `${entry.englishTitle} (English title)`;
  }

  // Audio entries carry the document id of the week's jw.org page, and dated
  // titles in languages whose text files are only numbered ("ファイル 4").
  const audio = new Map();
  for (const f of view.listing.files.MP3 ?? []) {
    const range = parse(f.title);
    if (range) audio.set(formatIsoDate(range.start), f);
  }
  const pageLink = (docid) => `https://www.jw.org/finder?wtlocale=${encodeURIComponent(ctx.lang.code)}&docid=${docid}`;
  let matched = 0;
  let sameTracks = true;
  for (const entry of dated) {
    const track = audio.get(formatIsoDate(entry.range.start));
    if (track?.docid > 0) entry.link = pageLink(track.docid);
    if (track) {
      matched += 1;
      sameTracks &&= track.track === entry.track;
    }
    if (source !== 'title') entry.title = track?.title || rangeLabel(entry.range, locale);
  }
  // Where the dated audio shares the text files' track numbers (the Watchtower, not the
  // workbook), the track also gives the undated articles (Life Story, Did You Know?) a page.
  if (matched && sameTracks) {
    const byTrack = new Map((view.listing.files.MP3 ?? []).map((f) => [f.track, f]));
    for (const entry of view.entries) {
      const docid = entry.range || entry.track < 1 ? 0 : byTrack.get(entry.track)?.docid;
      if (docid > 0) entry.link = pageLink(docid);
    }
  }
}

async function buildView(ctx, issue) {
  const scheduled = Boolean(PUBS[ctx.pub] && issue);
  const textMode = TEXT_FORMATS.includes(ctx.fileformat);
  const order = ctx.fileformat === 'TXT' ? ['TXT', 'RTF'] : textMode ? ['RTF', 'TXT'] : [ctx.fileformat];
  const listing = await loadListing(ctx, issue, scheduled && textMode ? [...order, 'MP3'] : order, order);
  const format = order.find((f) => listing.files[f]?.length);
  if (!format) {
    const all = (await probeListing(ctx, ctx.lang.code, issue)) ?? listing;
    throw formatsError(ctx, issue, all, order);
  }

  const view = {
    listing,
    issue: listing.issue ?? issue,
    format,
    entries: withoutZips(listing.files[format]).map((f) => ({ title: f.title, url: f.url, track: f.track, label: f.label })),
    weeks: [],
    notes: []
  };
  if (textMode && format !== order[0]) {
    view.notes.push(`${ctx.lang.name} has no ${order[0]} files for this issue, so these are ${format} files (${ctx.tools.contentTool} reads both).`);
  }
  if (!textMode) {
    view.notes.push(`These are ${format} download links; ${ctx.tools.contentTool} reads only RTF and TXT files.`);
  }
  if (scheduled && view.issue) await addWeekDates(view, ctx, textMode);
  return view;
}

function findWeek(view, date) {
  return view.weeks.find((e) => contains(e.range, date)) ?? null;
}

// The undated item filed between the weeks around a date the issue skips,
// such as the Memorial Bible Reading Schedule in Memorial week.
function gapEntry(view, date) {
  const next = view.weeks.findIndex((e) => e.range.start > date);
  if (next < 1) return null;
  const before = view.weeks[next - 1].track;
  const after = view.weeks[next].track;
  return view.entries.find((e) => e.type === 'other' && e.track > before && e.track < after) ?? null;
}

function gapText(ctx, gap) {
  const why = PUBS[ctx.pub].skipped ? `${PUBS[ctx.pub].skipped}; ` : '';
  return `${why}the issue files "${gap.title}" there instead`;
}

// The listing for ctx.issue. When that issue was derived from the date but
// its dated weeks do not reach the date, the neighbouring issue is tried once.
async function resolveView(ctx) {
  const view = await buildView(ctx, ctx.issue);
  if (!ctx.autoIssue || !view.weeks.length || findWeek(view, ctx.target)) return view;
  const step = ctx.target < view.weeks[0].range.start ? -1 : ctx.target > view.weeks.at(-1).range.end ? 1 : 0;
  if (!step) return view;
  try {
    const other = await buildView(ctx, shiftIssue(ctx.pub, view.issue, step));
    if (findWeek(other, ctx.target)) {
      other.notes.push(`The week of ${formatIsoDate(ctx.target)} is listed in issue ${other.issue}, not ${view.issue}.`);
      return other;
    }
  } catch (error) {
    if (!(error instanceof ToolError || error instanceof JwFetchError)) throw error;
  }
  return view;
}

function entryJson(entry, ctx) {
  const out = { title: entry.title };
  if (entry.type) out.type = entry.type;
  if (entry.range) {
    out.week = entry.week;
    out.week_start = formatIsoDate(entry.range.start);
    out.week_end = formatIsoDate(entry.range.end);
    out.is_current_week = contains(entry.range, ctx.target);
  }
  // No track: the workbook's is 0-based and the Watchtower's equals week, so it was mistaken for week.
  if (entry.label) out.resolution = entry.label;
  out.url = entry.url;
  if (entry.link) out.link = entry.link;
  return out;
}

// ---------------------------------------------------------------------------
// The tools

// pub-media takes the JW code itself, so a code still works when the mediator
// language list is down (as it did before that list was used).
async function periodicalLanguage(value, deadline) {
  const input = isMissing(value) ? 'E' : value;
  try {
    return await resolveLanguage(input, { name: 'langwritten', wol: false, deadline });
  } catch (error) {
    const code = typeof input === 'string' ? input.trim() : '';
    if (!(error instanceof JwFetchError) || !/^[A-Z][A-Z0-9-]{0,5}$/.test(code)) throw error;
    // iso 'und': DA/da and TL/tl are different languages; titleLocale uses the listing's locale.
    return { code, iso: 'und', name: code, vernacular: code, jwPath: null, rtl: false, signLanguage: false, wol: undefined };
  }
}

async function baseContext(args, tools, pub, fileformat) {
  const { issue, note } = normalizeIssue(args.issue, pub);
  const target = toIsoDate(args.date, 'date');
  const deadline = Date.now() + TOOL_BUDGET_MS;
  return {
    pub,
    tools,
    fileformat,
    target,
    lang: await periodicalLanguage(args.langwritten, deadline),
    issue: issue ?? issueForDate(pub, target),
    autoIssue: !issue,
    issueNote: note,
    deadline
  };
}

function weekList(view) {
  return view.weeks.map((e) => `${e.week}) ${formatIsoDate(e.range.start)} ${e.title}`).join('; ');
}

/** getWorkbookLinks / getWatchtowerLinks. */
export async function periodicalLinks(rawArgs, tools) {
  const args = requireArgs(rawArgs);
  const pub = toStr(args.pub, 'pub', {
    default: tools.pub,
    maxLength: 20,
    pattern: /^[a-z0-9-]+$/i,
    patternText: `a JW.org publication code such as "${tools.pub}"`
  }).toLowerCase();
  const fileformat = toEnum(args.fileformat, 'fileformat', FILE_FORMATS, { default: 'RTF' });
  const ctx = await baseContext(args, tools, pub, fileformat);
  const view = await resolveView(ctx);
  const notes = [ctx.lang.note, ctx.issueNote, ...view.notes].filter(Boolean);

  const out = {
    pubName: view.listing.pubName,
    formattedDate: view.listing.formattedDate,
    issue: view.issue,
    language: view.listing.languageName ?? ctx.lang.name,
    langwritten: ctx.lang.code,
    fileformat: view.format
  };
  if (PUBS[pub] && view.issue && (TEXT_FORMATS.includes(fileformat) || view.weeks.length)) {
    const current = findWeek(view, ctx.target);
    out.date = formatIsoDate(ctx.target);
    out.current_week = current ? entryJson(current, ctx) : null;
    if (!current && view.weeks.length) {
      const expected = issueForDate(pub, ctx.target);
      const monday = formatIsoDate(mondayOf(ctx.target));
      const gap = expected === view.issue ? gapEntry(view, ctx.target) : null;
      notes.push(
        gap
          ? `This issue has no ${PUBS[pub].one} for the week of ${monday}: ${gapText(ctx, gap)} (${tools.contentTool} with its url reads it).`
          : expected === view.issue
            ? `This issue has no ${PUBS[pub].one} for the week of ${monday}.`
            : `${out.date} is not in this issue; its week is in issue ${expected}.`
      );
    }
  }
  out[tools.listKey] = view.entries.slice(0, MAX_LIST_ENTRIES).map((e) => entryJson(e, ctx));
  if (view.entries.length > MAX_LIST_ENTRIES) {
    out.total_entries = view.entries.length;
    notes.push(`Showing the first ${MAX_LIST_ENTRIES} of ${view.entries.length} files. ${tools.linksTool} is meant for the ${PUBS[tools.pub].name}; ask for a narrower fileformat or issue.`);
  }
  if (notes.length) out.note = notes.join(' ');
  return out;
}

function pickWeek(view, ctx, { week, dateGiven }) {
  const info = PUBS[ctx.pub];
  const what = describe({ ...ctx, autoIssue: false }, view.issue);
  const count = view.weeks.length;
  if (!count) {
    throw new ToolError(
      `Could not tell which files in ${what} are ${info.many}.`,
      `Call ${ctx.tools.linksTool} and pass the url of the file you want.`
    );
  }
  if (week !== undefined) {
    if (week > count) {
      throw new ArgError('week', week, `a number from 1 to ${count} (issue ${view.issue} has ${count} ${info.many})`, {
        hint: `The ${info.many} are: ${weekList(view)}.`
      });
    }
    const entry = view.weeks[week - 1];
    if (dateGiven && !contains(entry.range, ctx.target)) {
      const day = formatIsoDate(ctx.target);
      const found = findWeek(view, ctx.target);
      const where = found ? `${day} is in week ${found.week} (${found.title})` : `${day} is not in any week of issue ${view.issue}`;
      throw new ArgError('week', week, `the week holding date ${day}, or date left out`, {
        hint: `${where}; week ${week} is ${formatIsoDate(entry.range.start)} ${entry.title}. date and week are alternatives: pass date alone, or issue + week.`
      });
    }
    return entry;
  }
  const found = findWeek(view, ctx.target);
  if (found) return found;
  const expected = issueForDate(ctx.pub, ctx.target);
  if (!ctx.autoIssue && expected !== view.issue) {
    const first = formatIsoDate(view.weeks[0].range.start);
    const last = formatIsoDate(view.weeks.at(-1).range.end);
    const day = formatIsoDate(ctx.target);
    throw new ToolError(
      dateGiven
        ? `${what} covers ${first} to ${last}; the week of ${day} is in issue ${expected}. Its ${info.many}: ${weekList(view)}.`
        : `${what} covers ${first} to ${last}, which does not include today (${day}). Its ${info.many}: ${weekList(view)}.`,
      dateGiven
        ? `Leave issue out (date alone picks the issue), or drop date and pass week (1-${count}) for a week of this issue.`
        : `Pass week (1-${count}) or a date in that range, or leave issue out for the current week.`
    );
  }
  const monday = mondayOf(ctx.target);
  const span = `${formatIsoDate(monday)} to ${formatIsoDate(addDays(monday, 6))}`;
  const gap = gapEntry(view, ctx.target);
  if (gap) {
    throw new ToolError(
      `${what} has no ${info.one} for ${span}: ${gapText(ctx, gap)}. Its ${info.many}: ${weekList(view)}.`,
      `To read "${gap.title}", call ${ctx.tools.contentTool} with url ${gap.url}. For a ${info.one}, pass week (1-${count}) or a date in one.`
    );
  }
  throw new ToolError(
    `${what} has no ${info.one} for ${span}. Its ${info.many}: ${weekList(view)}.`,
    `Pick one of those with week (1-${count}) or date, or call ${ctx.tools.linksTool} to see the whole issue.`
  );
}

// File names look like mwb_E_202609_04.rtf, or w_E_20150115_03.rtf for a dated issue.
function fileMeta(url) {
  const m = /\/([a-z0-9]+)_([A-Z0-9-]+)_(\d{6}(?:\d{2})?)(?:_\d+)?\.(?:rtf|txt)$/i.exec(new URL(url).pathname);
  if (!m) return {};
  return { pub: m[1].toLowerCase(), issue: m[3].length === 8 ? m[3] : `${m[3]}00`, langwritten: m[2].toUpperCase() };
}

// What the other modes return about a file read by url: title, week dates, and
// pubName, language and link from the issue's listing (one request, cached).
async function urlFileHeader(file, { pub, issue, langwritten }, tools, deadline, notes) {
  const out = { title: file.title };
  if (!file.title || !PUBS[pub] || !issue || !langwritten) return out;
  let lang;
  try {
    // The file name's code is a JW code (TL is Tamil, not Tagalog).
    lang = await resolveLanguage(langwritten, { as: 'code', wol: false });
  } catch (error) {
    // The dates are extras; an unknown code or an unreachable language list must not fail the read.
    if (error instanceof ArgError || error instanceof JwFetchError) return out;
    throw error;
  }
  const range = parseWeekRange(file.title, { locale: lang.iso, reference: issueSpan(pub, issue).reference });
  if (range) {
    out.week_start = formatIsoDate(range.start);
    out.week_end = formatIsoDate(range.end);
  }
  out.issue = issue;
  let view;
  try {
    // The text is already here: a hung pub-media must not hold it up long.
    const lookup = Math.min(deadline, Date.now() + 15000);
    view = await buildView({ pub, tools, fileformat: file.format, target: new Date(), lang, issue, autoIssue: false, deadline: lookup }, issue);
  } catch (error) {
    if (!(error instanceof ToolError || error instanceof JwFetchError)) throw error;
    notes.push(`pubName, language and link are left out: the issue ${issue} listing could not be loaded (${error.message}).`);
    return out;
  }
  out.pubName = view.listing.pubName;
  out.language = view.listing.languageName ?? lang.name;
  // The file name, not the whole url: the hash segment of a CDN path can differ.
  const name = (u) => new URL(u).pathname.split('/').pop();
  const entry = view.entries.find((e) => name(e.url).toLowerCase() === name(file.url).toLowerCase());
  if (entry?.link) out.link = entry.link;
  else notes.push(`link is left out: issue ${issue} lists no jw.org page for ${name(file.url)}.`);
  return out;
}

// parsedText, or one page of it with offset/next_offset and a note on how to read on.
function pagedText(text, { offset, maxChars }, tools, notes) {
  const part = pageByTokens(text, offset, maxChars);
  if (offset === 0 && part.next_offset === null) return { parsedText: text };
  if (part.next_offset !== null) {
    notes.push(
      `parsedText is characters ${offset}-${offset + part.text.length} of ${text.length}; call ${tools.contentTool} again with the same arguments and offset = next_offset for the rest.`
    );
  }
  return { offset, next_offset: part.next_offset, total_chars: text.length, parsedText: part.text };
}

function noteOf(notes) {
  return notes.length ? { note: notes.join(' ') } : {};
}

/** getWorkbookContent / getWatchtowerContent. */
export async function periodicalContent(rawArgs, tools) {
  const args = requireArgs(rawArgs);
  const page = {
    maxChars: toInt(args.max_chars, 'max_chars', { min: 1000, max: MAX_MAX_CHARS, default: DEFAULT_MAX_CHARS }),
    offset: toInt(args.offset, 'offset', { min: 0, default: 0 })
  };
  if (!isMissing(args.url)) {
    const deadline = Date.now() + TOOL_BUDGET_MS;
    const file = await fetchPeriodicalText(args.url, { deadline });
    const { pub, ...meta } = fileMeta(file.url);
    const notes = [];
    const text = pagedText(file.text, page, tools, notes);
    const header = await urlFileHeader(file, { pub, ...meta }, tools, deadline, notes);
    const { link, ...rest } = header;
    return { ...rest, ...meta, fileformat: file.format, url: file.url, ...(link ? { link } : {}), ...noteOf(notes), ...linksOf(file), ...text };
  }

  const week = toInt(args.week, 'week', { min: 1, max: 20, optional: true });
  const ctx = await baseContext(args, tools, tools.pub, 'RTF');
  const view = await resolveView(ctx);
  const entry = pickWeek(view, ctx, { week, dateGiven: !isMissing(args.date) });
  const file = await fetchPeriodicalText(entry.url, { deadline: ctx.deadline });
  const notes = [ctx.lang.note, ctx.issueNote, ...view.notes].filter(Boolean);
  const text = pagedText(file.text, page, tools, notes);
  return {
    title: entry.title,
    week_start: formatIsoDate(entry.range.start),
    week_end: formatIsoDate(entry.range.end),
    issue: view.issue,
    pubName: view.listing.pubName,
    language: view.listing.languageName ?? ctx.lang.name,
    langwritten: ctx.lang.code,
    fileformat: file.format,
    url: file.url,
    ...(entry.link ? { link: entry.link } : {}),
    ...noteOf(notes),
    ...linksOf(file),
    ...text
  };
}

// Song videos (finder?lank=) and cited publications (finder?docid=) linked
// in the RTF. Song videos have no captions, so each is followed by its lyrics
// page on WOL.
function linksOf(file) {
  if (!file.links?.length) return {};
  return { links: file.links.flatMap((link) => [link, songLyricsLink(link)].filter(Boolean)) };
}

function songLyricsLink(link) {
  let u;
  try {
    u = new URL(link.url);
  } catch {
    return null;
  }
  const song = songOfKey(u.searchParams.get('lank')?.trim());
  const docid = song && songbookDocid(song);
  if (!docid) return null;
  const wtlocale = u.searchParams.get('wtlocale') || 'E';
  return { text: `${link.text} lyrics`, url: `https://www.jw.org/finder?wtlocale=${encodeURIComponent(wtlocale)}&docid=${docid}` };
}

// ---------------------------------------------------------------------------
// Downloading one RTF/TXT file

const textCache = new TtlLruCache({ maxEntries: 20, ttlMs: HOUR_MS });
const FILE_URL_TEXT = 'an https link to an .rtf or .txt file on cfp2.jw-cdn.org, as listed by the links tools';
const FILE_URL_HINT = 'Leave url out and pass date (YYYY-MM-DD) or issue + week instead; the tool then finds the file itself.';
const STALE_LINK_HINT = `JW.org's file server answers 403 or 404 when a file does not exist; the link may be old or mistyped. ${FILE_URL_HINT}`;

function checkFileUrl(value) {
  let url;
  try {
    url = new URL(toJwUrl(value, 'url', { allowHosts: CDN_HOSTS }));
  } catch (error) {
    if (!(error instanceof ArgError) || error.tooLong) throw error;
    const s = typeof value === 'string' ? value.trim() : '';
    if (/^(?:https?:\/\/)?(?:www\.)?jw\.org\//i.test(s)) {
      throw new ArgError('url', value, FILE_URL_TEXT, {
        message: 'Invalid "url": that is a jw.org page link (the "link" field), not a file. Pass the "url" field of the same entry from the links tool (a cfp2.jw-cdn.org .rtf file).',
        hint: FILE_URL_HINT
      });
    }
    throw new ArgError('url', value, FILE_URL_TEXT, { hint: FILE_URL_HINT });
  }
  if (!/\.(rtf|txt)$/i.test(url.pathname)) {
    const ext = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toUpperCase();
    throw new ArgError('url', value, FILE_URL_TEXT, {
      message: `Invalid "url": this tool reads RTF or TXT files only, and ${url.href} is ${ext ? `a ${ext} file` : 'not one'}.`,
      hint: FILE_URL_HINT
    });
  }
  return url.href;
}

function txtToText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t　]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Download an RTF or TXT file from JW.org's CDN and return
 * { url, format: 'RTF'|'TXT', title, text, links } with the text converted to plain text.
 */
export async function fetchPeriodicalText(rawUrl, { deadline } = {}) {
  const url = checkFileUrl(rawUrl);
  return cached(
    `periodicals:text:${url}`,
    HOUR_MS,
    async () => {
      const res = await fetchResource(url, {
        allowHosts: CDN_HOSTS,
        maxBytes: MAX_FILE_BYTES,
        deadline,
        accept: 'application/rtf, text/rtf, text/plain;q=0.9, */*;q=0.5',
        hints: { 403: STALE_LINK_HINT, 404: STALE_LINK_HINT }
      });
      const raw = new TextDecoder('utf-8').decode(res.buffer).replace(/^﻿/, '');
      let format;
      let text;
      let title = null;
      let links = [];
      if (raw.trimStart().startsWith('{\\rtf')) {
        format = 'RTF';
        try {
          ({ text, title, links } = parseRTFDocument(res.buffer));
        } catch (error) {
          throw new ToolError(
            `Could not convert the RTF file at ${res.url}: ${error.message}`,
            'The file may be damaged or in an unexpected layout. Try another week or language.'
          );
        }
      } else if (/\.txt$/i.test(new URL(res.url).pathname) || /^text\/plain/i.test(res.contentType)) {
        format = 'TXT';
        text = txtToText(raw);
      } else {
        throw new JwFetchError({
          kind: 'bad_content',
          url: res.url,
          message: `${res.url} is not an RTF or TXT file (content type ${res.contentType || 'unknown'})`,
          hint: FILE_URL_HINT
        });
      }
      if (!text?.trim()) {
        throw new ToolError(`The ${format} file at ${res.url} contains no text.`, 'Try another week or language.');
      }
      // The RTF \info title is the whole heading even where the first line is the cover (mwb_*_00) or only the date (Japanese).
      title ||= text.split('\n').find((line) => line.trim())?.trim() ?? null;
      return { url: res.url, format, title, text, links };
    },
    { cache: textCache }
  );
}

/** For tests: forget cached listings and files. */
export function clearPeriodicalCaches() {
  listingCache.clear();
  textCache.clear();
}
