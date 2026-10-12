// Bible books, NWT chapter and verse counts, and the reference parser,
// validator and formatter the scripture tools share. Everything here works
// offline, so a bad reference fails before any request to JW.org.

import { ArgError, describeValue, isMissing, requireArgs, toStr } from './args.js';
import { asciiDigits } from './text.js';

// [name, JW standard abbreviation, JW short abbreviation], from the NWT Study
// Edition book data on jw.org (editionData.books, checked 2026-10-11).
const BOOK_ROWS = [
  ['Genesis', 'Gen.', 'Ge'], ['Exodus', 'Ex.', 'Ex'], ['Leviticus', 'Lev.', 'Le'],
  ['Numbers', 'Num.', 'Nu'], ['Deuteronomy', 'Deut.', 'De'], ['Joshua', 'Josh.', 'Jos'],
  ['Judges', 'Judg.', 'Jg'], ['Ruth', 'Ruth', 'Ru'], ['1 Samuel', '1 Sam.', '1Sa'],
  ['2 Samuel', '2 Sam.', '2Sa'], ['1 Kings', '1 Ki.', '1Ki'], ['2 Kings', '2 Ki.', '2Ki'],
  ['1 Chronicles', '1 Chron.', '1Ch'], ['2 Chronicles', '2 Chron.', '2Ch'], ['Ezra', 'Ezra', 'Ezr'],
  ['Nehemiah', 'Neh.', 'Ne'], ['Esther', 'Esther', 'Es'], ['Job', 'Job', 'Job'],
  ['Psalms', 'Ps.', 'Ps'], ['Proverbs', 'Prov.', 'Pr'], ['Ecclesiastes', 'Eccl.', 'Ec'],
  ['Song of Solomon', 'Song of Sol.', 'Ca'], ['Isaiah', 'Isa.', 'Isa'], ['Jeremiah', 'Jer.', 'Jer'],
  ['Lamentations', 'Lam.', 'La'], ['Ezekiel', 'Ezek.', 'Eze'], ['Daniel', 'Dan.', 'Da'],
  ['Hosea', 'Hos.', 'Ho'], ['Joel', 'Joel', 'Joe'], ['Amos', 'Amos', 'Am'],
  ['Obadiah', 'Obad.', 'Ob'], ['Jonah', 'Jonah', 'Jon'], ['Micah', 'Mic.', 'Mic'],
  ['Nahum', 'Nah.', 'Na'], ['Habakkuk', 'Hab.', 'Hab'], ['Zephaniah', 'Zeph.', 'Zep'],
  ['Haggai', 'Hag.', 'Hag'], ['Zechariah', 'Zech.', 'Zec'], ['Malachi', 'Mal.', 'Mal'],
  ['Matthew', 'Matt.', 'Mt'], ['Mark', 'Mark', 'Mr'], ['Luke', 'Luke', 'Lu'],
  ['John', 'John', 'Joh'], ['Acts', 'Acts', 'Ac'], ['Romans', 'Rom.', 'Ro'],
  ['1 Corinthians', '1 Cor.', '1Co'], ['2 Corinthians', '2 Cor.', '2Co'], ['Galatians', 'Gal.', 'Ga'],
  ['Ephesians', 'Eph.', 'Eph'], ['Philippians', 'Phil.', 'Php'], ['Colossians', 'Col.', 'Col'],
  ['1 Thessalonians', '1 Thess.', '1Th'], ['2 Thessalonians', '2 Thess.', '2Th'], ['1 Timothy', '1 Tim.', '1Ti'],
  ['2 Timothy', '2 Tim.', '2Ti'], ['Titus', 'Titus', 'Tit'], ['Philemon', 'Philem.', 'Phm'],
  ['Hebrews', 'Heb.', 'Heb'], ['James', 'Jas.', 'Jas'], ['1 Peter', '1 Pet.', '1Pe'],
  ['2 Peter', '2 Pet.', '2Pe'], ['1 John', '1 John', '1Jo'], ['2 John', '2 John', '2Jo'],
  ['3 John', '3 John', '3Jo'], ['Jude', 'Jude', 'Jude'], ['Revelation', 'Rev.', 'Re']
];

// Last verse number of every chapter in the NWT, one row per book. English
// versification; every chapter count and 95 versification-sensitive chapter
// ends were checked against jw.org's study-Bible data on 2026-10-11. NWT
// differences from the KJV: John 7 ends at 52 and Mark 16 at 8.
const VERSE_COUNT_ROWS = [
  '31 25 24 26 32 22 24 22 29 32 32 20 18 24 21 16 27 33 38 18 34 24 20 67 34 35 46 22 35 43 55 32 20 31 29 43 36 30 23 23 57 38 34 34 28 34 31 22 33 26',
  '22 25 22 31 23 30 25 32 35 29 10 51 22 31 27 36 16 27 25 26 36 31 33 18 40 37 21 43 46 38 18 35 23 35 35 38 29 31 43 38',
  '17 16 17 35 19 30 38 36 24 20 47 8 59 57 33 34 16 30 37 27 24 33 44 23 55 46 34',
  '54 34 51 49 31 27 89 26 23 36 35 16 33 45 41 50 13 32 22 29 35 41 30 25 18 65 23 31 40 16 54 42 56 29 34 13',
  '46 37 29 49 33 25 26 20 29 22 32 32 18 29 23 22 20 22 21 20 23 30 25 22 19 19 26 68 29 20 30 52 29 12',
  '18 24 17 24 15 27 26 35 27 43 23 24 33 15 63 10 18 28 51 9 45 34 16 33',
  '36 23 31 24 31 40 25 35 57 18 40 15 25 20 20 31 13 31 30 48 25',
  '22 23 18 22',
  '28 36 21 22 12 21 17 22 27 27 15 25 23 52 35 23 58 30 24 42 15 23 29 22 44 25 12 25 11 31 13',
  '27 32 39 12 25 23 29 18 13 19 27 31 39 33 37 23 29 33 43 26 22 51 39 25',
  '53 46 28 34 18 38 51 66 28 29 43 33 34 31 34 34 24 46 21 43 29 53',
  '18 25 27 44 27 33 20 29 37 36 21 21 25 29 38 20 41 37 37 21 26 20 37 20 30',
  '54 55 24 43 26 81 40 40 44 14 47 40 14 17 29 43 27 17 19 8 30 19 32 31 31 32 34 21 30',
  '17 18 17 22 14 42 22 18 31 19 23 16 22 15 19 14 19 34 11 37 20 12 21 27 28 23 9 27 36 27 21 33 25 33 27 23',
  '11 70 13 24 17 22 28 36 15 44',
  '11 20 32 23 19 19 73 18 38 39 36 47 31',
  '22 23 15 17 14 14 10 17 32 3',
  '22 13 26 21 27 30 21 22 35 22 20 25 28 22 35 22 16 21 29 29 34 30 17 25 6 14 23 28 25 31 40 22 33 37 16 33 24 41 30 24 34 17',
  '6 12 8 8 12 10 17 9 20 18 7 8 6 7 5 11 15 50 14 9 13 31 6 10 22 12 14 9 11 12 24 11 22 22 28 12 40 22 13 17 ' +
    '13 11 5 26 17 11 9 14 20 23 19 9 6 7 23 13 11 11 17 12 8 12 11 10 13 20 7 35 36 5 24 20 28 23 10 12 20 72 13 19 ' +
    '16 8 18 12 13 17 7 18 52 17 16 15 5 23 11 13 12 9 9 5 8 28 22 35 45 48 43 13 31 7 10 10 9 8 18 19 2 29 176 7 ' +
    '8 9 4 8 5 6 5 6 8 8 3 18 3 3 21 26 9 8 24 13 10 7 12 15 21 10 20 14 9 6',
  '33 22 35 27 23 35 27 36 18 32 31 28 25 35 33 33 28 24 29 30 31 29 35 34 28 28 27 28 27 33 31',
  '18 26 22 16 20 12 29 17 18 20 10 14',
  '17 17 11 16 16 13 13 14',
  '31 22 26 6 30 13 25 22 21 34 16 6 22 32 9 14 14 7 25 6 17 25 18 23 12 21 13 29 24 33 9 20 24 17 10 22 38 22 8 31 ' +
    '29 25 28 28 25 13 15 22 26 11 23 15 12 17 13 12 21 14 21 22 11 12 19 12 25 24',
  '19 37 25 31 31 30 34 22 26 25 23 17 27 22 21 21 27 23 15 18 14 30 40 10 38 24 22 17 32 24 40 44 26 22 19 32 21 28 18 16 ' +
    '18 22 13 30 5 28 7 47 39 46 64 34',
  '22 22 66 22 22',
  '28 10 27 17 17 14 27 18 11 22 25 28 23 23 8 63 24 32 14 49 32 31 49 27 17 21 36 26 21 26 18 32 33 31 15 38 28 23 29 49 ' +
    '26 20 27 31 25 24 23 35',
  '21 49 30 37 31 28 28 27 27 21 45 13',
  '11 23 5 19 15 11 16 14 17 15 12 14 16 9',
  '20 32 21',
  '15 16 15 13 27 14 17 14 15',
  '21',
  '17 10 10 11',
  '16 13 12 13 15 16 20',
  '15 13 19',
  '17 20 19',
  '18 15 20',
  '15 23',
  '21 13 10 14 11 15 14 23 17 12 17 14 9 21',
  '14 17 18 6',
  '25 23 17 25 48 34 29 34 38 42 30 50 58 36 39 28 27 35 30 34 46 46 39 51 46 75 66 20',
  '45 28 35 41 43 56 37 38 50 52 33 44 37 72 47 8',
  '80 52 38 44 39 49 50 56 62 42 54 59 35 35 32 31 37 43 48 47 38 71 56 53',
  '51 25 36 54 47 71 52 59 41 42 57 50 38 31 27 33 26 40 42 31 25',
  '26 47 26 37 42 15 60 40 43 48 30 25 52 28 41 40 34 28 41 38 40 30 35 27 27 32 44 31',
  '32 29 31 25 21 23 25 39 33 21 36 21 14 23 33 27',
  '31 16 23 21 13 20 40 13 27 33 34 31 13 40 58 24',
  '24 17 18 18 21 18 16 24 15 18 33 21 14',
  '24 21 29 31 26 18',
  '23 22 21 32 33 24',
  '30 30 21 23',
  '29 23 25 18',
  '10 20 13 18 28',
  '12 17 18',
  '20 15 16 16 25 21',
  '18 26 17 22',
  '16 15 15',
  '25',
  '14 18 19 16 14 20 28 13 28 39 40 29 25',
  '27 26 18 17 20',
  '25 25 22 19 14',
  '21 22 18',
  '10 29 24 21 21',
  '13',
  '14',
  '25',
  '20 29 22 11 14 17 17 13 21 11 19 17 18 20 8 21 18 24 21 15 27 21'
];

