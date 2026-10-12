// jw.org study-Bible data: verse text, psalm superscriptions, footnotes, cross
// references, study notes and chapter outlines, from the JSON the jw.org Bible
// pages load: <books path>/json/data/<BBCCC000-BBCCC999>, one whole chapter.
//
// Facts this relies on (checked 2026-10-12):
// - jw.org's chapter pages request BBCCC000-BBCCC999 on every chapter view and
//   CloudFront caches each URL (s-maxage 8 h): a miss takes about 2.5-3 s, a
//   hit 0.1-0.2 s, so this module asks for whole chapters by that id only;
// - a range whose end does not exist is clamped (validRange); one that does not
//   exist at all is missing from `ranges`;
// - a psalm's superscription is returned when the range starts at verse 0;
// - acrostic letter headings (style-s, "ב [Beth]" in Psalm 119, Proverbs 31,
//   Lamentations 1-4) also come in `superscriptions`, with source = the verse
//   they head (19119009), whenever that verse is in the range;
// - every response carries a ~150 KB editionData block (book names and which
//   books have study notes), which is dropped before caching.

import * as cheerio from 'cheerio';

import { TtlLruCache, cached } from './cache.js';
import { JwFetchError, fetchJson, fetchRedirect } from './http.js';
import { ToolError } from './results.js';
import { cleanText, joinText } from './text.js';
import { BIBLE_BOOKS, bibleVerseId, finderUrl, getFirstVerse, getVerseCount, hasBookNames, registerBookNames } from './bible-books.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Chapters fetched at once for a long passage or a ";" list.
const CHAPTER_CONCURRENCY = 4;

// Books paths that need no lookup; other languages are found through the finder.
const KNOWN_BASES = { E: 'https://www.jw.org/en/library/bible/study-bible/books/' };

const bibleCache = new TtlLruCache({ maxEntries: 200, ttlMs: 6 * HOUR_MS });

/** For tests: forget fetched ranges and books paths. */
export function clearBibleCache() {
  bibleCache.clear();
}

// jw.org's JSON carries pinyin/furigana as <ruby><rb>base</rb><rt>reading</rt></ruby> (CHS, CH, J); keep the base text only.
function fragment(html) {
  const $ = cheerio.load(String(html ?? ''), null, false);
  $('rt, rp').remove();
  $('ruby, rb').each((_, el) => {
    $(el).replaceWith($(el).contents());
  });
  return $;
}

/** Text of an HTML fragment, entities decoded ("Luke&nbsp;10:25" -> "Luke 10:25"). */
export function htmlText(html) {
  const s = String(html ?? '');
  return cleanText(/[<&]/.test(s) ? fragment(s).root().text() : s);
}

const MARK = '\u0001';
const LINE = '\u0002';
const CLAUSE_END = /[,;:.!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]/;
const EDGE_PUNCT = /^[\s\p{Po}\p{Pi}\p{Pf}]+|[\s\p{Po}\p{Pi}\p{Pf}]+$/gu;

/** True for verse HTML set as poetry (style-l / style-z lines, as in the Psalms). */
export function isPoetry(html) {
  return /class="[^"]*\bstyle-[lz]\b/.test(String(html ?? ''));
}

/** Verse HTML -> plain text: no verse or chapter number, no "+"/"*" markers; poetry keeps one printed line per "\n". */
export function verseHtmlToText(html) {
  return verseLines(html).join('\n');
}

// The printed lines of a verse (one for prose). Markers of `tag` (xref or fn)
// become MARK<id>MARK and the other kind is removed; one tag per pass, or a
// "+" right after a footnote marker would lose its phrase.
function verseLines(html, tag = null) {
  const $ = fragment(html);
  $('sup.verseNum, .chapterNum').remove();
  $('xref, fn').each((_, el) => {
    const $el = $(el);
    if (el.name === tag) $el.replaceWith(`${MARK}${$el.attr('id') ?? ''}${MARK}`);
    else $el.remove();
  });
  $('.newblock, .parabreak').replaceWith('\n');
  $('[class*="style-"]').append(isPoetry(html) ? LINE : '\n');
  return $.root().text().split(LINE).map((line) => line.split('\n').reduce(joinText, '')).filter(Boolean);
}

/**
 * Verse HTML -> Map of <marker id> -> the words a marker of `tag` follows (a
 * cross reference's "+" or a footnote's "*"): the last clause before it, back
 * to the previous marker ("the only true God").
 */
