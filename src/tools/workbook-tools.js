import fetch from 'node-fetch';

/**
 * Get available workbook links for a specific issue
 */
export async function getWorkbookLinks(pub = 'mwb', langwritten = 'E', issue = '20250500', fileformat = 'RTF') {
  try {
    const apiUrl = `https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?pub=${pub}&langwritten=${langwritten}&issue=${issue}&fileformat=${fileformat}&output=json`;
    
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Extract RTF files, excluding the ZIP file (which is always first)
    const rtfFiles = data.files?.[langwritten]?.[fileformat];
    
    if (!rtfFiles || rtfFiles.length === 0) {
      throw new Error('No RTF files found');
    }

    // Skip the first item (ZIP file) and return the individual week files
    const weekFiles = rtfFiles.slice(1).map((file, index) => ({
      title: file.title,
      url: file.file.url,
      filesize: file.filesize,
      track: file.track,
      modifiedDatetime: file.file.modifiedDatetime,
      checksum: file.file.checksum
    }));

    return {
      pubName: data.pubName,
      formattedDate: data.formattedDate,
      issue: data.issue,
      language: data.languages[langwritten].name,
      weekFiles: weekFiles
    };

  } catch (error) {
    throw new Error(`Failed to fetch workbook links: ${error.message}`);
  }
}

/**
 * Fetch RTF content from a given URL
 */
export async function getWorkbookContent(url) {
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
    throw new Error(`Failed to fetch workbook content: ${error.message}`);
  }
}

// Tool definitions for the MCP server
export const workbookTools = [
  {
    name: 'getWorkbookLinks',
    description: 'STEP 1: Get JW.org "Our Christian Life and Ministry" (CLM) meeting workbook weeks. When a user asks for CLM workbook content, use this tool FIRST to show them available weeks. Returns weekly titles like "May 5-11 (Proverbs 12)" with their RTF download URLs. Use default parameters for current English workbooks.',
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
          description: 'Issue in YYYYMM00 format. Current: "20250500" for May-June 2025',
          default: '20250500'
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
    description: 'STEP 2: Get the actual CLM workbook content after user chooses a week. Use this tool AFTER getWorkbookLinks when user specifies which week they want (e.g., "May 5-11" or "June 30-July 6"). Takes the RTF URL from Step 1 results and returns the full workbook text content for that specific week.',
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