const OMISSION_REASON = 'it is not found in the earliest and most reliable manuscripts';

// Verses the NWT keeps as a number with "——" for text (checked on jw.org 2026-10-11).
const DASHED_VERSES = new Set([
  '40:17:21', '40:18:11', '40:23:14', '41:7:16', '41:9:44', '41:9:46', '41:11:26', '41:15:28',
  '42:17:36', '42:23:17', '43:5:4', '44:8:37', '44:15:34', '44:24:7', '44:28:29', '45:16:24'
]);

// Passages the NWT has no verse numbers for. The study note on the verse
// before them explains why.
const ABSENT_PASSAGES = [
  { book: 41, chapter: 16, verse: 9, endChapter: 16, endVerse: 20, text: 'Mark 16:9-20', noteOn: 'Mark 16:8' },
  { book: 43, chapter: 7, verse: 53, endChapter: 8, endVerse: 11, text: 'John 7:53–8:11', noteOn: 'John 7:52' }
];

// Chapters whose first numbered verse is not 1.
const FIRST_VERSE = { '43:8': 12 };

// Verse numbers other translations use for text the NWT numbers differently.
const NUMBERING_HINTS = {
  '64:1:15': 'Some translations number the closing greeting of 3 John as verse 15; in the NWT it is part of verse 14.',
  '66:12:18': 'Some translations number the first sentence of Revelation 13:1 as 12:18; in the NWT it is part of 13:1.'
};

/** Book number -> English name, e.g. BIBLE_BOOKS[19] === 'Psalms'. */
export const BIBLE_BOOKS = Object.freeze(Object.fromEntries(BOOK_ROWS.map(([name], i) => [i + 1, name])));

/** Book number -> last verse number of each chapter: VERSE_COUNTS[43][2] === 36 (John 3). */
export const VERSE_COUNTS = Object.freeze(
  Object.fromEntries(VERSE_COUNT_ROWS.map((row, i) => [i + 1, Object.freeze(row.split(' ').map(Number))]))
);

/** Book number -> number of chapters. */
export const CHAPTER_COUNTS = Object.freeze(
  Object.fromEntries(Object.entries(VERSE_COUNTS).map(([book, verses]) => [book, verses.length]))
);

/**
 * Abbreviations and alternate names (any case and spacing). Full names and
 * JW.org's own abbreviations ("Ge", "Ps.", "1 Cor.") match too; see getBookNumber.
 */
export const BOOK_ABBREVIATIONS = Object.freeze({
  'gen': 1, 'ge': 1, 'gn': 1,
  'exo': 2, 'ex': 2,
  'lev': 3, 'le': 3, 'lv': 3,
  'num': 4, 'nu': 4, 'nm': 4, 'nb': 4,
  'deu': 5, 'de': 5, 'dt': 5, 'deut': 5,
  'jos': 6, 'josh': 6,
  'jdg': 7, 'judg': 7, 'jg': 7,
  'rut': 8, 'ru': 8,
  '1sa': 9, '1 sa': 9, '1sam': 9, '1 sam': 9,
  '2sa': 10, '2 sa': 10, '2sam': 10, '2 sam': 10,
  '1ki': 11, '1 ki': 11, '1kgs': 11, '1 kgs': 11,
  '2ki': 12, '2 ki': 12, '2kgs': 12, '2 kgs': 12,
  '1ch': 13, '1 ch': 13, '1chr': 13, '1 chr': 13, '1 chron': 13,
  '2ch': 14, '2 ch': 14, '2chr': 14, '2 chr': 14, '2 chron': 14,
  'ezr': 15, 'ez': 15,
  'neh': 16, 'ne': 16,
  'est': 17, 'es': 17,
  'job': 18,
  'psa': 19, 'ps': 19, 'pss': 19, 'psalm': 19, 'psalms': 19,
  'pro': 20, 'pr': 20, 'prv': 20, 'prov': 20,
  'ecc': 21, 'ec': 21, 'eccl': 21, 'qoh': 21, 'qoheleth': 21,
  'sng': 22, 'ss': 22, 'song': 22, 'sos': 22, 'sol': 22, 'ca': 22, 'song of sol': 22,
  'song of songs': 22, 'canticles': 22, 'canticle of canticles': 22,
  'isa': 23, 'is': 23,
  'jer': 24, 'je': 24, 'jr': 24,
  'lam': 25, 'la': 25,
  'eze': 26, 'ezk': 26, 'ezek': 26,
  'dan': 27, 'da': 27, 'dn': 27,
  'hos': 28, 'ho': 28,
  'joe': 29, 'jl': 29, 'joel': 29,
  'amo': 30, 'am': 30, 'amos': 30,
  'oba': 31, 'ob': 31, 'obad': 31,
  'jon': 32, 'jnh': 32, 'jonah': 32,
  'mic': 33, 'mi': 33,
  'nah': 34, 'na': 34, 'nahum': 34,
  'hab': 35, 'hb': 35,
  'zep': 36, 'zph': 36, 'zeph': 36,
  'hag': 37, 'hg': 37,
  'zec': 38, 'zch': 38, 'zech': 38,
  'mal': 39, 'ml': 39,
  'mat': 40, 'mt': 40, 'matt': 40, 'matthew': 40,
  'mrk': 41, 'mk': 41, 'mar': 41, 'mr': 41, 'mark': 41,
  'luk': 42, 'lk': 42, 'lu': 42, 'luke': 42,
  'joh': 43, 'jn': 43, 'jhn': 43, 'john': 43,
  'act': 44, 'ac': 44, 'acts': 44, 'acts of the apostles': 44,
  'rom': 45, 'ro': 45, 'rm': 45, 'romans': 45,
  '1co': 46, '1 co': 46, '1cor': 46, '1 cor': 46,
  '2co': 47, '2 co': 47, '2cor': 47, '2 cor': 47,
  'gal': 48, 'ga': 48,
  'eph': 49, 'ephes': 49,
  'phi': 50, 'php': 50, 'phil': 50,
  'col': 51,
  '1th': 52, '1 th': 52, '1thes': 52, '1 thes': 52, '1thess': 52, '1 thess': 52,
  '2th': 53, '2 th': 53, '2thes': 53, '2 thes': 53, '2thess': 53, '2 thess': 53,
  '1ti': 54, '1 ti': 54, '1tim': 54, '1 tim': 54,
  '2ti': 55, '2 ti': 55, '2tim': 55, '2 tim': 55,
  'tit': 56, 'ti': 56, 'titus': 56,
  'phm': 57, 'philem': 57, 'philemon': 57,
  'heb': 58, 'he': 58,
  'jas': 59, 'jm': 59, 'james': 59,
  '1pe': 60, '1 pe': 60, '1pet': 60, '1 pet': 60, '1peter': 60, '1 peter': 60,
  '2pe': 61, '2 pe': 61, '2pet': 61, '2 pet': 61, '2peter': 61, '2 peter': 61,
  '1jo': 62, '1 jo': 62, '1jn': 62, '1 jn': 62, '1john': 62, '1 john': 62,
  '2jo': 63, '2 jo': 63, '2jn': 63, '2 jn': 63, '2john': 63, '2 john': 63,
  '3jo': 64, '3 jo': 64, '3jn': 64, '3 jn': 64, '3john': 64, '3 john': 64,
  'jud': 65, 'jude': 65,
  'rev': 66, 're': 66, 'rv': 66, 'revelation': 66, 'revelations': 66, 'apocalypse': 66
});

