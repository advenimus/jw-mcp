// Offline tests for the assembled server: tools/list as a client sees it, and
// every tool's failure path through tools/call. globalThis.fetch is replaced
// in every test, so nothing here can reach JW.org.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SERVER_INSTRUCTIONS, allTools, callTool, createMcpServer } from '../../src/mcp-server.js';
import { ArgError } from '../../src/tools/args.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

// Tools that answer English calls from local data; all others fetch from JW.org.
const LOCAL_TOOLS = new Set(['search_bible_books', 'get_bible_verse_url']);
// Keeps tools/list small enough to send with every conversation (~3.5K tokens).
const MAX_TOOLS_LIST_CHARS = 14500;

const REALISTIC = {
  search_bible_books: { query: 'john' },
  get_bible_verse: { reference: 'John 3:16' },
  get_verse_with_study: { reference: 'Matt. 24:14', fields: ['verses', 'study_notes', 'study_articles'] },
  get_bible_verse_url: { reference: 'Ps. 83:18' },
  getWorkbookLinks: {},
  getWorkbookContent: {},
  getWatchtowerLinks: {},
  getWatchtowerContent: {},
  get_daily_text: {},
  read_wol_document: { url: 'https://wol.jw.org/en/wol/d/r1/lp-e/2025241' },
  search_wol: { query: 'kingdom' },
  get_jw_captions: { video_id: 'pub-jwb-142_1_VIDEO' }
};

// Bad input for each tool, and a pattern the error must contain.
const GARBAGE = {
  search_bible_books: [
    [{ query: '' }, /"query"/],
    [{ query: 'john', limit: 'many' }, /"limit"/],
    [{ query: 'zzzz' }, /No Bible book matches/]
  ],
  get_bible_verse: [
    [{ book: 99, chapter: 1 }, /"book"/],
    [{ reference: 'John 99:1' }, /21 chapters/],
    [{ reference: 'John 3:16', langwritten: 42 }, /"langwritten"/]
  ],
  get_verse_with_study: [
    [{ reference: 'John 3:16', fields: ['bogus'] }, /"fields"/],
    [{ reference: 'John 3:16', limit: 'many' }, /"limit"/],
    [{ reference: 'John 3:16', fetch: 'maybe' }, /"fetch"/]
  ],
  get_bible_verse_url: [
    [{ book: 1, chapter: 51 }, /50 chapters/],
    [{ reference: 'Hezekiah 1:1' }, /Unknown Bible book/]
  ],
  getWorkbookLinks: [
    [{ date: '2026-13-45' }, /"date"/],
    [{ fileformat: 'DOCX' }, /"fileformat"/],
    [{ issue: 'abc' }, /odd months/]
  ],
  getWorkbookContent: [
    [{ week: 0 }, /"week"/],
    [{ url: 'http://127.0.0.1/x.rtf' }, /"url"/],
    [{ url: 'https://example.com/a.rtf' }, /"url"/]
  ],
  getWatchtowerLinks: [
    [{ issue: '1999' }, /"issue"/],
    [{ date: 'yesterday' }, /"date"/]
  ],
  getWatchtowerContent: [
    [{ week: 'two' }, /"week"/],
    [{ url: 'file:///etc/passwd' }, /"url"/]
  ],
  get_daily_text: [
    [{ date: '2026-02-30' }, /"date"/],
    [{ langwritten: 42 }, /"langwritten"/]
  ],
  read_wol_document: [
    [{ url: 'https://example.com/' }, /"url"/],
    [{ url: 'https://wol.jw.org/en/wol/d/r1/lp-e/1', max_chars: 5 }, /"max_chars"/]
  ],
  search_wol: [
    [{ query: 'x'.repeat(300) }, /"query"/],
    [{ query: 'love', publications: ['comics'] }, /"publications"/],
    [{ query: 'love', page: 0 }, /"page"/]
  ],
  get_jw_captions: [
    [{ video_id: 'pub-x_1_VIDEO', format: 'mp4' }, /"format"/],
    [{ video_id: 'not a video at all' }, /Could not find a JW.org video/],
    [{ video_id: {} }, /"video_id"/]
  ]
};

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
let fetched;

