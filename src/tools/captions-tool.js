// get_jw_captions: finds a JW.org video from a key or a jw.org link, downloads
// its WebVTT captions and returns them as a readable, paged transcript.

import { ArgError, describeValue, formatIsoDate, isMissing, requireArgs, toEnum, toInt, toStr } from './args.js';
import { TtlLruCache, cached } from './cache.js';
import { DEFAULT_TIMEOUT_MS, JwFetchError, fetchJson, fetchText } from './http.js';
import { lookupLanguage, resolveLanguage } from './languages.js';
import { PAGE_TOKENS, ToolError, charsWithinTokens, wrapTool } from './results.js';
import { isSongKey, songOfKey, songbookDocid } from './songbook.js';
import { NO_SPACE_SCRIPT, joinText, lastChar } from './text.js';

const MEDIATOR_ROOT = 'https://b.jw-cdn.org/apis/mediator/v1';
const MEDIATOR = `${MEDIATOR_ROOT}/media-items`;
const BROADCAST_CATEGORY = 'StudioMonthlyPrograms';
const ENGLISH = lookupLanguage('E');
const FORMATS = ['text', 'plain', 'vtt'];
const FORMAT_ALIASES = { __proto__: null, timed: 'text', timestamped: 'text', transcript: 'text', raw: 'vtt', webvtt: 'vtt' };
// A monthly program (55-65 min, about 775 characters a minute) fits one part.
const DEFAULT_MAX_CHARS = 60000;
const MIN_MAX_CHARS = 1000;
// A part also ends near PAGE_TOKENS estimated tokens (Japanese runs about a token a character).
const MAX_MAX_CHARS = 80000;
const MAX_VTT_CHARS = 50000; // VTT cue timings cost about twice the tokens of prose
const CACHE_TTL_MS = 30 * 60 * 1000;
// Paragraphs close at the first sentence end after 30 s, at 60 s regardless,
// and before speech that resumes after a 10 s silence (music, scene change).
const PARAGRAPH_MIN_S = 30;
const PARAGRAPH_MAX_S = 60;
const PARAGRAPH_GAP_S = 10;

// Mediator lookups and page scans are small; caption files can reach 200 KB.
const metaCache = new TtlLruCache({ maxEntries: 200, ttlMs: CACHE_TTL_MS });
const vttCache = new TtlLruCache({ maxEntries: 16, ttlMs: CACHE_TTL_MS });

const ACCEPTED =
  `a JW.org video key such as pub-jwb-142_1_VIDEO or docid-502014331_1_VIDEO, a docid number, a jw.org video link, latest:<category>[~N] (latest:${BROADCAST_CATEGORY} is the newest JW Broadcasting monthly program, ~N the Nth before it), or "<Month> [<Year>] broadcast"`;
const LINK_HINT =
  `Pass latest:<Category> (e.g. latest:${BROADCAST_CATEGORY}; its notes list the keys of earlier videos, and latest:<Category>~N reads the Nth before the newest, as "previous broadcast" does), a monthly program by month ("September 2026 broadcast", "last month's broadcast"), a key such as pub-jwb-142_1_VIDEO, or a jw.org video link (the user can copy one from the video's Share menu).`;
// latest:<Category>~N reaches back at most this far.
const MAX_BACK = 499;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export const captionsTool = {
  name: 'get_jw_captions',
  description:
    'Transcript of a JW.org video: a JSON metadata block (title, duration, published, link), then paragraphs with [m:ss] markers. ' +
    'video_id "latest broadcast" (or morning worship, Governing Body update, talk) is the newest one; its notes list older ones\' keys. ' +
    'Long transcripts come in parts: call again with offset = next_offset. ' +
    'No caption file: captions_available: false, the reason and next_step.',
  inputSchema: {
    type: 'object',
    properties: {
      video_id: {
        type: 'string',
        description: 'A key (pub-jwb-142_1_VIDEO), docid, jw.org video link, latest:<Category> or a category link (its newest video by date); latest:<Category>~N the Nth before it; "August 2026 broadcast".'
      },
      langwritten: {
        type: 'string',
        description: 'Default: the link\'s, else E; falls back to English with a note.'
      },
      format: { type: 'string', enum: FORMATS, description: 'text (default, [m:ss] markers), plain, or vtt (raw WebVTT).' },
      max_chars: { type: 'integer', minimum: MIN_MAX_CHARS, maximum: MAX_MAX_CHARS, description: `Default ${DEFAULT_MAX_CHARS} (vtt ${MAX_VTT_CHARS}); parts end sooner in CJK.` },
      offset: { type: 'integer', minimum: 0, description: 'next_offset of the last call.' }
    },
    required: ['video_id']
  }
};

// ---------------------------------------------------------------------------
// Reading video references

// pub-<symbol>[_<issue>]_<track>_VIDEO or docid-<n>_<track>_VIDEO, optionally
// with a language segment after the first underscore (the "natural key").
const KEY_RE = /\b((?:pub-[a-z0-9][a-z0-9-]*|docid-\d+)(?:_[a-z0-9]+)+_video)\b/i;
const URLISH_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$))/i;
const LOCALE_SEGMENT = '[a-z]{2,3}(?:-[a-z0-9]{2,8})*';

