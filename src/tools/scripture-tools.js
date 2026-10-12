/**
 * Scripture Tools for JW-MCP
 * Bible book lookup, verse text and study content from the jw.org study Bible
 * (bible-api.js) and the Research Guide on wol.jw.org (wol-scraper.js).
 */

import { ArgError, isMissing, toBool, toEnum, toStr } from './args.js';
import { DEFAULT_TIMEOUT_MS, JwFetchError } from './http.js';
import { LANGWRITTEN_DESCRIPTION, resolveLanguage } from './languages.js';
import { MAX_RESULT_TOKENS, ToolError, estimateTokens, jsonText, wrapTool } from './results.js';
import { getBibleData, getBibleDataMany, isOmittedText, loadBookNames, rangePieces, stripPronunciationMarks } from './bible-api.js';
import { getWolChapter } from './wol-scraper.js';
import {
  searchBooks,
  getBookInfo,
  getBookNumber,
  getFirstVerse,
  getOmission,
  getVerseCount,
  foldFootnoteParts,
  formatReference,
  hasBookNames,
  listVerses,
  localBookName,
  looksLikeReference,
  normalizeReferenceText,
  parseReference,
  referenceFromArgs,
  referenceListText,
  referencesFromArgs,
  tryParseReference,
  verseLinks,
  BIBLE_BOOKS
} from './bible-books.js';

// Implementations take the tool's arguments object; the older positional
// form (query, limit) / (book, chapter, verse) still works.
function isArgsObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// One time budget for all the requests one call makes.
const CALL_BUDGET_MS = 2 * DEFAULT_TIMEOUT_MS;

async function bibleLanguage(args, deadline) {
  const value = isMissing(args.langwritten) ? args.lang : args.langwritten;
  return resolveLanguage(isMissing(value) ? 'E' : value, { name: 'langwritten', wol: false, deadline });
}

// The language's own note ("TL" read as Tagalog) goes first in the result's note.
function withLangNote(result, lang) {
  if (!lang?.note) return result;
  result.note = result.note ? `${lang.note} ${result.note}` : lang.note;
  return result;
}

// Learn the langwritten language's book names before parsing a reference that
// names a book: a local abbreviation can also be an English one ("Éz", "Pr"),
// so a parse must not depend on whether an earlier call loaded the names.
async function withBookNames(lang, deadline, parse, texts = []) {
  if (lang.code !== 'E' && !hasBookNames(lang.code) && texts.some((t) => typeof t === 'string' && /\p{L}/u.test(t))) {
    await loadBookNames(lang, { deadline });
  }
  return parse();
}

// 1.3.3 took any number for limit (schema type 'number'), so floor and clamp
// instead of rejecting: 0 or less, or over max, means max.
function toLimit(value, { default: def, max, all }) {
  if (isMissing(value)) return def;
  const n = typeof value === 'number' || typeof value === 'string' ? Number(String(value).trim()) : NaN;
  if (!Number.isFinite(n)) throw new ArgError('limit', value, `a number (0 or less, or over ${max}, means ${all})`);
  const whole = Math.floor(n);
  return whole < 1 ? max : Math.min(whole, max);
}

// ============================================================================
// Tool 1: search_bible_books
// ============================================================================

const BOOK_COUNT = Object.keys(BIBLE_BOOKS).length;

export const searchBibleBooksTool = {
  name: 'search_bible_books',
  description: 'Bible books by name, abbreviation ("Jn", "1 Cor.") or number: number (1-66), chapter count, JW.org abbreviations; a full reference is parsed too. Rarely needed: the verse tools take references.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name, abbreviation or number ("matt", "Ps.", "40").' },
      limit: { type: 'integer', minimum: 1, description: 'Most results. Default 10.' },
      langwritten: { type: 'string', description: 'Also its book names ("Juan" with S). Default English only.' }
    },
    required: ['query']
  }
};

async function searchBibleBooks(argsOrQuery, legacyLimit) {
  const args = isArgsObject(argsOrQuery) ? argsOrQuery : { query: argsOrQuery, limit: legacyLimit };
  const query = toStr(args.query, 'query', { maxLength: 200 });
  const limit = toLimit(args.limit, { default: 10, max: BOOK_COUNT, all: 'every match' });
  const lang = isMissing(args.langwritten) && isMissing(args.lang) ? null : await bibleLanguage(args);
  const code = lang && lang.code !== 'E' ? lang.code : undefined;
  if (code) await loadBookNames(lang, { deadline: Date.now() + DEFAULT_TIMEOUT_MS });
  const results = searchBooks(query, limit, { lang: code });
  if (!results.length) {
    throw new ToolError(
      `No Bible book matches "${query}"${code ? ` in English or ${lang.name}` : ''}.`,
      code
        ? 'Use a book name, an abbreviation such as "Jn", "Ps." or "1 Cor.", or a book number from 1 to 66.'
        : `Use an English name or abbreviation ("Jn", "Ps.", "1 Cor.") or a number from 1 to 66. For a name in another language pass langwritten (e.g. "S" for "Juan").`
    );
  }
  const response = {
    query,
    results_count: results.length,
    books: results.map((r) => {
      const info = getBookInfo(r.number);
      const local = code ? localBookName(code, r.number) : null;
      return {
        number: r.number,
        name: r.name,
        ...(local ? { local_name: local } : {}),
        testament: info.testament,
        division: info.division,
        chapters: info.chapters,
        abbreviations: [...new Set([info.abbreviation, info.shortAbbreviation])],
        relevance_score: r.score,
        ...(r.guess ? { match: 'spelling_guess' } : {})
      };
    })
  };
  // The typo fallback runs only when nothing else matched, so every result is a guess or none is.
  if (results[0].guess) {
    response.note = `No Bible book is named "${query}"; these are the closest spellings. Use one only if it is the book you meant.`;
  }
  const ref = looksLikeReference(query) ? tryParseReference(query, { lang: code }) : null;
  if (ref) {
    response.parsed_reference = { reference: ref.reference, book: ref.book, chapter: ref.chapter, verse: ref.verseSpec };
  }
  return withLangNote(response, lang);
}

export const searchBibleBooksImplementation = wrapTool(searchBibleBooks, 'search_bible_books');

// ============================================================================
// Shared by get_bible_verse and get_verse_with_study
// ============================================================================

const MAX_TEXT_VERSES = 200;
const MAX_STUDY_VERSES = 60;
const MAX_STUDY_CHAPTERS = 5;
const MAX_ARTICLES = 100;
const DEFAULT_ARTICLES = 5;
const MAX_LIST_REFERENCES = 12;

// Shared by get_bible_verse, get_verse_with_study and get_bible_verse_url.
function verseInputProperties(referenceDescription = '"John 3:16", "Ps. 83:18-20", "Psalm 23"; ";" between several; English or langwritten names. Or book + chapter + verse.') {
  return {
    reference: { type: 'string', description: referenceDescription },
    book: { type: 'integer', minimum: 1, maximum: 66, description: 'Book number (Psalms 19, John 43).' },
    chapter: { type: 'integer', minimum: 1, maximum: 150, description: 'Optional for one-chapter books.' },
    verse: { type: 'string', description: '"16", "16-18", "1,3,5"; none: whole chapter; "0": psalm heading.' },
    langwritten: { type: 'string', description: LANGWRITTEN_DESCRIPTION }
  };
}

// get_bible_verse and get_verse_with_study only.
const MARKS_PROPERTY = { type: 'boolean', description: 'false: Jo·haʹnan -> Johanan. Default true.' };

const DASHES = '-‐-―';
const REF_START = new RegExp(`^(?:(.*?[\\p{L}.])\\s*)?(\\d+)\\s*[:.]\\s*(\\d+)(?:\\s*[${DASHES}]\\s*(?:(\\d+)\\s*:\\s*)?(\\d+))?\\s*$`, 'u');
const VERSE_START = new RegExp(`^\\s*(\\d+)(?:\\s*[${DASHES}]\\s*(\\d+))?\\s*$`);

