// Watchtower Online Library (wol.jw.org) Bible chapter pages. The scripture
// tools take verse text, footnotes, cross references and study notes from the
// jw.org study-Bible JSON (bible-api.js); from WOL they need only the Research
// Guide (the publications that discuss each verse) and, when that JSON fails,
// the verse text.

import * as cheerio from 'cheerio';

import { TtlLruCache, cached } from './cache.js';
import { JwFetchError, fetchText } from './http.js';
import { wolUrl } from './languages.js';
import { absoluteUrl, cleanText, joinText } from './text.js';

const HOUR_MS = 60 * 60 * 1000;

// A parsed chapter keeps every verse's Research Guide (a few hundred entries
// for a long chapter), so pages get their own small cache.
const wolChapterCache = new TtlLruCache({ maxEntries: 30, ttlMs: 6 * HOUR_MS });

/** For tests: forget parsed WOL chapter pages. */
export function clearWolChapterCache() {
  wolChapterCache.clear();
}

// Research Guide citations start with a publication symbol: "w25.08 p. 31",
// "wp20 No. 2 p. 9", "it-1 “Herald” par. 2", "lff lesson 21 points 1-6".
const PUBLICATIONS = {
  __proto__: null,
  w: 'The Watchtower',
  wp: 'The Watchtower (public edition)',
  ws: 'The Watchtower (simplified edition)',
  g: 'Awake!',
  'it-1': 'Insight on the Scriptures, Volume 1',
  'it-2': 'Insight on the Scriptures, Volume 2',
  lff: 'Enjoy Life Forever!',
  jy: 'Jesus—The Way, the Truth, the Life',
  gt: 'The Greatest Man Who Ever Lived',
  kr: 'God’s Kingdom Rules!',
  bt: '“Bearing Thorough Witness” About God’s Kingdom',
  cl: 'Draw Close to Jehovah',
  ia: 'Imitate Their Faith',
  rs: 'Reasoning From the Scriptures',
  'ip-1': 'Isaiah’s Prophecy—Light for All Mankind I',
  'ip-2': 'Isaiah’s Prophecy—Light for All Mankind II',
  dp: 'Pay Attention to Daniel’s Prophecy!',
  re: 'Revelation—Its Grand Climax At Hand!',
  si: '“All Scripture Is Inspired of God and Beneficial”',
  rr: 'Pure Worship of Jehovah—Restored At Last!',
  jr: 'God’s Word for Us Through Jeremiah',
  lvs: '“Keep Yourselves in God’s Love”',
  lv: '“Keep Yourselves in God’s Love”',
  bh: 'What Does the Bible Really Teach?',
  bhs: 'What Can the Bible Teach Us?',
  lfb: 'Lessons You Can Learn From the Bible',
  my: 'My Book of Bible Stories',
  cf: '“Come Be My Follower”',
  jv: 'Jehovah’s Witnesses—Proclaimers of God’s Kingdom',
  od: 'Organized to Do Jehovah’s Will',
  es: 'Examining the Scriptures Daily',
  mwb: 'Our Christian Life and Ministry—Meeting Workbook',
  km: 'Our Kingdom Ministry',
  yb: 'Yearbook of Jehovah’s Witnesses',
  th: 'Apply Yourself to Reading and Teaching',
  be: 'Benefit From Theocratic Ministry School Education',
  lmd: 'Love People—Make Disciples',
  kl: 'Knowledge That Leads to Everlasting Life',
  pe: 'You Can Live Forever in Paradise on Earth',
  sh: 'Mankind’s Search for God',
  gm: 'The Bible—God’s Word or Man’s?',
  tp: 'True Peace and Security—How Can You Find It?',
  lr: 'Learn From the Great Teacher',
  jl: 'Who Are Doing Jehovah’s Will Today?',
  wt: 'Worship the Only True God',
  ti: 'Should You Believe in the Trinity?',
  kp: 'Keep on the Watch!',
  bm: 'The Bible—What Is Its Message?',
  ct: 'Is There a Creator Who Cares About You?',
  lc: 'Was Life Created?',
  dg: 'Does God Really Care About Us?',
  gf: 'You Can Be God’s Friend!',
  lmn: 'Look! I Am Making All Things New',
  ijwbq: 'Bible Questions Answered (jw.org)',
  ijwbv: 'Bible Verses Explained (jw.org)',
  ijwyp: 'Young People Ask (jw.org)',
  nwtsty: 'New World Translation (Study Edition)',
  nwt: 'New World Translation'
};