function isJwHost(host) {
  return /(^|\.)jw\.org$/.test(host) || /(^|\.)jw-cdn\.org$/.test(host);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 'pub-jwb-142_S_1_VIDEO' -> { key: 'pub-jwb-142_1_VIDEO', lang: 'S' }. In
// language-agnostic keys the segments after the symbol are digits or "x".
function normalizeKey(raw) {
  const parts = raw.split('_');
  const head = parts.shift().toLowerCase();
  parts.pop();
  let lang = null;
  if (parts.length >= 2 && /[a-z]/i.test(parts[0])) lang = parts.shift().toUpperCase();
  return { key: [head, ...parts.map((p) => p.toLowerCase()), 'VIDEO'].join('_'), lang };
}

// Free-text names of common categories, tried in order ("Governing Body talk"
// is a talk); the third column names a SERIES within the category.
const CATEGORY_ALIASES = [
  [/morning\s*worship/i, 'VODPgmEvtMorningWorship'],
  [/\btalks?\b/i, 'StudioTalks'],
  [/governing\s*body|\bupdates?\b/i, 'StudioNewsReports', 'gbUpdate'],
  [/news|announcement/i, 'StudioNewsReports'],
  [/featured/i, 'StudioFeatured'],
  [/broadcast|monthly|^programs?$/i, BROADCAST_CATEGORY]
];
// StudioNewsReports also lists news reports and "—Excerpt" reposts of old
// updates (pub-mwbv_ meeting videos); only the English titles mark the real
// updates, so a series is picked by the keys of its English titles.
const SERIES = {
  __proto__: null,
  gbUpdate: {
    label: 'Governing Body update',
    ref: 'latest Governing Body update',
    titled: '"<year> Governing Body Update #<n>"',
    test: (m) => /^\d{4} Governing Body Update #\d+$/.test(m?.title ?? '')
  }
};
const WORD_RE = /^[A-Za-z][A-Za-z0-9]{2,60}$/;
const KNOWN_CATEGORIES =
  `latest:${BROADCAST_CATEGORY} (monthly program), latest:VODPgmEvtMorningWorship (Morning Worship), "latest Governing Body update" (the updates only), latest:StudioNewsReports (all news and announcements, excerpts included), latest:StudioTalks (talks), latest:StudioFeatured, or "latest" for the newest video on jw.org`;
const CATEGORY_HINT = `Use one of ${KNOWN_CATEGORIES}; for another category, pass its jw.org link (Videos > the category).`;

// A camel-case key (VODProgramsEvents, StudioMonthlyPrograms) is used as given,
// even when it contains "Program"; all-caps BROADCAST is free text.
function isCategoryKey(w) {
  return WORD_RE.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w.slice(1));
}

// 'latest' -> LatestVideos; a category key as given; common names (broadcast,
// morning worship, Governing Body update, talk) -> their category, and series.
function categoryFromWords(words) {
  const w = words.trim();
  if (!w || /^videos?$/i.test(w)) return { category: 'LatestVideos' };
  if (isCategoryKey(w)) return { category: w };
  const alias = CATEGORY_ALIASES.find(([re]) => re.test(w));
  if (alias) return { category: alias[1], ...(alias[2] && { series: alias[2] }) };
  if (WORD_RE.test(w)) return { category: w };
  throw new ArgError('video_id', `latest ${w}`, ACCEPTED, {
    message: `${describeValue(`latest ${w}`)} names no JW.org video category this tool knows.`,
    hint: CATEGORY_HINT
  });
}

function notAVideo(input, why) {
  return new ArgError('video_id', input, ACCEPTED, {
    message: `Could not find a JW.org video in ${describeValue(input)}${why ? ` (${why})` : ''}. Expected ${ACCEPTED}.`,
    hint: LINK_HINT
  });
}

// "latest broadcast~2" or "previous broadcast": the category and how many
// videos before the newest (back). "~N" is read before the name, so it is
// never taken for part of a category key.
function categoryRef(words, back, input) {
  const m = /^(.*?)\s*~\s*(\d{1,4})$/.exec(words);
  const n = back + (m ? Number(m[2]) : 0);
  if (n > MAX_BACK) {
    throw new ArgError('video_id', input, ACCEPTED, {
      message: `${describeValue(input)} reaches back ${n} videos; the limit is ${MAX_BACK}.`,
      hint: 'Pass the key of the video instead; the notes of a latest: read list earlier keys.'
    });
  }
  return { kind: 'category', ...categoryFromWords(m ? m[1] : words), back: n, langHints: [] };
}

const MONTH_NAME = `(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`;
const PROGRAM = '(?:jw\\s+)?(?:broadcast(?:ing)?|monthly\\s+program)';
const MONTH_FIRST = new RegExp(`^(?:the\\s+)?(?:jw\\s+)?(?:${MONTH_NAME}|(\\d{4})-(\\d{2}))\\s+${PROGRAM}$`, 'i');
const PROGRAM_FIRST = new RegExp(`^(?:the\\s+)?${PROGRAM}\\s*[-–—,:]?\\s*(?:${MONTH_NAME}|(\\d{4})-(\\d{2}))$`, 'i');

const yearMonth = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

// "August 2026 broadcast", "2026-08 monthly program", "JW Broadcasting—August 2026" -> '2026-08'.
// A month without a year is its latest occurrence up to `now` (the server's local date).
function monthOf(s, now) {
  const m = MONTH_FIRST.exec(s) ?? PROGRAM_FIRST.exec(s);
  if (!m) return null;
  if (!m[1]) return Number(m[4]) >= 1 && Number(m[4]) <= 12 ? `${m[3]}-${m[4]}` : null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  const year = m[2] ? Number(m[2]) : now.getFullYear() - (month > now.getMonth() + 1 ? 1 : 0);
  return yearMonth(year, month);
}