// John 7:53–8:11 and Mark 16:9-20 have no verse numbers in the NWT, so the
// reference parser rejects a request that lies wholly inside one; this spots it.
// (A range that only runs into one is trimmed by the parser.)
function absentPassageRequest(args, code, defaultBook) {
  let book;
  let chapter;
  let verse;
  let endChapter;
  let end;
  const text = !isMissing(args.reference) ? args.reference : looksLikeReference(args.book) ? args.book : null;
  if (text !== null) {
    const s = typeof text === 'string' || typeof text === 'number' ? String(text).trim() : '';
    const m = s.length <= 200 ? REF_START.exec(s) : null;
    if (!m) {
      // A whole chapter with verse ("John 8" + "1-11"): the verse branch, with the reference's book and chapter.
      const whole = isMissing(args.verse) || s.length > 200 ? null : tryParseReference(s, { lang: code });
      if (!whole || whole.verse !== null || whole.endChapter !== whole.chapter) return null;
      return absentPassageRequest({ book: whole.book, chapter: whole.chapter, verse: args.verse }, code, defaultBook);
    }
    book = m[1] ? getBookNumber(m[1].trim(), code) : defaultBook;
    [chapter, verse] = [Number(m[2]), Number(m[3])];
    [endChapter, end] = m[5] ? [m[4] ? Number(m[4]) : chapter, Number(m[5])] : [chapter, verse];
  } else {
    const v = typeof args.verse === 'string' || typeof args.verse === 'number' ? String(args.verse) : '';
    const m = v.length <= 50 ? VERSE_START.exec(v) : null;
    if (!m) return null;
    book = getBookNumber(typeof args.book === 'string' ? args.book.trim() : args.book, code);
    [chapter, verse] = [Number(args.chapter), Number(m[1])];
    [endChapter, end] = [chapter, m[2] ? Number(m[2]) : verse];
  }
  const omission = book && Number.isInteger(chapter) ? getOmission(book, chapter, verse) : null;
  if (!omission || omission.numbered) return null;
  if (getOmission(book, endChapter, end)?.reference !== omission.reference) return null;
  if (endChapter < chapter || (endChapter === chapter && end < verse)) return null;
  const single = endChapter === chapter && end === verse;
  return {
    book,
    chapter,
    verse: single ? verse : endChapter === chapter ? `${verse}-${end}` : `${chapter}:${verse}–${endChapter}:${end}`,
    single,
    omission
  };
}

// "Juan 8:7" for one verse, else the whole omitted passage ("Juan 7:53–8:11").
function absentReference({ book, chapter, verse, single, omission }, code) {
  if (single) return formatReference(book, chapter, verse, code);
  const name = localBookName(code, book);
  return name ? name + omission.reference.slice(BIBLE_BOOKS[book].length) : omission.reference;
}

// {book, segments} for formatReference; runs over whole chapters print as "Genesis 1-7".
function versesRef(book, verses) {
  const runs = [];
  for (const { chapter, verse } of verses) {
    const run = runs.at(-1);
    const next = run && (chapter === run.endChapter
      ? verse === run.endVerse + 1
      : chapter === run.endChapter + 1 && run.endVerse === getVerseCount(book, run.endChapter) && verse === getFirstVerse(book, chapter));
    if (next) Object.assign(run, { endChapter: chapter, endVerse: verse });
    else runs.push({ chapter, verse, endChapter: chapter, endVerse: verse });
  }
  const whole = (r) => r.verse === getFirstVerse(book, r.chapter) && r.endVerse === getVerseCount(book, r.endChapter);
  return { book, segments: runs.map((r) => (whole(r) ? { ...r, verse: null, endVerse: null } : r)) };
}

// Where to split a passage over the limits: the longest first part one call
// takes, cut at a chapter end when a whole chapter fits.
function splitHint(book, verses, { maxVerses, maxChapters, wholeChapter }, code) {
  const chapters = [...new Set(verses.map((v) => v.chapter))];
  let cut = Math.min(maxVerses, verses.length);
  if (chapters.length > maxChapters) cut = Math.min(cut, verses.findIndex((v) => v.chapter === chapters[maxChapters]));
  const at = verses[cut]?.chapter;
  if (at === verses[cut - 1].chapter) {
    const start = verses.findIndex((v) => v.chapter === at);
    // One chapter is allowed whatever its length (wholeChapter).
    cut = start > 0 ? start : wholeChapter ? verses.findIndex((v) => v.chapter !== at) : cut;
  }
  const first = verses.slice(0, cut);
  const rest = formatReference(versesRef(book, verses.slice(cut)), code);
  return `Ask for ${formatReference(versesRef(book, first), code)} (${first.length} verses), then call again for ${rest}.`;
}

/**
 * {ref} for a passage within the limits, or {absent} for a passage the NWT
 * leaves out. wholeChapter: one chapter is allowed whatever its length.
 * `book` is the book of a reference that names none (a ";" list's "4:1").
 */
async function readReference(args, { lang, book, maxVerses, maxChapters = Infinity, wholeChapter = false, tool, deadline }) {
  let ref;
  try {
    ref = await withBookNames(lang, deadline, () => referenceFromArgs(args, { lang: lang.code, book }), [args.reference, args.book]);
  } catch (error) {
    const absent = error instanceof ArgError ? absentPassageRequest(args, lang.code, book) : null;
    if (!absent) throw error;
    // Nothing is fetched for an omitted passage, so langwritten's book names may not be known yet.
    await loadBookNames(lang, { deadline });
    return { absent: { ...absent, reference: absentReference(absent, lang.code) } };
  }
  const verses = listVerses(ref);
  const chapters = new Set(verses.map((v) => v.chapter)).size;
  // 1.3.3 returned any single chapter; keep that working whatever its length.
  if ((verses.length > maxVerses && !(wholeChapter && chapters === 1)) || chapters > maxChapters) {
    const param = isMissing(args.reference) ? 'verse' : 'reference';
    const limits = maxChapters === Infinity ? `${maxVerses} verses` : `${maxVerses} verses in ${maxChapters} chapters`;
    const split = splitHint(ref.book, verses, { maxVerses, maxChapters, wholeChapter }, lang.code);
    throw new ArgError(param, args[param], `a passage of at most ${limits}`, {
      message: `${ref.reference} has ${verses.length} verses${chapters > 1 ? ` in ${chapters} chapters` : ''}; ${tool} returns at most ${limits} per call.`,
      hint: tool === 'get_verse_with_study' ? `${split} For verse text only, use get_bible_verse (up to ${MAX_TEXT_VERSES} verses).` : split
    });
  }
  return { ref };
}

/**
 * readReference for each part of a ";" list ("Luke 10:25-28; Acts 17:26, 27;
 * 3:1"), the verse limit applying to the whole list. A part without a book
 * takes the book before it. One reference gives a one-item list.
 */
