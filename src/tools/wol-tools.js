// Tools that read the Watchtower Online Library (wol.jw.org): the daily text,
// any WOL document or link the other tools return, and WOL's own search.

import * as cheerio from 'cheerio';

import { ArgError, describeValue, formatIsoDate, isMissing, requireArgs, toBool, toEnum, toInt, toIsoDate, toJwUrl, toStr } from './args.js';
import { TtlLruCache, cached } from './cache.js';
import { DEFAULT_TIMEOUT_MS, JwFetchError, fetchResource } from './http.js';
import { LANGWRITTEN_DESCRIPTION, resolveLanguage, wolUrl } from './languages.js';
import { ToolError, pageByTokens, wrapTool } from './results.js';
import { songOfKey, songbookDocid } from './songbook.js';
import { absoluteUrl, cleanText } from './text.js';

const WOL_HOSTS = Object.freeze(['wol.jw.org']);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// One time limit per call, as the other multi-request tools have, so a slow
// WOL ends in a timeout result instead of the MCP client's own timeout.
const CALL_BUDGET_MS = 2 * DEFAULT_TIMEOUT_MS;
const DEFAULT_MAX_CHARS = 30000;
// The token budget (PAGE_TOKENS, results.js) does the limiting; this only bounds the argument.
const MAX_MAX_CHARS = 80000;
const SNIPPET_CHARS = 280;
const GLOSSARY_CHARS = 1000;
const SEARCH_PAGE_SIZE = 40; // fixed by WOL

// Parsed documents can hold a few hundred KB of text, so they get their own cache.
const wolCache = new TtlLruCache({ maxEntries: 60, ttlMs: 6 * HOUR_MS });

/** For tests: forget cached daily texts, documents and searches. */
export function clearWolCache() {
  wolCache.clear();
}

// ---------------------------------------------------------------------------
// Shared helpers
// WOL text carries no-break spaces, zero-width spaces before dashes and
// direction marks around numbers; cleanText (text.js) removes them.

function withoutQuery(href) {
  const u = new URL(href);
  u.search = '';
  u.hash = '';
  return u.href;
}

async function language(value, deadline) {
  return resolveLanguage(isMissing(value) ? 'E' : value, { deadline });
}

async function fetchWolPage(url, { hints, deadline } = {}) {
  const res = await fetchResource(url, { allowHosts: WOL_HOSTS, hints, deadline });
  if (!/html/i.test(res.contentType)) {
    throw new ToolError(
      `${res.url} is not a WOL page (it is ${res.contentType || 'an unknown type'}).`,
      'Pass a link to a WOL document, such as https://wol.jw.org/en/wol/d/r1/lp-e/2025241.'
    );
  }
  return { url: res.url, html: new TextDecoder().decode(res.buffer) };
}

// ---------------------------------------------------------------------------
// get_daily_text

const DAILY_TTL_MS = 12 * HOUR_MS;
function noDailyText(lang, date, url) {
  return new ToolError(
    `wol.jw.org has no daily text for ${date} in ${lang.name} (${url}).`,
    `WOL keeps the daily text for recent years only, plus next year once it is published. Try a recent date${lang.code === 'E' ? '' : ', or langwritten E'}.`
  );
}

/** Parse a WOL home page (/wol/h/...): it holds the day before, the day and the day after. */
export function parseDailyTextPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const days = new Map();
  $('.tabContent').each((_, el) => {
    const $tab = $(el);
    const date = /^\d{4}-\d{2}-\d{2}/.exec($tab.attr('data-date') ?? '')?.[0];
    const $body = $tab.find('.bodyTxt').first();
    if (!date || !$body.length) return;

    // The comment ends with its source, e.g. "w25.01 9 ¶6-8"; "w25.02 5 ¶17; 7 ¶18" has a link per part.
    const $sources = $body.find('a[href*="/wol/pc/"]');
    const citation = cleanText($sources.map((_, a) => $(a).text()).get().join(''));
    const sourceUrls = [...new Set($sources.map((_, a) => absoluteUrl($(a).attr('href'), pageUrl)).get().filter(Boolean))];
    $sources.remove();
    const $paragraphs = $body.find('p');
    const text = ($paragraphs.length ? $paragraphs.map((_, p) => cleanText($(p).text())).get() : [cleanText($body.text())])
      .filter(Boolean)
      .join('\n\n');
    const $pub = $tab.children('a[href*="/wol/d/"]').last();
    const $h2 = $tab.find('h2').first();
    // Memorial-season headings put each line in its own <br>-separated line; .text() would run them together.
    $h2.find('br').replaceWith(' · ');
    // In the days before the Memorial, WOL adds that day's Memorial Bible reading in .closingContent.
    const $closing = $tab.find('.closingContent').first();
    $closing.find('a[href*="/wol/d/"]').remove();
    const memorialReading = $closing.find('p').map((_, p) => cleanText($(p).text())).get().filter(Boolean).join('\n') || cleanText($closing.text());

    days.set(date, {
      date,
      heading: cleanText($h2.text()),
      theme_scripture: cleanText($tab.find('.themeScrp').first().text()),
      text,
      citation: citation || null,
      source_url: sourceUrls[0] ?? null,
      source_urls: sourceUrls,
      publication: cleanText($pub.text()) || null,
      memorial_reading: memorialReading || null
    });
  });
  return days;
}

async function loadDailyText(lang, day, date, deadline) {
  const url = wolUrl(lang, 'h', day.getFullYear(), day.getMonth() + 1, day.getDate());
  let page;
  try {
    page = await fetchWolPage(url, { deadline });
  } catch (error) {
    if (error instanceof JwFetchError && error.status === 404) {
      throw noDailyText(lang, date, url);
    }
    throw error;
  }
  const days = parseDailyTextPage(page.html, url);
  if (!days.size) {
    throw new ToolError(
      `The WOL page for ${date} has no daily text in the expected layout (${url}).`,
      'WOL may have changed its page layout. Open the url in a browser, or try again later.'
    );
  }
  // The neighbours come free with this page; keep them for the next call.
  for (const [d, entry] of days) {
    if (d !== date) wolCache.set(dailyKey(lang, d), { ...entry, url: wolUrl(lang, 'h', ...d.split('-').map(Number)) }, DAILY_TTL_MS);
  }
  const entry = days.get(date);
  if (!entry) throw noDailyText(lang, date, url);
  return { ...entry, url };
}