export function markerPhrases(html, tag = 'xref', into = new Map()) {
  const text = verseLines(html, tag).reduce(joinText, '');
  const parts = text.split(/\u0001([^\u0001]*)\u0001/);
  for (let i = 1; i < parts.length; i += 2) {
    const before = parts[i - 1].replace(EDGE_PUNCT, '');
    const phrase = before.split(CLAUSE_END).at(-1).replace(EDGE_PUNCT, '') || before;
    if (parts[i] && phrase) into.set(parts[i], phrase);
  }
  return into;
}

// Ids of the xref and fn markers in verse HTML, in text order (markerPhrases
// skips a marker whose phrase is empty, so its order cannot be used).
function markerIds(html) {
  const $ = fragment(html);
  return $('xref, fn').map((_, el) => $(el).attr('id') ?? '').get().filter(Boolean);
}

/** markerPhrases for cross-reference markers. */
export function xrefPhrases(html, into) {
  return markerPhrases(html, 'xref', into);
}

// Reading aids the NWT prints in names (Jo·haʹnan, Jọhanan, Joha̱nan, Иохана́н); jw.org's
// other publications quote verses without them. Per language, because the same marks are
// ordinary spelling elsewhere (Catalan l·l, Vietnamese ạ, Macedonian ѓ).
const PRONUNCIATION_MARKS = { __proto__: null, E: /[\u00b7\u02b9]/g, X: /\u0323/g, Z: /\u0323/g, O: /\u0331/g, U: /\u0301/g };

/** Verse text without the NWT's pronunciation marks in languageCode (E, X, Z, O, U); others unchanged. */
export function stripPronunciationMarks(text, languageCode) {
  const marks = PRONUNCIATION_MARKS[languageCode];
  return marks && text ? String(text).normalize('NFD').replace(marks, '').normalize('NFC') : text;
}

// The NWT's placeholder for a verse it leaves out: "——" (E, J), "－－－" (CHS, CH),
// "——." (VT), "[...]" with word joiners (I).
export function isOmittedText(text) {
  return /^(?:[\u2012-\u2015\u2212\uff0d-]+\.?|\[(?:\.+|\u2026)\])$/.test(String(text ?? '').replace(/[\s\u2060]/g, ''));
}

/**
 * Study-note HTML -> [{term?, note}]. A paragraph that opens with a bold term
 * starts a note: "<strong>term:</strong>" (en, pl, ja...), or a bold run that
 * is not a verse number followed by a space ("amó." in es, "la luce" in it,
 * ruby-wrapped "爱" in zh), or nothing but a bold heading such as "7:53". Other
 * paragraphs (including quoted verses that start with a bold verse number)
 * continue the previous note. One trailing ":" or "." is dropped from a term.
 */
export function parseStudyNotes(html) {
  const $ = fragment(html);
  const notes = [];
  $('p').each((_, p) => {
    const $p = $(p);
    const nodes = $p.contents().toArray();
    let i = 0;
    while (i < nodes.length && nodes[i].type === 'text' && !nodes[i].data.trim()) i++;
    const bold = [];
    while (i < nodes.length && nodes[i].type === 'tag' && nodes[i].name === 'strong') bold.push(nodes[i++]);
    const lead = cleanText($(bold).text());
    const whole = cleanText($p.text());
    const spaceAfter = i < nodes.length && nodes[i].type === 'text' && /^\s/.test(nodes[i].data);
    const verseNumber = /^[\d\s:,.\u2013\u2014-]+$/.test(lead);
    if (lead && (/[:\uff1a]$/.test(lead) || lead === whole || (spaceAfter && !verseNumber))) {
      $(bold).remove();
      notes.push({ term: lead.replace(/\s*[:\uff1a.\u3002]$/, ''), note: cleanText($p.text()) });
      return;
    }
    if (!whole) return;
    const last = notes[notes.length - 1];
    if (last) last.note = last.note ? `${last.note} ${whole}` : whole;
    else notes.push({ note: whole });
  });
  if (!notes.length) {
    const text = cleanText($.root().text());
    if (text) notes.push({ note: text });
  }
  return notes;
}

function chapterSpan(targets) {
  const ids = String(targets ?? '').match(/\d{7,8}/g);
  if (!ids) return null;
  const chapterOf = (id) => Number(id.slice(-6, -3));
  return [chapterOf(ids[0]), chapterOf(ids[ids.length - 1])];
}

