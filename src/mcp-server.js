import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { captionsTool, handleCaptionsTool } from './tools/captions-tool.js';
import { workbookTools, handleWorkbookTools } from './tools/workbook-tools.js';
import { watchtowerTools, handleWatchtowerTools } from './tools/watchtower-tools.js';
import {
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool,
  getBibleVerseURLTool,
  handleScriptureTools,
} from './tools/scripture-tools.js';

const { version: SERVER_VERSION } = createRequire(import.meta.url)('../package.json');

const allTools = [
  captionsTool,
  ...workbookTools,
  ...watchtowerTools,
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool,
  getBibleVerseURLTool,
];

const toolHandlers = [
  handleCaptionsTool,
  handleWorkbookTools,
  handleWatchtowerTools,
  handleScriptureTools,
];

export function createMcpServer(requestId = 'default') {
  const server = new Server(
    { name: 'jw-mcp', version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`[${requestId}] ListTools — ${allTools.length} tools`);
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const start = Date.now();
    console.error(`[${requestId}] ToolCall: ${toolName}`);

    try {
      for (const handler of toolHandlers) {
        const result = await handler(request);
        if (result !== null) {
          const duration = Date.now() - start;
          const isError = result.isError || false;
          console.error(`[${requestId}] ToolResult: ${toolName} ${isError ? 'ERROR' : 'OK'} ${duration}ms`);
          return result;
        }
      }

      console.error(`[${requestId}] ToolResult: ${toolName} — no handler matched`);
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    } catch (error) {
      console.error(`[${requestId}] ToolError: ${toolName} ${Date.now() - start}ms — ${error.message}`);
      throw error;
    }
  });

  return server;
}