async function readReferences(input, opts) {
  const args = Array.isArray(input.reference) ? { ...input, reference: referenceListText(input.reference) } : input;
  const raw = typeof args.reference === 'string' && args.reference.length <= 1000 ? args.reference : '';
  // Read as parseReferences reads it: CJK "；", Arabic "؛" and Arabic-Indic digits, "; ftn." parts.
  const parts = foldFootnoteParts(normalizeReferenceText(raw)).split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [await readReference(args, opts)];
  const { tool, maxVerses } = opts;
  if (['book', 'chapter', 'verse'].some((k) => !isMissing(args[k]))) {
    throw new ArgError('reference', args.reference, 'one reference, or a ";" list without book, chapter and verse', {
      hint: 'Send the list in "reference" alone.'
    });
  }
  if (parts.length > MAX_LIST_REFERENCES) {
    throw new ArgError('reference', args.reference, `at most ${MAX_LIST_REFERENCES} references`, {
      message: `Too many references (${parts.length}); ${tool} reads at most ${MAX_LIST_REFERENCES} per call.`,
      hint: 'Split the list into several calls.'
    });
  }
  // A part that cannot be read becomes {failed}: its passages[] entry is {reference, error, hint}.
  const requests = [];
  let book;
  for (const part of parts) {
    const named = /\p{L}/u.test(part);
    try {
      const request = await readReference({ reference: part }, { ...opts, book: named ? undefined : book });
      book = request.ref?.book ?? request.absent.book;
      requests.push(request);
    } catch (error) {
      if (!(error instanceof ArgError)) throw error;
      const reference = !named && book ? `${localBookName(opts.lang.code, book) ?? BIBLE_BOOKS[book]} ${part}` : part;
      // A later "4:1" takes this part's book, never the one before it.
      if (named) book = getBookNumber(part.replace(/[\s\d:,.\-–—]+$/u, ''), opts.lang.code) ?? undefined;
      requests.push({ failed: { error, entry: { reference, error: error.message, ...(error.hint ? { hint: error.hint } : {}) } } });
    }
  }
  const total = requests.reduce((n, r) => n + (r.ref ? listVerses(r.ref).length : 0), 0);
  if (total > maxVerses) {
    throw new ArgError('reference', args.reference, `at most ${maxVerses} verses in all`, {
      message: `Those references have ${total} verses; ${tool} returns at most ${maxVerses} per call.`,
      hint: 'Split the list into several calls.'
    });
  }
  return requests;
}

function omittedNote(omission) {
  const reason = omission.reason.charAt(0).toLowerCase() + omission.reason.slice(1);
  return `${omission.reference} is ${reason} The study note on ${omission.studyNote} explains this (get_verse_with_study with reference "${omission.studyNote}").`;
}

function omittedHeader(absent, lang) {
  const noteRef = parseReference(absent.omission.studyNote);
  return {
    noteRef,
    result: {
      reference: absent.reference,
      book_number: absent.book,
      book_name: localBookName(lang.code, absent.book) ?? BIBLE_BOOKS[absent.book],
      chapter: absent.chapter
    },
    url: verseLinks(noteRef, { lang: lang.code })[0].url
  };
}

const WOL_CONCURRENCY = 4;

// JW.org asked us to back off, or is struggling: stop starting more requests.
function isBackoff(error) {
  return error instanceof JwFetchError && (error.status === 429 || error.status >= 500 || error.kind === 'timeout' || error.kind === 'network');
}

// fn over items, at most `limit` at a time, as [{value} | {error}]. After a
// back-off error the rest are not started and get that error.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let stop = null;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      if (stop) {
        results[i] = { error: stop };
        continue;
      }
      try {
        results[i] = { value: await fn(items[i]) };
      } catch (error) {
        results[i] = { error };
        if (isBackoff(error)) stop = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The WOL chapter pages of each Ref, a few at a time and each chapter once:
// [{pages: Map(chapter -> page)} | {error}].
async function wolPagesMany(refs, wolLang, opts) {
  const keys = [...new Set(refs.flatMap((ref) => rangePieces(ref).map((p) => `${ref.book}:${p.chapter}`)))];
  const loaded = await mapPool(keys, WOL_CONCURRENCY, (key) => {
    const [book, chapter] = key.split(':').map(Number);
    return getWolChapter(wolLang, book, chapter, opts);
  });
  const byKey = new Map(keys.map((key, i) => [key, loaded[i]]));
  return refs.map((ref) => {
    const pages = new Map();
    for (const { chapter } of rangePieces(ref)) {
      const got = byKey.get(`${ref.book}:${chapter}`);
      if (got.error) return { error: got.error };
      pages.set(chapter, got.value);
    }
    return { pages };
  });
}

// lang.code is a JW code: TL is Tamil there, not Tagalog's ISO tag.
function wolLanguage(lang, deadline) {
  return resolveLanguage(lang.code, { as: 'code', deadline });
}

// The Research Guide pages of each Ref: {pages} or {error}.
async function loadGuides(refs, lang, opts) {
  let wolLang;
  try {
    wolLang = await wolLanguage(lang, opts.deadline);
  } catch (error) {
    return refs.map(() => ({ error }));
  }
  return wolPagesMany(refs, wolLang, opts);
}

// The verses of the WOL chapter pages, for when the study-Bible JSON failed
// with `error`: one passage or {error} per Ref (the original error when WOL fails too).
async function wolPassages(refs, lang, error, { bypass, deadline }) {
  let wolLang;
  try {
    wolLang = await wolLanguage(lang, deadline);
  } catch {
    return refs.map(() => ({ error }));
  }
  const loaded = await wolPagesMany(refs, wolLang, { bypass, deadline });
  return refs.map((ref, i) => (loaded[i].error ? { error } : wolPassage(ref, error, loaded[i].pages)));
}

function wolPassage(ref, error, pages) {
  const pieces = rangePieces(ref).map((piece) => {
    const page = pages.get(piece.chapter);
    const poetic = new Set(page.poetry);
    const verses = Object.entries(page.verses).map(([verse, text]) => ({
      chapter: piece.chapter,
      verse: Number(verse),
      text,
      ...(poetic.has(Number(verse)) && { poetry: true })
    }));
    const superscriptions = page.superscription ? [{ chapter: piece.chapter, text: page.superscription }] : [];
    return { ...piece, data: { verses, superscriptions, headings: [], crossReferences: [], footnotes: [], notes: [], outlines: [] } };
  });
  return { fallback: error, edition: null, book: null, pieces };
}

// A rate limit gets no fallback: more requests to WOL would only add to it.
function usesFallback(error, textFallback) {
  return textFallback && error instanceof JwFetchError && error.status !== 429;
}

// jw.org's study-Bible JSON; when it fails and the caller needs only verse
// text, the verses of the WOL chapter pages instead (`fallback` = the error).
async function loadPassage(ref, lang, { bypass = false, deadline, textFallback = false }) {
  try {
    return { fallback: null, ...(await getBibleData(ref, lang, { bypass, deadline })) };
  } catch (error) {
    if (!usesFallback(error, textFallback)) throw error;
    const [passage] = await wolPassages([ref], lang, error, { bypass, deadline });
    if (passage.error) throw passage.error;
    return passage;
  }
}

// loadPassage for several Refs in shared requests; a Ref that fails gets {error}.
async function loadPassages(refs, lang, { bypass = false, deadline, textFallback = false }) {
  let data;
  try {
    data = await getBibleDataMany(refs, lang, { bypass, deadline });
  } catch (error) {
    if (!usesFallback(error, textFallback)) throw error;
    return wolPassages(refs, lang, error, { bypass, deadline });
  }
  return data.map((d) => (d.error ? d : { fallback: null, ...d }));
}

// One row per requested verse ({chapter, verse, text, heading?, poetry?,
// omitted?, missing?}) and the superscriptions of the psalms whose verse 0 or
// 1 was requested. heading: an acrostic letter ("ב [Beth]") before the verse;
// poetry: the text keeps its printed lines ("\n").
// marks false drops the NWT's pronunciation marks from the text.
function passageRows(ref, passage, { marks = true, lang } = {}) {
  const plain = (text) => (marks ? text : stripPronunciationMarks(text, lang.code));
  const rows = [];
  const superscriptions = [];
  for (const { chapter, from, to, data } of passage.pieces) {
    const found = data.superscriptions.find((s) => s.chapter === chapter)?.text;
    const superscription = found ? plain(found) : null;
    if (from <= 1 && superscription) superscriptions.push({ chapter, text: superscription });
    const byVerse = new Map(data.verses.filter((v) => v.chapter === chapter).map((v) => [v.verse, v]));
    const headings = new Map((data.headings ?? []).filter((h) => h.chapter === chapter).map((h) => [h.verse, h.text]));
    for (let verse = from; verse <= to; verse++) {
      const text = verse === 0 ? superscription : byVerse.get(verse)?.text;
      const heading = headings.get(verse);
      const poetry = verse !== 0 && byVerse.get(verse)?.poetry;
      if (!text) rows.push({ chapter, verse, text: '', missing: true });
      else if (isOmittedText(text)) rows.push({ chapter, verse, text: '', omitted: true });
      else rows.push({ chapter, verse, text: plain(text), ...(heading && { heading: plain(heading) }), ...(poetry && { poetry: true }) });
    }
  }
  return { rows, superscriptions };
}

function rowNotes(ref, rows) {
  const notes = [...ref.notes];
  // John 8 starts at verse 12, and John 7 and Mark 16 stop before the
  // unnumbered passages other Bibles print; say why unless the parser already did.
  const name = BIBLE_BOOKS[ref.book];
  const explain = (absent, what) => {
    if (absent && !absent.numbered && !notes.some((n) => n.includes(absent.reference))) {
      notes.push(`${name} ${what} in the NWT: ${absent.reference} is not part of it (the study note on ${absent.studyNote} explains why).`);
    }
  };
  for (const chapter of new Set(rows.map((r) => r.chapter))) {
    const first = getFirstVerse(ref.book, chapter);
    const last = getVerseCount(ref.book, chapter);
    const verses = rows.filter((r) => r.chapter === chapter).map((r) => r.verse);
    if (first > 1 && verses[0] === first) explain(getOmission(ref.book, chapter, 1), `${chapter} starts at verse ${first}`);
    if (verses.at(-1) === last) explain(getOmission(ref.book, chapter, last + 1), `${chapter} ends at verse ${last}`);
  }
  const missing = rows.filter((r) => r.missing);
  for (const r of missing.filter((r) => r.verse === 0)) notes.push(`Psalm ${r.chapter} has no superscription.`);
  const lost = missing.filter((r) => r.verse !== 0).map((r) => `${r.chapter}:${r.verse}`);
  if (lost.length) {
    const more = lost.length > 10 ? ` and ${lost.length - 10} more` : '';
    notes.push(`jw.org returned no text for ${BIBLE_BOOKS[ref.book]} ${lost.slice(0, 10).join(', ')}${more}.`);
  }
  return notes;
}

function requireText(ref, rows, lang) {
  if (!rows.every((r) => r.missing)) return;
  const [note] = rowNotes(ref, rows).slice(-1);
  // Only a heading was asked for, and this psalm has none.
  const hint = rows.every((r) => r.verse === 0)
    ? `Ask for Psalm ${rows[0].chapter}:1 for its first verse; verse 0 exists only for psalms with a heading (e.g. Psalm 3:0).`
    : `Check the reference${lang.code === 'E' ? '' : ', or try langwritten "E"'}.`;
  throw new ToolError(note || `jw.org returned no text for ${ref.reference}.`, hint);
}

function fallbackNote(passage, what) {
  return `The jw.org study Bible did not answer (${passage.fallback.message}), so the text comes from wol.jw.org${what ? ` and ${what} are missing; try again later` : ''}.`;
}

// In langwritten whichever fields were asked for; English stays the BIBLE_BOOKS name.
function bookName(ref, passage, lang) {
  return (lang.code !== 'E' && (passage?.book?.name || localBookName(lang.code, ref.book))) || BIBLE_BOOKS[ref.book];
}

// "16-18", "1,3,5", "1-36" for a whole chapter, "5:3–6:4" across chapters.
function verseLabel(ref, rows) {
  if (ref.verseSpec) return ref.verseSpec;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first.chapter === last.chapter) return first.verse === last.verse ? String(first.verse) : `${first.verse}-${last.verse}`;
  return `${first.chapter}:${first.verse}–${last.chapter}:${last.verse}`;
}