/** Chapter-outline HTML -> [{level, text, chapters: [first, last] | null}]. */
export function parseOutline(html) {
  const $ = fragment(html);
  const entries = [];
  $('li').each((_, li) => {
    const level = Number(/\bL(\d)\b/.exec($(li).attr('class') || '')?.[1]);
    if (!level) return;
    let p = $(li).children('p').first();
    if (!p.length) p = $(li).children('div').children('p').first();
    const text = cleanText(p.text());
    if (!text) return;
    entries.push({ level, text, chapters: chapterSpan(p.find('[data-targetverses]').first().attr('data-targetverses')) });
  });
  return entries;
}

function splitId(id) {
  const s = String(id ?? '');
  if (!/^\d{7,8}$/.test(s)) return null;
  return { book: Number(s.slice(0, -6)), chapter: Number(s.slice(-6, -3)), verse: Number(s.slice(-3)) };
}

// jw.org JSON lists and HTML strings; a wrong type counts as empty.
const list = (value) => (Array.isArray(value) ? value.filter((x) => x && typeof x === 'object') : []);
const html = (value) => (typeof value === 'string' ? value : '');

/**
 * One entry of the JSON `ranges` object -> {verses, superscriptions, headings,
 * crossReferences, footnotes, notes, outlines}, each item tagged with its
 * chapter and verse (0 = superscription). A verse set as poetry has
 * `poetry: true` and its lines joined by "\n". headings are acrostic letters
 * on the verse they head; crossReferences has one entry per "+" marker, with
 * the phrase it follows; each footnote has its `id` and the `phrase` its
 * marker follows. Throws TypeError when the verses are unusable; secondary
 * fields of the wrong type are read as empty.
 */
export function parseRange(range) {
  if (!Array.isArray(range?.verses)) throw new TypeError('range.verses is not a list');
  const verses = new Map();
  for (const v of list(range.verses)) {
    const at = splitId(v.vsID) ?? { chapter: Number(v.chapterNumber), verse: Number(v.verseNumber) };
    if (!Number.isInteger(at.chapter) || !Number.isInteger(at.verse)) continue;
    const key = `${at.chapter}:${at.verse}`;
    const text = verseHtmlToText(html(v.content));
    const poetry = isPoetry(html(v.content));
    const prev = verses.get(key);
    if (prev) {
      // joinText would squash the line breaks of poetry.
      prev.text = poetry || prev.poetry ? [prev.text, text].filter(Boolean).join('\n') : joinText(prev.text, text);
      prev.poetry ||= poetry;
    } else {
      verses.set(key, { chapter: at.chapter, verse: at.verse, text, ...(poetry && { poetry }) });
    }
  }
  if (range.verses.length && !verses.size) throw new TypeError('range.verses has no usable verse');

  // Verse 0 is a psalm's superscription; a heading on a later verse is an acrostic letter.
  const supers = list(range.superscriptions)
    .map((s) => ({ ...splitId(s.source), text: verseHtmlToText(html(s.content)) }))
    .filter((s) => s.chapter && Number.isInteger(s.verse) && s.text);

  const phrases = new Map();
  const fnPhrases = new Map();
  // Marker id -> its position in the text: jw.org's crossReferences and
  // footnotes lists are often out of text order (John 17:3 is reversed).
  // Superscriptions first, so an acrostic heading's markers sort before its verse's.
  const position = new Map();
  for (const v of [...list(range.superscriptions), ...list(range.verses)]) {
    markerPhrases(html(v.content), 'xref', phrases);
    markerPhrases(html(v.content), 'fn', fnPhrases);
    for (const id of markerIds(html(v.content))) if (!position.has(id)) position.set(id, position.size);
  }
  // By verse, then marker; entries with no marker keep their order, last in their verse.
  const place = (x) => position.get(x.id) ?? Number.MAX_SAFE_INTEGER;
  const textOrder = (a, b) => a.chapter - b.chapter || a.verse - b.verse || place(a) - place(b);
  // One entry per "+" marker, as WOL shows them; a verse can have several.
  const crossReferences = [];
  for (const group of list(range.crossReferences)) {
    const at = splitId(group.source);
    if (!at) continue;
    const entry = { id: String(group.id), chapter: at.chapter, verse: at.verse, phrase: phrases.get(String(group.id)), targets: [], categories: {} };
    for (const t of list(group.targets)) {
      const citation = htmlText(html(t.standardCitation) || html(t.abbreviatedCitation));
      if (!citation || entry.targets.includes(citation)) continue;
      entry.targets.push(citation);
      // Category 1 is "General"; others are e.g. "Parallel Account".
      const label = t.category && String(t.category.id) !== '1' ? htmlText(html(t.category.label)) : null;
      if (label) (entry.categories[label] ??= []).push(citation);
    }
    if (entry.targets.length) crossReferences.push(entry);
  }

  const footnotes = list(range.footnotes)
    .map((f) => {
      const phrase = fnPhrases.get(String(f.id));
      return { ...splitId(f.source), id: String(f.id ?? ''), ...(phrase && { phrase }), text: htmlText(html(f.content)) };
    })
    .filter((f) => f.chapter && f.text)
    .sort(textOrder);

  const notes = [];
  for (const c of list(range.commentaries)) {
    const at = splitId(c.source);
    if (!at || !html(c.content)) continue; // null content = a note elsewhere that this range links to
    for (const n of parseStudyNotes(c.content)) notes.push({ chapter: at.chapter, verse: at.verse, ...n });
  }

  const outlines = list(range.chapterOutlines)
    .filter((o) => html(o.content))
    .map((o) => ({ id: o.id, entries: parseOutline(o.content) }));

  return {
    verses: [...verses.values()],
    superscriptions: supers.filter((x) => x.verse === 0).map(({ chapter, text }) => ({ chapter, text })),
    headings: supers.filter((x) => x.verse > 0).map(({ chapter, verse, text }) => ({ chapter, verse, text })),
    crossReferences: crossReferences.sort(textOrder).map(({ id, phrase, categories, ...e }) => ({
      ...e,
      ...(phrase && { phrase }),
      ...(Object.keys(categories).length && { categories })
    })),
    footnotes,
    notes,
    outlines
  };
}

