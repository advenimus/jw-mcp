import { fetchPublicationData, downloadRtfContent, getCurrentIssue } from './rtf-utils.js';
import { parseRTF } from './rtf-parser.js';

/**
 * Get available workbook links for a specific issue
 */
export async function getWorkbookLinks(pub = 'mwb', langwritten = 'E', issue = null, fileformat = 'RTF') {
  try {
    const { files, pubName, formattedDate, language } = await fetchPublicationData(pub, langwritten, issue, fileformat);
    
    // Skip the first item (ZIP file) and return the individual week files
    const weekFiles = files.slice(1).map((file, index) => ({
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
      issue: issue || getCurrentIssue(),
      language,
      weekFiles
    };

  } catch (error) {
    throw new Error(`Failed to fetch workbook links: ${error.message}`);
  }
}

/**
 * Fetch RTF content from a given URL and parse it to plain text
 */
export async function getWorkbookContent(url) {
  const rtfData = await downloadRtfContent(url);

  try {
    // Parse RTF to plain text
    const parsedText = parseRTF(rtfData.content);

    return {
      url: rtfData.url,
      contentType: rtfData.contentType,
      originalSize: rtfData.size,
      parsedText: parsedText,
      parsedSize: parsedText.length
    };
  } catch (error) {
    throw new Error(`Failed to parse RTF content: ${error.message}`);
  }
}

// Tool definitions for the MCP server
export const workbookTools = [
  {
    name: 'getWorkbookLinks',
    description: 'STEP 1: Get JW.org "Our Christian Life and Ministry" (CLM) meeting workbook weeks. When a user asks for CLM workbook content, use this tool FIRST to show them available weeks. Returns weekly titles like "May 5-11 (Proverbs 12)" with their RTF download URLs. Automatically uses current month/year for the issue.',
    inputSchema: {
      type: 'object',
      properties: {
        pub: {
          type: 'string',
          description: 'Publication code: "mwb" for Meeting Workbook (CLM workbook)',
          default: 'mwb'
        },
        langwritten: {
          type: 'string', 
          description: 'Language code: "E" for English, "S" for Spanish, etc.',
          default: 'E'
        },
        issue: {
          type: 'string',
          description: 'Issue in YYYYMM00 format. Leave empty to use current month/year automatically (e.g., "20250500" for May 2025)'
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
    name: 'getWorkbookContent',
    description: 'STEP 2: Get the actual CLM workbook content after user chooses a week. Use this tool AFTER getWorkbookLinks when user specifies which week they want (e.g., "May 5-11" or "June 30-July 6"). Takes the RTF URL from Step 1 results, downloads the RTF file, parses it to clean plain text, and returns the formatted workbook content with proper line breaks and structure.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The RTF file URL from getWorkbookLinks results (e.g., "https://cfp2.jw-cdn.org/a/...")'
        }
      },
      required: ['url']
    }
  }
];

// Tool handlers
export async function handleWorkbookTools(request) {
  // Handle getWorkbookLinks tool
  if (request.params.name === 'getWorkbookLinks') {
    try {
      const { pub, langwritten, issue, fileformat } = request.params.arguments || {};
      const result = await getWorkbookLinks(pub, langwritten, issue, fileformat);
      
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

  // Handle getWorkbookContent tool  
  if (request.params.name === 'getWorkbookContent') {
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
      
      const result = await getWorkbookContent(url);
      
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
