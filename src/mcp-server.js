import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Define tools statically for faster loading
const STATIC_TOOLS = [
  {
    name: 'get_jw_captions',
    description: 'Fetches video captions from JW.org by video ID or URL. Accepts either a direct video ID (e.g., "pub-jwbvod25_17_VIDEO") or a JW.org URL (e.g., "https://www.jw.org/finder?srcid=jwlshare&wtlocale=E&lank=pub-jwbvod25_17_VIDEO")',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: {
          type: 'string',
          description: 'The JW.org video ID or a JW.org URL containing the video ID. If a URL is provided, the video ID will be automatically extracted.',
        },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'getWorkbookLinks',
    description: 'STEP 1: Get JW.org "Our Christian Life and Ministry" (CLM) meeting workbook weeks. When a user asks for CLM workbook content, use this tool FIRST to show them available weeks. Returns weekly titles like "May 5-11 (Proverbs 12)" with their RTF download URLs. Automatically uses current month/year for the issue.',
    inputSchema: {
      type: 'object',
      properties: {
        pub: {
          type: 'string',
          description: 'Publication code: "mwb" for Meeting Workbook (CLM workbook)',
          default: 'mwb',
        },
        langwritten: {
          type: 'string',
          description: 'Language code: "E" for English, "S" for Spanish, etc.',
          default: 'E',
        },
        issue: {
          type: 'string',
          description: 'Issue in YYYYMM00 format. Leave empty to use current month/year automatically (e.g., "20250500" for May 2025)',
        },
        fileformat: {
          type: 'string',
          description: 'File format: "RTF" for Rich Text Format',
          default: 'RTF',
        },
      },
      required: [],
    },
  },
  {
    name: 'getWorkbookContent',
    description: 'STEP 2: Get the actual CLM workbook content after user chooses a week. Use this tool AFTER getWorkbookLinks when user specifies which week they want (e.g., "May 5-11" or "June 30-July 6"). Takes the RTF URL from Step 1 results and returns the full workbook text content for that specific week.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The RTF file URL from getWorkbookLinks results (e.g., "https://cfp2.jw-cdn.org/a/...")',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'getWatchtowerLinks',
    description: 'STEP 1: Get JW.org Watchtower study articles. When a user asks for current/this week\'s Watchtower content, use this tool FIRST without any parameters - it automatically gets the correct issue for current study articles (Watchtower publications are 2 months ahead, so May 2025 studies come from March 2025 issue). Returns article titles like "Imitate the Faithful Angels (July 14-20)" with their RTF download URLs. Just use defaults for current articles.',
    inputSchema: {
      type: 'object',
      properties: {
        pub: {
          type: 'string',
          description: 'Publication code: "w" for Watchtower (Study edition)',
          default: 'w',
        },
        langwritten: {
          type: 'string',
          description: 'Language code: "E" for English, "S" for Spanish, etc.',
          default: 'E',
        },
        issue: {
          type: 'string',
          description: 'Issue in YYYYMM00 format. Leave empty for current study articles (server automatically calculates correct issue - Watchtower studies are 2 months ahead of publication)',
        },
        fileformat: {
          type: 'string',
          description: 'File format: "RTF" for Rich Text Format',
          default: 'RTF',
        },
      },
      required: [],
    },
  },
  {
    name: 'getWatchtowerContent',
    description: 'STEP 2: Get the actual Watchtower article content after user chooses an article. Use this tool AFTER getWatchtowerLinks when user specifies which article they want (e.g., "Imitate the Faithful Angels" or "Look to Jehovah for Comfort"). Takes the RTF URL from Step 1 results and returns the full article text content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The RTF file URL from getWatchtowerLinks results (e.g., "https://cfp2.jw-cdn.org/a/...")',
        },
      },
      required: ['url'],
    },
  },
];

/**
 * Creates a new MCP server instance
 * @param {Object} config - Configuration object (currently unused but available for future use)
 * @returns {Server} MCP server instance
 */
export function createMcpServer({ config = {} } = {}) {
  // Create server instance
  const server = new Server(
    {
      name: 'jw-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools with static definitions for instant response
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: STATIC_TOOLS,
    };
  });

  // Handle tool calls by dynamically importing handlers (lazy loading)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'get_jw_captions': {
          // Lazy load captions tool
          const { handleCaptionsTool } = await import('./tools/captions-tool.js');
          return await handleCaptionsTool(request);
        }
        
        case 'getWorkbookLinks':
        case 'getWorkbookContent': {
          // Lazy load workbook tools
          const { handleWorkbookTools } = await import('./tools/workbook-tools.js');
          return await handleWorkbookTools(request);
        }
        
        case 'getWatchtowerLinks':
        case 'getWatchtowerContent': {
          // Lazy load watchtower tools
          const { handleWatchtowerTools } = await import('./tools/watchtower-tools.js');
          return await handleWatchtowerTools(request);
        }
        
        default:
          return {
            content: [
              {
                type: 'text',
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool ${name}: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