// "last month's broadcast", "this month's JW Broadcasting", "last week's morning worship".
const RELATIVE = /^(?:the\s+)?(this|last|previous|past)\s+(month|week)(?:['’]?s)?\s+(.+)$/i;

// Relative months are read against the server's local date. Only the monthly
// program is found by date: other categories upload irregularly (two Morning
// Worships on one day), so "last week's" cannot be mapped to a ~N.
function relativeRef(s, now) {
  const m = RELATIVE.exec(s);
  if (!m) return null;
  const [, which, unit, words] = m;
  const { category, series } = categoryFromWords(words);
  const per = unit.toLowerCase();
  if (category === BROADCAST_CATEGORY && per === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth() - (/^this$/i.test(which) ? 0 : 1), 1);
    return { kind: 'category', category, month: yearMonth(d.getFullYear(), d.getMonth() + 1), langHints: [] };
  }
  const today = `Today on this server is ${formatIsoDate(now)}.`;
  if (category === BROADCAST_CATEGORY) {
    throw new ArgError('video_id', s, ACCEPTED, {
      message: `${describeValue(s)} names the monthly program by week, but JW Broadcasting comes out once a month.`,
      hint: `Pass "this month's broadcast" or "last month's broadcast" (or "September 2026 broadcast"). ${today}`
    });
  }
  throw new ArgError('video_id', s, ACCEPTED, {
    message: `${describeValue(s)} names a video by ${per}; only the monthly program (${BROADCAST_CATEGORY}) is found by date.`,
    hint: `Pass ${series ? `"${SERIES[series].ref}"` : `latest:${category} (or "latest ${words.trim()}")`}: its published date and the notes' list of earlier keys with dates show which one you mean; then pass that key. ${today}`
  });
}

/**
 * Parse anything a user might paste into { kind: 'key'|'docid'|'page'|'category',
 * key?, docid?, pageUrl?, category?, series?, back?, month?,
 * langHints: [{ value, from, code }] } (code: the hint is certainly a JW
 * code). `now` (default: the server's local date) dates "last month's
 * broadcast" and "September broadcast". No network; throws ArgError.
 */
export function parseVideoReference(input, { now = new Date() } = {}) {
  const s = String(input).trim();
  if (URLISH_RE.test(s)) return parseUrlReference(s);
  const relative = relativeRef(s, now);
  if (relative) return relative;

  const latest = /^(?:the\s+)?(?:latest|newest)\b\s*:?\s*(.*)$/i.exec(s);
  if (latest) return categoryRef(latest[1], 0, s);
  // "the last broadcast" usually means the most recent one, so only "previous" steps back.
  const previous = /^(?:the\s+)?(previous|last)\s+(.+)$/i.exec(s);
  if (previous) return categoryRef(previous[2], /^previous$/i.test(previous[1]) ? 1 : 0, s);
  const month = monthOf(s, now);
  if (month) return { kind: 'category', category: BROADCAST_CATEGORY, month, langHints: [] };

  const m = KEY_RE.exec(s);
  if (m) {
    const { key, lang } = normalizeKey(m[1]);
    return { kind: 'key', key, langHints: lang ? [{ value: lang, from: `the key ${m[1]}`, code: true }] : [] };
  }
  const docid = /^(?:docid[-=:\s]*)?(\d{6,12})$/i.exec(s);
  if (docid) return { kind: 'docid', docid: docid[1], langHints: [] };
  throw notAVideo(s);
}

function parseUrlReference(s) {
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`);
  } catch {
    throw notAVideo(s, 'not a valid link');
  }
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || !isJwHost(host)) {
    throw new ArgError('video_id', s, ACCEPTED, {
      message: `${describeValue(s)} is not a JW.org link; get_jw_captions only reads videos published on jw.org.`,
      hint: LINK_HINT
    });
  }

  const params = url.searchParams;
  const path = safeDecode(url.pathname);
  const hash = safeDecode(url.hash.slice(1));
  const hashLocale = new RegExp(`^(${LOCALE_SEGMENT})/`, 'i').exec(hash)?.[1];
  const pathLocale = new RegExp(`^/(${LOCALE_SEGMENT})(?:/|$)`, 'i').exec(path)?.[1];
  const mediatorLang = /\/media-items\/([A-Za-z0-9-]+)\//.exec(path)?.[1];

  const haystack = [params.get('lank'), params.get('item'), path, hash, safeDecode(url.search)].filter(Boolean).join(' ');
  const keyMatch = KEY_RE.exec(haystack);
  const natural = keyMatch ? normalizeKey(keyMatch[1]) : null;

  // Most specific first: the finder's wtlocale, the video site's #<locale>,
  // a natural key's language, then the page's own locale.
  // wtlocale=, appLanguage=, a key's language and media-items/<code>/ are JW
  // codes (TL = Tamil); #<locale>/ and /<locale>/ are locale tags (tl = Tagalog).
  const langHints = [
    [params.get('wtlocale'), 'wtlocale in the link', true],
    [params.get('appLanguage'), 'appLanguage in the link', true],
    [hashLocale, `#${hashLocale}/ in the link`, false],
    [natural?.lang, `the key ${keyMatch?.[1]}`, true],
    [mediatorLang, 'the media-items language in the link', true],
    [pathLocale, `/${pathLocale}/ in the link`, false]
  ]
    .filter(([value]) => value)
    .map(([value, from, code]) => ({ value, from, code }));

  if (natural) return { kind: 'key', key: natural.key, langHints };

  const docid = /^\d{1,12}$/.exec(params.get('docid')?.trim() ?? '')?.[0];
  if (docid) return { kind: 'docid', docid, langHints };

  const category = new RegExp(`^${LOCALE_SEGMENT}/categories/([A-Za-z0-9]+)/?$`, 'i').exec(hash)?.[1];
  if (category) return { kind: 'category', category, langHints };
  if (hashLocale) throw notAVideo(s, 'this jw.org address opens a list of videos, not one video');
  if (/jw-cdn\.org$/.test(host)) throw notAVideo(s, 'this is a JW.org download link, not a video page or key');
  if (/^\/(finder|open)\/?$/i.test(path)) throw notAVideo(s, 'this link has no lank= or docid=');
  const isHome = new RegExp(`^/(?:${LOCALE_SEGMENT}/?)?$`, 'i').test(path);
  if (!(host === 'www.jw.org' || host === 'jw.org') || isHome) {
    throw notAVideo(s, 'no video key, lank= or docid= in this link');
  }
  return { kind: 'page', pageUrl: `https://www.jw.org${url.pathname}${url.search}`, langHints };
}

// ---------------------------------------------------------------------------
// Captions: WebVTT -> cues -> paragraphs

const TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;
const ENTITIES = { __proto__: null, amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };
const SENTENCE_END = /[.!?…。！？؟]["'”’»)\]]*$/u;

function parseTime(text) {
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000;
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = /x/i.test(name[1]) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function cleanCueLine(line) {
  return decodeEntities(line.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// English captions break lines and cues at a closed em dash (life— / —his ministry);
// Spanish (judíos —cansados) and French (— le désir) space it as written.
function dashJoin(a, b) {
  return a && b && (a.endsWith('—') || b.startsWith('—')) ? a + b : null;
}

// JW's Chinese and Japanese captions seldom end a cue with 。, so the cue break is
// often the only sentence break: keep it as a space unless the cue ends in CJK
// punctuation. (Wrapped lines inside one cue join tight: joinText.)
function joinCues(texts, closedDashes = false) {
  let out = '';
  for (const text of texts) {
    if (!text) continue;
    if (!out) {
      out = text;
      continue;
    }
    const dashed = closedDashes && dashJoin(out, text);
    if (dashed) {
      out = dashed;
      continue;
    }
    const last = lastChar(out);
    const tight = NO_SPACE_SCRIPT.test(last) && /\p{P}/u.test(last) && NO_SPACE_SCRIPT.test(String.fromCodePoint(text.codePointAt(0)));
    out += (tight ? '' : ' ') + text;
  }
  return out;
}

/**
 * WebVTT text -> [{ start, end, text }] without tags, cue settings or
 * NOTE/STYLE blocks. closedDashes: lines broken at an em dash join without a
 * space (English captions).
 */
export function parseVtt(vtt, { closedDashes = false } = {}) {
  const cues = [];
  const blocks = vtt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const [from, to] = lines[timing].split('-->');
    const start = parseTime(from);
    if (start === null) continue;
    const end = parseTime(to) ?? start;
    const text = lines.slice(timing + 1).map(cleanCueLine).reduce((a, b) => (closedDashes && dashJoin(a, b)) || joinText(a, b), '');
    if (!text) continue;
    const prev = cues[cues.length - 1];
    // Only a cue that overlaps the last one is a roll-up repeat; JW's separate
    // cues with the same text are sung or spoken again and must stay.
    if (prev && prev.text === text && start < prev.end) {
      prev.end = Math.max(prev.end, end);
      continue;
    }
    cues.push({ start, end, text });
  }
  return cues;
}

/** 75 -> '1:15', 3725 -> '1:02:05'. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// English captions repeat, at the start of each cue, the opening marks of every
// quotation still open (“Put forth… / “to supply…); prose shows them once.
function dropContinuationMarks(cues) {
  const open = [];
  let lastEnd = -Infinity;
  return cues.map((cue) => {
    if (cue.start - lastEnd >= PARAGRAPH_GAP_S) open.length = 0;
    lastEnd = cue.end;
    let k = 0;
    while (k < open.length && cue.text[k] === open[k]) k++;
    // A “ before punctuation closes a quotation (German „…“); keep it.
    if (k && /^(?:[,.;:!?)\]]|$)/.test(cue.text.slice(k))) k = 0;
    const text = k ? cue.text.slice(k).trimStart() : cue.text;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '“' || ch === '‘') open.push(ch);
      else if (ch === '”') {
        const at = open.lastIndexOf('“');
        if (at >= 0) open.length = at;
      // ’ before a Latin letter is an apostrophe (Jehovah’s); otherwise it closes ‘ (Korean ’는 too).
      } else if (ch === '’' && open.at(-1) === '‘' && !/[\p{Script=Latin}\p{N}]/u.test(text[i + 1] ?? '')) open.pop();
    }
    if (open.length > 4) open.length = 0;
    return k ? { ...cue, text } : cue;
  });
}

/**
 * Cues -> paragraphs of up to 60 s, each prefixed [m:ss] unless timestamps is
 * false. closedDashes: cues broken at an em dash join without a space.
 */
export function formatTranscript(cues, { timestamps = true, closedDashes = false } = {}) {
  const paragraphs = [];
  let current = null;
  let lastEnd = 0;
  for (const cue of dropContinuationMarks(cues)) {
    if (current && (cue.start - current.start >= PARAGRAPH_MAX_S || cue.start - lastEnd >= PARAGRAPH_GAP_S)) {
      paragraphs.push(current);
      current = null;
    }
    current ??= { start: cue.start, parts: [] };
    current.parts.push(cue.text);
    lastEnd = cue.end;
    if (cue.end - current.start >= PARAGRAPH_MIN_S && SENTENCE_END.test(cue.text)) {
      paragraphs.push(current);
      current = null;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.map((p) => `${timestamps ? `[${formatClock(p.start)}] ` : ''}${joinCues(p.parts, closedDashes)}`).join('\n\n');
}

// End of the part that starts at offset. A longer remainder is split into
// equal parts of at most max characters (75K -> 37K + 38K, not 60K + 15K),
// each cut after a paragraph break, line break or space in its second half.
function partEnd(text, offset, max) {
  const rest = text.length - offset;
  if (rest <= max) return text.length;
  const size = Math.ceil(rest / Math.ceil(rest / max));
  const hard = offset + size;
  const floor = offset + Math.floor(size / 2);
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(sep, hard - sep.length);
    if (at >= floor) return at + sep.length;
  }
  const code = text.charCodeAt(hard - 1);
  return code >= 0xd800 && code <= 0xdbff ? hard - 1 : hard;
}

// ---------------------------------------------------------------------------
// JW.org lookups

function pickSubtitles(files) {
  // Every rendition normally points at the same VTT; prefer the largest one's.
  const best = files
    .filter((f) => typeof f?.subtitles?.url === 'string' && f.subtitles.url)
    .sort((a, b) => (Number(b.frameHeight) || 0) - (Number(a.frameHeight) || 0))[0];
  return best ? best.subtitles.url : null;
}

function pickThumbnail(images) {
  if (!images || typeof images !== 'object') return null;
  if (images.wss?.sm) return images.wss.sm;
  for (const sizes of Object.values(images)) {
    const url = sizes && typeof sizes === 'object' && Object.values(sizes).find((u) => typeof u === 'string');
    if (url) return url;
  }
  return null;
}

const titleOf = (m) => (typeof m.title === 'string' && m.title.trim()) || null;

function trimMedia(m, key) {
  const files = Array.isArray(m.files) ? m.files : [];
  return {
    key: typeof m.languageAgnosticNaturalKey === 'string' ? m.languageAgnosticNaturalKey : key,
    title: titleOf(m),
    description: typeof m.description === 'string' ? m.description.trim() : '',
    category: m.primaryCategory || null,
    published: typeof m.firstPublished === 'string' ? m.firstPublished.slice(0, 10) : null,
    duration: Number(m.duration) || Number(files.find((f) => f?.duration)?.duration) || null,
    thumbnail: pickThumbnail(m.images),
    subtitlesUrl: pickSubtitles(files),
    burnedIn: files.some((f) => f?.subtitled === true),
    languageCount: Array.isArray(m.availableLanguages) ? m.availableLanguages.length : null
  };
}

// The mediator answers an unknown key, or a video not published in that
// language, with 200 and media: []. That comes back as null (not cached).
async function loadMedia(key, lang, ctx) {
  return cached(
    `captions:media:${lang.code}:${key}`,
    CACHE_TTL_MS,
    async () => {
      const url = `${MEDIATOR}/${encodeURIComponent(lang.code)}/${encodeURIComponent(key)}?clientType=www`;
      let data;
      try {
        data = await fetchJson(url, { deadline: ctx.deadline });
      } catch (error) {
        if (error instanceof JwFetchError && error.status === 404) return null;
        throw error;
      }
      if (!Array.isArray(data?.media)) {
        throw new JwFetchError({
          kind: 'bad_content',
          url,
          message: `b.jw-cdn.org answered the video lookup for ${key} without a media list (${url})`,
          hint: 'JW.org may be changing its video service; try again later.'
        });
      }
      return data.media[0] ? trimMedia(data.media[0], key) : null;
    },
    { cache: metaCache }
  );
}

async function fetchCategory(category, lang, ctx, query) {
  const url = `${MEDIATOR_ROOT}/categories/${encodeURIComponent(lang.code)}/${encodeURIComponent(category)}?clientType=www&${query}`;
  let data;
  try {
    data = await fetchJson(url, { deadline: ctx.deadline });
  } catch (error) {
    if (error instanceof JwFetchError && error.status === 404) {
      throw new ToolError(`JW.org has no video category "${category}".`, CATEGORY_HINT);
    }
    throw error;
  }
  if (!data?.category || typeof data.category !== 'object') {
    throw new JwFetchError({
      kind: 'bad_content',
      url,
      message: `b.jw-cdn.org answered the category lookup for ${category} without a category (${url})`,
      hint: 'JW.org may be changing its video service; try again later.'
    });
  }
  return { cat: data.category, total: Number(data.pagination?.totalCount) || 0 };
}

// LatestVideos and StudioMonthlyPrograms list newest first, so a few items give
// the newest and the ones before. Other categories use jw.org's curated order,
// so they are read whole and sorted by firstPublished.
const DATE_ORDERED_CATEGORIES = new Set(['LatestVideos', BROADCAST_CATEGORY]);
const CATEGORY_PAGE = 100;
const CATEGORY_MAX_PAGES = 5; // about 5 KB an item; caps the scan at 500 videos
const EARLIER = 5; // earlier videos named in the note

// What loadCategoryLead reads of a listed video. The raw item also carries every
// rendition, image size and language code: about 10 KB of heap each.
function slimItem(m) {
  return {
    languageAgnosticNaturalKey: m.languageAgnosticNaturalKey,
    title: titleOf(m),
    firstPublished: typeof m.firstPublished === 'string' ? m.firstPublished : null,
    media: trimMedia(m, m.languageAgnosticNaturalKey)
  };
}

// A string only: Date.parse also accepts numbers (5, 2026) and arrays.
function publishedTime(m) {
  const t = typeof m?.firstPublished === 'string' ? Date.parse(m.firstPublished) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * A category's items (slimItem): { name, items, total }. A date-ordered
 * category is read only as far as `want` items (newest first); any other is
 * read whole, up to CATEGORY_MAX_PAGES pages.
 */
async function loadCategoryItems(category, lang, ctx, want) {
  const byDate = DATE_ORDERED_CATEGORIES.has(category);
  // The newest few come from one small request; deeper ~N read whole pages, so
  // every ~N within the same pages shares one cached listing.
  const limit = byDate && want <= EARLIER + 1 ? want : CATEGORY_PAGE;
  const pages = byDate ? Math.min(CATEGORY_MAX_PAGES, Math.ceil(want / limit)) : CATEGORY_MAX_PAGES;
  return cached(
    `captions:catitems:${lang.code}:${category}${byDate ? `:${limit * pages}` : ''}`,
    CACHE_TTL_MS,
    async () => {
      const items = [];
      let name = category;
      let total = 0;
      for (let page = 0; page < pages; page++) {
        const query = `limit=${limit}${page ? `&offset=${page * limit}` : ''}`;
        const { cat, total: count } = await fetchCategory(category, lang, ctx, query);
        if (typeof cat.name === 'string' && cat.name) name = cat.name;
        if (cat.type === 'container') throw await containerError(category, name, lang, ctx);
        const got = Array.isArray(cat.media) ? cat.media.filter((m) => m && typeof m === 'object') : [];
        items.push(...got.map(slimItem));
        total = count;
        if (got.length < limit || items.length >= total) break;
      }
      return { name, items, total };
    },
    { cache: metaCache }
  );
}

/**
 * The newest video of a category, or the one `back` places before it: { name,
 * media, earlier: [{key, title, published}], partial: {listed, total} | null,
 * undated, series, seriesMissed, back } or null when it lists none. undated:
 * no item has a publish date, so media is in jw.org's own order. With a
 * series (gbUpdate), only the items whose English title marks the series
 * count; in another language that is the newest one already published there.
 */
async function loadCategoryLead(category, lang, ctx, { series, back = 0 } = {}) {
  return cached(
    `captions:category:${lang.code}:${category}:${series ?? ''}:${back}`,
    CACHE_TTL_MS,
    async () => {
      const byDate = DATE_ORDERED_CATEGORIES.has(category);
      const want = Math.max(EARLIER + 1, back + EARLIER + 1);
      const list = await loadCategoryItems(category, lang, ctx, want);
      if (!list.items.length) return null;
      let items = list.items;
      let seriesMissed = false;
      if (series) {
        const english = lang.code === ENGLISH.code ? list : await loadCategoryItems(category, ENGLISH, ctx, want);
        const keys = new Set(english.items.filter(SERIES[series].test).map((m) => m.languageAgnosticNaturalKey).filter((k) => typeof k === 'string'));
        // No English title matches: the title format changed, so do not filter.
        if (keys.size) items = items.filter((m) => keys.has(m.languageAgnosticNaturalKey));
        else seriesMissed = true;
        if (!items.length) return null;
      }
      // Stable sort; undated items (-Infinity) keep jw.org's order among themselves.
      const sorted = byDate ? items : [...items].sort((a, b) => publishedTime(b) - publishedTime(a) || 0);
      if (back >= sorted.length) {
        const n = byDate && !series ? Math.max(list.total, sorted.length) : sorted.length;
        throw new ToolError(
          `"${list.name}" (${category}) lists only ${n} ${series && !seriesMissed ? `${SERIES[series].label}s` : 'videos'}${n > sorted.length ? `, ${sorted.length} of them read` : ''}.`,
          `Use a smaller ~N (the newest is ~0), or pass the key of an older video.`
        );
      }
      const lead = sorted[back];
      const undated = publishedTime(lead) === -Infinity;
      const earlier = undated
        ? []
        : sorted
            .slice(back + 1, back + 1 + EARLIER)
            .filter((m) => publishedTime(m) > -Infinity && typeof m.languageAgnosticNaturalKey === 'string')
            .map((m) => ({ key: m.languageAgnosticNaturalKey, title: m.title, published: m.firstPublished.slice(0, 10) }));
      return {
        name: list.name,
        media: lead.media,
        earlier,
        // Counted on the whole listing, before any series filter.
        partial: !byDate && list.total > list.items.length ? { listed: list.items.length, total: list.total } : null,
        undated,
        series: series ?? null,
        seriesMissed,
        back
      };
    },
    { cache: metaCache }
  );
}

const MONTH_PAGE = 12;
const MONTH_MAX_PAGES = 6;

// The monthly program first published in `month` (YYYY-MM): { name, media }
// (media null when there is none). firstPublished, unlike the title, reads
// the same in every language.
async function loadMonthProgram(month, lang, ctx) {
  return cached(
    `captions:month:${lang.code}:${month}`,
    CACHE_TTL_MS,
    async () => {
      let name = BROADCAST_CATEGORY;
      for (let page = 0; page < MONTH_MAX_PAGES; page++) {
        const query = `limit=${MONTH_PAGE}${page ? `&offset=${page * MONTH_PAGE}` : ''}`;
        const { cat } = await fetchCategory(BROADCAST_CATEGORY, lang, ctx, query);
        if (typeof cat.name === 'string' && cat.name) name = cat.name;
        const got = Array.isArray(cat.media) ? cat.media.filter((m) => m && typeof m === 'object') : [];
        const hit = got.find((m) => typeof m.firstPublished === 'string' && m.firstPublished.startsWith(month));
        if (hit) return { name, media: trimMedia(hit, hit.languageAgnosticNaturalKey) };
        const oldest = got.at(-1)?.firstPublished;
        if (got.length < MONTH_PAGE || (typeof oldest === 'string' && oldest.slice(0, 7) < month)) break;
      }
      return { name, media: null };
    },
    { cache: metaCache }
  );
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`;
}

// A group of categories (VODStudio): only detailed=1 lists its categories.
async function containerError(category, name, lang, ctx) {
  const detailed = await fetchCategory(category, lang, ctx, 'detailed=1').catch(() => null);
  const subs = (Array.isArray(detailed?.cat.subcategories) ? detailed.cat.subcategories : [])
    .filter((c) => typeof c?.key === 'string' && WORD_RE.test(c.key))
    .map((c) => `latest:${c.key}${typeof c.name === 'string' && c.name ? ` (${c.name})` : ''}`);
  return new ToolError(
    `"${name}" (${category}) on JW.org is a group of video categories, not a list of videos.`,
    subs.length ? `Pass one of its categories: ${subs.slice(0, 20).join(', ')}.` : CATEGORY_HINT
  );
}

// cfp2.jw-cdn.org (S3) answers 403 for a file that does not exist.
const VTT_MISSING_HINT = 'JW.org\'s file server answers 403 when a captions file does not exist; it may have been withdrawn. Try again later, or ask for another language.';

async function loadVtt(url, ctx) {
  return cached(
    `captions:vtt:${url}`,
    CACHE_TTL_MS,
    async () => {
      const text = (await fetchText(url, { deadline: ctx.deadline, hints: { 403: VTT_MISSING_HINT } })).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (!/^\s*WEBVTT/.test(text) && !text.includes('-->')) {
        throw new JwFetchError({
          kind: 'bad_content',
          url,
          message: `${new URL(url).hostname} did not return a WebVTT caption file (${url})`,
          hint: 'Try again in a minute; JW.org may be busy.'
        });
      }
      return text;
    },
    { cache: vttCache }
  );
}

// A player's pub-media link -> media key. Its issue is YYYYMM00; keys use YYYYMM.
function keyFromMediaLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const p = url.searchParams;
  if (!/mp4|m4v|3gp/i.test(p.get('fileformat') ?? '')) return null;
  const track = /^\d+$/.test(p.get('track') ?? '') ? Number(p.get('track')) : 1;
  const docid = p.get('docid');
  if (docid && /^\d+$/.test(docid)) return `docid-${docid}_${track}_VIDEO`;
  const pub = p.get('pub');
  if (!pub || !/^[a-z0-9-]+$/i.test(pub)) return null;
  const issue = (p.get('issue') ?? '').replace(/^(\d{6})00$/, '$1');
  return `pub-${pub.toLowerCase()}${/^[1-9]\d*$/.test(issue) ? `_${issue}` : ''}_${track}_VIDEO`;
}

/** Video players embedded in a jw.org page, plus video keys it links to. */
async function scanPage(pageUrl, ctx) {
  return cached(
    `captions:page:${pageUrl}`,
    CACHE_TTL_MS,
    async () => {
      const html = await fetchText(pageUrl, { deadline: ctx.deadline });
      const embedded = [];
      for (const m of html.matchAll(/data-jsonurl\s*=\s*(["'])(.*?)\1/gis)) {
        const key = keyFromMediaLink(decodeEntities(m[2]));
        if (key && !embedded.includes(key)) embedded.push(key);
      }
      const linked = [];
      for (const m of html.matchAll(new RegExp(KEY_RE.source, 'gi'))) {
        const { key } = normalizeKey(m[1]);
        if (!embedded.includes(key) && !linked.includes(key)) linked.push(key);
      }
      return { embedded, linked: linked.slice(0, 5) };
    },
    { cache: metaCache }
  );
}

function languageList(langs) {
  return langs.map((l) => `${l.name} (${l.code})`).join(' and ');
}

function categoryNote(lead, category) {
  if (lead.undated) {
    const which = lead.back ? `video ${lead.back + 1}` : 'the first video';
    return `This is ${which} jw.org lists in the category "${lead.name}" (${category}), in its own order, not by date; pass a key to read another one.`;
  }
  const partial = lead.partial ? ` (newest of the first ${lead.partial.listed} listed; the category has ${lead.partial.total})` : '';
  const series = lead.series ? SERIES[lead.series] : null;
  const back = series && !lead.seriesMissed ? series.ref : `latest:${category}`;
  const more = lead.earlier.length
    ? ` Earlier ones (pass a key as video_id, or ${back}~N for the Nth before the newest): ${lead.earlier.map((e) => `${e.key} (${e.title ? `"${e.title}", ` : ''}${e.published})`).join('; ')}.`
    : ' Pass a key to read an older one.';
  if (series && !lead.seriesMissed) {
    const which = lead.back ? `number ${lead.back} before the newest ${series.label}` : `the newest ${series.label}`;
    return `This is ${which} (titled ${series.titled}) in the JW.org category "${lead.name}" (${category})${partial}; excerpts and news reports there are skipped.${more}`;
  }
  const missed = series
    ? `Could not tell ${series.label}s from other news in "${lead.name}" by title, so this is simply the category's newest video; check the title. `
    : '';
  const which = lead.back ? `number ${lead.back} before the newest video` : 'the newest video';
  return `${missed}This is ${which} in the JW.org category "${lead.name}" (${category})${partial}.${more}`;
}

/** Find the media item, trying the requested language and then English. */
async function locateVideo(ref, requested, ctx) {
  const langs = requested.code === ENGLISH.code ? [requested] : [requested, ENGLISH];
  const tryKey = async (key) => {
    for (const lang of langs) {
      const media = await loadMedia(key, lang, ctx);
      if (media) return { key: media.key, lang, media };
    }
    return null;
  };

  if (ref.month) {
    for (const lang of langs) {
      const found = await loadMonthProgram(ref.month, lang, ctx);
      if (!found.media || typeof found.media.key !== 'string') continue;
      ctx.notes.push(`This is the program in the JW.org category "${found.name}" (${BROADCAST_CATEGORY}) first published in ${monthLabel(ref.month)}.`);
      return { key: found.media.key, lang, media: found.media };
    }
    throw new ToolError(
      `JW.org lists no monthly program published in ${monthLabel(ref.month)}.`,
      `Pass latest:${BROADCAST_CATEGORY} to see the newest and the keys of earlier ones.`
    );
  }

  if (ref.kind === 'category') {
    for (const lang of langs) {
      const lead = await loadCategoryLead(ref.category, lang, ctx, { series: ref.series, back: ref.back ?? 0 });
      if (!lead || typeof lead.media.key !== 'string') continue;
      ctx.notes.push(categoryNote(lead, ref.category));
      return { key: lead.media.key, lang, media: lead.media };
    }
    return null;
  }

  const guess = ref.key ?? (ref.docid ? `docid-${ref.docid}_1_VIDEO` : null);
  if (guess) {
    const hit = await tryKey(guess);
    if (hit || ref.kind === 'key') return hit;
  }

  // A docid or a page link: read the key from the page's video player.
  const pageUrl =
    ref.pageUrl ?? `https://www.jw.org/finder?wtlocale=${encodeURIComponent(requested.code)}&docid=${ref.docid}`;
  let page;
  try {
    page = await scanPage(pageUrl, ctx);
  } catch (error) {
    // The finder answers an unknown docid with 404: report it as not found.
    if (ref.docid && error instanceof JwFetchError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  }
  if (!page.embedded.length) {
    const what = ref.docid ? `The jw.org page for docid ${ref.docid} (${pageUrl})` : `The jw.org page ${pageUrl}`;
    const links = page.linked.length ? ` It links to these videos: ${page.linked.join(', ')}.` : '';
    throw new ToolError(
      `${what} has no video player of its own, so there are no captions to read; it is probably an article.${links}`,
      page.linked.length ? 'Pass one of those keys as video_id, or the video\'s share link.' : LINK_HINT
    );
  }
  const [first, ...others] = page.embedded;
  if (others.length) {
    ctx.notes.push(`That page has ${page.embedded.length} videos; this is the first. The others: ${others.slice(0, 5).join(', ')}.`);
  }
  ctx.triedKeys.push(first);
  return first === guess ? null : tryKey(first);
}

async function chooseLanguage(explicit, hints, notes, deadline) {
  if (explicit) return resolveLanguage(explicit.value, { name: 'langwritten', wol: false, as: explicit.code ? 'code' : 'any', deadline });
  for (const { value, from, code } of hints) {
    try {
      return await resolveLanguage(value, { name: 'langwritten', wol: false, as: code ? 'code' : 'any', deadline });
    } catch (error) {
      if (!(error instanceof ArgError || error instanceof JwFetchError)) throw error;
      const why = error instanceof ArgError ? 'not a JW.org language' : 'the JW.org language list could not be loaded';
      notes.push(`Ignored the language "${value}" from ${from} (${why}). Pass langwritten to choose one.`);
    }
  }
  return ENGLISH;
}

function firstPresent(args, names) {
  for (const name of names) if (!isMissing(args[name])) return args[name];
  return undefined;
}

function toFormat(value) {
  if (isMissing(value)) return 'text';
  const alias = typeof value === 'string' ? FORMAT_ALIASES[value.trim().toLowerCase()] : undefined;
  return alias ?? toEnum(value, 'format', FORMATS);
}

// Song videos show the words on screen; the lyrics are songbook pages on WOL.
// The song comes from the title ("103. Shepherds—Gifts in Men"), else the key.
function songLyricsStep(media, lang) {
  const [, number, name = media.title ?? ''] = /^(\d+)\.\s*(.*)$/.exec(media.title ?? '') ?? [];
  const docid = songbookDocid(number ? Number(number) : songOfKey(media.key));
  // The audio-described version adds "(...)" to the title.
  const song = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const where = docid
    ? `the song's page in the songbook: https://www.jw.org/finder?wtlocale=${encodeURIComponent(lang.code)}&docid=${docid}`
    : `the songbook Sing Out Joyfully to Jehovah${song ? ` ("${song}")` : ''}`;
  return `Song videos show the words on screen and have no caption file in any language. For the lyrics, see ${where}.`;
}

function notFound(ref, requested, ctx) {
  const langs = languageList(requested.code === ENGLISH.code ? [requested] : [requested, ENGLISH]);
  if (ref.kind === 'category') {
    return new ToolError(`The JW.org video category ${ref.category} lists no videos in ${langs}.`, CATEGORY_HINT);
  }
  const guess = ref.key ?? (ref.docid ? `docid-${ref.docid}_1_VIDEO` : null);
  const keys = [...new Set([guess, ...ctx.triedKeys].filter(Boolean))];
  const what = ref.docid ? `JW.org has no video for docid ${ref.docid}` : 'JW.org has no video';
  return new ToolError(
    `${what} with the key ${keys.join(' or ')} (looked up in ${langs}).`,
    `Check the key for typos (keys end in _VIDEO, e.g. pub-jwb-142_1_VIDEO). ${LINK_HINT}`
  );
}

async function getCaptions(input, extra = {}) {
  const args = requireArgs(
    typeof input === 'object' && input !== null ? input : input === undefined ? extra : { ...extra, video_id: input }
  );
  const videoId = toStr(firstPresent(args, ['video_id', 'url', 'video_url', 'lank']), 'video_id', {
    maxLength: 2000,
    patternText: ACCEPTED
  });
  const ref = parseVideoReference(videoId);
  const format = toFormat(args.format);
  // VTT is clamped, not rejected: paging with next_offset covers the rest.
  const maxChars = Math.min(
    toInt(args.max_chars, 'max_chars', { min: MIN_MAX_CHARS, max: MAX_MAX_CHARS, default: DEFAULT_MAX_CHARS }),
    format === 'vtt' ? MAX_VTT_CHARS : MAX_MAX_CHARS
  );
  const offset = toInt(args.offset, 'offset', { min: 0, default: 0 });

  const ctx = { deadline: Date.now() + 2 * DEFAULT_TIMEOUT_MS, notes: [], triedKeys: [] };
  const explicitName = ['langwritten', 'lang', 'language', 'wtlocale'].find((name) => !isMissing(args[name]));
  const explicit = explicitName ? { value: args[explicitName], code: explicitName === 'wtlocale' } : null;
  const requested = await chooseLanguage(explicit, ref.langHints, ctx.notes, ctx.deadline);
  if (requested.note) ctx.notes.push(requested.note);

  const found = await locateVideo(ref, requested, ctx);
  if (!found) throw notFound(ref, requested, ctx);
  const { key, lang, media } = found;
  // The transcript may come from English while the video details stay in the requested language.
  let captionsLang = lang;
  let subtitlesUrl = media.subtitlesUrl;
  if (lang.code !== requested.code) {
    ctx.notes.push(`This video is not published in ${requested.name} (${requested.code}); showing the English version.`);
  } else if (!subtitlesUrl && lang.code !== ENGLISH.code) {
    const english = await loadMedia(key, ENGLISH, ctx);
    if (english?.subtitlesUrl) {
      ctx.notes.push(`JW.org has no ${requested.name} (${requested.code}) captions for this video; showing the English captions.`);
      captionsLang = ENGLISH;
      subtitlesUrl = english.subtitlesUrl;
    }
  }

  const meta = {
    title: media.title,
    key,
    language: lang.code,
    language_name: lang.name,
    ...(lang.code !== requested.code && { requested_language: requested.code }),
    ...(captionsLang.code !== lang.code && { captions_language: captionsLang.code }),
    duration: media.duration ? formatClock(media.duration) : null,
    duration_seconds: media.duration ? Math.round(media.duration) : null,
    published: media.published,
    category: media.category,
    ...(media.description && { description: media.description }),
    url: `https://www.jw.org/finder?wtlocale=${encodeURIComponent(lang.code)}&lank=${encodeURIComponent(key)}`,
    thumbnail: media.thumbnail
  };
  const metaBlock = (fields) => ({
    type: 'text',
    text: JSON.stringify({ ...meta, ...fields, ...(ctx.notes.length && { notes: ctx.notes }) })
  });
  const noCaptions = (reason) => ({
    content: [
      metaBlock({
        captions_available: false,
        reason,
        next_step: isSongKey(key)
          ? songLyricsStep(media, lang)
          : `Try langwritten with another language${media.languageCount ? ` (the video is published in ${media.languageCount} languages)` : ''}; not every language has a caption file.`
      })
    ]
  });

  if (!subtitlesUrl) {
    const checked = lang.code === requested.code && lang.code !== ENGLISH.code ? [lang, ENGLISH] : [lang];
    const where = languageList(checked);
    return noCaptions(
      media.burnedIn
        ? `JW.org publishes no caption file for this video in ${where}; its only subtitles are burned into the picture of some of its video files.`
        : `JW.org publishes no caption file for this video in ${where}.`
    );
  }

  let vtt;
  try {
    vtt = await loadVtt(subtitlesUrl, ctx);
  } catch (error) {
    if (!(error instanceof JwFetchError)) throw error;
    throw new ToolError(
      `Found "${media.title ?? key}" (${key}, ${captionsLang.code}) but could not download its caption file: ${error.message}`,
      error.hint ?? 'Try again in a minute.'
    );
  }

  // Only English captions are known to close em dashes; the flag follows the captions' own language.
  const closedDashes = captionsLang.code === ENGLISH.code;
  const transcript = format === 'vtt' ? vtt : formatTranscript(parseVtt(vtt, { closedDashes }), { timestamps: format === 'text', closedDashes });
  if (!transcript.trim()) return noCaptions(`The ${captionsLang.name} caption file for this video has no text.`);
  if (offset >= transcript.length) {
    throw new ArgError('offset', offset, `an integer from 0 to ${transcript.length - 1}`, {
      hint: `The ${format} transcript has ${transcript.length} characters; start again from offset 0.`
    });
  }

  const end = partEnd(transcript, offset, charsWithinTokens(transcript, offset, PAGE_TOKENS, maxChars));
  const truncated = end < transcript.length;
  const more = truncated
    ? `\n\n[Transcript continues: call get_jw_captions again with the same arguments and offset ${end} (${transcript.length - end} more characters).]`
    : '';
  return {
    content: [
      metaBlock({
        subtitles_url: subtitlesUrl,
        captions_available: true,
        format,
        total_chars: transcript.length,
        offset,
        returned_chars: end - offset,
        truncated,
        next_offset: truncated ? end : null
      }),
      { type: 'text', text: transcript.slice(offset, end).trimEnd() + more }
    ]
  };
}

/**
 * getCaptionsImplementation({ video_id, langwritten?, format?, max_chars?, offset? }).
 * The old form getCaptionsImplementation(video_id) still works.
 */
export const getCaptionsImplementation = wrapTool(getCaptions, 'get_jw_captions');

export async function handleCaptionsTool(request) {
  if (request?.params?.name !== captionsTool.name) return null;
  return getCaptionsImplementation(request.params.arguments ?? {});
}

/** For tests: forget cached lookups and caption files. */
export function clearCaptionsCache() {
  metaCache.clear();
  vttCache.clear();
}
