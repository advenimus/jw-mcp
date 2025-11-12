/**
 * Bible Books Reference System
 * Complete mapping of all 66 Bible books with search functionality
 */

/**
 * Complete Bible book mappings (1-66)
 */
export const BIBLE_BOOKS = {
  // Old Testament (1-39)
  1: 'Genesis', 2: 'Exodus', 3: 'Leviticus', 4: 'Numbers', 5: 'Deuteronomy',
  6: 'Joshua', 7: 'Judges', 8: 'Ruth', 9: '1 Samuel', 10: '2 Samuel',
  11: '1 Kings', 12: '2 Kings', 13: '1 Chronicles', 14: '2 Chronicles',
  15: 'Ezra', 16: 'Nehemiah', 17: 'Esther', 18: 'Job', 19: 'Psalms',
  20: 'Proverbs', 21: 'Ecclesiastes', 22: 'Song of Solomon', 23: 'Isaiah',
  24: 'Jeremiah', 25: 'Lamentations', 26: 'Ezekiel', 27: 'Daniel',
  28: 'Hosea', 29: 'Joel', 30: 'Amos', 31: 'Obadiah', 32: 'Jonah',
  33: 'Micah', 34: 'Nahum', 35: 'Habakkuk', 36: 'Zephaniah', 37: 'Haggai',
  38: 'Zechariah', 39: 'Malachi',

  // New Testament (40-66)
  40: 'Matthew', 41: 'Mark', 42: 'Luke', 43: 'John', 44: 'Acts',
  45: 'Romans', 46: '1 Corinthians', 47: '2 Corinthians', 48: 'Galatians',
  49: 'Ephesians', 50: 'Philippians', 51: 'Colossians', 52: '1 Thessalonians',
  53: '2 Thessalonians', 54: '1 Timothy', 55: '2 Timothy', 56: 'Titus',
  57: 'Philemon', 58: 'Hebrews', 59: 'James', 60: '1 Peter', 61: '2 Peter',
  62: '1 John', 63: '2 John', 64: '3 John', 65: 'Jude', 66: 'Revelation'
};

/**
 * Common abbreviations for Bible books
 */
export const BOOK_ABBREVIATIONS = {
  'gen': 1, 'ge': 1, 'gn': 1,
  'exo': 2, 'ex': 2,
  'lev': 3, 'le': 3, 'lv': 3,
  'num': 4, 'nu': 4, 'nm': 4, 'nb': 4,
  'deu': 5, 'de': 5, 'dt': 5,
  'jos': 6, 'josh': 6,
  'jdg': 7, 'judg': 7, 'jg': 7,
  'rut': 8, 'ru': 8,
  '1sa': 9, '1 sa': 9, '1sam': 9, '1 sam': 9,
  '2sa': 10, '2 sa': 10, '2sam': 10, '2 sam': 10,
  '1ki': 11, '1 ki': 11, '1kgs': 11, '1 kgs': 11,
  '2ki': 12, '2 ki': 12, '2kgs': 12, '2 kgs': 12,
  '1ch': 13, '1 ch': 13, '1chr': 13, '1 chr': 13,
  '2ch': 14, '2 ch': 14, '2chr': 14, '2 chr': 14,
  'ezr': 15, 'ez': 15,
  'neh': 16, 'ne': 16,
  'est': 17, 'es': 17,
  'job': 18,
  'psa': 19, 'ps': 19, 'psalm': 19, 'psalms': 19,
  'pro': 20, 'pr': 20, 'prv': 20, 'prov': 20,
  'ecc': 21, 'ec': 21, 'eccl': 21, 'qoh': 21,
  'sng': 22, 'ss': 22, 'song': 22, 'sos': 22, 'sol': 22,
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

  // New Testament
  'mat': 40, 'mt': 40, 'matt': 40, 'matthew': 40,
  'mrk': 41, 'mk': 41, 'mar': 41, 'mark': 41,
  'luk': 42, 'lk': 42, 'luke': 42,
  'joh': 43, 'jn': 43, 'john': 43,
  'act': 44, 'ac': 44, 'acts': 44,
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
  'rev': 66, 're': 66, 'rv': 66, 'revelation': 66, 'revelations': 66
};

/**
 * Get the name of a Bible book by its number
 * @param {number} bookNum - Book number (1-66)
 * @returns {string|null} Book name or null if invalid
 */
export function getBookName(bookNum) {
  return BIBLE_BOOKS[bookNum] || null;
}

/**
 * Get the number of a Bible book by its name or abbreviation
 * @param {string} bookName - Book name or abbreviation (case-insensitive)
 * @returns {number|null} Book number (1-66) or null if not found
 */
export function getBookNumber(bookName) {
  if (!bookName) return null;

  const normalized = bookName.toLowerCase().trim();

  // Check if it's a number
  const asNumber = parseInt(normalized);
  if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= 66) {
    return asNumber;
  }

  // Check abbreviations first
  if (BOOK_ABBREVIATIONS[normalized]) {
    return BOOK_ABBREVIATIONS[normalized];
  }

  // Check full names (case-insensitive)
  for (const [num, name] of Object.entries(BIBLE_BOOKS)) {
    if (name.toLowerCase() === normalized) {
      return parseInt(num);
    }
  }

  return null;
}