// Lowercase, accents and periods removed, "I John"/"First John"/"1John" -> "1 john".
function normalizeName(text) {
  let s = asciiDigits(String(text).normalize('NFKD')).replace(/\p{M}/gu, '').toLowerCase();
  s = s.replace(/[.\s]+/g, ' ').trim().replace(/^the /, '');
  s = s.replace(/^(?:first|1st|i) /, '1 ').replace(/^(?:second|2nd|ii) /, '2 ').replace(/^(?:third|3rd|iii) /, '3 ');
  return s.replace(/^([123]) ?(?=\p{L})/u, '$1 ');
}

const ALIASES = new Map();
const NAME_KEYS = Array.from({ length: 67 }, () => []);
const ALIAS_KEYS = Array.from({ length: 67 }, () => []);

function addAlias(alias, book) {
  const key = normalizeName(alias);
  if (!key || ALIASES.has(key)) return;
  ALIASES.set(key, book);
  ALIAS_KEYS[book].push(key);
}

BOOK_ROWS.forEach(([name, standard, short], i) => {
  NAME_KEYS[i + 1].push(normalizeName(name));
  for (const alias of [name, standard, short]) addAlias(alias, i + 1);
});
NAME_KEYS[19].push('psalm');
for (const [alias, book] of Object.entries(BOOK_ABBREVIATIONS)) addAlias(alias, book);

function isBookNumber(n) {
  return Number.isInteger(n) && n >= 1 && n <= 66;
}

/** English book name for 1-66, or null. */
export function getBookName(bookNum) {
  return BIBLE_BOOKS[bookNum] || null;
}

/**
 * {number, name, singularName, abbreviation ('Gen.'), shortAbbreviation ('Ge'),
 * chapters, testament, division} for 1-66, or null.
 */
export function getBookInfo(book) {
  if (!isBookNumber(book)) return null;
  const [name, abbreviation, shortAbbreviation] = BOOK_ROWS[book - 1];
  return {
    number: book,
    name,
    singularName: book === 19 ? 'Psalm' : name,
    abbreviation,
    shortAbbreviation,
    chapters: CHAPTER_COUNTS[book],
    testament: book <= 39 ? 'Old Testament' : 'New Testament',
    division: book <= 39 ? 'Hebrew-Aramaic Scriptures' : 'Christian Greek Scriptures'
  };
}

/** Number of chapters in a book, or null. */
export function getChapterCount(book) {
  return CHAPTER_COUNTS[book] ?? null;
}

/** Last verse number of a chapter in the NWT, or null when the chapter does not exist. */
export function getVerseCount(book, chapter) {
  return VERSE_COUNTS[book]?.[chapter - 1] ?? null;
}

/** First verse number of a chapter: 1, except John 8, which starts at 12 in the NWT. */
export function getFirstVerse(book, chapter) {
  return FIRST_VERSE[`${book}:${chapter}`] ?? 1;
}

function absentPassageAt(book, chapter, verse) {
  return ABSENT_PASSAGES.find(
    (p) =>
      p.book === book &&
      (chapter > p.chapter || (chapter === p.chapter && verse >= p.verse)) &&
      (chapter < p.endChapter || (chapter === p.endChapter && verse <= p.endVerse))
  );
}

/**
 * Why the NWT has no text for a verse, or null when it has:
 * {reference, numbered, studyNote, reason}. `numbered` is true for verses
 * that keep their number with "——" as the text, false for John 7:53–8:11
 * and Mark 16:9-20, which have no verse numbers. `studyNote` names the verse
 * whose study note explains the omission.
 */
export function getOmission(book, chapter, verse) {
  const name = BIBLE_BOOKS[book];
  if (DASHED_VERSES.has(`${book}:${chapter}:${verse}`)) {
    const reference = `${name} ${chapter}:${verse}`;
    return { reference, numbered: true, studyNote: reference, reason: `Left out of the NWT because ${OMISSION_REASON}.` };
  }
  const passage = absentPassageAt(book, chapter, verse);
  if (!passage) return null;
  return {
    reference: passage.text,
    numbered: false,
    studyNote: passage.noteOn,
    reason: `Left out of the NWT because ${OMISSION_REASON}.`
  };
}

// A local name as written ("Éz", Dutch "Re") beats an English alias; an
// accent-folded local key ("dan" from Vietnamese "Dân") does not, unless the
// input itself has accents, so English "Dan." stays Daniel with langwritten VT.
function lookupAlias(text, key, local) {
  const exact = local?.exact.get(exactKey(text));
  if (exact) return exact;
  const folded = local?.folded.get(key);
  if (folded && (!ALIASES.has(key) || /[^\x00-\x7f]/.test(text))) return folded;
  return ALIASES.get(key) ?? null;
}

/**
 * Book number from a number, a numeric string, a name or an abbreviation
 * ("John", "Jn", "1 Cor.", "I John", "Song of Songs"), or null. A word that
 * starts exactly one book name ("Zephan") also matches. With `lang` (a JW
 * code), that language's names registered with registerBookNames ("Juan",
 * "Sal.") count too: a local name exactly as written beats an English alias
 * (French "Éz" is Ezekiel, not Ezra), which beats an accent-folded local name
 * (Vietnamese "Dan." is Daniel, not "Dân" Numbers). The scripture tools load
 * the names before they parse, so the answer never depends on call order.
 */
export function getBookNumber(bookName, lang) {
  if (typeof bookName === 'number') return isBookNumber(bookName) ? bookName : null;
  if (typeof bookName !== 'string') return null;
  const text = asciiDigits(bookName).trim();
  if (/^\d+$/.test(text)) return isBookNumber(Number(text)) ? Number(text) : null;
  const key = normalizeName(text);
  if (!key) return null;
  const local = lang && lang !== 'E' ? localAliases.get(lang) : null;
  const hit = lookupAlias(text, key, local);
  if (hit) return hit;
  const prefixOf = (keys, minLength) => {
    if ([...key.replace(/[\d ]/g, '')].length < minLength) return null;
    const hits = new Set();
    keys.forEach((names, book) => {
      if (names.some((n) => n.startsWith(key))) hits.add(book);
    });
    return hits.size === 1 ? [...hits][0] : null;
  };
  return prefixOf(NAME_KEYS, 3) ?? (local ? prefixOf(local.keys, 2) : null);
}

/**
 * Books matching a name, abbreviation or number, best first, as
 * [{number, name, score}]. Scores: exact name 100, exact abbreviation 95,
 * name prefix 80, abbreviation prefix 75, word prefix 70, substring 60, and
 * when nothing else matches, a near miss ("Jhon") 50 or 45, marked
 * `guess: true`. A trailing chapter and verse ("1 Cor. 13:4") is ignored.
 */
