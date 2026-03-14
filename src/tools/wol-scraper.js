/**
 * WOL (Watchtower Online Library) Web Scraper
 * Fetches and parses Bible study content from wol.jw.org
 * Ported from Python scraper in wol-api
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { getBookName } from './bible-books.js';

/**
 * WOL Scraper class for extracting Bible study content
 */
export class WOLScraper {
  constructor() {
    // User-Agent to avoid blocking
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };
  }

  /**
   * Extract all content for a chapter
   * @param {number} bookNum - Bible book number (1-66)
   * @param {number} chapterNum - Chapter number
   * @returns {Promise<Object>} Chapter content with verses, notes, and study data
   */
  async extractChapterContent(bookNum, chapterNum) {
    const url = `https://wol.jw.org/en/wol/b/r1/lp-e/nwtsty/${bookNum}/${chapterNum}#study=discover`;

    try {
      console.log(`[scraper] Fetching ${url}`);
      const fetchStart = Date.now();
      const response = await fetch(url, {
        headers: this.headers,
        timeout: 30000
      });

      const fetchDuration = Date.now() - fetchStart;
      console.log(`[scraper] Fetch response: ${response.status} ${response.statusText} in ${fetchDuration}ms`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      console.log(`[scraper] HTML size: ${html.length} chars`);
      const $ = cheerio.load(html);

      // Extract chapter-level study data
      const studyDiscover = $('#studyDiscover');
      let chapterStudyData = null;

      if (studyDiscover.length > 0) {
        chapterStudyData = {
          book_num: bookNum,
          chapter_num: chapterNum,
          outline: this.extractOutline($, studyDiscover),
          study_articles: this.extractResearchGuideArticles($, studyDiscover),
          cross_references: this.extractCrossReferences($, studyDiscover)
        };
      }

      // Extract verse-specific study notes
      const verseStudyNotes = this.extractVerseStudyNotes($, bookNum, chapterNum);

      // Extract verse-specific research guide articles
      const verseStudyArticles = this.extractVerseResearchGuideArticles($, bookNum, chapterNum);

      // Extract all verses from the chapter
      const verses = this.extractVerses($, bookNum, chapterNum);

      const totalDuration = Date.now() - fetchStart;
      console.log(`[scraper] Parsed ${bookNum}:${chapterNum} — ${verses.length} verses, ${Object.keys(verseStudyNotes).length} study notes, ${Object.keys(verseStudyArticles).length} verse articles in ${totalDuration}ms`);

      return {
        chapter_study_data: chapterStudyData,
        verse_study_notes: verseStudyNotes,
        verse_study_articles: verseStudyArticles,
        verses: verses
      };

    } catch (error) {
      console.error(`[scraper] Failed ${bookNum}:${chapterNum} — ${error.message}`);
      throw new Error(`Failed to extract content for ${bookNum}:${chapterNum} - ${error.message}`);
    }
  }

  /**
   * Extract all verses from the chapter
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {number} bookNum - Book number
   * @param {number} chapterNum - Chapter number
   * @returns {Array} Array of verse objects
   */
  extractVerses($, bookNum, chapterNum) {
    const verses = [];

    // Find all verse elements
    $('span.v').each((i, elem) => {
      try {
        const verseId = $(elem).attr('id');
        if (!verseId) return;

        // Parse verse ID (format: v{book}-{chapter}-{verse})
        const parts = verseId.replace('v', '').split('-');
        if (parts.length >= 3) {
          const vBook = parseInt(parts[0]);
          const vChapter = parseInt(parts[1]);
          const vVerse = parseInt(parts[2]);

          if (vBook === bookNum && vChapter === chapterNum) {
            // Get verse text
            const verseText = $(elem).text().trim();

            // Get book name
            const bookName = this.extractBookName($, bookNum);

            verses.push({
              book_num: bookNum,
              book_name: bookName,
              chapter: chapterNum,
              verse_num: vVerse,
              verse_text: verseText
            });
          }
        }
      } catch (error) {
        console.error(`Error parsing verse: ${error.message}`);
      }
    });

    return verses;
  }

  /**
   * Extract book name from the page
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {number} bookNum - Book number (fallback)
   * @returns {string} Book name
   */
  extractBookName($, bookNum) {
    // Try to extract from page title
    const title = $('title').text();
    if (title) {
      // Extract book name from title (usually first part before chapter)
      if (title.includes('—')) {
        return title.split('—')[0].trim();
      } else if (title.includes(' ')) {
        // Fallback: take first word as book name
        return title.split(' ')[0];
      }
    }

    // Fallback: use our bible-books mapping
    return getBookName(bookNum) || 'Unknown';
  }

  /**
   * Extract study notes for individual verses
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {number} bookNum - Book number
   * @param {number} chapterNum - Chapter number
   * @returns {Object} Map of verse numbers to study notes
   */
  extractVerseStudyNotes($, bookNum, chapterNum) {
    const verseNotes = {};

    // Find all sections with verse-specific study notes
    $('div.section').each((i, section) => {
      const dataKey = $(section).attr('data-key');
      if (!dataKey) return;

      try {
        // Parse data-key to extract verse number (format: book-chapter-verse)
        const parts = dataKey.split('-');
        if (parts.length >= 3) {
          const sectionBook = parseInt(parts[0]);
          const sectionChapter = parseInt(parts[1]);
          const sectionVerse = parseInt(parts[2]);

          // Only process if it matches our target book/chapter
          if (sectionBook === bookNum && sectionChapter === chapterNum) {
            // Look for study note groups
            const studyNoteGroups = $(section).find('div.studyNoteGroup');

            if (studyNoteGroups.length > 0) {
              const studyNotes = [];

              studyNoteGroups.each((j, group) => {
                // Find individual study notes
                $(group).find('li.item.studyNote').each((k, note) => {
                  // Extract paragraphs within the study note
                  const noteContent = [];

                  $(note).find('p').each((l, p) => {
                    const pText = $(p).text().trim();
                    if (pText) {
                      noteContent.push(pText);
                    }
                  });

                  if (noteContent.length > 0) {
                    studyNotes.push(noteContent.join(' '));
                  }
                });
              });

              if (studyNotes.length > 0) {
                verseNotes[sectionVerse] = studyNotes;
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error processing section: ${error.message}`);
      }
    });

    return verseNotes;
  }

  /**
   * Extract research guide articles per-verse from div.section[data-key] elements.
   * Each verse section (e.g., data-key="45-7-23" for Romans 7:23) has its own
   * Research Guide entries. This method maps them by verse number so articles
   * can be filtered to the requested verse range.
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {number} bookNum - Book number
   * @param {number} chapterNum - Chapter number
   * @returns {Object} Map of verse numbers to article arrays: { verseNum: [articles] }
   */
  extractVerseResearchGuideArticles($, bookNum, chapterNum) {
    const verseArticles = {};

    $('div.section[data-key]').each((i, section) => {
      const dataKey = $(section).attr('data-key');
      if (!dataKey) return;

      // Parse data-key (format: book-chapter-verse)
      const parts = dataKey.split('-');
      if (parts.length < 3) return;

      const sectionBook = parseInt(parts[0]);
      const sectionChapter = parseInt(parts[1]);
      const sectionVerse = parseInt(parts[2]);

      if (sectionBook !== bookNum || sectionChapter !== chapterNum) return;
      if (isNaN(sectionVerse)) return;

      // Find ref-rsg items within this verse section
      const rsgItems = $(section).find('li.item.ref-rsg');
      if (rsgItems.length === 0) return;

      const articles = [];

      rsgItems.each((itemIndex, item) => {
        this.extractArticlesFromRsgElement($, item, articles);
      });

      if (articles.length > 0) {
        verseArticles[sectionVerse] = articles;
      }
    });

    return verseArticles;
  }

  /**
   * Extract articles from a single li.item.ref-rsg element.
   * Handles su (subject heading) and sk (sub-item) paragraph structures.
   * Properly combines multi-part titles (e.g., "The Watchtower," + "6/15/2008, p. 30").
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {Element} item - The li.item.ref-rsg element
   * @param {Array} articles - Array to push extracted articles into
   */
  extractArticlesFromRsgElement($, item, articles) {
    const classify = (url, title) => {
      const u = url.toLowerCase();
      const t = title.toLowerCase();
      if (u.includes('watchtower') || t.includes('watchtower')) return 'watchtower';
      if (u.includes('awake') || t.includes('awake')) return 'awake';
      if (u.includes('/pc/') || u.includes('/d/')) return 'research';
      return 'other';
    };

    const paragraphs = $(item).find('p').toArray();
    let i = 0;

    while (i < paragraphs.length) {
      const p = paragraphs[i];
      const classes = ($(p).attr('class') || '').toLowerCase();

      if (classes.includes('su')) {
        const suAnchors = $(p).find('a[href]').toArray();

        if (suAnchors.length > 0) {
          let added = false;
          let j = i + 1;

          // Look for following "sk" paragraphs (sub-items like date/page for Watchtower)
          while (j < paragraphs.length) {
            const pNext = paragraphs[j];
            const nextClasses = ($(pNext).attr('class') || '').toLowerCase();
            if (!nextClasses.includes('sk')) break;

            // For SU+SK pairs (e.g., "The Watchtower," + "6/15/2008, p. 30"):
            // Combine the SU label with the SK text to form the full title.
            // Both typically share the same href.
            const suLabel = suAnchors
              .map(a => $(a).text().trim())
              .filter(text => text)
              .join(' ');

            const skAnchors = $(pNext).find('a[href]').toArray();
            for (const a of skAnchors) {
              const href = $(a).attr('href') || '';
              const text = $(a).text().trim();
              if (!href || !text) continue;

              const fullUrl = href.startsWith('/')
                ? `https://wol.jw.org${href}`
                : href;

              const title = `${suLabel} ${text}`.trim();
              articles.push({ title, url: fullUrl, type: classify(fullUrl, title) });
              added = true;
            }

            j++;
          }

          if (added) {
            i = j - 1;
          }

          // If no SK items: process SU anchors directly.
          // For multi-anchor SU entries (e.g., "Insight, Vol 2, pp. 224," + " 966-967"),
          // each anchor references different pages in the same publication.
          if (!added) {
            if (suAnchors.length === 1) {
              // Single anchor: use its text directly
              const a = suAnchors[0];
              const href = $(a).attr('href') || '';
              const text = $(a).text().trim().replace(/,\s*$/, '');
              if (href && text) {
                const fullUrl = href.startsWith('/') ? `https://wol.jw.org${href}` : href;
                articles.push({ title: text, url: fullUrl, type: classify(fullUrl, text) });
              }
            } else {
              // Multi-anchor: extract publication prefix from first anchor,
              // prepend to subsequent page-only anchors for complete titles
              const firstText = $(suAnchors[0]).text().trim();
              // Extract pub prefix (e.g., "Insight, Volume 2, " from "Insight, Volume 2, pp. 224,")
              const prefixMatch = firstText.match(/^(.+?(?:Volume\s+\d+),?\s*)/i);
              const pubPrefix = prefixMatch ? prefixMatch[1].replace(/,\s*$/, '') : '';

              for (const a of suAnchors) {
                const href = $(a).attr('href') || '';
                let text = $(a).text().trim().replace(/,\s*$/, '');
                if (!href || !text) continue;

                // If this anchor's text starts with a page number (continuation),
                // prepend the publication prefix
                if (a !== suAnchors[0] && pubPrefix && /^[\s\d]/.test($(a).text())) {
                  text = `${pubPrefix}, pp. ${text.trim()}`;
                }

                const fullUrl = href.startsWith('/') ? `https://wol.jw.org${href}` : href;
                articles.push({ title: text, url: fullUrl, type: classify(fullUrl, text) });
              }
            }
          }
        }
      }

      i++;
    }
  }

  /**
   * Extract chapter outline from study discover section
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {Cheerio} studyDiscover - Study discover element
   * @returns {Array} Array of outline items
   */
  extractOutline($, studyDiscover) {
    const outline = [];

    // Look for outline structure
    studyDiscover.find('div.outline').each((i, section) => {
      $(section).find('li').each((j, item) => {
        const text = $(item).text().trim();
        if (text) {
          outline.push(text);
        }
      });
    });

    return outline;
  }

  /**
   * Extract research guide articles from li.item.ref-rsg
   * Consolidate multi-line entries by grouping <a> tags with the same href into a single title
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {Cheerio} studyDiscover - Study discover element
   * @returns {Array} Array of article objects
   */
  extractResearchGuideArticles($, studyDiscover) {
    const articles = [];

    /**
     * Classify article type based on URL and title
     */
    const classify = (url, title) => {
      const u = url.toLowerCase();
      const t = title.toLowerCase();

      if (u.includes('watchtower') || t.includes('watchtower')) {
        return 'watchtower';
      }
      if (u.includes('awake') || t.includes('awake')) {
        return 'awake';
      }
      if (u.includes('/pc/') || u.includes('/d/')) {
        return 'research';
      }
      return 'other';
    };

    // Find all li.item.ref-rsg elements
    studyDiscover.find('li.item.ref-rsg').each((itemIndex, item) => {
      const paragraphs = $(item).find('p').toArray();
      let i = 0;

      while (i < paragraphs.length) {
        const p = paragraphs[i];
        const classes = ($(p).attr('class') || '').toLowerCase();

        // Check if this is a "su" paragraph (subject/heading)
        if (classes.includes('su')) {
          const suAnchors = $(p).find('a[href]').toArray();

          if (suAnchors.length > 0) {
            // Get the su label (combine all anchor texts)
            const suLabel = suAnchors
              .map(a => $(a).text().trim())
              .filter(text => text)
              .join(' ');

            let added = false;
            let j = i + 1;

            // Look for following "sk" paragraphs (sub-items)
            while (j < paragraphs.length) {
              const pNext = paragraphs[j];
              const nextClasses = ($(pNext).attr('class') || '').toLowerCase();

              // Stop if not a "sk" paragraph
              if (!nextClasses.includes('sk')) {
                break;
              }

              // Process sk anchors
              const skAnchors = $(pNext).find('a[href]').toArray();
              for (const a of skAnchors) {
                const href = $(a).attr('href') || '';
                const text = $(a).text().trim();

                if (!href || !text) continue;

                const fullUrl = href.startsWith('/')
                  ? `https://wol.jw.org${href}`
                  : href;

                const title = `${suLabel} ${text}`.trim();

                articles.push({
                  title: title,
                  url: fullUrl,
                  type: classify(fullUrl, title)
                });

                added = true;
              }

              j++;
            }

            // If we added sk items, skip to where we left off
            if (added) {
              i = j - 1;
            }

            // If no sk items were found, process su anchors directly
            if (!added) {
              for (const a of suAnchors) {
                const href = $(a).attr('href') || '';
                const text = $(a).text().trim();

                if (!href || !text) continue;

                const fullUrl = href.startsWith('/')
                  ? `https://wol.jw.org${href}`
                  : href;

                articles.push({
                  title: text,
                  url: fullUrl,
                  type: classify(fullUrl, text)
                });
              }
            }
          }
        }

        i++;
      }
    });

    return articles;
  }

  /**
   * Extract cross references
   * @param {CheerioAPI} $ - Cheerio instance
   * @param {Cheerio} studyDiscover - Study discover element
   * @returns {Array} Array of cross reference strings
   */
  extractCrossReferences($, studyDiscover) {
    const references = [];

    // Look for cross reference sections
    studyDiscover.find('div.crossRefs').each((i, section) => {
      $(section).find('a').each((j, item) => {
        const refText = $(item).text().trim();
        if (refText) {
          references.push(refText);
        }
      });
    });

    return references;
  }

  /**
   * Get a single verse text (plain text only)
   * @param {number} bookNum - Book number
   * @param {number} chapterNum - Chapter number
   * @param {number} verseNum - Verse number
   * @returns {Promise<Object>} Verse object with text
   */
  async getSingleVerse(bookNum, chapterNum, verseNum) {
    console.log(`[scraper] getSingleVerse(${bookNum}, ${chapterNum}, ${verseNum})`);
    const content = await this.extractChapterContent(bookNum, chapterNum);

    console.log(`[scraper] Available verses: [${content.verses.map(v => v.verse_num).join(', ')}]`);
    const verse = content.verses.find(v => v.verse_num === verseNum);

    if (!verse) {
      console.error(`[scraper] Verse ${verseNum} not found in ${content.verses.length} extracted verses`);
      throw new Error(`Verse ${bookNum}:${chapterNum}:${verseNum} not found`);
    }

    console.log(`[scraper] Found verse ${verseNum}: "${verse.verse_text.slice(0, 80)}..."`);
    return verse;
  }

  /**
   * Get verses with study content
   * @param {number} bookNum - Book number
   * @param {number} chapterNum - Chapter number
   * @param {string|number} verseInput - Verse number or range (e.g., "14" or "14-16")
   * @param {Object} options - Options for field selection and limits
   * @returns {Promise<Object>} Complete study content
   */
  async getVerseWithStudy(bookNum, chapterNum, verseInput, options = {}) {
    console.log(`[scraper] getVerseWithStudy(${bookNum}, ${chapterNum}, ${verseInput}, ${JSON.stringify(options)})`);
    const {
      fields = ['verses', 'study_notes'],
      limit = null
    } = options;

    // Parse verse input (single number or range)
    let verseStart, verseEnd;
    if (typeof verseInput === 'string' && verseInput.includes('-')) {
      const parts = verseInput.split('-');
      verseStart = parseInt(parts[0]);
      verseEnd = parseInt(parts[1]);
    } else {
      verseStart = verseEnd = parseInt(verseInput);
    }

    // Fetch chapter content
    const content = await this.extractChapterContent(bookNum, chapterNum);

    // Build result object based on requested fields
    const result = {
      book_num: bookNum,
      book_name: getBookName(bookNum),
      chapter: chapterNum,
      verse_range: verseStart === verseEnd ? `${verseStart}` : `${verseStart}-${verseEnd}`
    };

    // Filter verses in range
    const versesInRange = content.verses.filter(
      v => v.verse_num >= verseStart && v.verse_num <= verseEnd
    );

    // Add requested fields
    if (fields.includes('verses')) {
      result.verses = versesInRange;
    }

    if (fields.includes('combined_text')) {
      result.combined_text = versesInRange
        .map(v => `${v.verse_num}. ${v.verse_text}`)
        .join(' ');
    }

    if (fields.includes('study_notes')) {
      result.study_notes = {};
      for (let v = verseStart; v <= verseEnd; v++) {
        if (content.verse_study_notes[v]) {
          result.study_notes[v] = content.verse_study_notes[v];
        }
      }
    }

    if (fields.includes('study_articles')) {
      // Use verse-specific articles (filtered to requested range)
      const allArticles = [];
      const seenUrls = new Set();
      const seenTitles = new Set();

      for (let v = verseStart; v <= verseEnd; v++) {
        if (content.verse_study_articles[v]) {
          for (const article of content.verse_study_articles[v]) {
            // Deduplicate by URL or title (same article is cited from
            // multiple verse sections with different /pc/ URLs)
            const titleKey = article.title.toLowerCase().trim();
            if (seenUrls.has(article.url) || seenTitles.has(titleKey)) continue;

            seenUrls.add(article.url);
            seenTitles.add(titleKey);
            allArticles.push(article);
          }
        }
      }

      if (limit && allArticles.length > limit) {
        result.study_articles = allArticles.slice(0, limit);
      } else {
        result.study_articles = allArticles;
      }
      result.study_articles_count = result.study_articles.length;
    }

    if (fields.includes('cross_references') && content.chapter_study_data) {
      result.cross_references = content.chapter_study_data.cross_references;
    }

    if (fields.includes('chapter_level') && content.chapter_study_data) {
      result.chapter_level = {
        outline: content.chapter_study_data.outline,
        study_articles: content.chapter_study_data.study_articles,
        cross_references: content.chapter_study_data.cross_references
      };
    }

    return result;
  }
}

/**
 * Create a singleton instance for convenience
 */
export const scraper = new WOLScraper();
