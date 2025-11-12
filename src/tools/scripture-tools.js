/**
 * Scripture Tools for JW-MCP
 * Provides Bible verse lookup and study content from wol.jw.org
 */

import { scraper } from './wol-scraper.js';
import {
  searchBooks,
  getBookName,
  getBookNumber,
  formatReference,
  validateReference,
  BIBLE_BOOKS
} from './bible-books.js';

// ============================================================================
// Tool 1: search_bible_books
// ============================================================================

export const searchBibleBooksTool = {
  name: 'search_bible_books',
  description: 'Search for Bible books by name or abbreviation. Returns book numbers (1-66) and names. Useful for finding the correct book number for other scripture tools. Examples: "matt" -> Matthew (40), "1 john" -> 1 John (62), "gen" -> Genesis (1).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query - can be book name, abbreviation, or number. Examples: "matthew", "matt", "mt", "40", "1 john"'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
        default: 10
      }
    },
    required: ['query']
  }
};

export async function searchBibleBooksImplementation(query, limit = 10) {
  try {
    if (!query || typeof query !== 'string') {
      return {
        content: [{
          type: 'text',
          text: 'Error: Query must be a non-empty string'
        }],
        isError: true
      };
    }

    const results = searchBooks(query, limit);

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No Bible books found matching "${query}". Try using a book name, abbreviation, or number (1-66).`
        }]
      };
    }

    // Format results
    const formattedResults = results.map(r => ({
      number: r.number,
      name: r.name,
      testament: r.number <= 39 ? 'Old Testament' : 'New Testament',
      relevance_score: r.score
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: query,
          results_count: formattedResults.length,
          books: formattedResults
        }, null, 2)
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error searching Bible books: ${error.message}`
      }],
      isError: true
    };
  }
}

// ============================================================================
// Tool 2: get_bible_verse
// ============================================================================

export const getBibleVerseTool = {
  name: 'get_bible_verse',
  description: 'Get plain Bible verse text from wol.jw.org. Returns just the verse text without study notes or additional content. For comprehensive study content including notes and cross-references, use get_verse_with_study instead.',
  inputSchema: {
    type: 'object',
    properties: {
      book: {
        type: 'number',
        description: 'Bible book number (1-66). Examples: Genesis=1, Matthew=40, John=43, Revelation=66. Use search_bible_books to find book numbers.'
      },
      chapter: {
        type: 'number',
        description: 'Chapter number within the book'
      },
      verse: {
        type: 'number',
        description: 'Verse number within the chapter'
      }
    },
    required: ['book', 'chapter', 'verse']
  }
};