function dailyKey(lang, date) {
  return `wol:daily:${lang.code}:${date}`;
}

// The cited paragraphs of each source link, in one result.
async function dailySources(entry, deadline) {
  const sources = [];
  for (const href of entry.source_urls) {
    const { doc, hash, cited } = await readCitation(href, { deadline });
    if (!cited.length) {
      throw new ToolError(
        `The daily text's source link ${href} does not point at specific paragraphs.`,
        'Call get_daily_text without sources, or read_wol_document(url, cited_only: true) on each source_urls entry.'
      );
    }
    const url = doc.url + (Array.isArray(hash) ? hash[0] : hash);
    sources.push({ title: doc.title, citation: doc.citation, url, text: citedText(doc.blocks, cited) });
  }
  return sources;
}

export const getDailyTextImplementation = wrapTool(async (rawArgs) => {
  const args = requireArgs(rawArgs);
  const day = toIsoDate(args.date, 'date');
  const date = formatIsoDate(day);
  const withSources = toBool(args.sources, 'sources', { default: false });
  const deadline = Date.now() + CALL_BUDGET_MS;
  const lang = await language(args.langwritten, deadline);
  const entry = await cached(dailyKey(lang, date), DAILY_TTL_MS, () => loadDailyText(lang, day, date, deadline), { cache: wolCache });
  const out = lang.note ? { ...entry, note: lang.note } : entry;
  if (!withSources || !entry.source_urls.length) return out;
  return { ...out, sources: await dailySources(entry, deadline) };
}, 'get_daily_text');

export const getDailyTextTool = {
  name: 'get_daily_text',
  description:
    'The daily text (Examining the Scriptures Daily) from wol.jw.org: heading, theme_scripture, text, citation, source_urls (source_url = the first), memorial_reading (before the Memorial, else null) and url, for today or date (recent years only). sources: true adds the cited paragraphs (or use read_wol_document).',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD. Default: today (server time).' },
      langwritten: { type: 'string', description: LANGWRITTEN_DESCRIPTION },
      sources: { type: 'boolean', description: 'Also the cited source paragraphs. Default false.' }
    },
    required: []
  }
};

// ---------------------------------------------------------------------------
// read_wol_document

const DOC_URL_TEXT = 'a wol.jw.org link such as https://wol.jw.org/en/wol/d/r1/lp-e/2025241, a jw.org article link, or a jw.org finder link with docid=';
const JW_HOSTS = Object.freeze(['www.jw.org', 'jw.org']);
const WOL_PATH = /^\/[^/]+\/wol\/([a-z]+)\//i;
// Pages other tools handle better.
const OTHER_TOOL_PAGES = {
  __proto__: null,
  s: 'That is a WOL search page. Use search_wol with the same query instead.',
  qt: 'That is a WOL search page. Use search_wol with the same query instead.',
  h: 'That is the WOL daily text page. Use get_daily_text with the date instead (sources: true adds the cited paragraphs), or read_wol_document on its source_urls.'
};
// Links worth following: documents, paragraph citations, cross-references and verse indexes.
const DOC_LINK = /^(?:https:\/\/wol\.jw\.org)?\/[^/]+\/wol\/(?:d|pc|tc|dx)\//;

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul'
]);
// Answer boxes, page markers, media widgets, image toggles ("Printed Edition"),
// hidden templates and other chrome.
const DROP_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'button', 'label', 'svg', 'img',
  'video', 'audio', 'iframe', 'nav', 'hr', '.gen-field', '.pageNum', '.pswp', '#questionContainer',
  '#galleryModalContainer', '.cardThumbnail', '.cardChevron', '.alternatePresentation', '.hidden'
].join(', ');
// Language-neutral markers, like ▶ for cited paragraphs: no English label in Spanish or Japanese text.
const PREFIX = { __proto__: null, h1: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '#### ', h6: '#### ', li: '- ', figcaption: '🖼 ' };
// Older publications (roughly pre-2013) mark the title and subheadings with classes, not <h1>/<h2>.
const CLASS_PREFIX = { __proto__: null, st: '# ', ss: '## ' };

function blockPrefix(el) {
  if (PREFIX[el.name]) return PREFIX[el.name];
  if (el.name !== 'p') return undefined;
  const cls = (el.attribs.class ?? '').split(/\s+/);
  const byClass = cls.map((c) => CLASS_PREFIX[c]).find(Boolean);
  if (byClass) return byClass;
  // A box title ("Do You Recall?") is a p.so holding nothing but one <strong>.
  const kids = el.children.filter((c) => !(c.type === 'text' && !c.data.trim()));
  if (cls.includes('so') && kids.length === 1 && kids[0].name === 'strong') return '## ';
  return undefined;
}