function editionOf(editionData) {
  const abbreviation = String(editionData?.vernacularAbbreviation ?? '');
  const symbol =
    /-(nwt[a-z]*)$/i.exec(abbreviation)?.[1]?.toLowerCase() ??
    /\bpub-(nwt[a-z]*)\b/i.exec(String(editionData?.pageCSSClassNames ?? ''))?.[1]?.toLowerCase() ??
    null;
  return { symbol, studyEdition: symbol === 'nwtsty' };
}

function bookInfo(editionData, book) {
  const b = editionData?.books?.[book] ?? editionData?.books?.[String(book)];
  if (!b) return null;
  return { name: cleanText(b.standardName) || null, hasStudyNotes: b.hasStudyNotes === true };
}

/** The range id jw.org's chapter pages request for a whole chapter: BBCCC000-BBCCC999. */
export function chapterRangeId(book, chapter) {
  return `${bibleVerseId(book, chapter, 0)}-${bibleVerseId(book, chapter, 999)}`;
}

/**
 * The chapter pieces a Ref covers, one per chapter run: [{chapter, from, to,
 * id}]. `id` is the whole chapter's range (chapterRangeId), so a psalm's
 * superscription always comes back and two verses of one chapter share a request.
 */
export function rangePieces(ref) {
  const pieces = [];
  for (const s of ref.segments) {
    for (let ch = s.chapter; ch <= s.endChapter; ch++) {
      const from = s.verse !== null && ch === s.chapter ? s.verse : getFirstVerse(ref.book, ch);
      const to = s.verse !== null && ch === s.endChapter ? s.endVerse : getVerseCount(ref.book, ch);
      pieces.push({ chapter: ch, from, to, id: chapterRangeId(ref.book, ch) });
    }
  }
  return pieces;
}

function notAvailable(lang, what) {
  return new ToolError(
    `jw.org has no New World Translation in ${lang.name} (${lang.code})${what ? ` with ${what}` : ''}.`,
    'Use another language, such as E (English) or S (Spanish).'
  );
}

/**
 * The jw.org "books" path of the language's NWT (study edition when there is
 * one), e.g. https://www.jw.org/es/biblioteca/biblia/biblia-estudio/libros/.
 * Found by following the finder link for `probe` (a BBCCCVVV id); cached a day.
 */
export async function bibleBase(lang, { probe = '43003016', deadline } = {}) {
  if (KNOWN_BASES[lang.code]) return KNOWN_BASES[lang.code];
  return cached(
    `bible:base:${lang.code}`,
    DAY_MS,
    async () => {
      const location = await fetchRedirect(finderUrl(probe, lang.code), { deadline });
      let url = null;
      try {
        url = location ? new URL(location) : null;
      } catch {
        url = null;
      }
      const parts = url ? url.pathname.split('/').filter(Boolean) : [];
      const chapter = String(Number(probe.slice(-6, -3)));
      // /<language>/.../<book>/<chapter>/; the finder sends unknown languages to English.
      if (!url || url.hostname !== 'www.jw.org' || parts.length < 4 || parts.at(-1) !== chapter || parts[0].toLowerCase() !== lang.jwPath) {
        throw notAvailable(lang, null);
      }
      return `https://www.jw.org/${parts.slice(0, -2).join('/')}/`;
    },
    { cache: bibleCache }
  );
}