// "16 For God loved... 17 For God sent..."; across chapters each chapter's
// first verse is "6:1". An acrostic letter goes before its verse number
// ("ב [Beth] 9 How can"). Poetry keeps its lines: a verse next to a poetic
// one starts a new line. Verses the NWT omits are left out (see `note`).
function numberedText(rows, multiChapter) {
  let text = '';
  let chapter = null;
  let prevPoetry = false;
  for (const r of rows) {
    if (!r.text) continue;
    const sep = !text ? '' : r.poetry || prevPoetry ? '\n' : ' ';
    prevPoetry = Boolean(r.poetry);
    // A psalm's heading sits before its first verse, which still gets "23:1".
    if (r.verse === 0) {
      text += sep + r.text;
      continue;
    }
    const label = multiChapter && r.chapter !== chapter ? `${r.chapter}:${r.verse} ` : `${r.verse} `;
    chapter = r.chapter;
    text += `${sep}${r.heading ? `${r.heading} ` : ''}${label}${r.text}`;
  }
  return text;
}

function addSuperscriptions(result, superscriptions, rows) {
  const asked = new Set(rows.filter((r) => r.verse === 0).map((r) => r.chapter));
  const extra = superscriptions.filter((s) => !asked.has(s.chapter));
  if (!extra.length) return;
  // The bare field is unambiguous only when the passage stays inside that one psalm.
  if (extra.length === 1 && rows.every((r) => r.chapter === extra[0].chapter)) result.superscription = extra[0].text;
  else result.superscriptions = Object.fromEntries(extra.map((x) => [x.chapter, x.text]));
}

function addLinks(result, ref, lang) {
  const links = verseLinks(ref, { lang: lang.code });
  result.url = links[0].url;
  if (links.length > 1) result.links = links.map(({ reference, url }) => ({ reference, url }));
}

// {phrase, note}: phrase is the words the footnote marker follows.
const footnoteEntry = (f) => (f.phrase ? { phrase: f.phrase, note: f.text } : { note: f.text });

// Two footnotes of a verse can read alike (Gen. 2:2 "Or “making.”" twice), so
// they are told apart by id; pieces of one chapter share their data.
const footnoteId = (f) => f.id || `${f.chapter}:${f.verse}|${f.phrase ?? ''}|${f.text}`;