/** Publication name for a Research Guide citation such as "w25.08 p. 31", or null. */
export function publicationName(source) {
  const symbol = /^([a-z]+(?:-\d)?)(?=[\d\s.,]|$)/i.exec(cleanText(source))?.[1]?.toLowerCase();
  return (symbol && PUBLICATIONS[symbol]) || null;
}

// One li.item.ref-rsg. English pages list a title link per paragraph with
// its citation ("w25.08 p. 31") in the next, unlinked paragraph. Other
// languages (es, ja ...) use a citation index: every line is a link, the
// publication sits in <em>/<strong>, more links on a line are further pages
// or articles, and a div[data-pid] groups a publication line with its issues.
// Arabic items hold both: titled pairs, then an index.
function researchGuideEntries($, item, base) {
  const ps = $(item).find('p').toArray().filter((p) => cleanText($(p).text()));
  const linked = (p) => $(p).find('a[href]').length > 0;
  const paired = new Set();
  ps.forEach((p, i) => {
    if (i > 0 && !linked(p) && linked(ps[i - 1])) paired.add(ps[i - 1]).add(p);
  });
  const rest = ps.filter((p) => !paired.has(p));
  const index = $(rest).is('p.sk') || $(rest).find('a[href] > em, a[href] > strong').length > 0;
  if (!index) return titledEntries($, ps, base);
  return titledEntries($, ps.filter((p) => paired.has(p)), base).concat(indexEntries($, rest, base));
}

function titledEntries($, ps, base) {
  const entries = [];
  let open = null;
  for (const p of ps) {
    const anchors = $(p).find('a[href]').toArray();
    if (anchors.length) {
      for (const a of anchors) {
        const title = cleanText($(a).text()).replace(/,$/, '');
        const url = absoluteUrl($(a).attr('href'), base);
        if (!title || !url) continue;
        open = { title, source: null, publication: null, url };
        entries.push(open);
      }
      if (anchors.length > 1) open = null; // several links on one line: no shared citation
      continue;
    }
    const text = cleanText($(p).find('em').text()) || cleanText($(p).text());
    if (open && text) {
      open.source = text;
      open.publication = publicationName(text);
      open = null;
    }
  }
  return entries;
}

const trimSep = (s) => s.replace(/[\s,\uff0c\u3001\u060c]+$/, '');

// The citation is the entry's title: "Perspicacia, págs. 437", "La Atalaya
// (estudio), 2/2017, págs. 6, 7". A URL is listed once.
function indexEntries($, ps, base) {
  const entries = [];
  const seen = new Set();
  let header = null;
  const emit = (text, publication, url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    const source = cleanText(text);
    if (source) entries.push({ title: source, source, publication: publication || null, url });
  };
  for (const p of ps) {
    const anchors = $(p).find('a[href]').toArray();
    if (!anchors.length) continue;
    const group = $(p).parent('div[data-pid]').get(0) ?? null;
    const first = $(anchors[0]);
    const firstText = cleanText(first.text());
    const isHeader = $(p).is('p.su') && group && $(group).find('p.sk a[href]').length > 0;
    if (header && (header.group !== group || isHeader)) {
      if (!header.used) emit(trimSep(header.text), header.publication, header.url);
      header = null;
    }
    if (isHeader) {
      // The publication line of a group; its link is also its first issue's.
      header = { group, text: firstText, publication: trimSep(firstText), url: absoluteUrl(first.attr('href'), base), used: false };
      continue;
    }
    let lead = '';
    let publication;
    if ($(p).is('p.sk') && header) {
      lead = `${header.text} `;
      publication = header.publication;
      header.used = true;
    } else {
      publication = trimSep(cleanText(first.find('em, strong').first().text()));
    }
    // Drop the first link's page list (any digits: Arabic "١٢٠،"); never the day of a y/m/d date ("2015/5/1, 3").
    const prefix = trimSep(firstText).replace(/(?<![\p{Nd}/])(?:\p{Nd}+(?:[\u2013-]\p{Nd}+)?[\s,\uff0c\u3001\u060c]*)+$/u, '');
    anchors.forEach((a, i) => {
      const text = trimSep(cleanText($(a).text()));
      emit(lead + (i === 0 ? text : prefix + text), publication, absoluteUrl($(a).attr('href'), base));
    });
  }
  if (header && !header.used) emit(trimSep(header.text), header.publication, header.url);
  return entries;
}