/**
 * Search for Bible books by partial name
 * @param {string} query - Search query
 * @param {number} limit - Maximum results to return (default: 10)
 * @returns {Array} Array of matching books with {number, name, score}
 */
export function searchBooks(query, limit = 10) {
  if (!query || typeof query !== 'string') {
    return [];
  }

  const normalizedQuery = query.toLowerCase().trim();

  // If query is a number, return exact match
  const asNumber = parseInt(normalizedQuery);
  if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= 66) {
    return [{
      number: asNumber,
      name: BIBLE_BOOKS[asNumber],
      score: 100
    }];
  }

  const results = [];

  // Search through all books
  for (const [num, name] of Object.entries(BIBLE_BOOKS)) {
    const bookNum = parseInt(num);
    const nameLower = name.toLowerCase();

    let score = 0;

    // Exact match
    if (nameLower === normalizedQuery) {
      score = 100;
    }
    // Starts with query
    else if (nameLower.startsWith(normalizedQuery)) {
      score = 80;
    }
    // Contains query
    else if (nameLower.includes(normalizedQuery)) {
      score = 60;
    }
    // Check if any word starts with query
    else if (nameLower.split(' ').some(word => word.startsWith(normalizedQuery))) {
      score = 70;
    }

    // Also check abbreviations
    for (const [abbr, abbNum] of Object.entries(BOOK_ABBREVIATIONS)) {
      if (abbNum === bookNum && abbr.startsWith(normalizedQuery)) {
        score = Math.max(score, 75);
      }
    }

    if (score > 0) {
      results.push({
        number: bookNum,
        name: name,
        score: score
      });
    }
  }

  // Sort by score (highest first), then by book number
  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.number - b.number;
  });

  return results.slice(0, limit);
}

/**
 * Parse a complete Bible reference string
 * @param {string} reference - Reference like "Matthew 24:14" or "John 3:16-17"
 * @returns {Object|null} Parsed reference {book, chapter, verse, verseEnd} or null
 */
export function parseReference(reference) {
  if (!reference || typeof reference !== 'string') {
    return null;
  }

  // Common patterns:
  // "Matthew 24:14"
  // "John 3:16-17"
  // "1 John 2:3"
  // "Psalm 23:1"

  const pattern = /^([123]?\s*[a-z]+)\s+(\d+):(\d+)(?:-(\d+))?$/i;
  const match = reference.trim().match(pattern);

  if (!match) {
    return null;
  }

  const bookName = match[1].trim();
  const chapter = parseInt(match[2]);
  const verse = parseInt(match[3]);
  const verseEnd = match[4] ? parseInt(match[4]) : null;

  const bookNumber = getBookNumber(bookName);
  if (!bookNumber) {
    return null;
  }

  return {
    book: bookNumber,
    bookName: getBookName(bookNumber),
    chapter: chapter,
    verse: verse,
    verseEnd: verseEnd
  };
}

/**
 * Format a book reference as a string
 * @param {number} book - Book number
 * @param {number} chapter - Chapter number
 * @param {number|string} verse - Verse number or range
 * @returns {string} Formatted reference like "Matthew 24:14"
 */
export function formatReference(book, chapter, verse) {
  const bookName = getBookName(book);
  if (!bookName) {
    return '';
  }

  return `${bookName} ${chapter}:${verse}`;
}

/**
 * Validate book, chapter, verse inputs
 * @param {number} book - Book number
 * @param {number} chapter - Chapter number
 * @param {number|string} verse - Verse number or range
 * @returns {Object} {valid: boolean, error: string|null}
 */
export function validateReference(book, chapter, verse) {
  if (typeof book !== 'number' || book < 1 || book > 66) {
    return {
      valid: false,
      error: `Invalid book number: ${book}. Must be between 1 and 66.`
    };
  }

  if (typeof chapter !== 'number' || chapter < 1) {
    return {
      valid: false,
      error: `Invalid chapter number: ${chapter}. Must be a positive number.`
    };
  }

  // Verse can be a number or a string like "14-16"
  if (typeof verse === 'string') {
    // Check if it's a range
    const rangeMatch = verse.match(/^(\d+)-(\d+)$/);
    if (!rangeMatch) {
      // Try parsing as single number
      const verseNum = parseInt(verse);
      if (isNaN(verseNum) || verseNum < 1) {
        return {
          valid: false,
          error: `Invalid verse: ${verse}. Must be a number or range like "14-16".`
        };
      }
    } else {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      if (start < 1 || end < 1 || start > end) {
        return {
          valid: false,
          error: `Invalid verse range: ${verse}. Start must be less than or equal to end.`
        };
      }
    }
  } else if (typeof verse === 'number') {
    if (verse < 1) {
      return {
        valid: false,
        error: `Invalid verse number: ${verse}. Must be a positive number.`
      };
    }
  } else {
    return {
      valid: false,
      error: `Invalid verse type: ${typeof verse}. Must be a number or string.`
    };
  }

  return { valid: true, error: null };
}