function blockNetwork() {
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    throw new Error(`offline test tried to fetch ${url}`);
  };
}

function useFetch(handler) {
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    return handler(String(url), init);
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
  it('reports the package version and instructions that name every tool', async () => {
    assert.deepEqual(client.getServerVersion(), { name: 'jw-mcp', version: pkg.version });
    assert.equal(manifest.version, pkg.version, 'manifest.json and package.json versions match');
    const instructions = client.getInstructions();
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.match(instructions, /langwritten/);
    for (const tool of allTools) assert.match(instructions, new RegExp(`\\b${tool.name}\\b`), tool.name);
    // latest:StudioNewsReports is the whole news category, not the Governing Body updates.
    assert.doesNotMatch(instructions, /"latest Governing Body update" \(latest:StudioNewsReports\)/);
    // read_wol_document does not read daily text pages.
    assert.doesNotMatch(instructions, /any wol\.jw\.org link/);
    assert.match(instructions, /\/wol\/h\/[^.]*get_daily_text/);
  });
});

describe('tools/list', () => {
  let tools;
  before(async () => {
    ({ tools } = await client.listTools());
  });

  it('lists the same 12 tools as manifest.json, each once', () => {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual([...names].sort(), manifest.tools.map((t) => t.name).sort());
    assert.equal(names.length, 12);
  });

  it('gives every tool a title, a description and read-only annotations', () => {
    for (const tool of tools) {
      assert.equal(typeof tool.title, 'string', tool.name);
      assert.ok(tool.title.length >= 5 && tool.title.length <= 40, `${tool.name} title`);
      assert.ok(tool.description.length >= 80 && tool.description.length <= 600, `${tool.name} description length`);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        idempotentHint: true,
        // The local tools fetch a language's book names when langwritten is set.
        openWorldHint: true
      }, tool.name);
    }
  });

  it('has valid input schemas: typed, described properties; integers with bounds', () => {
    const TYPES = new Set(['string', 'integer', 'boolean', 'array', 'object']);
    const KEYS = new Set(['type', 'description', 'enum', 'minimum', 'maximum', 'items', 'default']);
    const check = (schema, where) => {
      assert.ok(TYPES.has(schema.type), `${where}: type ${schema.type}`);
      for (const key of Object.keys(schema)) assert.ok(KEYS.has(key), `${where}: unexpected key ${key}`);
      if (schema.type === 'integer') {
        assert.equal(typeof schema.minimum, 'number', `${where}: integer needs a minimum`);
        if (schema.maximum !== undefined) assert.ok(schema.maximum >= schema.minimum, where);
      }
      if (schema.enum) {
        assert.ok(schema.enum.length > 0 && schema.enum.every((v) => typeof v === 'string'), `${where}: enum`);
        assert.equal(new Set(schema.enum).size, schema.enum.length, `${where}: duplicate enum values`);
      }
      if (schema.type === 'array') check(schema.items, `${where}[]`);
    };
    for (const tool of tools) {
      const { type, properties, required = [] } = tool.inputSchema;
      assert.equal(type, 'object', tool.name);
      assert.ok(Object.keys(properties).length > 0, tool.name);
      for (const name of required) assert.ok(properties[name], `${tool.name}: required "${name}" is a property`);
      for (const [name, schema] of Object.entries(properties)) {
        assert.ok(schema.description?.trim(), `${tool.name}.${name} has a description`);
        check(schema, `${tool.name}.${name}`);
      }
    }
  });

  it('uses the same parameter shapes across tools', () => {
    for (const tool of tools) {
      const { properties } = tool.inputSchema;
      if (tool.name !== 'search_bible_books') {
        assert.equal(properties.langwritten?.type, 'string', `${tool.name} takes langwritten`);
        assert.match(properties.langwritten.description, /Default/, `${tool.name} langwritten default`);
      }
      if (properties.date) assert.match(properties.date.description, /YYYY-MM-DD/, `${tool.name}.date`);
      if (properties.reference) {
        assert.deepEqual(properties.book, { type: 'integer', minimum: 1, maximum: 66, description: properties.book.description });
        assert.equal(properties.chapter.type, 'integer');
        assert.equal(properties.verse.type, 'string', `${tool.name}.verse is a string in every verse tool`);
      }
      for (const name of ['offset', 'max_chars', 'limit', 'page', 'week']) {
        if (properties[name]) assert.equal(properties[name].type, 'integer', `${tool.name}.${name}`);
      }
    }
  });

  it('cross-references the follow-up tools in the descriptions', () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
    assert.match(byName.get_bible_verse, /get_verse_with_study/);
    assert.match(byName.get_bible_verse, /get_bible_verse_url/);
    assert.match(byName.get_verse_with_study, /read_wol_document/);
    assert.match(byName.getWorkbookLinks, /getWorkbookContent/);
    assert.match(byName.getWorkbookContent, /getWorkbookLinks/);
    assert.match(byName.getWatchtowerLinks, /getWatchtowerContent/);
    assert.match(byName.getWatchtowerContent, /getWatchtowerLinks/);
    assert.match(byName.get_daily_text, /read_wol_document/);
    assert.match(byName.search_wol, /read_wol_document/);
    assert.match(byName.get_jw_captions, /next_offset/);
    assert.match(byName.read_wol_document, /next_offset/);
  });

  it(`stays under ${MAX_TOOLS_LIST_CHARS} characters`, () => {
    const size = JSON.stringify({ tools }).length;
    assert.ok(size <= MAX_TOOLS_LIST_CHARS, `tools/list is ${size} characters`);
  });

  it('accepts the realistic example input of every tool', () => {
    for (const tool of tools) {
      const example = REALISTIC[tool.name];
      assert.ok(example, `${tool.name} has an example`);
      for (const name of tool.inputSchema.required ?? []) assert.ok(name in example, `${tool.name} example has ${name}`);
      for (const [name, value] of Object.entries(example)) {
        const schema = tool.inputSchema.properties[name];
        assert.ok(schema, `${tool.name} has a "${name}" property`);
        assert.equal(Array.isArray(value) ? 'array' : typeof value, schema.type === 'integer' ? 'number' : schema.type, `${tool.name}.${name}`);
      }
    }
  });
});

