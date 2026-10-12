// End-to-end check of the real server: spawns `node src/index.js` over stdio
// with the MCP SDK client and calls every tool once with a realistic input
// (about 16 JW.org requests). Skipped unless JW_MCP_LIVE=1.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { formatIsoDate } from '../../src/tools/args.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';
const SERVER = fileURLToPath(new URL('../../src/index.js', import.meta.url));
// The server runs on this machine, so "today" is the same local date for both.
const TODAY = formatIsoDate(new Date());
const TIMEOUT = 60000;

// Forward JW_* settings and NODE_OPTIONS (e.g. a fetch-cache preload) to the server.
function serverEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('JW_') || k === 'NODE_OPTIONS'));
}

describe('jw-mcp over stdio (live)', { skip, timeout: 10 * TIMEOUT }, () => {
  let client;
  let transport;
  let stderr = '';
  const results = {};

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT });
    const text = result.content[0]?.text ?? '';
    assert.notEqual(result.isError, true, `${name} failed: ${text}\n--- server stderr ---\n${stderr.slice(-2000)}`);
    const json = JSON.parse(text);
    results[name] = json;
    return { result, json };
  }

  before(async () => {
    transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: serverEnv(), stderr: 'pipe' });
    transport.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    client = new Client({ name: 'jw-mcp-e2e', version: '0.0.0' });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
  });

  it('initializes with instructions and lists 12 annotated tools', async () => {
    assert.equal(client.getServerVersion().name, 'jw-mcp');
    assert.match(client.getInstructions(), /langwritten/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    for (const tool of tools) {
      assert.ok(tool.title, tool.name);
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    }
  });

  it('search_bible_books finds Psalms from a reference', async () => {
    const { json } = await call('search_bible_books', { query: 'Ps 83:18' });
    assert.equal(json.books[0].number, 19);
    assert.equal(json.parsed_reference.reference, 'Psalm 83:18');
  });

  it('get_bible_verse returns John 3:16', async () => {
    const { json } = await call('get_bible_verse', { reference: 'John 3:16' });
    assert.equal(json.reference, 'John 3:16');
    assert.match(json.text, /loved the world/);
    assert.match(json.url, /^https:\/\/www\.jw\.org\/finder\?wtlocale=E&.*bible=43003016/);
  });

  it('get_verse_with_study returns study notes and Research Guide articles for Matthew 24:14', async () => {
    const { json } = await call('get_verse_with_study', {
      reference: 'Matt. 24:14',
      fields: ['verses', 'study_notes', 'study_articles'],
      limit: 3
    });
    assert.equal(json.verses[0].verse, 14);
    assert.ok(json.study_notes_count > 0, JSON.stringify(json.study_notes));
    assert.ok(json.study_articles.length > 0 && json.study_articles.length <= 3);
    assert.match(json.study_articles[0].url, /^https:\/\/wol\.jw\.org\//);
  });

  it('get_bible_verse_url links Psalm 83:18 in Spanish', async () => {
    const { json } = await call('get_bible_verse_url', { reference: 'Ps. 83:18', langwritten: 'es' });
    assert.equal(json.langwritten, 'S');
    assert.match(json.url, /wtlocale=S&.*bible=19083018/);
    assert.match(json.markdown, /^\[Psalm 83:18\]\(https:/);
  });

  it('getWorkbookContent with no arguments returns this week', async () => {
    const { json } = await call('getWorkbookContent', {});
    assert.ok(json.week_start <= TODAY && TODAY <= json.week_end, `${json.week_start}..${json.week_end} vs ${TODAY}`);
    assert.ok(json.parsedText.length > 1000);
    assert.ok(json.links.some((l) => /lank=pub-sjjm_\d+_VIDEO/.test(l.url)), JSON.stringify(json.links));
  });

  it('getWorkbookLinks lists the issue and marks the current week', async () => {
    const { json } = await call('getWorkbookLinks', { date: TODAY });
    assert.equal(json.weekFiles.filter((w) => w.is_current_week).length, 1);
    assert.equal(json.issue, results.getWorkbookContent.issue);
  });

  it('getWatchtowerLinks lists the study articles of the current issue', async () => {
    const { json } = await call('getWatchtowerLinks', {});
    const studies = json.articles.filter((a) => a.type === 'study');
    assert.ok(studies.length >= 4, JSON.stringify(json.articles.map((a) => a.title)));
    assert.equal(studies.filter((a) => a.is_current_week).length, 1);
  });

  it('getWatchtowerContent with no arguments returns this week\'s study', async () => {
    const { json } = await call('getWatchtowerContent', {});
    assert.ok(json.week_start <= TODAY && TODAY <= json.week_end, `${json.week_start}..${json.week_end} vs ${TODAY}`);
    assert.equal(json.issue, results.getWatchtowerLinks.issue);
    assert.ok(json.parsedText.length > 3000);
  });

  it('get_daily_text returns today\'s text', async () => {
    const { json } = await call('get_daily_text', { date: TODAY });
    assert.equal(json.date, TODAY);
    assert.ok(json.text.length > 200);
    assert.match(json.source_url, /^https:\/\/wol\.jw\.org\//);
  });

  it('read_wol_document opens the daily text\'s source, cited paragraphs only', async () => {
    const { json } = await call('read_wol_document', { url: results.get_daily_text.source_url, cited_only: true });
    assert.ok(json.title);
    assert.equal(json.showing, 'cited paragraphs only');
    assert.match(json.url, /^https:\/\/wol\.jw\.org\/en\/wol\/d\/.*#h=/);
    assert.ok(json.text.length > 200 && json.text.length < 6000, `${json.text.length} chars`);
  });

  it('search_wol finds a phrase', async () => {
    const { json } = await call('search_wol', { query: '"kingdom of God"', limit: 3 });
    assert.ok(json.total > 3);
    assert.equal(json.results.length, 3);
    assert.match(json.results[0].url, /^https:\/\/wol\.jw\.org\//);
  });

  it('get_jw_captions reads the first part of a transcript from a share link', async () => {
    const result = await client.callTool(
      { name: 'get_jw_captions', arguments: { video_id: 'https://www.jw.org/finder?wtlocale=E&lank=pub-jwb-142_1_VIDEO', max_chars: 2000 } },
      undefined,
      { timeout: TIMEOUT }
    );
    assert.notEqual(result.isError, true, result.content[0].text);
    const meta = JSON.parse(result.content[0].text);
    assert.equal(meta.captions_available, true);
    assert.equal(meta.truncated, true);
    assert.ok(meta.next_offset > 0);
    assert.match(result.content[1].text, /^\[0:\d\d\] /);
  });

  it('reports a real JW.org failure as an isError result', async () => {
    const result = await client.callTool({ name: 'get_jw_captions', arguments: { video_id: 'pub-doesnotexist_99_VIDEO' } }, undefined, {
      timeout: TIMEOUT
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /\nNext step: /);
  });
});