export function searchBooks(query, limit = 10, { lang } = {}) {
  if (typeof query !== 'string' && typeof query !== 'number') return [];
  let text = asciiDigits(String(query)).trim();
  if (text.length > MAX_BOOK_LENGTH * 2) return [];
  const withSpec = /^(.*\p{L}\.?)\s*\d[\d\s:.,\-\u2010-\u2015]*$/u.exec(text);
  if (withSpec) text = withSpec[1];
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return isBookNumber(n) ? [{ number: n, name: BIBLE_BOOKS[n], score: 100 }] : [];
  }
  const q = normalizeName(text);
  if (!q) return [];
  const local = lang && lang !== 'E' ? localAliases.get(lang) : null;
  const exactAlias = lookupAlias(text, q, local);
  const namesOf = (book) => (local ? [...NAME_KEYS[book], ...local.keys[book]] : NAME_KEYS[book]);
  const results = [];
  for (let book = 1; book <= 66; book++) {
    const names = namesOf(book);
    let score = 0;
    if (names.includes(q)) score = 100;
    else if (exactAlias === book) score = 95;
    else if (names.some((n) => n.startsWith(q))) score = 80;
    else if (ALIAS_KEYS[book].some((a) => a.startsWith(q))) score = 75;
    else if (names.some((n) => n.split(' ').some((w) => w.startsWith(q)))) score = 70;
    else if (q.length >= 3 && names.some((n) => n.includes(q))) score = 60;
    if (score) results.push({ number: book, name: BIBLE_BOOKS[book], score });
  }
  if (!results.length && q.length >= 3) {
    // Typos ("Jhon", "Mathew") as a last resort. Two edits only when both words have 5+ letters,
    // so "Tobit" does not match the abbreviation "Tit." by dropping two letters.
    const near = (keys) => keys.some((k) => k.length >= 3 && editDistance(q, k) <= (Math.min(q.length, k.length) <= 4 ? 1 : 2));
    for (let book = 1; book <= 66; book++) {
      const score = near(namesOf(book)) ? 50 : near(ALIAS_KEYS[book]) ? 45 : 0;
      if (score) results.push({ number: book, name: BIBLE_BOOKS[book], score, guess: true });
    }
  }
  results.sort((a, b) => b.score - a.score || a.number - b.number);
  return results.slice(0, limit);
}

// Levenshtein distance that also counts swapping two adjacent letters as one edit.
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const BOOK_ALLOWED = 'a Bible book number from 1 to 66 or a book name such as "John" or "1 Cor."';
const VERSE_ALLOWED = 'a verse like "16", a range like "14-16" or a list like "1,3,5-7"';
const REFERENCE_ALLOWED = 'a Bible reference like "John 3:16", "Ps. 83:18", "1 Cor. 13:4-7", "Psalm 23" or "Jude 25"';
// The tools serve only the NWT, so a trailing "NWT", "(nwtsty)" or "New World Translation" adds nothing.
const NWT_TAG = /,? ?[([]?\b(?:NWT|nwtsty|New World Translation)\b[)\]]?\.?$/i;
// Study notes cite "Eph 4:11, ftn." and "Re 5:9; 13:7; ftns.": see the footnote(s) on that verse.
const FOOTNOTE_TAG = /(?:^|,? ?)\bftns?\.?$/i;
const FOOTNOTE_PART = /; ?(ftns?\.?) ?(?=;|$)/gi;

/** Folds a "; ftn." part into the reference before it ("2Pe 1:13; ftn." -> "2Pe 1:13, ftn."). */
export function foldFootnoteParts(text) {
  return text.replace(FOOTNOTE_PART, ', $1');
}

const MAX_SEGMENTS = 50;
const MAX_REFERENCES = 20;
// Long arguments are refused before any regex runs on them.
const MAX_BOOK_LENGTH = 100;
const MAX_VERSE_LENGTH = 1000;
export const UNKNOWN_BOOK_HINT =
  'Book names are read in English (or in the langwritten language once known): use "John 3:16" or book: 43, with langwritten "S" for Spanish text.';

/** True when a letter is followed somewhere by a digit ("John 3", "روما ٥"). Linear; /\p{L}.*\d/u is quadratic on long input. */
export function looksLikeReference(text) {
  if (typeof text !== 'string') return false;
  const i = text.search(/\p{L}/u);
  return i >= 0 && /\p{Nd}/u.test(text.slice(i));
}

function bookHint(text, lang) {
  const guesses = typeof text === 'string' ? searchBooks(text, 3, { lang }) : [];
  return guesses.length ? `Did you mean ${guesses.map((g) => `${g.name} (${g.number})`).join(', ')}?` : UNKNOWN_BOOK_HINT;
}

// error.unknownBook lets a caller learn the language's book names and retry.
function unknownBook(error) {
  error.unknownBook = true;
  return error;
}

/** Book number from 1-66, a numeric string or a name (in `lang` too); throws ArgError otherwise. */
export function toBook(value, name = 'book', lang) {
  if (isMissing(value)) {
    throw new ArgError(name, undefined, BOOK_ALLOWED, { hint: 'search_bible_books finds book numbers.' });
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(value))) {
    const n = Number(value);
    if (isBookNumber(n)) return n;
    throw new ArgError(name, value, BOOK_ALLOWED);
  }
  if (typeof value === 'string' && value.length > MAX_BOOK_LENGTH) {
    throw new ArgError(name, value, BOOK_ALLOWED, { hint: 'search_bible_books lists book names, abbreviations and numbers.' });
  }
  const book = getBookNumber(value, lang);
  if (book) return book;
  throw unknownBook(new ArgError(name, value, BOOK_ALLOWED, { hint: bookHint(value, lang) }));
}

// Reference text as the parser reads it: NFKC (CJK "；" and "："), ASCII digits
// and punctuation for Arabic citations ("١ يوحنا ٤:٩، ١٠" uses Arabic-Indic
// digits, "،" and "؛"), "-" for every dash, and "to"/"through" as "-".
export function normalizeReferenceText(text) {
  return asciiDigits(String(text).normalize('NFKC'))
    .replace(/،/g, ',')
    .replace(/؛/g, ';')
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/ (?:to|through|thru) /gi, '-');
}

const ITEM_RE = /^(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/;

// "16b" (part of verse 16) and "16ff" (16 and following). The NWT has no
// part verses, so the letters are dropped with a note. In a reference only
// letters after "chapter:verse" count, so "1C 13:4" keeps its book name.
const PART_VERSE = /(?<=\d)(?:[a-c]|ff?)(?=$|[\s,;)\]-])/gi;
const REF_PART_VERSE = /(?<=:[\d\s,a-cf-]*\d)(?:[a-c]|ff?)(?=$|[\s,;)\]-])/gi;

function dropPartVerse(text, re) {
  const found = text.match(re);
  if (!found) return { text, notes: [] };
  const more = found.some((f) => /f$/i.test(f)) ? ' "f"/"ff" (and following) adds no verses; send an end verse, e.g. "16-18".' : '';
  return {
    text: text.replace(re, ''),
    notes: [`Part-verse letters (${found.map((f) => `"${f}"`).join(', ')}) were ignored; the NWT is served by whole verses.${more}`]
  };
}

// "3:16-18,20" -> [{a:3, b:16, c:18}, {a:20}]; null when the text does not fit.
function parseSpecItems(spec) {
  const compact = spec.replace(/\s+/g, ' ').replace(/ ?([:,-]) ?/g, '$1').trim();
  if (!compact || /\s/.test(compact)) return null;
  const items = [];
  for (const item of compact.split(',')) {
    const m = ITEM_RE.exec(item);
    if (!m) return null;
    const [a, b, c, d] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
    items.push({ a, b, c, d });
  }
  return items;
}

function wholeChapters(chapter, endChapter = chapter) {
  return { chapter, verse: null, endChapter, endVerse: null };
}

function verseRun(chapter, verse, endVerse = verse, endChapter = chapter) {
  return { chapter, verse, endChapter, endVerse };
}

// Items of a reference's chapter-and-verse part -> segments. A bare number is
// a chapter until a "chapter:verse" item sets the chapter, then a verse; in a
// one-chapter book it is always a verse.
function itemsToSegments(items, book, fail) {
  const oneChapter = CHAPTER_COUNTS[book] === 1;
  let chapter = null;
  return items.map(({ a, b, c, d }) => {
    if (b !== undefined) {
      if (d !== undefined) {
        chapter = c;
        return verseRun(a, b, d, c);
      }
      chapter = a;
      return verseRun(a, b, c ?? b);
    }
    if (d !== undefined) {
      if (chapter === null && !oneChapter) fail();
      const from = chapter ?? 1;
      chapter = c;
      return verseRun(from, a, d, c);
    }
    if (chapter !== null || oneChapter) return verseRun(chapter ?? 1, a, c ?? a);
    return wholeChapters(a, c ?? a);
  });
}

function refLabel(book, chapter) {
  if (CHAPTER_COUNTS[book] === 1) return BIBLE_BOOKS[book];
  return `${book === 19 ? 'Psalm' : BIBLE_BOOKS[book]} ${chapter}`;
}

function refError(param, received, message, hint) {
  return new ArgError(param, received, REFERENCE_ALLOWED, { message, hint });
}

