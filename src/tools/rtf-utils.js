import fetch from 'node-fetch';

/**
 * Get current issue in YYYYMM00 format
 * For workbooks, this is the current month
 * For Watchtower, this needs to be 2 months behind (see getCurrentWatchtowerIssue)
 */
export function getCurrentIssue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}${month}00`;
}

/**
 * Get current Watchtower issue in YYYYMM00 format
 * Watchtower studies are 2 months ahead of publication date
 * So to get current studies, we need the issue from 2 months ago
 */
export function getCurrentWatchtowerIssue() {
  const now = new Date();
  // Subtract 2 months to get the correct Watchtower issue
  const targetDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  return `${year}${month}00`;
}

/**
 * Fetch RTF content from a given URL
 */
export async function downloadRtfContent(url) {
  try {
    const response = await fetch(url);
    
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
    
    const response = await fetch(apiUrl);
    
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
