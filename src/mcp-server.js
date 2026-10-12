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
import { describeValue } from './tools/args.js';
import { errorResult, errorToResult } from './tools/results.js';

const { version: SERVER_VERSION } = createRequire(import.meta.url)('../package.json');

// Every tool only reads public JW.org content.
const TOOL_META = {
  search_bible_books: { title: 'Find Bible Books' },
  get_bible_verse: { title: 'Bible Verse Text' },
  get_verse_with_study: { title: 'Bible Verses with Study Notes' },
  get_bible_verse_url: { title: 'Bible Verse Links' },
  getWorkbookLinks: { title: 'List Meeting Workbook Weeks' },
  getWorkbookContent: { title: 'Read Meeting Workbook Week' },
  getWatchtowerLinks: { title: 'List Watchtower Study Articles' },
  getWatchtowerContent: { title: 'Read Watchtower Study Article' },
  get_jw_captions: { title: 'Video Transcript' },
};

function withMeta(tool) {
  const meta = TOOL_META[tool.name];
  if (!meta) throw new Error(`mcp-server.js: add ${tool.name} to TOOL_META`);
  return {
    ...tool,
    title: meta.title,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  };
}

export const allTools = [
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool,
  getBibleVerseURLTool,
  ...workbookTools,
  ...watchtowerTools,
  captionsTool,
].map(withMeta);

const toolHandlers = [
  handleScriptureTools,
  handleWorkbookTools,
  handleWatchtowerTools,
  handleCaptionsTool,
];

// Argument names models reach for that mean a real parameter. lang and
// language apply only to tools whose schema has langwritten.
const LANG_ALIASES = { __proto__: null, lang: 'langwritten', language: 'langwritten' };
const TOOL_ALIASES = {
  __proto__: null,
  get_jw_captions: { __proto__: null, url: 'video_id', video_url: 'video_id', lank: 'video_id', link: 'video_id' },
  getWorkbookContent: { __proto__: null, link: 'url' },
  getWatchtowerContent: { __proto__: null, link: 'url' }
};
// Accepted but left out of the schema: 1.3.3's pub, max_chars to keep
// tools/list small.
const HIDDEN_PARAMS = {
  __proto__: null,
  getWorkbookLinks: ['pub'],
  getWatchtowerLinks: ['pub'],
  getWorkbookContent: ['max_chars'],
  getWatchtowerContent: ['max_chars']
};
const toolsByName = new Map(allTools.map((t) => [t.name, t]));

// Levenshtein distance, ignoring case, "_" and "-" (videoId, lang_written).
function editDistance(a, b) {
  [a, b] = [a, b].map((s) => s.toLowerCase().replace(/[-_]/g, ''));
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** The parameter an unknown key probably misspells, or null. */
function misspelledParam(key, names) {
  if (key.length > 40) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const name of names) {
    const distance = editDistance(key, name);
    if (distance <= (Math.min(key.length, name.length) <= 4 ? 1 : 2) && distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * A known tool's arguments with aliases mapped to the real names:
 * {args, ignored}, or {error} for a probable misspelling of a parameter, a
 * language under another name, or two names that disagree. Other unknown
 * keys are dropped and listed in ignored (1.3.3 ignored them silently).
 * Unknown tools and non-object arguments pass through for the handlers to judge.
 */
function normalizeArgs(name, args) {
  const tool = toolsByName.get(name);
  if (!tool || typeof args !== 'object' || args === null || Array.isArray(args)) return { args, ignored: [] };
  const props = tool.inputSchema.properties;
  const known = new Set([...Object.keys(props), ...(HIDDEN_PARAMS[name] ?? [])]);
  const aliases = { __proto__: null, ...('langwritten' in props ? LANG_ALIASES : {}), ...TOOL_ALIASES[name] };
  const out = {};
  const from = {};
  const ignored = [];
  for (const [key, value] of Object.entries(args)) {
    const target = known.has(key) ? key : aliases[key];
    if (!target) {
      // A language sent under another name would silently give English.
      const meant = misspelledParam(key, known) ?? ('langwritten' in props && /lang|locale/i.test(key) ? 'langwritten' : null);
      if (meant) {
        return {
          error: errorResult(
            `Unknown argument ${describeValue(key)} for ${name}; did you mean "${meant}"?`,
            `Its parameters are: ${Object.keys(props).join(', ')}. Rename ${describeValue(key)} and call again.`
          )
        };
      }
      ignored.push(describeValue(key));
      continue;
    }
    if (value === undefined) continue;
    if (target in out && !Object.is(out[target], value)) {
      return { error: errorResult(`${describeValue(key)} and "${from[target]}" disagree for ${name}.`, `Send only "${target}".`) };
    }
    out[target] = value;
    from[target] = key;
  }
  return { args: out, ignored };
}

function withIgnoredNote(result, name, ignored) {
  if (!ignored.length || !Array.isArray(result?.content)) return result;
  const params = Object.keys(toolsByName.get(name).inputSchema.properties).join(', ');
  const listed = ignored.length > 10 ? `${ignored.slice(0, 10).join(', ')} and ${ignored.length - 10} more` : ignored.join(', ');
  const text = `Ignored argument${ignored.length > 1 ? 's' : ''} ${listed}: ${name} takes ${params}.`;
  return { ...result, content: [...result.content, { type: 'text', text }] };
}

/**
 * Run one tools/call request. Never throws: a handler that throws, or a call
 * to an unknown tool, becomes an isError result. Clients may omit
 * `arguments`; handlers always get an object, with aliases (lang, language,
 * link...) mapped to the real parameter names.
 */
export async function callTool(request, { handlers = toolHandlers } = {}) {
  const toolName = request.params.name;
  try {
    const checked = normalizeArgs(toolName, request.params.arguments ?? {});
    if (checked.error) return checked.error;
    const call = { ...request, params: { ...request.params, arguments: checked.args } };
    for (const handler of handlers) {
      const result = await handler(call);
      if (result !== null && result !== undefined) return withIgnoredNote(result, toolName, checked.ignored);
    }
    return errorResult(`Unknown tool ${describeValue(toolName)}.`, `Use one of: ${allTools.map((t) => t.name).join(', ')}.`);
  } catch (error) {
    return errorToResult(error, typeof toolName === 'string' && toolName.length <= 60 ? toolName : describeValue(toolName));
  }
}

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
    // Logged only; callTool gets the untouched request.
    const toolName = describeValue(request.params.name);
    const start = Date.now();
    console.error(`[${requestId}] ToolCall: ${toolName}`);
    const result = await callTool(request);
    console.error(`[${requestId}] ToolResult: ${toolName} ${result.isError ? 'ERROR' : 'OK'} ${Date.now() - start}ms`);
    return result;
  });

  return server;
}