function checkVerse(book, chapter, verse, param, received) {
  if (!Number.isInteger(verse) || verse < 0) throw new ArgError(param, received, VERSE_ALLOWED);
  const first = getFirstVerse(book, chapter);
  if (verse === 0) {
    if (book === 19) return;
    throw refError(
      param,
      received,
      'Verse 0 exists only in Psalms, where it is the superscription.',
      `Verses in ${refLabel(book, chapter)} start at ${first}.`
    );
  }
  const last = getVerseCount(book, chapter);
  const absent = absentPassageAt(book, chapter, verse);
  if (absent && (verse > last || verse < first)) {
    throw refError(
      param,
      received,
      `${absent.text} is not part of the New World Translation, because ${OMISSION_REASON}.`,
      `The study note on ${absent.noteOn} explains it (get_verse_with_study). ${BIBLE_BOOKS[book]} ${chapter} has verses ${first}-${last}.`
    );
  }
  if (verse > last) {
    throw refError(
      param,
      received,
      `${refLabel(book, chapter)} has ${last} verses, so there is no verse ${verse}.`,
      NUMBERING_HINTS[`${book}:${chapter}:${verse}`] ?? `Use a verse from ${first} to ${last}.`
    );
  }
}

function checkChapter(book, chapter, param, received) {
  const name = BIBLE_BOOKS[book];
  const chapters = CHAPTER_COUNTS[book];
  if (Number.isInteger(chapter) && chapter >= 1 && chapter <= chapters) return;
  if (!Number.isInteger(chapter) || chapter < 1) {
    throw new ArgError(param, received, `a chapter from 1 to ${chapters}`);
  }
  if (chapters === 1) {
    const verses = getVerseCount(book, 1);
    throw refError(
      param,
      received,
      `${name} has only one chapter, so there is no chapter ${chapter}.`,
      chapter <= verses
        ? `Did you mean ${name} ${chapter}? Use chapter 1, verse ${chapter}.`
        : `Use chapter 1; ${name} has ${verses} verses.`
    );
  }
  throw refError(
    param,
    received,
    `${name} has ${chapters} chapters, so there is no chapter ${chapter}.`,
    `Use a chapter from 1 to ${chapters}.`
  );
}

function inSegment(seg, chapter, verse) {
  const afterStart = chapter > seg.chapter || (chapter === seg.chapter && verse >= seg.verse);
  const beforeEnd = chapter < seg.endChapter || (chapter === seg.endChapter && verse <= seg.endVerse);
  return afterStart && beforeEnd;
}

function mergeSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.chapter - b.chapter || (a.verse ?? -1) - (b.verse ?? -1));
  const out = [];
  for (const seg of sorted) {
    const prev = out.at(-1);
    const bothWhole = prev && prev.verse === null && seg.verse === null;
    const sameChapterRuns =
      prev && prev.verse !== null && seg.verse !== null &&
      prev.chapter === prev.endChapter && seg.chapter === seg.endChapter && prev.chapter === seg.chapter;
    if (bothWhole && seg.chapter <= prev.endChapter + 1) {
      prev.endChapter = Math.max(prev.endChapter, seg.endChapter);
    } else if (sameChapterRuns && seg.verse <= prev.endVerse + 1) {
      prev.endVerse = Math.max(prev.endVerse, seg.endVerse);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

const before = (c1, v1, c2, v2) => c1 < c2 || (c1 === c2 && v1 < v2);

// A range that runs into or out of a passage with no verse numbers is cut to
// the numbered verses around it. A range wholly inside one is left for
// checkVerse to reject.
function trimAbsent(book, seg, notes) {
  const head = absentPassageAt(book, seg.chapter, seg.verse);
  if (head && before(head.endChapter, head.endVerse, seg.endChapter, seg.endVerse)) {
    const next = head.endVerse < getVerseCount(book, head.endChapter)
      ? [head.endChapter, head.endVerse + 1]
      : [head.endChapter + 1, 1];
    // Nothing follows Mark 16:9-20, so that range is left for checkVerse to reject.
    if (next[0] <= CHAPTER_COUNTS[book]) {
      [seg.chapter, seg.verse] = next;
      notes.push(`${head.text} is not part of the New World Translation, so the passage starts at ${next.join(':')}.`);
    }
  }
  const tail = absentPassageAt(book, seg.endChapter, seg.endVerse);
  if (tail && before(seg.chapter, seg.verse, tail.chapter, tail.verse)) {
    // Both passages start after verse 1 of their chapter.
    [seg.endChapter, seg.endVerse] = [tail.chapter, tail.verse - 1];
    notes.push(`${tail.text} is not part of the New World Translation, so the passage ends at ${seg.endChapter}:${seg.endVerse}.`);
  }
}

// Validates segments (trimAbsent cuts ranges that run into John 7:53–8:11 or
// Mark 16:9-20, with a note), then sorts and merges them. Returns {segments, notes}.
function checkSegments(book, segments, params, received) {
  const notes = [];
  for (const seg of segments) {
    checkChapter(book, seg.chapter, params.chapter, received.chapter);
    checkChapter(book, seg.endChapter, params.chapter, received.chapter);
    if (seg.endChapter < seg.chapter) {
      throw refError(
        params.chapter,
        received.chapter,
        `The range ${seg.chapter}-${seg.endChapter} ends before it starts.`,
        'Put the earlier chapter first.'
      );
    }
    if (seg.verse === null) continue;
    trimAbsent(book, seg, notes);
    checkVerse(book, seg.chapter, seg.verse, params.verse, received.verse);
    // A range that starts in the chapter but runs past its end ("16-100") means "to the end".
    const last = getVerseCount(book, seg.endChapter);
    const isRange = seg.endChapter !== seg.chapter || seg.endVerse !== seg.verse;
    if (isRange && Number.isInteger(seg.endVerse) && seg.endVerse > last) {
      const hint = NUMBERING_HINTS[`${book}:${seg.endChapter}:${seg.endVerse}`];
      notes.push(`${refLabel(book, seg.endChapter)} has ${last} verses, so the passage ends at verse ${last}.${hint ? ` ${hint}` : ''}`);
      seg.endVerse = last;
    }
    checkVerse(book, seg.endChapter, seg.endVerse, params.verse, received.verse);
    if (seg.endChapter === seg.chapter && seg.endVerse < seg.verse) {
      throw refError(
        params.verse,
        received.verse,
        `The range ${seg.verse}-${seg.endVerse} in ${refLabel(book, seg.chapter)} ends before it starts.`,
        `Put the lower verse first, e.g. "${seg.endVerse}-${seg.verse}".`
      );
    }
  }
  const merged = mergeSegments(segments);
  if (merged.length > MAX_SEGMENTS) {
    throw refError(
      params.verse,
      received.verse,
      `That reference has ${merged.length} separate passages; the limit is ${MAX_SEGMENTS}.`,
      'Ask for fewer passages at a time.'
    );
  }
  for (const seg of merged) {
    if (seg.verse === null) continue;
    for (const key of DASHED_VERSES) {
      const [b, c, v] = key.split(':').map(Number);
      if (b === book && inSegment(seg, c, v)) {
        notes.push(`${BIBLE_BOOKS[b]} ${c}:${v} has no text in the NWT ("——"), because ${OMISSION_REASON}.`);
      }
    }
  }
  return { segments: merged, notes };
}

// Localized book names registered with registerBookNames, by language code:
// localNames for formatReference, localAliases for the parser.
const localNames = new Map();
const localAliases = new Map();

// The names and abbreviations a language's editionData gives each book.
const NAME_FIELDS = [
  'standardName',
  'standardSingularBookName',
  'standardPluralBookName',
  'standardAbbreviation',
  'officialAbbreviation',
  'standardSingularAbbreviation',
  'officialSingularAbbreviation',
  'chapterDisplayTitle'
];

// Lowercase, periods and spacing normalized, accents kept: Portuguese "Jo" (João) and "Jó" (Job) differ.
function exactKey(text) {
  return asciiDigits(String(text).normalize('NFC')).toLowerCase().replace(/[.\s]+/g, ' ').trim().replace(/^([123]) ?(?=\p{L})/u, '$1 ');
}

function plainName(value) {
  return typeof value === 'string' ? value.replace(/<rt>.*?<\/rt>/gs, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

/**
 * Register a language's book names, for formatReference and for parsing
 * references written in that language: the jw.org study-Bible JSON's
 * editionData.books ({'43': {standardName: 'Juan', officialAbbreviation:
 * 'Jn', ...}}) or a plain {43: 'Juan', ...} map.
 */
export function registerBookNames(lang, books) {
  const code = typeof lang === 'string' ? lang : lang?.code;
  if (!code || !books || typeof books !== 'object') return;
  const names = {};
  const aliases = { exact: new Map(), folded: new Map(), keys: Array.from({ length: 67 }, () => []), digitNames: [] };
  const ambiguous = new Set();
  for (const [key, value] of Object.entries(books)) {
    const book = Number(key);
    if (!isBookNumber(book)) continue;
    const fields = typeof value === 'string' ? [value] : NAME_FIELDS.map((f) => value?.[f]);
    const list = fields.map(plainName).filter(Boolean);
    if (!list.length) continue;
    const name = typeof value === 'string' ? list[0] : plainName(value.standardName);
    if (name) names[book] = { name, singular: plainName(value?.standardSingularBookName) || name };
    // "요한 1서" is also written "요한1서".
    for (const alias of new Set(list.flatMap((a) => [a, a.replace(/(\p{L})\s+(?=\p{Nd})/gu, '$1')]))) {
      const exact = exactKey(alias);
      const folded = normalizeName(alias);
      if (exact && !aliases.exact.has(exact)) {
        aliases.exact.set(exact, book);
        if (looksLikeReference(exact)) aliases.digitNames.push([exact, book]);
      }
      if (!folded) continue;
      if (!aliases.keys[book].includes(folded)) aliases.keys[book].push(folded);
      const seen = aliases.folded.get(folded);
      if (seen === undefined && !ambiguous.has(folded)) aliases.folded.set(folded, book);
      else if (seen !== undefined && seen !== book) {
        aliases.folded.delete(folded);
        ambiguous.add(folded);
      }
    }
  }
  aliases.digitNames.sort((a, b) => b[0].length - a[0].length);
  localNames.set(code, names);
  localAliases.set(code, aliases);
}

/** A book's name registered for a language code ("Juan" for S, 43), or null. */
export function localBookName(code, book) {
  return localNames.get(code)?.[book]?.name ?? null;
}

/** True once registerBookNames has run for the language code. */
export function hasBookNames(code) {
  return localAliases.has(code);
}

/** For tests: forget every registered language's book names. */
export function clearBookNames() {
  localNames.clear();
  localAliases.clear();
}

function bookLabel(book, segments, lang) {
  const code = typeof lang === 'string' ? lang : lang?.code;
  const local = code && code !== 'E' ? localNames.get(code)?.[book] : null;
  const oneChapter = segments.every((s) => s.chapter === segments[0].chapter && s.endChapter === s.chapter);
  if (book === 19 && oneChapter) return local?.singular ?? 'Psalm';
  return local?.name ?? BIBLE_BOOKS[book];
}

function verseText(v) {
  return v === 0 ? 'superscription' : String(v);
}

// JW style: "16", "16, 17" for two verses, "16-18" for three or more.
function runText(from, to, fmt = String) {
  if (from === to) return fmt(from);
  return `${fmt(from)}${to === from + 1 ? ', ' : '-'}${fmt(to)}`;
}

function formatSegments(book, segments, lang) {
  const oneChapterBook = CHAPTER_COUNTS[book] === 1;
  let text = '';
  let prev = null;
  for (const s of segments) {
    let part;
    let sep = '; ';
    if (s.verse === null) {
      part = oneChapterBook ? '' : runText(s.chapter, s.endChapter);
      if (prev?.verse === null) sep = ', ';
    } else if (s.endChapter !== s.chapter) {
      part = `${s.chapter}:${verseText(s.verse)}–${s.endChapter}:${verseText(s.endVerse)}`;
    } else if (prev && prev.verse !== null && prev.endChapter === s.chapter) {
      part = runText(s.verse, s.endVerse, verseText);
      sep = ', ';
    } else {
      const verses = runText(s.verse, s.endVerse, verseText);
      part = oneChapterBook ? verses : `${s.chapter}:${verses}`;
    }
    if (part) text += text ? sep + part : part;
    prev = s;
  }
  const label = bookLabel(book, segments, lang);
  return text ? `${label} ${text}` : label;
}

function verseSpecOf(segments) {
  const chapter = segments[0].chapter;
  if (segments.some((s) => s.chapter !== chapter || s.endChapter !== chapter)) return null;
  if (segments.length === 1 && segments[0].verse === null) return '';
  if (segments.some((s) => s.verse === null)) return null;
  return segments.map((s) => (s.verse === s.endVerse ? `${s.verse}` : `${s.verse}-${s.endVerse}`)).join(',');
}

function buildRef(book, segments, notes) {
  const first = segments[0];
  const single = segments.length === 1 ? first : null;
  const oneRange =
    single && single.verse !== null && single.endChapter === single.chapter && single.endVerse !== single.verse;
  return {
    book,
    bookName: BIBLE_BOOKS[book],
    chapter: first.chapter,
    verse: first.verse,
    verseEnd: oneRange ? single.endVerse : null,
    endChapter: segments.at(-1).endChapter,
    segments,
    verseSpec: verseSpecOf(segments),
    contiguous: segments.length === 1,
    reference: formatSegments(book, segments),
    notes
  };
}

function cleanReferenceText(text) {
  return normalizeReferenceText(text)
    .replace(/(\d)\s*\.\s*(?=\d)/g, '$1:')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[([]\s*/, '')
    .replace(/\s*[)\]]$/, '')
    .replace(/[\s;,.]+$/, '');
}

// One reference. `book` (a number) is the book of a part without one ("4:1"
// in "John 3:16; 4:1"); otherwise the text names it, in English or in `lang`.
// Names words after the last number ("John 3:16 KJV") so the caller knows what to drop.
function unreadable(s, name, received, given) {
  let i = s.length;
  while (i > 0 && !/\d/.test(s[i - 1])) i--;
  const head = s.slice(0, i).trim();
  const tail = s.slice(i).replace(/^[\s([]+/, '');
  if (i && /^(?:[a-c]|ff?)$/i.test(s.slice(i))) {
    return new ArgError(name, received, REFERENCE_ALLOWED, {
      hint: `"${tail}" after "${head}" reads as a part-verse letter; the NWT has only whole verses, so drop it and call again.`
    });
  }
  // A numbered book ("1 Cor 13:4", "2Ti 4:5") starts with a digit.
  const headOk = given ? /^\d[\d\s:,-]*$/.test(head) : /^(?:[1-3] ?)?[^\d]*[\p{L}.]\s*\d[\d\s:,-]*$/u.test(head);
  if (!i || !/\p{L}/u.test(tail) || !headOk) return new ArgError(name, received, REFERENCE_ALLOWED);
  const bare = tail.replace(/^[\s,]+/, '').replace(/[()[\].]/g, '');
  const translation = /^[A-Z][A-Z0-9]{1,5}$/.test(bare) || /\b(?:version|translation|bible)\b/i.test(tail);
  return new ArgError(name, received, REFERENCE_ALLOWED, {
    hint: `Drop ${describeValue(tail)} after "${head}" and call again${translation ? '; the tools serve only the New World Translation' : ''}.`
  });
}

// "John 3:16, Romans 5:8" or "John 3:16 and 1 John 4:8": a second book after a
// comma or "and". Returns the ";" form when every piece parses, else null.
const LIST_JOIN = /\s*(?:,|&|\band\b)\s*(?=(?:[1-3]\s*)?\p{L})/u;

function semicolonList(s, lang) {
  const pieces = s.split(LIST_JOIN);
  if (pieces.length < 2) return null;
  const list = pieces.join('; ');
  try {
    parseReferences(list, { lang });
    return list;
  } catch {
    return null;
  }
}

// A local name with a digit after a letter (Korean "요한 1서", "요1") defeats the
// generic name/number split, so such names are matched first, longest first.
// A name ending in a digit needs a space or the end after it: "요14:8" is John 14:8.
function localDigitName(s, lang) {
  const names = lang && lang !== 'E' ? localAliases.get(lang)?.digitNames : null;
  if (!names?.length) return null;
  const key = exactKey(s);
  for (const [alias, book] of names) {
    if (!key.startsWith(alias)) continue;
    const rest = key.slice(alias.length);
    if (/\d$/.test(alias) && rest && !/^\s/.test(rest)) continue;
    const m = /^\s*(\d[\d\s:,-]*)?$/.exec(rest);
    if (m) return { book, m: [s, alias, m[1]] };
  }
  return null;
}

function parseOne(text, name, received, { lang, book: given } = {}) {
  const s = cleanReferenceText(text);
  const digitName = given ? null : localDigitName(s, lang);
  const m = digitName?.m ?? (given ? /^()(\d[\d\s:,-]*)$/.exec(s) : /^(.*?[\p{L}.])\s*(\d[\d\s:,-]*)?$/u.exec(s));
  if (!m || (!digitName && looksLikeReference(m[1]))) {
    const list = given ? null : semicolonList(s, lang);
    if (list) {
      throw new ArgError(name, received, REFERENCE_ALLOWED, { hint: `Separate references with ";": use ${describeValue(list)}.` });
    }
    throw unreadable(s, name, received, given);
  }
  const bookText = m[1].trim();
  const book = given ?? digitName?.book ?? getBookNumber(bookText, lang);
  const shown = describeValue(String(received).trim());
  if (!book) {
    throw unknownBook(new ArgError(name, received, REFERENCE_ALLOWED, {
      message: `Unknown Bible book ${describeValue(bookText)} in ${shown}.`,
      hint: bookHint(bookText, lang)
    }));
  }
  let segments;
  if (m[2] === undefined) {
    if (CHAPTER_COUNTS[book] !== 1) {
      throw new ArgError(name, received, REFERENCE_ALLOWED, {
        message: `${shown} has no chapter.`,
        hint: `Add a chapter, e.g. "${BIBLE_BOOKS[book]} 1" or "${BIBLE_BOOKS[book]} 1:1".`
      });
    }
    segments = [wholeChapters(1)];
  } else {
    const fail = () => {
      throw new ArgError(name, received, REFERENCE_ALLOWED);
    };
    const items = parseSpecItems(m[2]);
    if (!items) fail();
    segments = itemsToSegments(items, book, fail);
  }
  const checked = checkSegments(book, segments, { chapter: name, verse: name }, { chapter: received, verse: received });
  return buildRef(book, checked.segments, checked.notes);
}

/**
 * Parse references separated by ";" ("Ps 83:18; John 17:3", "John 3:16; 4:1").
 * Book names may be English or, with `lang` (a JW code), that language's
 * registered names ("Juan 3:16"). `book` gives a leading part without a book
 * its book number. Returns Ref[]; throws ArgError naming `name` for anything
 * unreadable or not in the NWT (with error.unknownBook for an unknown name).
 */
export function parseReferences(text, { name = 'reference', lang, book } = {}) {
  const raw = toStr(text, name, { maxLength: 1000, patternText: REFERENCE_ALLOWED });
  const parts = foldFootnoteParts(normalizeReferenceText(raw)).split(';').map((p) => p.trim().replace(NWT_TAG, '')).filter(Boolean);
  if (!parts.length) throw new ArgError(name, text, REFERENCE_ALLOWED);
  if (parts.length > MAX_REFERENCES) {
    throw new ArgError(name, text, REFERENCE_ALLOWED, {
      message: `Too many references (${parts.length}); the limit is ${MAX_REFERENCES}.`,
      hint: 'Split the list into several calls.'
    });
  }
  const refs = [];
  for (const raw of parts) {
    const footnote = FOOTNOTE_TAG.test(raw);
    const { text: part, notes } = dropPartVerse(footnote ? raw.replace(FOOTNOTE_TAG, '') : raw, REF_PART_VERSE);
    if (!part) throw new ArgError(name, text, REFERENCE_ALLOWED);
    const prevBook = refs.at(-1)?.book ?? book;
    const ownBook = /\p{L}/u.test(part);
    if (!ownBook && !prevBook) throw new ArgError(name, text, REFERENCE_ALLOWED);
    const ref = parseOne(part, name, text, ownBook ? { lang } : { book: prevBook });
    ref.notes.unshift(...notes);
    if (footnote) {
      ref.footnote = true;
      ref.notes.push(`"ftn." (jw.org's "see the footnote") after ${ref.reference} was read as that verse.`);
    }
    refs.push(ref);
  }
  return refs;
}

/**
 * Parse one reference: "John 3:16", "Jn 3:16-18", "Ps 83:18", "1 Cor. 13:4-7",
 * "Psalm 23", "Matthew 5-7", "Jude 25", "Obadiah 1:21", "John 3:16–18",
 * "John 3:1,3,5", "Matt 5:3–6:4". Returns a Ref; throws ArgError.
 *
 * Ref: {book, bookName, chapter, verse (null = whole chapter), verseEnd (end of
 * a single same-chapter range, else null), endChapter, segments: [{chapter,
 * verse, endChapter, endVerse}] (sorted, merged; verse null = whole chapters),
 * verseSpec ('16-18', '1,3,5', '' for a whole chapter, null when it spans
 * chapters), contiguous, reference ('John 3:16-18'), notes: string[]}.
 */
export function parseReference(text, { name = 'reference', lang } = {}) {
  const refs = parseReferences(text, { name, lang });
  if (refs.length > 1) {
    throw new ArgError(name, text, REFERENCE_ALLOWED, {
      message: `Expected one reference, got ${refs.length}: ${refs.map((r) => r.reference).join('; ')}.`,
      hint: 'Send one reference per call.'
    });
  }
  return refs[0];
}

/** parseReference that returns null instead of throwing. */
export function tryParseReference(text, opts) {
  try {
    return parseReference(text, opts);
  } catch {
    return null;
  }
}

// {segments, notes} of the verse parameter.
function verseSegments(value, chapter, name) {
  if (isMissing(value)) return { segments: [wholeChapters(chapter)], notes: [] };
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new ArgError(name, value, VERSE_ALLOWED);
    return { segments: [verseRun(chapter, value)], notes: [] };
  }
  const flat = Array.isArray(value) && value.every((v) => typeof v === 'number' || typeof v === 'string');
  const text = flat ? value.join(',') : value;
  if (typeof text !== 'string') throw new ArgError(name, value, VERSE_ALLOWED);
  if (text.length > MAX_VERSE_LENGTH) {
    throw new ArgError(name, value, VERSE_ALLOWED, {
      message: `"${name}" is ${text.length} characters long; the limit is ${MAX_VERSE_LENGTH}.`,
      hint: 'Send a shorter verse list, or split it over several calls.'
    });
  }
  const clean = normalizeReferenceText(text).trim();
  if (clean.includes(':')) {
    throw new ArgError(name, value, VERSE_ALLOWED, {
      hint: 'Put the chapter in "chapter", or send the whole reference as "reference", e.g. "John 3:16".'
    });
  }
  const part = dropPartVerse(clean, PART_VERSE);
  const items = /^\d[\d\s,-]*$/.test(part.text) ? parseSpecItems(part.text) : null;
  if (!items) throw new ArgError(name, value, VERSE_ALLOWED);
  return { segments: items.map(({ a, c }) => verseRun(chapter, a, c ?? a)), notes: part.notes };
}

/**
 * Ref from separate values. book: 1-66, a numeric string or a name; chapter
 * defaults to 1 for one-chapter books; verse is optional (whole chapter) and
 * may be 16, "16", "14-16", "1,3,5" or [1, 3, 5]. Throws ArgError naming the
 * offending parameter ('book', 'chapter', 'verse' unless renamed by `names`).
 */
export function referenceFromParts(book, chapter, verse, { names = {}, lang } = {}) {
  const n = { book: 'book', chapter: 'chapter', verse: 'verse', ...names };
  const bookNum = toBook(book, n.book, lang);
  let chapterNum = 1;
  if (!isMissing(chapter) || CHAPTER_COUNTS[bookNum] !== 1) {
    const allowed = `a chapter from 1 to ${CHAPTER_COUNTS[bookNum]}`;
    if (isMissing(chapter)) throw new ArgError(n.chapter, undefined, allowed);
    const chapterText = typeof chapter === 'string' ? asciiDigits(chapter) : null;
    chapterNum = chapterText !== null && /^\s*\d+(\.0+)?\s*$/.test(chapterText) ? Number(chapterText) : chapter;
    if (typeof chapterNum !== 'number' || !Number.isInteger(chapterNum) || chapterNum < 1) {
      throw new ArgError(n.chapter, chapter, allowed);
    }
  }
  checkChapter(bookNum, chapterNum, n.chapter, chapter);
  const part = verseSegments(verse, chapterNum, n.verse);
  const checked = checkSegments(bookNum, part.segments, n, { chapter, verse });
  return buildRef(bookNum, checked.segments, [...part.notes, ...checked.notes]);
}

// get_verse_with_study's cross_references[].targets is an array of references; read one as a ";" list.
export function referenceListText(value) {
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === 'string' && v.trim())) return value;
  return value.map((v) => v.trim()).join('; ');
}

// `verse` sent with `reference`: it picks verses of a reference that names a
// whole chapter ("Psalm 83" + "18"); otherwise it must name the same verses.
function applyVerse(refs, reference, verse) {
  const [first] = refs;
  const [seg] = first.segments;
  const wholeChapter = refs.length === 1 && first.segments.length === 1 && seg.verse === null && seg.endChapter === seg.chapter;
  if (wholeChapter) return referenceFromParts(first.book, first.chapter, verse);
  let same = false;
  try {
    same = refs.length === 1 && referenceFromParts(first.book, first.chapter, verse).reference === first.reference;
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
  }
  if (same) return first;
  const given = typeof verse === 'object' ? describeValue(verse) : describeValue(String(verse)).replace(/^"|"$/g, '');
  throw new ArgError('reference', reference, REFERENCE_ALLOWED, {
    message: `"reference" (${refs.map((r) => r.reference).join('; ')}) disagrees with verse (${given}).`,
    hint: 'Send the verses in "reference" ("Psalm 83:18"), or a whole chapter in "reference" ("Psalm 83") with "verse".'
  });
}

/**
 * Refs from tool arguments: `reference` ("John 3:16"; several separated by
 * ";"), or book + chapter (+ verse). A book sent as a whole reference
 * ("John 3:16") also works. When both forms are sent, book and chapter must
 * agree with the first reference; `verse` with a whole-chapter reference
 * ("Psalm 83") selects its verses, and must otherwise name the reference's
 * verses. `lang` (a JW code) also accepts that language's registered book
 * names; `book` is the book of a reference that names none ("4:1"), see
 * parseReferences.
 */
export function referencesFromArgs(args, { lang, book } = {}) {
  const r = requireArgs(args);
  const a = Array.isArray(r.reference) ? { ...r, reference: referenceListText(r.reference) } : r;
  const parts = ['book', 'chapter', 'verse'].filter((k) => !isMissing(a[k]));
  if (!isMissing(a.reference)) {
    const refs = parseReferences(a.reference, { name: 'reference', lang, book });
    const first = refs[0];
    if (typeof a.book === 'string' && a.book.length > 1000) throw new ArgError('book', a.book, BOOK_ALLOWED);
    const bookDiffers = parts.includes('book') && getBookNumber(typeof a.book === 'string' ? a.book.trim() : a.book, lang) !== first.book;
    const chapterDiffers = parts.includes('chapter') && (typeof a.chapter === 'object' || Number(a.chapter) !== first.chapter);
    if (bookDiffers || chapterDiffers) {
      // describeValue caps each echoed value at 60 characters; strings keep no quotes ("Romans 3").
      const given = [a.book, a.chapter].filter((v) => !isMissing(v))
        .map((v) => (typeof v === 'object' ? describeValue(v) : describeValue(String(v)).replace(/^"|"$/g, '')))
        .join(' ');
      throw new ArgError('reference', a.reference, REFERENCE_ALLOWED, {
        message: `"reference" (${first.reference}) disagrees with book/chapter (${given}).`,
        hint: 'Send either reference, or book and chapter (and verse).'
      });
    }
    if (parts.includes('verse')) return [applyVerse(refs, a.reference, a.verse)];
    return refs;
  }
  if (parts.length === 1 && looksLikeReference(a.book)) {
    if (a.book.length > 1000) throw new ArgError('book', a.book, BOOK_ALLOWED);
    return parseReferences(a.book, { name: 'book', lang });
  }
  if (!parts.length) {
    throw new ArgError('reference', undefined, REFERENCE_ALLOWED, {
      message: 'Missing reference: send "reference" (e.g. "John 3:16") or "book" and "chapter".'
    });
  }
  return [referenceFromParts(a.book, a.chapter, a.verse, { lang })];
}

/** One Ref from tool arguments; a ";" list is rejected. */
export function referenceFromArgs(args, opts) {
  const refs = referencesFromArgs(args, opts);
  if (refs.length > 1) {
    throw new ArgError('reference', args.reference, REFERENCE_ALLOWED, {
      message: `Expected one reference, got ${refs.length}: ${refs.map((r) => r.reference).join('; ')}.`,
      hint: 'Send one reference per call.'
    });
  }
  return refs[0];
}

/**
 * 1.3's {valid, error} check, kept for old deep imports: the Ref plus
 * `valid: true, error: null`, or `{valid: false, error}` with a readable
 * message ("John has 21 chapters, so there is no chapter 22."). New code
 * calls referenceFromParts, which throws ArgError.
 */
export function validateReference(book, chapter, verse) {
  try {
    return { ...referenceFromParts(book, chapter, verse), valid: true, error: null };
  } catch (error) {
    if (error instanceof ArgError) return { valid: false, error: error.message };
    throw error;
  }
}

/**
 * JW-style citation: formatReference(ref, lang?) for a Ref, or
 * formatReference(book, chapter, verseSpec, lang?) with verseSpec 16, "16-18",
 * "1,3,5" or empty for the whole chapter. A single psalm is "Psalm 23:1",
 * two verses are "21:3, 4", verse 0 in Psalms is "superscription". `lang`
 * picks names registered with registerBookNames; default English. Does not
 * validate; returns '' for an unknown book.
 */
export function formatReference(book, chapter, verse, lang) {
  if (book && typeof book === 'object' && Array.isArray(book.segments)) {
    return formatSegments(book.book, book.segments, chapter);
  }
  if (!BIBLE_BOOKS[book]) return '';
  if (isMissing(verse)) return formatSegments(book, [wholeChapters(chapter)], lang);
  const items = typeof verse === 'number' ? [{ a: verse }] : parseSpecItems(normalizeReferenceText(String(verse)));
  if (!items || items.some((i) => i.b !== undefined || i.d !== undefined)) {
    return `${bookLabel(book, [wholeChapters(chapter)], lang)} ${chapter}:${verse}`;
  }
  return formatSegments(book, mergeSegments(items.map(({ a, c }) => verseRun(chapter, a, c ?? a))), lang);
}

/** Every {chapter, verse} a Ref covers, in order, whole chapters expanded. */
export function listVerses(ref) {
  const out = [];
  for (const s of ref.segments) {
    for (let ch = s.chapter; ch <= s.endChapter; ch++) {
      const from = s.verse !== null && ch === s.chapter ? s.verse : getFirstVerse(ref.book, ch);
      const to = s.verse !== null && ch === s.endChapter ? s.endVerse : getVerseCount(ref.book, ch);
      for (let v = from; v <= to; v++) out.push({ chapter: ch, verse: v });
    }
  }
  return out;
}

/**
 * The BBCCCVVV id jw.org uses for a verse: bibleVerseId(19, 83, 18) ->
 * '19083018'. Verse 0 (the default) means the whole chapter in finder links.
 */
export function bibleVerseId(book, chapter, verse = 0) {
  return `${book}${String(chapter).padStart(3, '0')}${String(verse).padStart(3, '0')}`;
}

/** jw.org finder link for a bible id or id range ('43003016-43003018'). */
export function finderUrl(bible, lang = 'E') {
  const code = typeof lang === 'string' ? lang : lang?.code ?? 'E';
  return `https://www.jw.org/finder?wtlocale=${encodeURIComponent(code)}&prefer=lang&bible=${bible}&pub=nwtsty`;
}

/**
 * jw.org links for a Ref as [{reference, url, markdown}]: one per passage
 * and per chapter, because a finder link opens one chapter and cannot
 * combine separate passages. A whole chapter links as BBCCC000; verse 0 (a
 * psalm's superscription) opens the whole psalm.
 */
export function verseLinks(ref, { lang = 'E' } = {}) {
  const links = [];
  for (const s of ref.segments) {
    for (let ch = s.chapter; ch <= s.endChapter; ch++) {
      let piece;
      let bible;
      if (s.verse === null) {
        piece = wholeChapters(ch);
        bible = bibleVerseId(ref.book, ch, 0);
      } else {
        const from = ch === s.chapter ? s.verse : getFirstVerse(ref.book, ch);
        const to = ch === s.endChapter ? s.endVerse : getVerseCount(ref.book, ch);
        const start = from === 0 && to > 0 ? 1 : from;
        piece = verseRun(ch, from, to);
        bible = start === to ? bibleVerseId(ref.book, ch, start) : `${bibleVerseId(ref.book, ch, start)}-${bibleVerseId(ref.book, ch, to)}`;
      }
      const reference = formatSegments(ref.book, [piece]);
      const url = finderUrl(bible, lang);
      links.push({ reference, url, markdown: `[${reference}](${url})` });
    }
  }
  return links;
}