describe('tools/call failures are isError results', () => {
  for (const [name, cases] of Object.entries(GARBAGE)) {
    it(`${name}: bad arguments fail without touching the network`, async () => {
      for (const [args, pattern] of cases) {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.match(text(result), pattern, `${name} ${JSON.stringify(args)}`);
        assert.doesNotMatch(text(result), /TypeError|undefined|failed unexpectedly/, `${name} ${JSON.stringify(args)}`);
      }
      assert.deepEqual(fetched, [], `${name} fetched`);
    });
  }

  it('tools with required parameters reject a call without arguments', async () => {
    for (const tool of allTools) {
      const needsInput = (tool.inputSchema.required ?? []).length > 0 || 'reference' in tool.inputSchema.properties || tool.name === 'read_wol_document';
      if (!needsInput) continue;
      const result = await client.callTool({ name: tool.name });
      assert.equal(result.isError, true, tool.name);
      assert.match(text(result), /Missing/, tool.name);
    }
    assert.deepEqual(fetched, []);
  });

  it('every network tool reports a JW.org 404 as an error with a next step', async () => {
    useFetch(() => new Response('<html>not here</html>', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/html' } }));
    for (const tool of allTools) {
      const result = await client.callTool({ name: tool.name, arguments: REALISTIC[tool.name] });
      if (LOCAL_TOOLS.has(tool.name)) {
        assert.equal(result.isError, undefined, tool.name);
        continue;
      }
      assert.equal(result.isError, true, tool.name);
      assert.match(text(result), /\nNext step: /, tool.name);
    }
    assert.ok(fetched.length >= allTools.length - LOCAL_TOOLS.size);
  });

  it('every network tool reports an unreachable JW.org as an error', async () => {
    useFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    });
    for (const tool of allTools.filter((t) => !LOCAL_TOOLS.has(t.name))) {
      const result = await client.callTool({ name: tool.name, arguments: REALISTIC[tool.name] });
      assert.equal(result.isError, true, tool.name);
      assert.match(text(result), /Could not reach .*ENOTFOUND/, tool.name);
    }
  });

  it('answers arguments nested too deeply for JSON with an ordinary argument error', async () => {
    const deep = JSON.parse('['.repeat(20000) + ']'.repeat(20000));
    for (const tool of allTools) {
      for (const name of Object.keys(tool.inputSchema.properties)) {
        // A deep value is rejected, or ignored where another argument wins (verse next to reference).
        const result = await callTool({ params: { name: tool.name, arguments: { ...REALISTIC[tool.name], [name]: deep } } });
        assert.doesNotMatch(text(result), /unexpectedly|Maximum call stack/, `${tool.name}.${name}`);
        const alone = await callTool({ params: { name: tool.name, arguments: { [name]: deep } } });
        assert.equal(alone.isError, true, `${tool.name}.${name} alone`);
        assert.doesNotMatch(text(alone), /unexpectedly|Maximum call stack/, `${tool.name}.${name} alone`);
      }
    }
    const reference = await callTool({ params: { name: 'get_bible_verse', arguments: { reference: deep } } });
    assert.match(text(reference), /^Invalid "reference"[^]*got array \(too deeply nested to show\)/);
  });

  it('an unknown tool is an isError result naming the real tools', async () => {
    const result = await client.callTool({ name: 'get_bible_verses', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown tool "get_bible_verses"/);
    assert.match(text(result), /get_bible_verse,/);
  });
});

describe('content tools', () => {
  it('getWorkbookContent returns the links in the RTF next to parsedText', async () => {
    const rtf =
      '{\\rtf1\\ansi {\\info{\\title Sample week}}\\pard Sample week heading\\par\\pard ' +
      '{\\field{\\*\\fldinst HYPERLINK "https://www.jw.org/finder?wtlocale=E&lank=pub-sjjm_1_VIDEO"}{\\fldrslt Song 1}}' +
      ' and opening comments (1 min.)\\par}';
    useFetch(() => new Response(rtf, { status: 200, headers: { 'content-type': 'application/rtf' } }));
    const result = await client.callTool({
      name: 'getWorkbookContent',
      arguments: { url: 'https://cfp2.jw-cdn.org/a/abc123/1/o/mwb_E_202609_04.rtf' }
    });
    assert.equal(result.isError, undefined, text(result));
    const json = JSON.parse(text(result));
    assert.deepEqual(json.links, [
      { text: 'Song 1', url: 'https://www.jw.org/finder?wtlocale=E&lank=pub-sjjm_1_VIDEO' },
      { text: 'Song 1 lyrics', url: 'https://www.jw.org/finder?wtlocale=E&docid=1102016801' }
    ]);
    assert.equal(json.parsedText, 'Sample week heading\nSong 1 and opening comments (1 min.)');
    assert.equal(json.issue, '20260900');
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

  it('maps lang and language to langwritten on every tool that has it', async () => {
    await run('get_daily_text', { lang: 'S', date: '2026-10-11' });
    assert.ok(fetched.some((u) => u.startsWith('https://wol.jw.org/es/wol/h/r4/lp-s/')), fetched.join('\n'));
    fetched = [];
    await run('getWatchtowerContent', { language: 'Spanish' });
    assert.ok(fetched.some((u) => u.includes('GETPUBMEDIALINKS') && u.includes('langwritten=S')), fetched.join('\n'));
    fetched = [];
    await run('search_wol', { query: 'resurrección', lang: 'S' });
    assert.ok(fetched.some((u) => u.startsWith('https://wol.jw.org/es/wol/s/r4/lp-s')), fetched.join('\n'));
  });

  it('maps link to url and the captions aliases to video_id', async () => {
    await run('read_wol_document', { link: 'https://wol.jw.org/en/wol/d/r1/lp-e/2025241' });
    assert.ok(fetched.includes('https://wol.jw.org/en/wol/d/r1/lp-e/2025241'), fetched.join('\n'));
    fetched = [];
    await run('get_jw_captions', { link: 'https://www.jw.org/finder?wtlocale=E&lank=pub-jwb-142_1_VIDEO' });
    assert.ok(fetched.some((u) => u.includes('pub-jwb-142_1_VIDEO')), fetched.join('\n'));
  });

  it('refuses a probable misspelling or a language under another name, before fetching', async () => {
    const study = await run('get_verse_with_study', { reference: 'John 17:3', field: 'cross_references' });
    assert.equal(study.isError, true);
    assert.match(text(study), /Unknown argument "field" for get_verse_with_study; did you mean "fields"\?\nNext step: Its parameters are: reference, book/);
    for (const [key, meant] of [['referense', 'reference'], ['langauge', 'langwritten'], ['wtlocale', 'langwritten'], ['locale', 'langwritten']]) {
      const result = await run('get_bible_verse', { reference: 'John 3:16', [key]: 'S' });
      assert.equal(result.isError, true, key);
      assert.match(text(result), new RegExp(`Unknown argument "${key}".*did you mean "${meant}"`), key);
    }
    assert.match(text(await run('get_jw_captions', { videoId: 'pub-jwb-142_1_VIDEO' })), /did you mean "video_id"/);
    assert.equal((await run('search_bible_books', { query: 'John', language: 'S', limit: 1 })).isError, undefined);
    assert.deepEqual(fetched.filter((u) => !u.startsWith('https://www.jw.org/')), []);
  });

  it('drops any other unknown argument with a note, as 1.3.3 ignored it', async () => {
    const seen = [];
    const handlers = [async (req) => { seen.push(req.params.arguments); return { content: [{ type: 'text', text: '{}' }] }; }];
    const verse = await callTool({ params: { name: 'get_bible_verse', arguments: { book: 43, chapter: 3, verse: 16, fields: ['verses'], limit: 3 } } }, { handlers });
    assert.equal(verse.isError, undefined);
    assert.equal(verse.content[0].text, '{}', 'the tool\'s JSON stays first');
    assert.deepEqual(seen.pop(), { book: 43, chapter: 3, verse: 16 });
    assert.equal(verse.content.at(-1).text, 'Ignored arguments "fields", "limit": get_bible_verse takes reference, book, chapter, verse, langwritten, pronunciation_marks.');
    const daily = await callTool({ params: { name: 'get_daily_text', arguments: JSON.parse('{"__proto__": 1, "constructor": 2, "toString": 3, "translation": "nwt"}') } }, { handlers });
    assert.equal(daily.isError, undefined);
    const passed = seen.pop();
    assert.deepEqual(Object.keys(passed), []);
    assert.equal(Object.getPrototypeOf(passed), Object.prototype);
    assert.match(daily.content.at(-1).text, /^Ignored arguments "__proto__", "constructor", "toString", "translation": get_daily_text takes date, langwritten, sources\.$/);
    const many = await callTool({ params: { name: 'get_daily_text', arguments: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`junk${i}`, i])) } }, { handlers });
    assert.match(many.content.at(-1).text, /"junk9" and 20 more: get_daily_text takes/);
    const real = await run('search_bible_books', { query: 'John', foo: 1 });
    assert.equal(real.isError, undefined);
    assert.equal(real.content.length, 2);
    assert.match(real.content[1].text, /^Ignored argument "foo": search_bible_books takes query, limit, langwritten\.$/);
  });

  it('still accepts the hidden parameters', async () => {
    const links = await run('getWorkbookLinks', { pub: 'mwb' });
    assert.doesNotMatch(text(links), /Unknown argument/);
    assert.ok(fetched.length > 0);
    const content = await run('getWatchtowerContent', { max_chars: 2000 });
    assert.doesNotMatch(text(content), /Unknown argument/);
  });

  it('refuses two names for one parameter that disagree', async () => {
    const result = await run('get_bible_verse', { reference: 'John 3:16', langwritten: 'S', language: 'French' });
    assert.equal(result.isError, true);
    assert.match(text(result), /"language" and "langwritten" disagree for get_bible_verse/);
    assert.deepEqual(fetched, []);
  });
});