// One chapter range (chapterRangeId), cached per chapter.
async function fetchChapter(lang, base, id, { bypass, deadline }) {
  return cached(
    `bible:data:${lang.code}:${id}`,
    6 * HOUR_MS,
    async () => {
      const url = `${base}json/data/${id}`;
      const data = await fetchJson(url, {
        deadline,
        hints: { 404: `jw.org has no Bible data at that address for ${lang.name}. Try again later or use langwritten "E".` }
      });
      const shapeError = (cause) =>
        new JwFetchError({
          kind: 'bad_content',
          url,
          message: `www.jw.org returned Bible data in an unexpected shape for ${url}`,
          hint: 'JW.org may have changed its Bible pages; try again later.',
          cause
        });
      if (!data || typeof data !== 'object' || typeof data.ranges !== 'object' || data.ranges === null) throw shapeError();
      if (data.editionData?.books && typeof data.editionData.books === 'object') registerBookNames(lang.code, data.editionData.books);
      const book = Number(id.split('-')[0].slice(0, -6));
      const range = data.ranges[id] ?? null;
      let parsed;
      try {
        parsed = range ? parseRange(range) : null;
      } catch (error) {
        throw shapeError(error);
      }
      return { edition: editionOf(data.editionData), book: bookInfo(data.editionData, book), range: parsed };
    },
    { cache: bibleCache, bypass }
  );
}

/**
 * Bible data for a Ref (from bible-books.js) in a resolved language.
 * Returns {edition: {symbol, studyEdition}, book: {name, hasStudyNotes} | null,
 * pieces: [{chapter, from, to, id, data}]} where data
 * is parseRange()'s result, or throws ToolError when the language's Bible
 * lacks a passage and JwFetchError when jw.org fails. `bypass` skips the cache.
 */
export async function getBibleData(ref, lang, opts = {}) {
  const [result] = await getBibleDataMany([ref], lang, opts);
  if (result.error) throw result.error;
  return result;
}

/**
 * getBibleData for several Refs, possibly in different books: one request per
 * distinct chapter, a few at a time (a comma-joined URL is never warm on
 * jw.org's CDN). Returns one result per Ref; a Ref the language's Bible lacks
 * gets {error} instead. JwFetchError throws.
 */
export async function getBibleDataMany(refs, lang, { bypass = false, deadline } = {}) {
  const perRef = refs.map((ref) => rangePieces(ref));
  const firstPiece = perRef[0][0];
  const base = await bibleBase(lang, { probe: bibleVerseId(refs[0].book, firstPiece.chapter, Math.max(firstPiece.from, 1)), deadline });
  const ids = [...new Set(perRef.flat().map((p) => p.id))];
  const loaded = [];
  for (let i = 0; i < ids.length; i += CHAPTER_CONCURRENCY) {
    loaded.push(...(await Promise.all(ids.slice(i, i + CHAPTER_CONCURRENCY).map((id) => fetchChapter(lang, base, id, { bypass, deadline })))));
  }
  const byId = new Map(ids.map((id, i) => [id, loaded[i]]));
  return refs.map((ref, i) => {
    const pieces = perRef[i];
    const missing = pieces.filter((p) => !byId.get(p.id).range);
    if (missing.length) {
      return { error: notAvailable(lang, `${BIBLE_BOOKS[ref.book]} ${missing[0].chapter} (it may be a partial translation)`) };
    }
    const chapters = pieces.map((p) => byId.get(p.id));
    return {
      edition: chapters[0].edition,
      book: chapters.map((c) => c.book).find(Boolean) ?? null,
      pieces: pieces.map((p) => ({ ...p, data: byId.get(p.id).range }))
    };
  });
}

/**
 * Learn a language's book names (registerBookNames) so references written in
 * it parse: one cached request for John 3, the same chapter bibleBase probes,
 * which a later John 3 lookup reuses. Failures are ignored; the caller's own
 * error then stands.
 */
export async function loadBookNames(lang, { deadline } = {}) {
  if (!lang || lang.code === 'E' || hasBookNames(lang.code)) return;
  try {
    const base = await bibleBase(lang, { deadline });
    await fetchChapter(lang, base, chapterRangeId(43, 3), { deadline });
  } catch {
    // Unknown names are reported by the parser.
  }
}
