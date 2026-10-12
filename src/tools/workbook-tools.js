import { FILE_FORMATS, WORKBOOK_TOOLS, periodicalContent, periodicalLinks } from './rtf-utils.js';
import { LANGWRITTEN_DESCRIPTION } from './languages.js';
import { wrapTool } from './results.js';

const LANG = { type: 'string', description: LANGWRITTEN_DESCRIPTION };
const DATE = { type: 'string', description: 'YYYY-MM-DD in the week. Default: today (server time).' };
// max_chars (default 60000) is accepted but left out of the schema to keep tools/list small.
const OFFSET = { type: 'integer', minimum: 0, description: 'next_offset of the last call.' };

export const getWorkbookLinksImplementation = wrapTool(
  (args) => periodicalLinks(args, WORKBOOK_TOOLS),
  'getWorkbookLinks'
);

export const getWorkbookContentImplementation = wrapTool(
  (args) => periodicalContent(args, WORKBOOK_TOOLS),
  'getWorkbookContent'
);

// Tool definitions for the MCP server
export const workbookTools = [
  {
    name: 'getWorkbookLinks',
    description:
      'Weeks of one Our Christian Life and Ministry workbook issue: title, week, week_start/week_end, is_current_week, file url, jw.org link. Default: the issue for today (or date). Not needed to read a week: getWorkbookContent takes date or issue + week.',
    inputSchema: {
      type: 'object',
      properties: {
        langwritten: LANG,
        date: DATE,
        issue: {
          type: 'string',
          description:
            'YYYYMM00 or YYYYMM; odd months only (20261100 = Nov–Dec 2026), an even month means the issue holding it. Default: the issue for date.'
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
    name: 'getWorkbookContent',
    description:
      'Text of one meeting-workbook week. No arguments: this week; date: that day\'s week; issue + week; or url from getWorkbookLinks. Returns title, week_start/week_end, issue, url (source file), link (jw.org page to cite), links (songs, cited publications) and parsedText (outline with songs, parts, minutes; then the scriptures). Long text: offset = next_offset until null.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DATE,
        langwritten: LANG,
        issue: { type: 'string', description: 'YYYYMM00 (see getWorkbookLinks). Default: the issue for date.' },
        week: { type: 'integer', minimum: 1, maximum: 20, description: 'Week in the issue (from getWorkbookLinks), not in the month; with date it must match.' },
        url: { type: 'string', description: 'url (not link) of a getWorkbookLinks entry; overrides the rest.' },
        offset: OFFSET
      },
      required: []
    }
  }
];

// Tool handlers
export async function handleWorkbookTools(request) {
  const args = request.params.arguments;
  switch (request.params.name) {
    case 'getWorkbookLinks':
      return await getWorkbookLinksImplementation(args);
    case 'getWorkbookContent':
      return await getWorkbookContentImplementation(args);
    default:
      return null;
  }
}