// Absolute, without WOL's search-highlight query; keeps a #h=... paragraph range.
function docLink(href, base) {
  const u = new URL(href, base);
  u.search = '';
  return u.href.replace(/#$/, '');
}

function hasClass(el, name) {
  return (el.attribs?.class ?? '').split(/\s+/).includes(name);
}

/**
 * Turn WOL article markup into text blocks: [{ pid, pnum, verses, starts,
 * notes?, fnid?, text }] (pnum: the printed paragraph number; starts[k]: where
 * verses[k] begins in text; notes: [{ id, at }], the footnotes the block marks
 * and where; fnid: set on the blocks of a footnote).
 * Keeps paragraph numbers, headings (# style), list items and footnotes;
 * footnote markers become [a], or [*1] for a `footnotes` entry (Bible pages);
 * cross-reference "+" and other "*" markers are dropped; links to other WOL
 * documents become markdown links when `links`.
 */
export function renderBlocks($, $root, { base, links = true, footnotes } = {}) {
  $root.find(DROP_SELECTOR).remove();
  const blocks = [];
  let buf = '';
  let verses = [];
  let marks = []; // where each of verses starts in buf
  let notes = []; // [{ id, at }]: footnote markers and where they are in buf
  let pending = ''; // a prefix waiting for the first text of its block
  let pid;
  let pnum;
  let fnid; // set inside a footnote (div.fn-ref)
  let numbered = 0; // `footnotes` entries numbered so far, in marker order

  const flush = () => {
    const text = cleanText(buf);
    // cleanText is local, so a prefix of buf cleans to a prefix of text (less a joining space).
    const place = (at) => {
      const head = cleanText(buf.slice(0, at)).length;
      return pending.length + (head && text[head] === ' ' ? head + 1 : head);
    };
    const starts = marks.map(place);
    const placed = notes.map((n) => ({ id: n.id, at: place(n.at) }));
    buf = '';
    if (!text) {
      // The verses and notes carry over to the next block's text.
      marks = marks.map(() => 0);
      notes = notes.map((n) => ({ ...n, at: 0 }));
      return;
    }
    blocks.push({ pid, pnum, verses, starts, ...(placed.length && { notes: placed }), ...(fnid && { fnid }), text: pending + text });
    pending = '';
    verses = [];
    marks = [];
    notes = [];
    pnum = undefined;
  };

  const visitChildren = (el) => {
    for (const child of el.children ?? []) visit(child);
  };

  const visitBlock = (el) => {
    flush();
    const outerPid = pid;
    const outerFnid = fnid;
    const outerPending = pending;
    const prefix = blockPrefix(el);
    pid = el.attribs['data-pid'] ?? pid;
    if (hasClass(el, 'fn-ref') && el.attribs['data-fnid']) fnid = el.attribs['data-fnid'];
    if (prefix) pending = prefix;
    visitChildren(el);
    flush();
    pid = outerPid;
    fnid = outerFnid;
    pending = pending === prefix ? outerPending : pending;
  };

  const visit = (node) => {
    if (node.type === 'text') {
      buf += node.data;
      return;
    }
    if (node.type !== 'tag') return;
    const el = node;
    if (BLOCK_TAGS.has(el.name)) {
      visitBlock(el);
      return;
    }
    if (el.name === 'br') {
      buf += ' ';
      return;
    }
    if (hasClass(el, 'parNum')) {
      if (el.attribs['data-pnum']) {
        pnum = Number(el.attribs['data-pnum']);
        buf += ` ${el.attribs['data-pnum']} `;
      }
      return;
    }
    if (el.name === 'span' && hasClass(el, 'v')) {
      const m = /^v(\d+)-(\d+)-(\d+)/.exec(el.attribs.id ?? '');
      if (m) {
        verses.push([Number(m[1]), Number(m[2]), Number(m[3])]);
        marks.push(buf.length);
      }
    }
    // Bible pages print the chapter number in place of verse 1.
    if (el.name === 'a' && hasClass(el, 'cl') && verses.length) {
      buf += `${verses[verses.length - 1][2]} `;
      return;
    }
    if ((el.name === 'td' || el.name === 'th') && $(el).prevAll('td, th').length) buf += ' | ';
    if (el.name === 'a') {
      const text = cleanText($(el).text());
      if (hasClass(el, 'fn') || hasClass(el, 'fn-symbol')) {
        const id = hasClass(el, 'fn') ? el.attribs['data-fnid'] : undefined;
        if (id) notes.push({ id, at: buf.length });
        const note = id && footnotes?.get(id);
        if (note) buf += `[*${(note.n ??= ++numbered)}]`;
        else if (/^[\p{L}\p{N}]{1,3}$/u.test(text)) buf += `[${text}]`;
        return;
      }
      if (/^[+*]$/.test(text)) return;
      const href = el.attribs.href ?? '';
      if (links && DOC_LINK.test(href) && /\p{L}/u.test(text)) {
        buf += `[${text}](${docLink(href, base)})`;
        return;
      }
    }
    visitChildren(el);
  };

  visitChildren($root.get(0));
  flush();
  return blocks;
}

/** Parse a WOL document page into { title, publication, citation, blocks }. */
export function parseDocument(html, url, { links = true } = {}) {
  const $ = cheerio.load(html);
  const $article = $('#article').first();
  if (!$article.length) {
    throw new ToolError(
      `${url} has no article to read.`,
      'Pass a link to a WOL document (/wol/d/, /wol/pc/, /wol/b/ ...), for example one returned by search_wol.'
    );
  }
  const citationParts = $('#documentCitationInformation > div').map((_, d) => cleanText($(d).text())).get();
  // A citation of several ranges is a list of excerpts under "Title / Publication" cards.
  const $card = $article.find('li.linkCard a').first();
  // <title> is "Title — Watchtower ONLINE LIBRARY", or just the site name.
  const pageTitle = $('title').text().split(' — ');
  const title =
    cleanText($('#contentTitle').attr('value')) ||
    cleanText($article.find('h1').first().text()) ||
    cleanText($card.find('.cardLine1').text()) ||
    (pageTitle.length > 1 ? cleanText(pageTitle[0]) : null);
  const publication =
    cleanText($('#parentTitle').attr('value')) || citationParts[0] || cleanText($card.find('.cardLine2').text()) || null;
  const citation = citationParts[1] || null;
  const footnotes = bibleFootnotes($);
  const blocks = renderBlocks($, $article, { base: url, links, footnotes });
  const used = [...footnotes].filter(([, f]) => f.n).sort((a, b) => a[1].n - b[1].n);
  if (used.length) {
    // No pid or verses, so citations never select them; fnid ties each to its marker.
    // The heading is the page's own ("Footnotes", "Fußnoten").
    const heading = cleanText($('.group.footnote .header .title').first().text());
    if (heading) blocks.push({ verses: [], starts: [], text: `## ${heading}` });
    blocks.push(...used.map(([id, f]) => ({ verses: [], starts: [], fnid: id, text: `[*${f.n}] ${f.verse}: ${f.text}` })));
  }
  return { title, publication, citation, blocks };
}

// Bible chapter pages (/wol/b/) keep their footnotes outside #article, in the
// study pane: li[data-extract-id=verseFootnote-<id>] under an h3 naming the
// verse, matched by the "*" marker's data-fnid.
function bibleFootnotes($) {
  const notes = new Map();
  $('li.footnote[data-extract-id^="verseFootnote-"]').each((_, li) => {
    const $li = $(li);
    $li.find('.marker').remove();
    const text = cleanText($li.text());
    if (!text) return;
    notes.set($li.attr('data-extract-id').slice('verseFootnote-'.length), {
      verse: cleanText($li.closest('.section').children('.title').first().text()),
      text
    });
  });
  return notes;
}

function compareVerse(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The parts of blocks a link's fragment points at, in document order, as
 * [{ i, start, end }] (block index, character range in its text):
 * #h=13:0-16:0 (paragraph ids; an end token of 0 means "up to"), whole blocks;
 * #v=43:3:16[-43:3:18], just those verses, since a Bible <p> holds several.
 * Question blocks interleaved with the cited paragraphs have other ids and are
 * left out. Returns [] when there is none. An array of fragments gives the union.
 */
export function citedParts(blocks, hash) {
  if (Array.isArray(hash)) {
    const byBlock = new Map();
    for (const part of hash.flatMap((one) => citedParts(blocks, one))) {
      const seen = byBlock.get(part.i);
      byBlock.set(part.i, seen ? { i: part.i, start: Math.min(seen.start, part.start), end: Math.max(seen.end, part.end) } : part);
    }
    return [...byBlock.values()].sort((a, b) => a.i - b.i);
  }
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const h = /^(\d+)(?::\d+)?(?:-(\d+)(?::(\d+))?)?$/.exec(params.get('h') ?? '');
  const v = /^(\d+):(\d+):(\d+)(?:-(\d+):(\d+):(\d+))?$/.exec(params.get('v') ?? '');
  if (h) {
    const from = Number(h[1]);
    const to = h[2] === undefined ? from : h[3] === '0' ? Number(h[2]) - 1 : Number(h[2]);
    return blocks.flatMap((b, i) =>
      b.pid !== undefined && Number(b.pid) >= from && Number(b.pid) <= to ? [{ i, start: 0, end: b.text.length }] : []
    );
  }
  if (!v) return [];
  const from = [Number(v[1]), Number(v[2]), Number(v[3])];
  const to = v[4] ? [Number(v[4]), Number(v[5]), Number(v[6])] : from;
  const inRange = (x) => compareVerse(x, from) >= 0 && compareVerse(x, to) <= 0;
  return blocks.flatMap((b, i) => {
    const hit = b.verses.flatMap((x, k) => (inRange(x) ? [k] : []));
    if (!hit.length) return [];
    const start = b.starts[hit[0]];
    let end = b.starts[hit.at(-1) + 1] ?? b.text.length;
    while (end > start && b.text[end - 1] === ' ') end--;
    return [{ i, start, end }];
  });
}

/** The cited parts, then the footnotes they mark (which sit at the end of the document). */
export function citedText(blocks, parts) {
  const isCited = new Set(parts.map((p) => p.i));
  const marked = new Set(parts.flatMap((p) => (blocks[p.i].notes ?? []).filter((n) => n.at >= p.start && n.at < p.end).map((n) => n.id)));
  const footnotes = blocks.filter((b, i) => b.fnid !== undefined && marked.has(b.fnid) && !isCited.has(i));
  return [...parts.map((p) => blocks[p.i].text.slice(p.start, p.end)), ...footnotes.map((b) => b.text)].join('\n\n');
}

function joinBlocks(blocks) {
  return blocks.map((b) => b.text).join('\n\n');
}

// jw.org share links (finder?docid=N&wtlocale=X), as the workbook and Watchtower tools return them.
function finderDocid(u) {
  if (u.hostname === 'wol.jw.org' || !/(^|\.)jw\.org$/i.test(u.hostname) || !/^\/(finder|open)\/?$/i.test(u.pathname)) return null;
  const docid = /^\d{1,15}$/.exec(u.searchParams.get('docid')?.trim() ?? '')?.[0];
  return docid ? { docid, wtlocale: u.searchParams.get('wtlocale') || 'E' } : null;
}

// A song video link (lank=pub-sjjm_<n>_VIDEO) opens the song's lyrics page:
// song videos have no captions.
function songLink(u) {
  if (u.hostname === 'wol.jw.org' || !/(^|\.)jw\.org$/i.test(u.hostname)) return null;
  const song = songOfKey(u.searchParams.get('lank')?.trim());
  const docid = song && songbookDocid(song);
  if (!docid) return null;
  return {
    finder: { docid, wtlocale: u.searchParams.get('wtlocale') || 'E' },
    note: `That link is the video of song ${song}, which has no captions; this is the song's lyrics page.`
  };
}

// {url} for a WOL link, {finder: {docid, wtlocale}} for a jw.org finder link
// with docid= (or a song video's lank=, with a note), {jwPage} for a www.jw.org
// page (/<lang>/library/..., /<lang>/bible-teachings/...).
function toWolDocUrl(value) {
  let href;
  try {
    href = toJwUrl(value, 'url');
  } catch (error) {
    if (error instanceof ArgError && !error.tooLong) throw new ArgError('url', value, DOC_URL_TEXT);
    throw error;
  }
  const u = new URL(href);
  const finder = finderDocid(u);
  if (finder) return { finder };
  const lyrics = songLink(u);
  if (lyrics) return lyrics;
  const queryLink = u.searchParams.has('bible') || u.searchParams.has('lank');
  if (JW_HOSTS.includes(u.hostname) && !queryLink && /^\/[^/]+\/[^/]+/.test(u.pathname)) {
    u.hash = '';
    return { jwPage: u.href };
  }
  if (u.hostname !== 'wol.jw.org') {
    const hint = u.searchParams.has('bible')
      ? 'Use get_bible_verse or get_verse_with_study for Bible links.'
      : u.searchParams.has('lank')
        ? 'That is a video; use get_jw_captions.'
        : 'This tool reads wol.jw.org only. To find a jw.org article in WOL, search_wol for its title and open the result.';
    throw new ArgError('url', value, DOC_URL_TEXT, { hint });
  }
  const type = WOL_PATH.exec(u.pathname)?.[1]?.toLowerCase();
  if (!type) throw new ArgError('url', value, DOC_URL_TEXT);
  if (OTHER_TOOL_PAGES[type]) {
    throw new ArgError('url', value, 'a link to a WOL document', { hint: OTHER_TOOL_PAGES[type] });
  }
  return { url: u.href };
}

// A /wol/d/ link read in langwritten: the same docid (MEPS ids are shared across
// languages) and #h= range. Other link types are read as given, with a note.
function wolLinkIn(href, lang) {
  const u = new URL(href);
  const lp = /^\/[^/]+\/wol\/[a-z]+\/[^/]+\/(lp-[^/]+)/i.exec(u.pathname)?.[1]?.toLowerCase();
  if (!lp || lp === lang.wol?.lp) return { url: href };
  const docid = /^\/[^/]+\/wol\/d\/[^/]+\/[^/]+\/(\d{1,15})\/?$/i.exec(u.pathname)?.[1];
  if (docid) {
    const hint = `WOL has no ${lang.name} edition of document ${docid}. Leave out langwritten to read the link as given, or search_wol with langwritten ${lang.code}.`;
    return { url: wolUrl(lang, 'd', docid) + u.hash, hints: { ...DOC_HINTS, 404: hint } };
  }
  return {
    url: href,
    note: `langwritten ${lang.code} was not applied: it switches docid, finder and /wol/d/ links only, so this ${lp} link was read as given. For ${lang.name}, search_wol with langwritten ${lang.code}.`
  };
}

// A www.jw.org article page names its own document in <body>: id="mid<docid>"
// or class "docId-<docid>", its language as class "ml-<code>", and a Bible
// chapter as data-insight-context-id="bc-43003_nwtsty". The first docid= or
// data-page-id elsewhere on the page belongs to related cards or the footer.
function parseJwPageBody(html) {
  const tag = /<body\b[^>]*>/i.exec(html)?.[0] ?? '';
  const attr = (name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ?? '';
  const cls = attr('class');
  const bible = /^bc-(\d{1,2})(\d{3})_([a-z0-9]+)$/i.exec(attr('data-insight-context-id'));
  return {
    docid: /^mid(\d{1,15})$/.exec(attr('id'))?.[1] ?? /\bdocId-(\d{1,15})\b/.exec(cls)?.[1] ?? null,
    code: /\bml-([A-Z0-9]+)\b/.exec(cls)?.[1] ?? null,
    bible: bible ? { book: Number(bible[1]), chapter: Number(bible[2]), pub: bible[3].toLowerCase() } : null
  };
}

const JW_PAGE_SEARCH_HINT = 'This tool reads wol.jw.org only. To find a jw.org article in WOL, search_wol for its title and open the result.';

async function loadJwPage(href, deadline) {
  const res = await fetchResource(href, {
    allowHosts: JW_HOSTS,
    deadline,
    hints: { 404: 'That jw.org page does not exist. Check the link, or search_wol for its title.' }
  });
  if (!/html/i.test(res.contentType)) {
    throw new ToolError(`${res.url} is not a jw.org page (it is ${res.contentType || 'an unknown type'}).`, JW_PAGE_SEARCH_HINT);
  }
  return { ...parseJwPageBody(new TextDecoder().decode(res.buffer)), path: new URL(res.url).pathname.split('/')[1] ?? '' };
}

// The body's ml-<code> is a JW code; the path's first segment a locale (/en/, /es/).
async function pageLanguage(page, deadline) {
  for (const [value, as] of [[page.code, 'code'], [page.path, 'any']]) {
    if (!value) continue;
    try {
      return await resolveLanguage(value, { as, deadline });
    } catch (error) {
      if (!(error instanceof ArgError)) throw error;
    }
  }
  return resolveLanguage('E');
}

// The WOL address of the document a jw.org article page shows: its docid in
// `asked` (the resolved langwritten), else in the page's own language. One
// cached request.
async function jwPageWolUrl(href, value, asked, deadline) {
  const page = await cached(`wol:jwpage:${href}`, DAY_MS, () => loadJwPage(href, deadline), { cache: wolCache });
  if (!page.docid && !page.bible) {
    throw new ToolError(`${href} names no document that WOL has.`, JW_PAGE_SEARCH_HINT);
  }
  // wolUrl reports a langwritten without a library itself.
  const lang = asked ?? (await pageLanguage(page, deadline));
  if (!asked && !lang.wol) {
    throw new ArgError('url', value, 'a language available on wol.jw.org', {
      message: `That jw.org page is in ${lang.name}, which has no Watchtower Online Library on wol.jw.org.`,
      hint: 'Pass langwritten (e.g. "E") to read the document in another language.'
    });
  }
  if (page.bible) return wolUrl(lang, 'b', page.bible.pub, page.bible.book, page.bible.chapter);
  return wolUrl(lang, 'd', page.docid);
}

// The caller sent no langwritten, so a bad wtlocale is blamed on the link.
async function finderWolUrl({ docid, wtlocale }, value, deadline) {
  const hint = `Pass langwritten (e.g. "E") to read docid ${docid} in another language, or pass docid=${docid} instead of the link.`;
  let lang;
  try {
    lang = await resolveLanguage(wtlocale, { as: 'code', deadline });
  } catch (error) {
    if (!(error instanceof ArgError)) throw error; // a failing language list passes through unchanged
    throw new ArgError('url', value, 'a finder link whose wtlocale is a JW.org language code', {
      message: `The link's wtlocale=${describeValue(wtlocale)} is not a JW.org language code.`,
      hint
    });
  }
  if (!lang.wol) {
    throw new ArgError('url', value, 'a language available on wol.jw.org', {
      message: `The link's wtlocale=${lang.code} is ${lang.name}, which has no Watchtower Online Library on wol.jw.org.`,
      hint
    });
  }
  return wolUrl(lang, 'd', docid);
}

const DOC_TTL_MS = 6 * HOUR_MS;
// These link types only redirect to a document; #h=... on the target marks the cited paragraphs.
const REDIRECTORS = new Set(['pc', 'tc', 'bc']);
const DOC_HINTS = {
  404: 'Check the link: copy it exactly from a tool result, or use search_wol to find the document.',
  blocked_host: 'That WOL link leads off wol.jw.org (for example to www.jw.org); this tool reads wol.jw.org pages only.'
};
// Some finder docids are jw.org-only web pages (section indexes), which WOL does not have.
const FINDER_HINTS = {
  ...DOC_HINTS,
  404: 'WOL has no document with that docid; it is probably a jw.org web page (such as a section index). Open the link in a browser, or search_wol for its title.'
};

/**
 * The document a link leads to: { docUrl (no fragment, no search highlighting),
 * hash (a fragment, or an array of them for a citation of several ranges) }.
 * Citation links are resolved with one cached lookup, so several citations
 * into the same document share one download.
 */
async function locateDocument(url, deadline) {
  const u = new URL(url);
  const hash = u.hash;
  u.hash = '';
  u.searchParams.delete('q');
  u.searchParams.delete('p');
  if (![...u.searchParams].length) u.search = '';
  const type = WOL_PATH.exec(u.pathname)[1].toLowerCase();
  if (!REDIRECTORS.has(type)) return { docUrl: u.href, hash };

  const location = await cached(`wol:loc:${u.href}`, DAY_MS, () => resolveCitation(u.href, deadline), { cache: wolCache });
  if (!location) return { docUrl: u.href, hash };
  if (Array.isArray(location)) {
    const first = new URL(location[0]);
    first.hash = '';
    return { docUrl: first.href, hash: hash || location.map((l) => new URL(l).hash) };
  }
  const target = new URL(location);
  if (target.hostname !== 'wol.jw.org') {
    throw new ToolError(`${url} leads to ${location}, outside wol.jw.org.`, 'Open that link in a browser; this tool reads wol.jw.org pages only.');
  }
  const targetHash = target.hash;
  target.hash = '';
  return { docUrl: target.href, hash: hash || targetHash };
}

// One request: a redirect target, or for a citation of several paragraph ranges
// (WOL answers 200 with a list of excerpts) the /wol/d/ link of each excerpt,
// when they all lie in one document; null otherwise.
async function resolveCitation(href, deadline) {
  const res = await fetchResource(href, { allowHosts: WOL_HOSTS, hints: DOC_HINTS, redirect: 'manual', deadline });
  if (res.location) return res.location;
  if (!/html/i.test(res.contentType)) return null;
  const $ = cheerio.load(new TextDecoder().decode(res.buffer));
  const targets = $('#article li.linkCard a[href*="/wol/d/"]').map((_, a) => absoluteUrl($(a).attr('href'), href)).get().filter(Boolean);
  const docs = new Set(targets.map((t) => t.split('#')[0]));
  return targets.length && docs.size === 1 ? targets : null;
}

async function loadDocument(url, { links, hints = DOC_HINTS, deadline }) {
  const page = await fetchWolPage(url, { hints, deadline });
  const doc = parseDocument(page.html, page.url, { links });
  if (!doc.blocks.length) {
    throw new ToolError(`${page.url} has no readable text.`, 'Pass a link to an article, book chapter or Bible chapter on wol.jw.org.');
  }
  return { ...doc, url: page.url.split('#')[0] };
}

const CITED_MARK = '▶ ';

// The document a link points into, and the indexes of its cited blocks.
async function readCitation(url, { links = true, hints = DOC_HINTS, deadline } = {}) {
  const { docUrl, hash } = await locateDocument(url, deadline);
  const doc = await cached(`wol:doc:${links ? 'l' : 'n'}:${docUrl}`, DOC_TTL_MS, () => loadDocument(docUrl, { links, hints, deadline }), {
    cache: wolCache
  });
  return { doc, hash, cited: citedParts(doc.blocks, hash) };
}

// One page of text. PAGE_TOKENS leaves room for the metadata (a link is at most
// 2000 characters), so the whole result stays within MAX_RESULT_TOKENS.
function pagedResult(out, text, offset, maxChars) {
  const part = pageByTokens(text, offset, maxChars);
  return { ...out, offset, next_offset: part.next_offset, total_chars: text.length, text: part.text };
}

export const readWolDocumentImplementation = wrapTool(async (rawArgs) => {
  const args = requireArgs(rawArgs);
  const maxChars = toInt(args.max_chars, 'max_chars', { min: 1000, max: MAX_MAX_CHARS, default: DEFAULT_MAX_CHARS });
  const offset = toInt(args.offset, 'offset', { min: 0, default: 0 });
  const citedOnly = toBool(args.cited_only, 'cited_only', { default: false });
  const links = toBool(args.links, 'links', { default: true });
  const deadline = Date.now() + CALL_BUDGET_MS;

  let url;
  let hints = DOC_HINTS;
  let linkNote;
  // An explicit langwritten, resolved once (its note, e.g. "TL" read as Tagalog, goes in the result).
  const asked = isMissing(args.langwritten) ? null : await language(args.langwritten, deadline);
  if (!isMissing(args.url)) {
    const ref = toWolDocUrl(args.url);
    if (ref.finder) {
      // langwritten, when given, overrides the link's wtlocale (a JW code: TL is Tamil).
      hints = FINDER_HINTS;
      linkNote = ref.note;
      url = asked ? wolUrl(asked, 'd', ref.finder.docid) : await finderWolUrl(ref.finder, args.url, deadline);
    } else if (ref.jwPage) {
      // A jw.org section index has a docid WOL lacks: FINDER_HINTS says so on the 404.
      hints = FINDER_HINTS;
      url = await jwPageWolUrl(ref.jwPage, args.url, asked, deadline);
    } else if (!asked) {
      url = ref.url;
    } else {
      ({ url, hints = DOC_HINTS, note: linkNote } = wolLinkIn(ref.url, asked));
    }
  } else if (!isMissing(args.docid)) {
    const docid = toStr(args.docid, 'docid', {
      pattern: /^\d{1,15}$/,
      patternText: 'a WOL document id: the number in a /wol/d/ link, e.g. 2025241'
    });
    url = wolUrl(asked ?? (await language(undefined, deadline)), 'd', docid);
  } else {
    throw new ArgError('url', undefined, `${DOC_URL_TEXT}, or a docid`);
  }

  const { doc, hash, cited } = await readCitation(url, { links, hints, deadline });

  const out = { title: doc.title, publication: doc.publication, citation: doc.citation, url: doc.url + (Array.isArray(hash) ? hash[0] : hash) };
  let text;
  if (citedOnly && cited.length) {
    text = citedText(doc.blocks, cited);
    out.showing = 'cited paragraphs only';
  } else {
    // ▶ marks where each cited part starts; offset and chars are measured on the marked text.
    const parts = new Map(cited.map((p) => [p.i, p]));
    const blocks = doc.blocks.map((b, i) => {
      const p = parts.get(i);
      return p ? { ...b, text: b.text.slice(0, p.start) + CITED_MARK + b.text.slice(p.start) } : b;
    });
    text = joinBlocks(blocks);
    if (cited.length) {
      const first = cited[0];
      const last = cited.at(-1);
      const at = (i) => (i ? joinBlocks(blocks.slice(0, i)).length + 2 : 0);
      const offset = at(first.i) + first.start;
      const paragraphs = cited.map((p) => doc.blocks[p.i].pnum).filter((n) => n !== undefined);
      out.cited = { ...(paragraphs.length && { paragraphs }), offset, chars: at(last.i) + CITED_MARK.length + last.end - offset };
    } else if (citedOnly) {
      out.note = 'This link does not point at specific paragraphs, so the whole document is returned.';
    }
  }
  for (const note of [linkNote, asked?.note]) if (note) out.note = out.note ? `${note} ${out.note}` : note;
  return pagedResult(out, text, offset, maxChars);
}, 'read_wol_document');

export const readWolDocumentTool = {
  name: 'read_wol_document',
  description:
    'A wol.jw.org document as clean text (articles, Insight, books, Bible chapters), e.g. links other tools return or a jw.org article. Returns title, publication, citation, url and text with paragraph numbers, # headings, 🖼 captions and markdown links. Call again with offset = next_offset until null. Citation links (/wol/pc/, /bc/, #v=) also return cited {paragraphs, offset, chars}, marked ▶ in text; cited_only returns just those.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A wol.jw.org link (/wol/d/, /pc/, /b/...), a jw.org article link, or a jw.org finder?docid= link.' },
      docid: { type: 'string', description: 'Instead of url: a WOL document id, read in langwritten.' },
      langwritten: { type: 'string', description: 'Reads docid, finder, jw.org and /wol/d/ links in this language (code, ISO tag or name). Default: the link\'s, else E.' },
      max_chars: { type: 'integer', minimum: 1000, maximum: MAX_MAX_CHARS, description: `Default ${DEFAULT_MAX_CHARS} (pages end sooner in CJK).` },
      offset: { type: 'integer', minimum: 0, description: 'next_offset of the last call.' },
      cited_only: { type: 'boolean', description: 'Only the cited paragraphs. Default false.' },
      links: { type: 'boolean', description: 'Keep links as markdown. Default true.' }
    },
    required: []
  }
};