export async function getBibleVerseImplementation(book, chapter, verse) {
  try {
    // Validate inputs
    const validation = validateReference(book, chapter, verse);
    if (!validation.valid) {
      return {
        content: [{
          type: 'text',
          text: `Validation error: ${validation.error}`
        }],
        isError: true
      };
    }

    // Fetch verse
    const verseData = await scraper.getSingleVerse(book, chapter, verse);

    // Format reference
    const reference = formatReference(book, chapter, verse);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          reference: reference,
          book_number: verseData.book_num,
          book_name: verseData.book_name,
          chapter: verseData.chapter,
          verse: verseData.verse_num,
          text: verseData.verse_text
        }, null, 2)
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error fetching verse: ${error.message}`
      }],
      isError: true
    };
  }
}

// ============================================================================
// Tool 3: get_verse_with_study
// ============================================================================

export const getVerseWithStudyTool = {
  name: 'get_verse_with_study',
  description: 'Get Bible verse(s) with comprehensive study content from wol.jw.org. Supports single verses or ranges (e.g., "14-16"). Returns verse text, study notes, cross-references, research articles from the Research Guide, and chapter outlines. Field selection allows you to customize what content is returned.',
  inputSchema: {
    type: 'object',
    properties: {
      book: {
        type: 'number',
        description: 'Bible book number (1-66). Use search_bible_books to find book numbers.'
      },
      chapter: {
        type: 'number',
        description: 'Chapter number within the book'
      },
      verse: {
        type: 'string',
        description: 'Single verse number (e.g., "14") or verse range (e.g., "14-16")'
      },
      fields: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['verses', 'study_notes', 'study_articles', 'cross_references', 'chapter_level', 'combined_text']
        },
        description: 'Content fields to include. Options: "verses" (verse text), "study_notes" (verse-specific notes), "study_articles" (research guide articles), "cross_references" (related scriptures), "chapter_level" (outline and chapter content), "combined_text" (all verses as single text). Default: ["verses", "study_notes"]',
        default: ['verses', 'study_notes']
      },
      limit: {
        type: 'number',
        description: 'Maximum number of study articles to return. Default: 5 for articles, unlimited for other fields.',
        default: 5
      },
      fetch: {
        type: 'boolean',
        description: 'Force fresh data from wol.jw.org (useful when content appears to be missing). Default: false',
        default: false
      }
    },
    required: ['book', 'chapter', 'verse']
  }
};

export async function getVerseWithStudyImplementation(book, chapter, verse, fields = ['verses', 'study_notes'], limit = 5, fetch = false) {
  try {
    // Validate inputs
    const validation = validateReference(book, chapter, verse);
    if (!validation.valid) {
      return {
        content: [{
          type: 'text',
          text: `Validation error: ${validation.error}`
        }],
        isError: true
      };
    }

    // Validate fields
    const validFields = ['verses', 'study_notes', 'study_articles', 'cross_references', 'chapter_level', 'combined_text'];
    const invalidFields = fields.filter(f => !validFields.includes(f));
    if (invalidFields.length > 0) {
      return {
        content: [{
          type: 'text',
          text: `Invalid fields: ${invalidFields.join(', ')}. Valid fields are: ${validFields.join(', ')}`
        }],
        isError: true
      };
    }

    // Fetch verse with study content
    const studyData = await scraper.getVerseWithStudy(book, chapter, verse, {
      fields: fields,
      limit: limit
    });

    // Format reference
    const reference = formatReference(book, chapter, studyData.verse_range);

    // Build response
    const response = {
      reference: reference,
      book_number: studyData.book_num,
      book_name: studyData.book_name,
      chapter: studyData.chapter,
      verse_range: studyData.verse_range
    };

    // Add requested fields
    if (studyData.verses) {
      response.verses = studyData.verses;
    }

    if (studyData.combined_text) {
      response.combined_text = studyData.combined_text;
    }

    if (studyData.study_notes) {
      response.study_notes = studyData.study_notes;
      response.study_notes_count = Object.keys(studyData.study_notes).length;
    }

    if (studyData.study_articles) {
      response.study_articles = studyData.study_articles;
      response.study_articles_count = studyData.study_articles.length;
    }

    if (studyData.cross_references) {
      response.cross_references = studyData.cross_references;
      response.cross_references_count = studyData.cross_references.length;
    }

    if (studyData.chapter_level) {
      response.chapter_level = studyData.chapter_level;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error fetching verse with study content: ${error.message}`
      }],
      isError: true
    };
  }
}

// ============================================================================
// Tool Handler
// ============================================================================

export async function handleScriptureTools(request) {
  const toolName = request.params.name;
  const args = request.params.arguments;

  switch (toolName) {
    case 'search_bible_books':
      return await searchBibleBooksImplementation(
        args.query,
        args.limit
      );

    case 'get_bible_verse':
      return await getBibleVerseImplementation(
        args.book,
        args.chapter,
        args.verse
      );

    case 'get_verse_with_study':
      return await getVerseWithStudyImplementation(
        args.book,
        args.chapter,
        args.verse,
        args.fields,
        args.limit,
        args.fetch
      );

    default:
      return null;
  }
}