// WOL sets the poetic lines the study-Bible JSON marks style-l / style-z in p.sl / p.sz.
const POETRY_LINE = 'p.sl, p.sz';

/**
 * Parse a WOL Bible chapter page: {verses: {[verse]: text}, poetry,
 * superscription, articles: {[verse]: [{title, source, publication, url}]}}.
 * Verse 0 is a psalm's superscription. Verse text has no verse number and no
 * +/* markers; a verse split over several spans is joined as on the JSON
 * path: `poetry` lists the verses that keep one line per "\n", and prose
 * segments are joined with joinText (no space between CJK characters).
 */
export function parseWolChapter(html, book, chapter, pageUrl = 'https://wol.jw.org/') {
  const $ = cheerio.load(html);
  const parts = new Map();
  $('span.v[id]').each((_, el) => {
    const m = /^v(\d+)-(\d+)-(\d+)-(\d+)$/.exec($(el).attr('id'));
    if (!m || Number(m[1]) !== book || Number(m[2]) !== chapter) return;
    const span = $(el).clone();
    span.find('a.vp, a.vl, a.cl, a.b, a.fn').remove();
    const text = cleanText(span.text());
    const verse = Number(m[3]);
    if (!parts.has(verse)) parts.set(verse, []);
    if (text) parts.get(verse).push({ seg: Number(m[4]), text, poetry: $(el).closest(POETRY_LINE).length > 0 });
  });
  const verses = {};
  const poetry = [];
  let superscription = null;
  for (const [verse, segs] of [...parts].sort((a, b) => a[0] - b[0])) {
    const lines = segs.sort((a, b) => a.seg - b.seg).map((s) => s.text);
    const poetic = verse !== 0 && segs.some((s) => s.poetry);
    const text = poetic ? lines.join('\n') : lines.reduce(joinText, '');
    if (verse === 0) superscription = text || null;
    else verses[verse] = text;
    if (poetic) poetry.push(verse);
  }

  const articles = {};
  $('div.section[data-key]').each((_, section) => {
    const [b, c, v] = String($(section).attr('data-key')).split('-').map(Number);
    if (b !== book || c !== chapter || !Number.isInteger(v)) return;
    const list = $(section).find('li.item.ref-rsg').toArray().flatMap((item) => researchGuideEntries($, item, pageUrl));
    if (list.length) articles[v] = (articles[v] ?? []).concat(list);
  });

  return { verses, poetry, superscription, articles };
}

/**
 * Fetch and parse a WOL Bible chapter page in a language resolved with WOL
 * info (languages.js). symbol: 'nwtsty' (study edition) or 'nwt'; when WOL
 * has no study edition page it falls back to 'nwt'. Returns parseWolChapter()'s
 * result plus {url, symbol}. Throws JwFetchError, or ArgError when WOL has no
 * library for the language. Cached 6 hours; `bypass` refetches.
 */
export async function getWolChapter(lang, book, chapter, { symbol = 'nwtsty', bypass = false, deadline } = {}) {
  return cached(
    `wol:bible:${lang.code}:${symbol}:${book}:${chapter}`,
    6 * HOUR_MS,
    async () => {
      const url = wolUrl(lang, 'b', symbol, book, chapter);
      let html;
      try {
        html = await fetchText(url, { deadline });
      } catch (error) {
        const missing = error instanceof JwFetchError && (error.status === 400 || error.status === 404);
        if (missing && symbol !== 'nwt') return getWolChapter(lang, book, chapter, { symbol: 'nwt', bypass, deadline });
        throw error;
      }
      const page = parseWolChapter(html, book, chapter, url);
      if (!Object.keys(page.verses).length) {
        throw new JwFetchError({
          kind: 'bad_content',
          url,
          message: `wol.jw.org returned a page without Bible verses for ${url}`,
          hint: 'WOL may have changed its Bible pages; try again later.'
        });
      }
      return { url, symbol, ...page };
    },
    { cache: wolChapterCache, bypass }
  );
}