// ---------------------------------------------------------------------------
// search_wol

const SEARCH_TTL_MS = HOUR_MS;
const SCOPES = { sentence: 'sen', paragraph: 'par', article: 'doc' };
const SORTS = { occurrences: 'occ', newest: 'newest', oldest: 'oldest' };
// WOL's "Refine Search" categories (the fc[] parameter); the codes are the same in every language.
const PUBLICATIONS = {
  bible: 'bi',
  watchtower: 'w',
  awake: 'g',
  insight: 'it',
  index: 'dx',
  glossary: 'gloss',
  books: 'bk',
  brochures: 'brch',
  booklets: 'bklt',
  tracts: 'trct',
  workbook: 'mwb',
  kingdom_ministry: 'km',
  daily_text: 'es',
  yearbooks: 'yb',
  songbooks: 'sgbk',
  kingdom_news: 'kn',
  web: 'web'
};
const PUBLICATION_NAMES = [...new Set([...Object.keys(PUBLICATIONS), ...Object.values(PUBLICATIONS)])];

function toPublications(value) {
  if (isMissing(value)) return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!list) throw new ArgError('publications', value, 'an array of publication names such as ["watchtower", "insight"]');
  const codes = list
    .filter((v) => !isMissing(v))
    .map((v) => toEnum(v, 'publications', PUBLICATION_NAMES))
    .map((name) => PUBLICATIONS[name] ?? name);
  return [...new Set(codes)];
}

