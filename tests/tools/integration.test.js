// Offline tests for the assembled server: tools/list as a client sees it, and
// tools/call through callTool. globalThis.fetch is replaced in every test, so
// nothing here can reach JW.org.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { allTools, callTool, createMcpServer } from '../../src/mcp-server.js';
import { ArgError } from '../../src/tools/args.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
let fetched;

function blockNetwork() {
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    throw new Error(`offline test tried to fetch ${url}`);
  };
}

function text(result) {
  return result.content.map((c) => c.text).join('\n');
}

let client;
let server;

before(async () => {
  console.error = () => {}; // the server logs every call to stderr
  server = createMcpServer('test');
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'integration-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

after(async () => {
  await client.close();
  console.error = realConsoleError;
});

beforeEach(() => {
  fetched = [];
  blockNetwork();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('server metadata', () => {
  it('reports the package version', async () => {
    assert.deepEqual(client.getServerVersion(), { name: 'jw-mcp', version: pkg.version });
    assert.equal(manifest.version, pkg.version, 'manifest.json and package.json versions match');
  });
});

describe('tools/list', () => {
  let tools;
  before(async () => {
    ({ tools } = await client.listTools());
  });

  it('lists the same tools as manifest.json, each once', () => {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual([...names].sort(), manifest.tools.map((t) => t.name).sort());
  });

  it('gives every tool a title, a description and read-only annotations', () => {
    for (const tool of tools) {
      assert.equal(typeof tool.title, 'string', tool.name);
      assert.ok(tool.title.length >= 5 && tool.title.length <= 40, `${tool.name} title`);
      assert.ok(tool.description.length >= 80 && tool.description.length <= 600, `${tool.name} description length`);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: true }, tool.name);
    }
  });
});

describe('tools/call', () => {
  it('an unknown tool is an isError result naming the real tools', async () => {
    const result = await client.callTool({ name: 'get_bible_verses', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown tool "get_bible_verses"/);
    assert.match(text(result), /get_bible_verse,/);
  });
});

describe('callTool', () => {
  it('turns a handler that throws into an isError result', async () => {
    const boom = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'query')");
    };
    const result = await callTool({ params: { name: 'search_bible_books', arguments: {} } }, { handlers: [boom] });
    assert.equal(result.isError, true);
    assert.match(text(result), /search_bible_books failed unexpectedly: Cannot read properties/);
    assert.match(text(result), /Next step: /);
  });

  it('keeps the message and hint of a caller-facing error', async () => {
    const reject = async () => {
      throw new ArgError('chapter', 'abc', 'an integer from 1 to 150', { hint: 'Pass a chapter number.' });
    };
    const result = await callTool({ params: { name: 'get_bible_verse' } }, { handlers: [reject] });
    assert.equal(result.isError, true);
    assert.equal(text(result), 'Invalid "chapter": expected an integer from 1 to 150, got "abc".\nNext step: Pass a chapter number.');
  });

  it('gives handlers an arguments object when the client sent none', async () => {
    let seen;
    const spy = async (request) => {
      seen = request.params.arguments;
      return null;
    };
    await callTool({ params: { name: 'anything' } }, { handlers: [spy] });
    assert.deepEqual(seen, {});
  });

  it('asks the next handler when one returns null', async () => {
    const result = await callTool(
      { params: { name: 'x', arguments: {} } },
      { handlers: [async () => null, async () => ({ content: [{ type: 'text', text: 'ok' }] })] }
    );
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
  });
});

describe('argument names', () => {
  const run = (name, args) => callTool({ params: { name, arguments: args } });
  // Records the arguments a tool's handler receives.
  const spy = () => {
    const seen = [];
    const handlers = [async (req) => { seen.push(req.params.arguments); return { content: [{ type: 'text', text: '{}' }] }; }];
    return { seen, handlers };
  };

  it('maps lang and language to langwritten on every tool that has it', async () => {
    const { seen, handlers } = spy();
    await callTool({ params: { name: 'getWorkbookLinks', arguments: { lang: 'S' } } }, { handlers });
    await callTool({ params: { name: 'getWatchtowerLinks', arguments: { language: 'S', issue: '20260800' } } }, { handlers });
    assert.deepEqual(seen, [{ langwritten: 'S' }, { langwritten: 'S', issue: '20260800' }]);
  });

  it('maps link to url and the captions aliases to video_id', async () => {
    const { seen, handlers } = spy();
    const link = 'https://cfp2.jw-cdn.org/a/abc123/1/o/mwb_E_202609_04.rtf';
    await callTool({ params: { name: 'getWorkbookContent', arguments: { link } } }, { handlers });
    await callTool({ params: { name: 'get_jw_captions', arguments: { link: 'https://www.jw.org/finder?wtlocale=E&lank=pub-jwb-142_1_VIDEO' } } }, { handlers });
    assert.deepEqual(seen, [{ url: link }, { video_id: 'https://www.jw.org/finder?wtlocale=E&lank=pub-jwb-142_1_VIDEO' }]);
  });

  it('refuses a probable misspelling or a language under another name, before fetching', async () => {
    const study = await run('get_verse_with_study', { book: 43, chapter: 17, verse: '3', field: 'cross_references' });
    assert.equal(study.isError, true);
    assert.match(text(study), /Unknown argument "field" for get_verse_with_study; did you mean "fields"\?\nNext step: Its parameters are: book, chapter, verse/);
    for (const [key, meant] of [['langauge', 'langwritten'], ['wtlocale', 'langwritten'], ['locale', 'langwritten'], ['isue', 'issue']]) {
      const result = await run('getWorkbookLinks', { [key]: 'S' });
      assert.equal(result.isError, true, key);
      assert.match(text(result), new RegExp(`Unknown argument "${key}".*did you mean "${meant}"`), key);
    }
    assert.match(text(await run('get_jw_captions', { videoId: 'pub-jwb-142_1_VIDEO' })), /did you mean "video_id"/);
    assert.deepEqual(fetched, []);
  });

  it('drops any other unknown argument with a note, as 1.3.3 ignored it', async () => {
    const { seen, handlers } = spy();
    const verse = await callTool({ params: { name: 'get_bible_verse', arguments: { book: 43, chapter: 3, verse: 16, fields: ['verses'], limit: 3 } } }, { handlers });
    assert.equal(verse.isError, undefined);
    assert.equal(verse.content[0].text, '{}', 'the tool\'s JSON stays first');
    assert.deepEqual(seen.pop(), { book: 43, chapter: 3, verse: 16 });
    assert.equal(verse.content.at(-1).text, 'Ignored arguments "fields", "limit": get_bible_verse takes book, chapter, verse.');
    const links = await callTool({ params: { name: 'getWorkbookLinks', arguments: JSON.parse('{"__proto__": 1, "constructor": 2, "toString": 3, "translation": "nwt"}') } }, { handlers });
    assert.equal(links.isError, undefined);
    const passed = seen.pop();
    assert.deepEqual(Object.keys(passed), []);
    assert.equal(Object.getPrototypeOf(passed), Object.prototype);
    assert.match(links.content.at(-1).text, /^Ignored arguments "__proto__", "constructor", "toString", "translation": getWorkbookLinks takes pub, langwritten, issue, fileformat\.$/);
    const many = await callTool({ params: { name: 'getWorkbookLinks', arguments: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`junk${i}`, i])) } }, { handlers });
    assert.match(many.content.at(-1).text, /"junk9" and 20 more: getWorkbookLinks takes/);
  });

  it('refuses two names for one parameter that disagree', async () => {
    const result = await run('getWatchtowerLinks', { langwritten: 'S', language: 'French' });
    assert.equal(result.isError, true);
    assert.match(text(result), /"language" and "langwritten" disagree for getWatchtowerLinks/);
    assert.deepEqual(fetched, []);
  });
});
