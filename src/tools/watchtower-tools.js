import { fetchPublicationData, downloadRtfContent, getCurrentWatchtowerIssue } from './rtf-utils.js';

/**
 * Get available Watchtower articles for a specific issue
 */
export async function getWatchtowerLinks(pub = 'w', langwritten = 'E', issue = null, fileformat = 'RTF') {
  try {
    // Use current Watchtower issue (2 months behind) if none provided
    const finalIssue = issue || getCurrentWatchtowerIssue();
    const { files, pubName, formattedDate, language } = await fetchPublicationData(pub, langwritten, finalIssue, fileformat);
    
    // Skip the first item (ZIP file) and return the individual articles
    const articles = files.slice(1).map((file, index) => ({
      title: file.title,
      url: file.file.url,
      filesize: file.filesize,
      track: file.track,
      modifiedDatetime: file.file.modifiedDatetime,
      checksum: file.file.checksum
    }));

    return {
      pubName,
      formattedDate,
      issue: finalIssue,
      language,
      articles
    };

  } catch (error) {
    throw new Error(`Failed to fetch Watchtower links: ${error.message}`);
  }
}

/**
 * Fetch Watchtower article content from a given URL
 */
export async function getWatchtowerContent(url) {
  return await downloadRtfContent(url);
}

// Tool definitions for the MCP server
export const watchtowerTools = [
  {
    name: 'getWatchtowerLinks',
    description: 'STEP 1: Get JW.org Watchtower study articles. When a user asks for current/this week\'s Watchtower content, use this tool FIRST without any parameters - it automatically gets the correct issue for current study articles (Watchtower publications are 2 months ahead, so May 2025 studies come from March 2025 issue). Returns article titles like "Imitate the Faithful Angels (July 14-20)" with their RTF download URLs. Just use defaults for current articles.',
    inputSchema: {
      type: 'object',
      properties: {
        pub: {
          type: 'string',
          description: 'Publication code: "w" for Watchtower (Study edition)',
          default: 'w'
        },
        langwritten: {
          type: 'string', 
          description: 'Language code: "E" for English, "S" for Spanish, etc.',
          default: 'E'
        },
        issue: {
          type: 'string',
          description: 'Issue in YYYYMM00 format. Leave empty for current study articles (server automatically calculates correct issue - Watchtower studies are 2 months ahead of publication)'
        },
        fileformat: {
          type: 'string',
          description: 'File format: "RTF" for Rich Text Format',
          default: 'RTF'
        }
      },
      required: []
    }
  },
  {
    name: 'getWatchtowerContent',
    description: 'STEP 2: Get the actual Watchtower article content after user chooses an article. Use this tool AFTER getWatchtowerLinks when user specifies which article they want (e.g., "Imitate the Faithful Angels" or "Look to Jehovah for Comfort"). Takes the RTF URL from Step 1 results and returns the full article text content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The RTF file URL from getWatchtowerLinks results (e.g., "https://cfp2.jw-cdn.org/a/...")'
        }
      },
      required: ['url']
    }
  }
];

// Tool handlers
export async function handleWatchtowerTools(request) {
  // Handle getWatchtowerLinks tool
  if (request.params.name === 'getWatchtowerLinks') {
    try {
      const { pub, langwritten, issue, fileformat } = request.params.arguments || {};
      const result = await getWatchtowerLinks(pub, langwritten, issue, fileformat);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Handle getWatchtowerContent tool  
  if (request.params.name === 'getWatchtowerContent') {
    try {
      const { url } = request.params.arguments;
      
      if (!url) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: URL parameter is required',
            },
          ],
          isError: true,
        };
      }
      
      const result = await getWatchtowerContent(url);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  return null;
}