function parseCount(text) {
  const digits = String(text ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

function snippetOf($, $doc, max = SNIPPET_CHARS) {
  $doc.find('label, textarea, .gen-field, a.fn, a.fn-symbol').remove();
  $doc.find('a').filter((_, a) => /^[+*]$/.test($(a).text().trim())).remove();
  const parts = $doc.find('p, h1, h2, h3, h4, li').map((_, el) => cleanText($(el).text())).get().filter(Boolean);
  let text = parts.length ? parts.join(' … ') : cleanText($doc.text());
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text || null;
}

/** Parse one WOL search results page into { total, results, glossary }. */
export function parseSearchPage(html, pageUrl) {
  const $ = cheerio.load(html);
  if (!$('#searchResultsForm').length) {
    throw new ToolError(
      `wol.jw.org answered the search with an unexpected page (${pageUrl}).`,
      'WOL may have changed its layout or be busy. Try again later.'
    );
  }
  // WOL heads page 1 with a glossary card (ul.resultContentTopic) whatever the
  // publications filter; it is not one of the 40 documents per page.
  let glossary = null;
  const $topic = $('ul.results.resultContentTopic').first();
  const $topicLink = $topic.find('li.caption a').first();
  const topicUrl = $topicLink.attr('href') ? absoluteUrl($topicLink.attr('href'), pageUrl) : null;
  if (topicUrl) {
    glossary = {
      title: cleanText($topicLink.text()),
      url: withoutQuery(topicUrl),
      definition: snippetOf($, $topic.find('li.definition').first(), GLOSSARY_CHARS)
    };
  }
  const results = [];
  $('ul.results').not('.resultContentTopic').each((_, ul) => {
    const $ul = $(ul);
    const $link = $ul.find('li.caption a').first();
    const href = $link.attr('href');
    if (!href) return;
    const url = absoluteUrl(href, pageUrl);
    if (!url) return;
    results.push({
      title: cleanText($link.text()),
      citation: cleanText($ul.find('li.ref').first().text()) || null,
      url: withoutQuery(url),
      occurrences: parseCount($ul.find('li.caption .count').first().text()),
      snippet: snippetOf($, $ul.find('li.searchResult .document').first())
    });
  });
  // null: WOL leaves the total blank both for no matches and for a page past the last one.
  const total = parseCount($('#searchResultsTotal').attr('value')) ?? (results.length || null);
  return { total, results, glossary };
}

// WOL keeps punctuation attached to a word as part of it, so "Son," "You?" "Look!"
// and "—" match nothing. Kept: an en dash between digits (John 17:1–3),
// punctuation after digits (John 3:16, 17), hyphens, a mid-word ? wildcard
// (wom?n), a ! starting a word (NOT), | ( ) * and quotes.
export function wolQueryText(query) {
  const removed = new Set();
  const drop = (ch, out = ' ') => (removed.add(ch), out);
  const q = query
    .replace(/[—―]/g, (m) => drop(m))
    .replace(/(^|\D)–|–(?=\D|$)/g, (m, before = '') => drop('–', `${before} `))
    .replace(/(^|\s)(?:\.\s*){2,}|…/g, (m, before = '') => drop('…', `${before} `))
    .replace(/(\p{L})([.,;:?!]+)(?=[\s"”’)]|$)/gu, (m, l, p) => ([...p].forEach((c) => removed.add(c)), l))
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { q, removed: [...removed] };
}

export const searchWolImplementation = wrapTool(async (rawArgs) => {
  const args = requireArgs(rawArgs);
  const query = toStr(args.query, 'query', { maxLength: 256, patternText: 'search words, a "quoted phrase" or a Bible citation (at most 256 characters)' });
  const limit = toInt(args.limit, 'limit', { min: 1, max: SEARCH_PAGE_SIZE, default: 10 });
  const page = toInt(args.page, 'page', { min: 1, max: 1000, default: 1 });
  const scope = SCOPES[toEnum(args.scope, 'scope', Object.keys(SCOPES), { default: 'paragraph' })];
  const sort = SORTS[toEnum(args.sort, 'sort', Object.keys(SORTS), { default: 'occurrences' })];
  const publications = toPublications(args.publications);
  const { q: searched, removed } = wolQueryText(query);
  if (!searched) {
    throw new ArgError('query', query, 'search words, a "quoted phrase" or a Bible citation', {
      hint: 'WOL matches words, not punctuation; send at least one word.'
    });
  }
  const deadline = Date.now() + CALL_BUDGET_MS;
  const lang = await language(args.langwritten, deadline);

  const loadPage = (pg) => {
    const url = new URL(wolUrl(lang, 's'));
    url.searchParams.set('q', searched);
    url.searchParams.set('p', scope);
    url.searchParams.set('r', sort);
    for (const fc of publications) url.searchParams.append('fc[]', fc);
    if (pg > 1) url.searchParams.set('pg', String(pg));
    return cached(
      `wol:search:${lang.code}:${url.search}`,
      SEARCH_TTL_MS,
      async () => parseSearchPage((await fetchWolPage(url.href, { deadline })).html, url.href),
      { cache: wolCache }
    );
  };

  const start = (page - 1) * limit;
  const firstPage = Math.floor(start / SEARCH_PAGE_SIZE) + 1;
  const lastPage = Math.floor((start + limit - 1) / SEARCH_PAGE_SIZE) + 1;
  const first = await loadPage(firstPage);
  let rows = first.results;
  if (lastPage > firstPage && first.results.length === SEARCH_PAGE_SIZE) {
    rows = rows.concat((await loadPage(lastPage)).results);
  }
  const offsetInPage = start - (firstPage - 1) * SEARCH_PAGE_SIZE;
  const results = rows.slice(offsetInPage, offsetInPage + limit);
  // Past the last WOL page the total is blank, so take it from page 1 (usually cached).
  const total = (first.total === null && firstPage > 1 ? (await loadPage(1)).total : first.total) ?? 0;

  const out = { query, ...(searched !== query && { searched }), total, page, results };
  if (page === 1 && first.glossary) out.glossary = first.glossary;
  if (start + results.length < total && results.length === limit) out.next_page = page + 1;
  const notes = [lang.note];
  if (removed.length) {
    const wildcard = removed.includes('?') ? ' (a ? ending a word would be a one-character wildcard)' : '';
    const marks = removed.map((c) => `"${c}"`).join(', ');
    notes.push(`Searched for ${searched}: WOL matches words only, so ${marks} ${removed.length > 1 ? 'were' : 'was'} removed${wildcard}.`);
  }
  if (!total) {
    const other = lang.code === 'E' ? '"S" for Spanish' : '"E" for English';
    notes.push(`No matches in the ${lang.name} library. Check the spelling, use fewer or more general words, a * wildcard, scope "article", or remove the publications filter. If the query is in another language, pass its langwritten (e.g. ${other}).`);
  } else if (!results.length) {
    notes.push(`No results on page ${page}: there are ${total} in all, ${limit} per page.`);
  }
  const note = notes.filter(Boolean).join(' ');
  if (note) out.note = note;
  return out;
}, 'search_wol');

export const searchWolTool = {
  name: 'search_wol',
  description:
    'Search the Watchtower Online Library: total plus results {title, citation, url, occurrences, snippet}; open one with read_wol_document. Finds topics, phrases, or publications citing a verse (query "John 3:16"). Syntax: all words must appear; "exact phrase"; * any text; ? one character; | OR; ! NOT; ( ) group.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words, a "phrase" or a citation, in the search language.' },
      langwritten: { type: 'string', description: LANGWRITTEN_DESCRIPTION },
      limit: { type: 'integer', minimum: 1, maximum: SEARCH_PAGE_SIZE, description: 'Results per page. Default 10.' },
      page: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 1; use next_page for more.' },
      scope: { type: 'string', enum: Object.keys(SCOPES), description: 'Where all words must occur together. Default paragraph.' },
      sort: { type: 'string', enum: Object.keys(SORTS), description: 'Default occurrences.' },
      publications: {
        type: 'array',
        items: { type: 'string', enum: Object.keys(PUBLICATIONS) },
        description: 'Only these kinds, e.g. ["watchtower", "insight"]. Default: all.'
      }
    },
    required: ['query']
  }
};

// ---------------------------------------------------------------------------

export const wolTools = [getDailyTextTool, readWolDocumentTool, searchWolTool];

export async function handleWolTools(request) {
  const args = request.params.arguments;
  switch (request.params.name) {
    case 'get_daily_text':
      return await getDailyTextImplementation(args);
    case 'read_wol_document':
      return await readWolDocumentImplementation(args);
    case 'search_wol':
      return await searchWolImplementation(args);
    default:
      return null;
  }
}
