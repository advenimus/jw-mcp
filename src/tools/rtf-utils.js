import { fetchWithTimeout } from './fetch-with-timeout.js';

// The workbook has been bimonthly (odd-month issues only) since January 2021.
const BIMONTHLY_FROM = 2021;

/** Monday of the Mon–Sun meeting week that contains date. */
function mondayOf(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
}

function issueCode(year, monthIndex) {
  const d = new Date(year, monthIndex, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}00`;
}

/**
 * Workbook issue (YYYYMM00) that holds the meeting week containing date.
 * A week belongs to the month of its Monday; since 2021 each issue covers
 * two months and only odd months exist, so October is in the September
 * issue and Dec 28–Jan 3 is in the November issue.
 */
export function getCurrentIssue(date = new Date()) {
  const monday = mondayOf(date);
  const year = monday.getFullYear();
  const month = monday.getMonth();
  return issueCode(year, year >= BIMONTHLY_FROM ? month - (month % 2) : month);
}

/**
 * Watchtower study-edition issue (YYYYMM00) that holds the study article
 * for the week containing date. Issue M holds the studies for the weeks
 * whose Monday is in month M+2 (August holds October's studies).
 */
export function getCurrentWatchtowerIssue(date = new Date()) {
  const monday = mondayOf(date);
  return issueCode(monday.getFullYear(), monday.getMonth() - 2);
}

/**
 * A workbook issue as published: from 2021 an even month (20261000) has no
 * issue of its own and becomes the odd-month issue that covers it (20260900).
 * Anything else is returned unchanged.
 */
export function workbookIssue(issue) {
  const m = /^(\d{4})(\d{2})00$/.exec(typeof issue === 'string' ? issue.trim() : '');
  if (!m || Number(m[1]) < BIMONTHLY_FROM || Number(m[2]) % 2 === 1) return issue;
  return issueCode(Number(m[1]), Number(m[2]) - 2);
}

/**
 * Fetch RTF content from a given URL
 */
export async function downloadRtfContent(url) {
  try {
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch RTF content: ${response.statusText}`);
    }

    const rtfContent = await response.text();
    
    return {
      url: url,
      content: rtfContent,
      contentType: response.headers.get('content-type'),
      size: rtfContent.length
    };

  } catch (error) {
    throw new Error(`Failed to fetch RTF content: ${error.message}`);
  }
}

/**
 * Make API call to JW.org pub-media API
 */
export async function fetchPublicationData(pub, langwritten = 'E', issue = null, fileformat = 'RTF') {
  try {
    // Use current issue if none provided
    const finalIssue = issue || getCurrentIssue();
    
    const apiUrl = `https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?pub=${pub}&langwritten=${langwritten}&issue=${finalIssue}&fileformat=${fileformat}&output=json`;
    
    const response = await fetchWithTimeout(apiUrl);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Extract files for the specified language and format
    const files = data.files?.[langwritten]?.[fileformat];
    
    if (!files || files.length === 0) {
      throw new Error(`No ${fileformat} files found for ${pub} in ${langwritten}`);
    }

    return {
      data,
      files,
      pubName: data.pubName,
      formattedDate: data.formattedDate,
      issue: data.issue,
      language: data.languages[langwritten].name
    };

  } catch (error) {
    throw new Error(`Failed to fetch publication data: ${error.message}`);
  }
}