function footnoteMap(passage, plain = (t) => t) {
  const map = new Map();
  const seen = new Set();
  for (const { data } of passage.pieces) {
    for (const f of data.footnotes) {
      if (seen.has(footnoteId(f))) continue;
      seen.add(footnoteId(f));
      const key = `${f.chapter}:${f.verse}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(footnoteEntry({ ...f, phrase: f.phrase && plain(f.phrase) }));
    }
  }
  return map;
}

// Several references: one entry each in passages[]; a reference that could
// not be read gets {reference, error, hint}. All failing is an isError result.
function passagesResult(entries, failures, lang) {
  if (failures.length === entries.length) throw failures[0];
  const result = { reference: entries.map((p) => p.reference).join('; '), passages_count: entries.length, passages: entries };
  if (failures.length) result.note = `${failures.length} of ${entries.length} references could not be read; see "error" in passages.`;
  result.langwritten = lang.code;
  return result;
}

function failedEntry(ref, error, lang) {
  return { reference: formatReference(ref, lang.code), error: error.message, ...(error.hint ? { hint: error.hint } : {}) };
}

function isCallerFailure(error) {
  return error instanceof ToolError || error instanceof JwFetchError || error instanceof ArgError;
}

// ============================================================================
// Tool 2: get_bible_verse
// ============================================================================

export const getBibleVerseTool = {
  name: 'get_bible_verse',
  description: 'NWT text from jw.org: a verse, range or chapter, up to 200 verses: {reference, book_name, chapter, verse, text (verses numbered), url}; one verse has footnotes [{phrase, note}]; several, verses[] for those with footnotes or omitted: true (Matt. 17:21, with a note). A ";" list (up to 12) gives passages[]. Study notes, cross references, research: get_verse_with_study; links only: get_bible_verse_url.',
  inputSchema: {
    type: 'object',
    properties: { ...verseInputProperties(), pronunciation_marks: MARKS_PROPERTY },
    required: []
  }
};

function omittedVerse(absent, lang) {
  const { result, url } = omittedHeader(absent, lang);
  return {
    ...result,
    verse: absent.verse,
    text: '',
    omitted: true,
    note: `${omittedNote(absent.omission)} The url opens ${absent.omission.studyNote}.`,
    url
  };
}

async function getBibleVerse(argsOrBook, legacyChapter, legacyVerse) {
  const args = isArgsObject(argsOrBook) ? argsOrBook : { book: argsOrBook, chapter: legacyChapter, verse: legacyVerse };
  const marks = toBool(args.pronunciation_marks, 'pronunciation_marks', { default: true });
  const deadline = Date.now() + CALL_BUDGET_MS;
  const lang = await bibleLanguage(args, deadline);
  const requests = await readReferences(args, { lang, maxVerses: MAX_TEXT_VERSES, tool: 'get_bible_verse', deadline });
  if (requests.length === 1) {
    const [{ ref, absent }] = requests;
    if (absent) return withLangNote({ ...omittedVerse(absent, lang), langwritten: lang.code }, lang);
    const passage = await loadPassage(ref, lang, { deadline, textFallback: true });
    return withLangNote({ ...versePassage(ref, passage, lang, marks), langwritten: lang.code }, lang);
  }

  const refs = requests.filter((r) => r.ref).map((r) => r.ref);
  const loaded = refs.length ? await loadPassages(refs, lang, { deadline, textFallback: true }) : [];
  const failures = [];
  const entries = requests.map(({ ref, absent, failed }) => {
    if (failed) {
      failures.push(failed.error);
      return failed.entry;
    }
    if (absent) return omittedVerse(absent, lang);
    const passage = loaded.shift();
    try {
      if (passage.error) throw passage.error;
      return versePassage(ref, passage, lang, marks);
    } catch (error) {
      if (!isCallerFailure(error)) throw error;
      failures.push(error);
      return failedEntry(ref, error, lang);
    }
  });
  return withLangNote(passagesResult(entries, failures, lang), lang);
}

// Study notes still cite some footnotes the current NWT dropped ("Eph 4:11, ftn.").
const noFootnoteNote = (reference) => `jw.org's NWT has no footnote on ${reference} now; the "ftn." citation may follow an older edition.`;

// One passage of get_bible_verse, without langwritten.
function versePassage(ref, passage, lang, marks) {
  const { rows, superscriptions } = passageRows(ref, passage, { marks, lang });
  requireText(ref, rows, lang);
  const footnotes = footnoteMap(passage, (t) => (marks ? t : stripPronunciationMarks(t, lang.code)));
  const multiChapter = ref.endChapter !== ref.chapter;

  const result = {
    reference: formatReference(ref, lang.code),
    book_number: ref.book,
    book_name: bookName(ref, passage, lang),
    chapter: ref.chapter
  };
  if (rows.length === 1) {
    const [row] = rows;
    result.verse = row.verse;
    result.text = row.text;
    if (row.heading) result.heading = row.heading;
    if (row.omitted) result.omitted = true;
    if (footnotes.has(`${row.chapter}:${row.verse}`)) result.footnotes = footnotes.get(`${row.chapter}:${row.verse}`);
  } else {
    result.verse = verseLabel(ref, rows);
    result.text = numberedText(rows, multiChapter);
  }
  addSuperscriptions(result, superscriptions, rows);
  // A superscription that came along with verse 1 brings its footnotes too.
  const headed = new Set(superscriptions.map((x) => x.chapter));
  if (rows.length === 1 && result.superscription && footnotes.has(`${rows[0].chapter}:0`)) {
    result.superscription_footnotes = footnotes.get(`${rows[0].chapter}:0`);
  }
  // text already numbers every verse; verses[] carries only what text cannot.
  if (rows.length > 1) {
    const extras = [];
    for (const r of rows) {
      const head = headed.delete(r.chapter) && r.verse !== 0 && footnotes.get(`${r.chapter}:0`);
      if (head) extras.push(multiChapter ? { chapter: r.chapter, verse: 0, footnotes: head } : { verse: 0, footnotes: head });
      const fn = footnotes.get(`${r.chapter}:${r.verse}`);
      if (!fn && !r.omitted) continue;
      const entry = multiChapter ? { chapter: r.chapter, verse: r.verse } : { verse: r.verse };
      if (r.omitted) entry.omitted = true;
      if (fn) entry.footnotes = fn;
      extras.push(entry);
    }
    if (extras.length) result.verses = extras;
  }

  const notes = rowNotes(ref, rows);
  if (ref.footnote && !passage.fallback && !rows.some((r) => footnotes.has(`${r.chapter}:${r.verse}`))) notes.push(noFootnoteNote(result.reference));
  const explained = rows.filter((r) => r.omitted).map((r) => getOmission(ref.book, r.chapter, r.verse)?.studyNote).filter(Boolean);
  if (explained.length) notes.push(`The study note on ${explained.join(', ')} explains why (get_verse_with_study).`);
  if (passage.fallback) notes.push(fallbackNote(passage, 'footnotes'));
  if (notes.length) result.note = notes.join(' ');
  addLinks(result, ref, lang);
  return result;
}

export const getBibleVerseImplementation = wrapTool(getBibleVerse, 'get_bible_verse');

// ============================================================================
// Tool 3: get_verse_with_study
// ============================================================================

const STUDY_FIELDS = [
  'verses',
  'study_notes',
  'study_articles',
  'cross_references',
  'chapter_level',
  'combined_text',
  'footnotes',
  'chapter_articles'
];
const DEFAULT_STUDY_FIELDS = ['verses', 'study_notes', 'footnotes'];
// Fields that come from the WOL Research Guide; the rest come from jw.org.
const GUIDE_FIELDS = new Set(['study_articles', 'chapter_articles']);
const FIELDS_TEXT = `an array of field names from: ${STUDY_FIELDS.join(', ')}`;
const FIELDS_HINT = 'Field names use underscores, e.g. ["cross_references", "study_notes"].';

export const getVerseWithStudyTool = {
  name: 'get_verse_with_study',
  description: 'NWT Study Edition verses with study material: one chapter, or up to 60 verses in 5 chapters (200 if text-only); a ";" list gives passages[]. fields: verses, combined_text, study_notes {verse: [{term, note}]} (English: Matthew to James), footnotes {verse: [{phrase, note}]}, cross_references (one per marker: {verse, phrase, targets}), study_articles (Research Guide [{title, source, url}] for read_wol_document), chapter_level (outline), chapter_articles (the whole chapter\'s, in chapter_level).',
  inputSchema: {
    type: 'object',
    properties: {
      ...verseInputProperties(),
      fields: {
        type: 'array',
        items: { type: 'string', enum: STUDY_FIELDS },
        description: `Default: ${DEFAULT_STUDY_FIELDS.join(', ')}.`
      },
      limit: {
        type: 'integer',
        minimum: 0,
        description: `Most Research Guide articles. Default ${DEFAULT_ARTICLES}; ≤0 or >${MAX_ARTICLES} means ${MAX_ARTICLES}.`
      },
      fetch: { type: 'boolean', description: 'Bypass the 6-hour cache. Default false.' },
      pronunciation_marks: MARKS_PROPERTY
    },
    required: []
  }
};

function toFields(value) {
  if (isMissing(value)) return DEFAULT_STUDY_FIELDS;
  let list = value;
  if (typeof list === 'string') {
    const s = list.trim();
    if (s.startsWith('[')) {
      try {
        list = JSON.parse(s);
      } catch {
        throw new ArgError('fields', value, FIELDS_TEXT, { hint: FIELDS_HINT });
      }
    } else {
      list = s.split(/[\s,]+/).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) throw new ArgError('fields', value, FIELDS_TEXT, { hint: FIELDS_HINT });
  if (!list.length) return DEFAULT_STUDY_FIELDS;
  try {
    return [...new Set(list.map((f) => toEnum(f, 'fields', STUDY_FIELDS)))];
  } catch (error) {
    if (error instanceof ArgError) error.hint = FIELDS_HINT;
    throw error;
  }
}

// How to see more articles once limit is at its maximum.
const NARROWER = { study_articles: 'ask for fewer verses', 'chapter_level.study_articles': 'request study_articles for part of the chapter' };

function moreArticlesNote(field, shown, total, limit) {
  if (total <= shown) return null;
  const how = limit < MAX_ARTICLES ? `set limit up to ${MAX_ARTICLES}` : NARROWER[field];
  return `${field} shows ${shown} of ${total} Research Guide articles; ${how} to see the rest.`;
}

// Verses a request covers as {chapter, verse}, with verse 0 for each psalm
// whose superscription comes along.
function studyPlaces(ref) {
  const places = [];
  for (const { chapter, from, to } of rangePieces(ref)) {
    if (ref.book === 19 && from === 1) places.push({ chapter, verse: 0 });
    for (let verse = from; verse <= to; verse++) places.push({ chapter, verse });
  }
  return places;
}

function collectArticles(pages, places, limit, keyOf, withVerses) {
  const found = new Map();
  for (const { chapter, verse } of places) {
    for (const a of pages.get(chapter)?.articles[verse] ?? []) {
      const id = `${a.title}|${a.source ?? ''}`.toLowerCase();
      let entry = found.get(id);
      if (!entry) {
        entry = { title: a.title, source: a.source, publication: a.publication, url: a.url, verses: [] };
        found.set(id, entry);
      }
      const at = keyOf(chapter, verse);
      if (!entry.verses.includes(at)) entry.verses.push(at);
    }
  }
  const all = [...found.values()];
  const list = all.slice(0, limit).map(({ verses, ...entry }) => (withVerses ? { ...entry, verses } : entry));
  return { list, total: all.length };
}

function chapterOutline(ref, passage) {
  const seen = new Set();
  const outline = [];
  for (const { data } of passage.pieces) {
    for (const o of data.outlines) {
      for (const e of o.entries) {
        if (e.chapters && (e.chapters[1] < ref.chapter || e.chapters[0] > ref.endChapter)) continue;
        const id = `${e.level}|${e.text}`;
        if (seen.has(id)) continue;
        seen.add(id);
        outline.push({ level: e.level, text: e.text });
      }
    }
  }
  return outline;
}

function noStudyNotesNote(passage, lang, name, want) {
  const others = ['study_articles', 'cross_references', 'footnotes'].filter((f) => !want.has(f));
  const more = others.length ? ` For more on these verses, request fields ${others.map((f) => `"${f}"`).join(', ')}.` : '';
  if (!passage.edition?.studyEdition) {
    return `jw.org has no Study Edition of the New World Translation in ${lang.name}, so there are no study notes.${more}`;
  }
  return `The NWT Study Edition has no study notes for ${name}.${more}`;
}

async function omittedStudy(absent, lang, opts) {
  const { result, noteRef, url } = omittedHeader(absent, lang);
  const data = await getBibleData(noteRef, lang, opts);
  const all = data.pieces
    .flatMap((p) => p.data.notes)
    .filter((n) => n.chapter === noteRef.chapter && n.verse === noteRef.verse)
    .map(({ term, note }) => (term ? { term, note } : { note }));
  // The note on the passage names its first verse ("7:53"); the verse's other notes are about the verse itself.
  const start = /\d+:\d+/.exec(absent.omission.reference)?.[0];
  const about = all.filter((n) => `${n.term ?? ''} ${n.note}`.includes(start));
  const notes = about.length ? about : all;
  return {
    ...result,
    verse_range: String(absent.verse),
    omitted: true,
    note: `${omittedNote(absent.omission)} Its study notes are in "explanation".`,
    explanation: { reference: formatReference(noteRef, lang.code), study_notes: notes, url }
  };
}

// One passage of get_verse_with_study, without langwritten. passage: the
// study-Bible data (null when no field needs it); guide: {pages} or {error}.
function studyPassage(ref, lang, { want, limit, marks }, passage, guide) {
  const wantsText = want.has('verses') || want.has('combined_text');
  const multiChapter = ref.endChapter !== ref.chapter;
  const keyOf = (chapter, verse) => (multiChapter ? `${chapter}:${verse}` : String(verse));
  const places = studyPlaces(ref);
  const inScope = new Set(places.map((p) => keyOf(p.chapter, p.verse)));
  // Phrases quoted from the verse lose the pronunciation marks with it.
  const plain = (text) => (marks ? text : stripPronunciationMarks(text, lang.code));
  let notes = [...ref.notes];

  const result = {
    reference: formatReference(ref, lang.code),
    book_number: ref.book,
    book_name: bookName(ref, passage, lang),
    chapter: ref.chapter
  };

  if (passage) {
    const { rows, superscriptions } = passageRows(ref, passage, { marks, lang });
    requireText(ref, rows, lang);
    result.verse_range = verseLabel(ref, rows);
    notes = rowNotes(ref, rows);
    if (wantsText) addSuperscriptions(result, superscriptions, rows);
    if (want.has('verses')) {
      result.verses = rows.map((r) => {
        const entry = { chapter: r.chapter, verse: r.verse, text: r.text };
        if (r.heading) entry.heading = r.heading;
        if (r.omitted) entry.omitted = true;
        return entry;
      });
    }
    if (want.has('combined_text')) {
      // A psalm asked for from verse 0 already has its heading as a row.
      const psalmHeads = superscriptions
        .filter((x) => !rows.some((r) => r.chapter === x.chapter && r.verse === 0))
        .map((x) => ({ chapter: x.chapter, verse: 0, text: x.text }));
      result.combined_text = numberedText([...psalmHeads, ...rows].sort((a, b) => a.chapter - b.chapter || a.verse - b.verse), multiChapter);
    }

    if (passage.fallback) {
      notes.push(fallbackNote(passage, 'study notes, footnotes, cross references and the outline'));
    } else {
      const items = (name) => passage.pieces.flatMap((p) => p.data[name]).filter((x) => inScope.has(keyOf(x.chapter, x.verse)));
      if (want.has('study_notes')) {
        const map = {};
        const seen = new Set();
        for (const n of items('notes')) {
          const key = keyOf(n.chapter, n.verse);
          if (seen.has(`${key}|${n.note}`)) continue;
          seen.add(`${key}|${n.note}`);
          (map[key] ??= []).push(n.term ? { term: n.term, note: n.note } : { note: n.note });
        }
        result.study_notes = map;
        result.study_notes_count = seen.size;
        result.has_study_notes = Boolean(passage.edition?.studyEdition && passage.book?.hasStudyNotes);
        if (!result.has_study_notes) notes.push(noStudyNotesNote(passage, lang, BIBLE_BOOKS[ref.book], want));
      }
      // "Eph 4:11, ftn." asks for the verse's footnotes.
      if (want.has('footnotes') || ref.footnote) {
        const map = {};
        const seen = new Set();
        for (const f of items('footnotes')) {
          if (seen.has(footnoteId(f))) continue;
          seen.add(footnoteId(f));
          (map[keyOf(f.chapter, f.verse)] ??= []).push(footnoteEntry({ ...f, phrase: f.phrase && plain(f.phrase) }));
        }
        result.footnotes = map;
        result.footnotes_count = seen.size;
        if (ref.footnote && !seen.size) notes.push(noFootnoteNote(result.reference));
      }
      if (want.has('cross_references')) {
        result.cross_references = items('crossReferences').map(({ chapter, verse, phrase, targets, categories }) => ({
          chapter,
          verse,
          ...(phrase && { phrase: plain(phrase) }),
          targets,
          ...(categories && { categories })
        }));
        // Counts references, like footnotes_count and study_notes_count (and 1.3).
        result.cross_references_count = result.cross_references.reduce((n, x) => n + x.targets.length, 0);
      }
      if (want.has('chapter_level')) {
        result.chapter_level = { outline: chapterOutline(ref, passage) };
        // 1.3 put the chapter's Research Guide articles here; they are now opt-in.
        if (!want.has('chapter_articles')) {
          notes.push('chapter_level now holds only the outline. For the chapter\'s Research Guide articles (in chapter_level.study_articles, capped by limit), add "chapter_articles" to fields.');
        }
      }
    }
  } else {
    result.verse_range = ref.verseSpec || verseLabel(ref, listVerses(ref));
  }

  if (guide?.error) {
    notes.push(`Research Guide articles are unavailable: ${guide.error.message}`);
  } else if (guide) {
    if (want.has('study_articles')) {
      const { list, total } = collectArticles(guide.pages, places, limit, keyOf, places.length > 1);
      result.study_articles = list;
      result.study_articles_count = list.length;
      result.study_articles_total = total;
      const more = moreArticlesNote('study_articles', list.length, total, limit);
      if (more) notes.push(more);
    }
    if (want.has('chapter_articles')) {
      const everywhere = [...guide.pages].flatMap(([chapter, page]) =>
        Object.keys(page.articles).map(Number).sort((a, b) => a - b).map((verse) => ({ chapter, verse }))
      );
      // A passage that covers every verse with articles already lists them all in study_articles.
      if (want.has('study_articles') && everywhere.every((p) => inScope.has(keyOf(p.chapter, p.verse)))) {
        result.chapter_level = { ...result.chapter_level, study_articles_same_as: 'study_articles', study_articles_total: result.study_articles_total };
      } else {
        const { list, total } = collectArticles(guide.pages, everywhere, limit, keyOf, true);
        result.chapter_level = { ...result.chapter_level, study_articles: list, study_articles_count: list.length, study_articles_total: total };
        const more = moreArticlesNote('chapter_level.study_articles', list.length, total, limit);
        if (more) notes.push(more);
      }
    }
  }

  if (notes.length) result.note = notes.join(' ');
  addLinks(result, ref, lang);
  return result;
}

const resultSize = (result) => estimateTokens(jsonText(result));

// Keeps as many leading entries of owner[key] as fit the budget, but at least `floor`.
function keepFitting(result, owner, key, budget, floor = 0) {
  const all = owner[key];
  let lo = Math.min(floor, all.length);
  let hi = all.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    owner[key] = all.slice(0, mid);
    if (resultSize(result) <= budget) lo = mid;
    else hi = mid - 1;
  }
  owner[key] = all.slice(0, lo);
  return lo;
}

/**
 * A long passage with every field and limit 0 can pass the client's output
 * limit (estimated tokens): drop combined_text (verses has the same text),
 * then shorten the article lists (the chapter's first) down to the default
 * 5, then the cross references (the last verses' first), then the rest of
 * the article lists, then leave out the chapter outline, until it fits, and
 * say what was cut. Throws ToolError when even that is too long; its hint
 * names the largest fields and a verse range that fits. *_total fields stay
 * as they are.
 */
export function fitStudyResult(result, maxTokens = MAX_RESULT_TOKENS) {
  if (resultSize(result) <= maxTokens) return result;
  const budget = maxTokens - 250; // room for the note
  const parts = result.passages ?? [result];
  const label = (part, name) => (result.passages ? `${part.reference}: ${name}` : name);
  const cut = [];
  if (parts.some((p) => p.verses && p.combined_text !== undefined)) {
    for (const p of parts) if (p.verses) delete p.combined_text;
    cut.push('combined_text (the same text is in verses)');
  }
  const articles = [
    ...parts.map((p) => ({ part: p, owner: p.chapter_level, field: 'chapter_level.study_articles' })),
    ...parts.map((p) => ({ part: p, owner: p, field: 'study_articles' }))
  ].filter((l) => l.owner?.study_articles?.length);
  for (const l of articles) l.before = l.owner.study_articles.length;
  const shrink = (l, floor) => {
    if (resultSize(result) > budget) keepFitting(result, l.owner, 'study_articles', budget, floor);
  };
  // The default 5 articles are small and were asked for, so cross references are cut before them.
  for (const l of articles) shrink(l, DEFAULT_ARTICLES);
  for (const p of parts) {
    const before = p.cross_references?.length;
    if (!before || resultSize(result) <= budget) continue;
    const kept = keepFitting(result, p, 'cross_references', budget);
    // The count is of targets, not markers.
    p.cross_references_count = p.cross_references.reduce((n, x) => n + x.targets.length, 0);
    const last = p.cross_references.at(-1);
    const name = label(p, 'cross_references');
    if (kept < before) cut.push(kept ? `${name} through verse ${last.chapter}:${last.verse} (${kept} of ${before} markers)` : `${name} left out (${before} markers found)`);
  }
  for (const l of articles) shrink(l, 0);
  for (const l of articles) {
    const kept = l.owner.study_articles.length;
    if (kept === l.before) continue;
    l.owner.study_articles_count = kept;
    const total = l.owner.study_articles_total ?? l.before;
    // studyPassage's "shows N of M; set limit ..." no longer holds; it was written only when limit === N.
    const stale = moreArticlesNote(l.field, l.before, total, l.before);
    if (stale && l.part.note) {
      l.part.note = l.part.note.replace(stale, '').replace(/\s{2,}/g, ' ').trim();
      if (!l.part.note) delete l.part.note;
    }
    const name = label(l.part, l.field);
    cut.push(kept ? `${name} ${kept} of ${total}` : `${name} left out (${total} found)`);
  }
  for (const p of parts) {
    if (!p.chapter_level?.outline || resultSize(result) <= budget) continue;
    delete p.chapter_level.outline;
    if (!Object.keys(p.chapter_level).length) delete p.chapter_level;
    cut.push(`${label(p, 'chapter_level.outline')} left out`);
  }
  if (resultSize(result) > budget) {
    const ranked = (entries) => entries.map(([k, v]) => [k, resultSize(v)]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} about ${n}`).join(', ');
    const largest = result.passages ? ranked(parts.map((p) => [p.reference, p])) : ranked(Object.entries(result));
    const prefix = result.passages ? null : fittingPrefix(result, budget);
    throw new ToolError(
      `${result.reference} with these fields is too long for one result (about ${resultSize(result)} tokens).`,
      `Ask for fewer verses or fewer fields, then call again for the rest (largest: ${largest})${prefix ? `; ${prefix} fits with these fields` : ''}.`
    );
  }
  const note = `Shortened to fit the client's output limit: ${cut.join(', ')}. For the rest, ask for fewer verses or request the shortened fields on their own.`;
  result.note = result.note ? `${result.note} ${note}` : note;
  return result;
}

// The longest leading run of verses that fits the budget with the same
// fields, as a reference for the hint ("John 1:1-26"), or null.
function fittingPrefix(result, budget) {
  const rows = result.verses;
  if (!rows?.length) return null;
  const multi = rows.some((r) => r.chapter !== rows[0].chapter);
  const keyOf = (c, v) => (multi ? `${c}:${v}` : String(v));
  const cutTo = (n) => {
    const keep = new Set(rows.slice(0, n).map((r) => keyOf(r.chapter, r.verse)));
    const pick = (map) => map && Object.fromEntries(Object.entries(map).filter(([k]) => keep.has(k)));
    return {
      ...result,
      verses: rows.slice(0, n),
      ...(result.study_notes && { study_notes: pick(result.study_notes) }),
      ...(result.footnotes && { footnotes: pick(result.footnotes) }),
      ...(result.cross_references && { cross_references: result.cross_references.filter((x) => keep.has(keyOf(x.chapter, x.verse))) })
    };
  };
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (resultSize(cutTo(mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  if (!lo) return null;
  const [a, b] = [rows[0], rows[lo - 1]];
  if (a === b) return `${result.book_name} ${a.chapter}:${a.verse}`;
  return `${result.book_name} ${a.chapter}:${a.verse}-${b.chapter === a.chapter ? '' : `${b.chapter}:`}${b.verse}`;
}

async function getVerseWithStudy(argsOrBook, legacyChapter, legacyVerse, legacyFields, legacyLimit, legacyFetch) {
  const args = isArgsObject(argsOrBook)
    ? argsOrBook
    : { book: argsOrBook, chapter: legacyChapter, verse: legacyVerse, fields: legacyFields, limit: legacyLimit, fetch: legacyFetch };
  const fields = toFields(args.fields);
  const limit = toLimit(args.limit, { default: DEFAULT_ARTICLES, max: MAX_ARTICLES, all: String(MAX_ARTICLES) });
  const bypass = toBool(args.fetch, 'fetch', { default: false });
  const marks = toBool(args.pronunciation_marks, 'pronunciation_marks', { default: true });
  const deadline = Date.now() + CALL_BUDGET_MS;
  const lang = await bibleLanguage(args, deadline);
  const want = new Set(fields);
  const wantsText = want.has('verses') || want.has('combined_text');
  const wantsData = fields.some((f) => !GUIDE_FIELDS.has(f));
  const wantsGuide = fields.some((f) => GUIDE_FIELDS.has(f));
  const requests = await readReferences(args, {
    lang,
    maxVerses: want.has('study_notes') || wantsGuide ? MAX_STUDY_VERSES : MAX_TEXT_VERSES,
    maxChapters: MAX_STUDY_CHAPTERS,
    wholeChapter: true,
    tool: 'get_verse_with_study',
    deadline
  });
  const opts = { bypass, deadline };
  const shape = { want, limit, marks };

  if (requests.length === 1) {
    const [{ ref, absent }] = requests;
    if (absent) return withLangNote({ ...(await omittedStudy(absent, lang, opts)), langwritten: lang.code }, lang);
    const [passage, [guide]] = await Promise.all([
      wantsData ? loadPassage(ref, lang, { ...opts, textFallback: wantsText }) : null,
      wantsGuide ? loadGuides([ref], lang, opts) : [null]
    ]);
    if (guide?.error && !wantsData) throw guide.error;
    return fitStudyResult(withLangNote({ ...studyPassage(ref, lang, shape, passage, guide), langwritten: lang.code }, lang));
  }

  const refs = requests.filter((r) => r.ref).map((r) => r.ref);
  // Each chapter of the Research Guide is one WOL page.
  const chapters = new Set(refs.flatMap((ref) => listVerses(ref).map((v) => `${ref.book}:${v.chapter}`)));
  if (wantsGuide && chapters.size > MAX_STUDY_CHAPTERS) {
    throw new ArgError('reference', args.reference, `references in at most ${MAX_STUDY_CHAPTERS} chapters`, {
      message: `Those references span ${chapters.size} chapters; with study_articles or chapter_articles get_verse_with_study reads at most ${MAX_STUDY_CHAPTERS} per call.`,
      hint: 'Split the list into several calls, or leave the article fields out.'
    });
  }
  const [loaded, guides] = await Promise.all([
    wantsData && refs.length ? loadPassages(refs, lang, { ...opts, textFallback: wantsText }) : refs.map(() => null),
    wantsGuide && refs.length ? loadGuides(refs, lang, opts) : refs.map(() => null)
  ]);
  const failures = [];
  const entries = [];
  for (const { ref, absent, failed } of requests) {
    if (failed) {
      failures.push(failed.error);
      entries.push(failed.entry);
      continue;
    }
    if (absent) {
      try {
        entries.push(await omittedStudy(absent, lang, opts));
      } catch (error) {
        if (!isCallerFailure(error)) throw error;
        failures.push(error);
        entries.push({ reference: absent.reference, error: error.message, ...(error.hint ? { hint: error.hint } : {}) });
      }
      continue;
    }
    const passage = loaded.shift();
    const guide = guides.shift();
    try {
      if (passage?.error) throw passage.error;
      if (guide?.error && !wantsData) throw guide.error;
      entries.push(studyPassage(ref, lang, shape, passage, guide));
    } catch (error) {
      if (!isCallerFailure(error)) throw error;
      failures.push(error);
      entries.push(failedEntry(ref, error, lang));
    }
  }
  return fitStudyResult(withLangNote(passagesResult(entries, failures, lang), lang));
}

export const getVerseWithStudyImplementation = wrapTool(getVerseWithStudy, 'get_verse_with_study');

// ============================================================================
// Tool 4: get_bible_verse_url
// ============================================================================

export const getBibleVerseURLTool = {
  name: 'get_bible_verse_url',
  description: 'jw.org links (NWT Study Edition) for a Bible reference: {reference, url, markdown}; separate passages ("1,3,5", "Ps. 83:18; John 17:3") each get one in links. langwritten sets the page language; labels stay English.',
  inputSchema: {
    type: 'object',
    properties: verseInputProperties('"John 3:16", "Psalm 23" or "Ps. 83:18; John 17:3"; or book + chapter + verse.'),
    required: []
  }
};

const MAX_LINKS = 50;

async function getBibleVerseUrl(argsOrBook, legacyChapter, legacyVerse) {
  const args = isArgsObject(argsOrBook) ? argsOrBook : { book: argsOrBook, chapter: legacyChapter, verse: legacyVerse };
  const lang = await bibleLanguage(args);
  const refs = await withBookNames(lang, Date.now() + DEFAULT_TIMEOUT_MS, () => referencesFromArgs(args, { lang: lang.code }), [referenceListText(args.reference), args.book]);
  const links = refs.flatMap((ref) => verseLinks(ref, { lang: lang.code }));
  if (links.length > MAX_LINKS) {
    throw new ArgError('reference', args.reference ?? args.verse, `at most ${MAX_LINKS} separate passages`, {
      message: `That reference needs ${links.length} separate jw.org links; the limit is ${MAX_LINKS}.`,
      hint: 'Ask for fewer passages or whole chapters at a time.'
    });
  }
  const result = {
    reference: refs.map((r) => r.reference).join('; '),
    url: links[0].url,
    markdown: links.map((l) => l.markdown).join('; '),
    langwritten: lang.code
  };
  const notes = [lang.note, ...refs.flatMap((r) => r.notes)].filter(Boolean);
  if (links.length > 1) {
    result.links = links;
    notes.push('A jw.org link opens one passage in one chapter, so each passage has its own link in "links"; "url" is the first.');
  }
  if (refs.some((r) => r.book === 19 && r.segments.some((s) => s.verse === 0))) {
    notes.push('Verse 0 is the psalm\'s superscription (heading); the link opens the psalm with it at the top.');
  }
  if (notes.length) result.note = notes.join(' ');
  return result;
}

export const getBibleVerseURLImplementation = wrapTool(getBibleVerseUrl, 'get_bible_verse_url');


// ============================================================================
// Tool Handler
// ============================================================================

export async function handleScriptureTools(request) {
  const toolName = request?.params?.name;
  const args = request?.params?.arguments ?? {};

  switch (toolName) {
    case 'search_bible_books':
      return await searchBibleBooksImplementation(args);

    case 'get_bible_verse':
      return await getBibleVerseImplementation(args);

    case 'get_verse_with_study':
      return await getVerseWithStudyImplementation(args);

    case 'get_bible_verse_url':
      return await getBibleVerseURLImplementation(args);

    default:
      return null;
  }
}
