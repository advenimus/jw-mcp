import { FILE_FORMATS, WATCHTOWER_TOOLS, periodicalContent, periodicalLinks } from './rtf-utils.js';
import { LANGWRITTEN_DESCRIPTION } from './languages.js';
import { wrapTool } from './results.js';

const LANG = { type: 'string', description: LANGWRITTEN_DESCRIPTION };
const DATE = { type: 'string', description: 'YYYY-MM-DD in the week. Default: today (server time).' };
// max_chars (default 60000) is accepted but left out of the schema to keep tools/list small.
const OFFSET = { type: 'integer', minimum: 0, description: 'next_offset of the last call.' };

export const getWatchtowerLinksImplementation = wrapTool(
  (args) => periodicalLinks(args, WATCHTOWER_TOOLS),
  'getWatchtowerLinks'
);

export const getWatchtowerContentImplementation = wrapTool(
  (args) => periodicalContent(args, WATCHTOWER_TOOLS),
  'getWatchtowerContent'
);

// Tool definitions for the MCP server
export const watchtowerTools = [
  {
    name: 'getWatchtowerLinks',
    description:
      'Articles of one Watchtower study-edition issue: studies (type "study") with week, week_start/week_end, is_current_week, and others (type "other"), each with a file url and jw.org link. Default: the issue for this week (or date). Not needed to read a study: getWatchtowerContent takes date or issue + week.',
    inputSchema: {
      type: 'object',
      properties: {
        langwritten: LANG,
        date: DATE,
        issue: {
          type: 'string',
          description: 'YYYYMM00 or YYYYMM (YYYYMM15 before 2016). Issue M is studied in month M+2 (20260800: Oct 5–Nov 1, 2026). Default: the issue for date.'
        },
        fileformat: {
          type: 'string',
          enum: [...FILE_FORMATS],
          description: 'Default RTF, else TXT. Others give download links only.'
        }
      },
      required: []
    }
  },
  {
    name: 'getWatchtowerContent',
    description:
      'Text of one Watchtower study article. No arguments: this week\'s study; date: that day\'s week; issue + week; or url from getWatchtowerLinks (any article). Returns title, week_start/week_end, issue, url (source file), link (jw.org page to cite), links (songs, cited publications) and parsedText (paragraphs, questions, review box). Long text: offset = next_offset until null.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DATE,
        langwritten: LANG,
        issue: { type: 'string', description: 'YYYYMM00 (YYYYMM15 before 2016). Default: the issue for date.' },
        week: { type: 'integer', minimum: 1, maximum: 20, description: 'Study in the issue (week from getWatchtowerLinks), not in the month; with date it must match.' },
        url: { type: 'string', description: 'url (not link) of a getWatchtowerLinks entry; overrides the rest.' },
        offset: OFFSET
      },
      required: []
    }
  }
];

// Tool handlers
export async function handleWatchtowerTools(request) {
  const args = request.params.arguments;
  switch (request.params.name) {
    case 'getWatchtowerLinks':
      return await getWatchtowerLinksImplementation(args);
    case 'getWatchtowerContent':
      return await getWatchtowerContentImplementation(args);
    default:
      return null;
  }
}
