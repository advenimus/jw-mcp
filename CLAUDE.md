# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a **Model Context Protocol (MCP) server** that provides tools for accessing JW.org content. The server has a single entry point (`src/index.js`) with two transport modes controlled by `MCP_TRANSPORT`:

1. **stdio** (default) — For local Claude Desktop / Claude Code integration
2. **http** — Docker/cloud deployment with OAuth 2.1 authentication

Requires Node >= 20.18.1 (cheerio and undici crash on older Node while loading). `src/index.js` checks the version before importing anything else.

## Project Structure

```
src/
├── index.js              # Entry point: Node version check, then stdio or http
├── mcp-server.js         # Server factory: tool list, titles/annotations, instructions, callTool()
├── http-server.js        # Express + OAuth + Streamable HTTP
├── auth.js               # OAuth 2.1 provider exports
├── auth/                 # Login page, CIMD, token store
└── tools/
    ├── http.js               # fetchText/fetchJson/fetchResource: timeouts, host allowlist, size cap, JwFetchError
    ├── fetch-with-timeout.js # Timeout defaults, default headers and error classes used by http.js
    ├── cache.js              # TtlLruCache and cached() (shared loads, failures not cached)
    ├── args.js               # Argument helpers (toInt, toStr, toEnum, toIsoDate, ...) that throw ArgError
    ├── results.js            # textResult/jsonResult/errorResult, ToolError, wrapTool(), token estimate and pageText
    ├── text.js               # cleanText, joinText (CJK-aware), asciiDigits, absoluteUrl: shared, no imports
    ├── songbook.js           # "Sing Out Joyfully": song video keys (pub-sjjm_<n>_VIDEO) -> WOL lyrics docid
    ├── languages.js          # resolveLanguage(): JW code / ISO tag / name -> code, jw.org path, WOL r/lp
    ├── scripture-tools.js    # search_bible_books, get_bible_verse, get_verse_with_study, get_bible_verse_url
    ├── bible-books.js        # Offline book/chapter/verse tables, reference parser, finder links
    ├── bible-api.js          # jw.org study-Bible JSON: verses, notes, footnotes, cross refs, outlines
    ├── wol-scraper.js        # WOL Bible chapter pages: Research Guide articles, fallback verse text
    ├── workbook-tools.js     # getWorkbookLinks, getWorkbookContent
    ├── watchtower-tools.js   # getWatchtowerLinks, getWatchtowerContent
    ├── rtf-utils.js          # Shared periodicals logic: issue/week rules, pub-media listings, file download
    ├── rtf-parser.js         # RTF to plain text
    ├── wol-tools.js          # get_daily_text, read_wol_document, search_wol
    └── captions-tool.js      # get_jw_captions
tests/
├── auth/, http-oauth.test.js # OAuth and HTTP connector
├── tools/                    # Offline tests, one file per area, plus integration.test.js (whole server)
└── live/                     # Live JW.org tests, skipped unless JW_MCP_LIVE=1; e2e.live.test.js spawns the server
```

## Tool Structure Pattern

Each tool file exports three things:

1. **Tool definitions**: `{ name, description, inputSchema }`. Keep them short; `tools/list` goes into every conversation.
2. **Implementations**: wrapped with `wrapTool`, so they never throw.
3. **Handler**: routes tool calls to implementations and returns `null` for tools it does not handle.

```javascript
import { isMissing, requireArgs, toInt, toStr } from './args.js';
import { LANGWRITTEN_DESCRIPTION, resolveLanguage } from './languages.js';
import { fetchJson } from './http.js';
import { ToolError, wrapTool } from './results.js';

// 1. Tool definition
export const exampleTool = {
  name: 'get_example',
  description: 'What it returns, and which tool to use next.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' },
      langwritten: { type: 'string', description: LANGWRITTEN_DESCRIPTION }
    },
    required: ['query']
  }
};

// 2. Implementation: validate, fetch, return plain data
export const getExampleImplementation = wrapTool(async (rawArgs) => {
  const args = requireArgs(rawArgs);                    // undefined/null -> {}
  const query = toStr(args.query, 'query');             // throws ArgError naming the parameter
  const limit = toInt(args.limit, 'limit', { min: 1, max: 50, default: 10 });
  const lang = await resolveLanguage(isMissing(args.langwritten) ? 'E' : args.langwritten);
  const data = await fetchJson(`https://b.jw-cdn.org/...${lang.code}`);  // throws JwFetchError
  if (!data.items.length) throw new ToolError(`Nothing found for "${query}".`, 'Try a shorter query.');
  return { query, items: data.items.slice(0, limit) };  // becomes a compact JSON result
}, 'get_example');

// 3. Handler
export async function handleExampleTools(request) {
  switch (request.params.name) {
    case 'get_example':
      return await getExampleImplementation(request.params.arguments ?? {});
    default:
      return null;  // MUST return null for unhandled tools
  }
}
```

Rules:

- Every failure the caller can cause or hit (bad input, 404, timeout, unexpected markup) must come back as `isError: true` with a message that says what failed and a hint that says what to do next. Throw `ArgError` (args.js; its hint defaults to `Fix "param" and call again.`), `ToolError` (results.js) or let `JwFetchError` (http.js) through; `wrapTool` turns them into `message\nNext step: hint`. Never return an error-ish payload with `isError` unset.
- Lookup tables keyed by caller or upstream text are object literals with `__proto__: null` (or `Map`s), so `constructor` and friends miss.
- A result should stay under about 22,000 tokens (`MAX_RESULT_TOKENS`; Claude Code cuts tool results at 25K tokens). Budget by `estimateTokens` (results.js), not characters: Japanese and Chinese run about one token a character, URLs and citations about two. Page text with `pageByTokens` (`offset`/`next_offset`, at most `PAGE_TOKENS` a page), or shorten and say so in `note` (see `fitStudyResult` in scripture-tools.js).
- Fetch with `http.js` (`fetchText`, `fetchJson`, `fetchResource`), never `fetch` directly. Pass `deadline` when a call makes more than one request.
- Cache parsed results, not raw pages: `cached(key, ttlMs, loader, { cache })` with a module-level `TtlLruCache` for large values. Prefix keys with the area and include the language.
- Content tools take `langwritten` (default `E`) and resolve it with `resolveLanguage` (`isMissing(v) ? 'E' : v`).
- Date-dependent tools take `date` (YYYY-MM-DD) and default to the server's local date (`toIsoDate`).
- Schemas: `integer` with `minimum`/`maximum` for numbers, `enum` for fixed choices, every property described, new parameters optional.

## Adding New Tools

1. Add the definition, implementation and handler case in a file under `src/tools/`.
2. Register in `src/mcp-server.js`: add the definition to `allTools`, the handler to `toolHandlers`, and a `TOOL_META` entry with a human `title`. Startup fails if a tool has no `TOOL_META` entry. Both stdio and http modes share this file. If the tool changes which tool an AI should pick, update `SERVER_INSTRUCTIONS` there too.
3. Add the tool to `manifest.json` `tools` and to README.md.
4. Add offline tests in `tests/tools/<area>.test.js` and a live test in `tests/live/<area>.live.test.js`. Add the tool's bad-input and realistic cases to `tests/tools/integration.test.js` and a call to `tests/live/e2e.live.test.js`. The integration test checks titles, annotations, schemas, the `tools/list` size budget (14,500 characters) and that the manifest matches.

## Running the Server

### Local Development (stdio mode)
```bash
npm start
```

### HTTP Mode with OAuth
```bash
MCP_TRANSPORT=http MCP_AUTH_SECRET=change-me-16chars MCP_BASE_URL=http://localhost:8080 npm run start:http
```

HTTP mode with auth off (`MCP_AUTH=false`) is loopback-only. Do not disable auth in Docker.

### Docker
```bash
docker compose up
```
Requires `.env` with `MCP_BASE_URL` and `MCP_AUTH_SECRET` (at least 16 characters). Compose binds `127.0.0.1:8080`. Put a TLS reverse proxy on the host and proxy to that loopback port. Do not publish 8080 publicly. Do not set `MCP_AUTH=false` in Docker.

## Testing

```bash
npm test               # offline: auth, http-oauth, tests/tools/*.test.js
npm run test:live      # JW_MCP_LIVE=1, tests/live/*.test.js (about 140 JW.org requests)
npm run test:coverage  # offline tests with c8 thresholds (auth, server and tools)
```

- Offline tests must not touch the network. Replace `globalThis.fetch` in `beforeEach` with a guard that throws, and stub it per test (see `tests/tools/foundation.test.js`).
- Use small synthetic fixtures that mimic JW.org markup, JSON or RTF structure. Do not commit copies of JW.org articles, RTF files, Bible chapter pages or caption files; one sentence is the most to embed.
- Live tests skip unless `JW_MCP_LIVE=1`. Be polite to JW.org: run a single live file while iterating (`JW_MCP_LIVE=1 node --test tests/live/wol.live.test.js`).

## Key Technical Details

### Transport Modes

**stdio mode** creates a single Server+Transport pair. **http mode** creates a new Server+Transport pair per session (SDK limitation: one transport per Server instance). The `createMcpServer()` factory function is shared.

### MCP Server (`src/mcp-server.js`)

- `allTools` adds a `title` and `annotations` (`readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`) to every tool definition. Even the book and link tools fetch a language's book names when `langwritten` is set.
- `SERVER_INSTRUCTIONS` is sent at initialize and tells the AI which tool to use for what, and that `langwritten` selects the language.
- `callTool()` handles every `tools/call`: it checks `arguments ?? {}` against the tool's schema (`normalizeArgs`): `lang`/`language` become `langwritten` on tools that have it, `TOOL_ALIASES` maps per-tool names (`link` -> `url`, captions' `url`/`lank` -> `video_id`), `HIDDEN_PARAMS` lists accepted keys left out of the schema (1.3.3's `pub`, `max_chars`), a key within edit distance 1 (names of 4 characters or fewer) or 2 of a parameter, or a lang/locale-like key on a tool with `langwritten`, is an `isError` result naming the likely parameter, and any other key is dropped and listed in a trailing "Ignored argument ..." text block (1.3.3 ignored them; `content[0]` stays the tool's JSON). Then it passes the arguments to the handlers, turns a thrown error into an `isError` result (`errorToResult`) and answers an unknown tool name with an `isError` result listing the real tools. It never throws to the SDK.

### OAuth Authentication (`src/auth.js`)

When `MCP_AUTH` is not `false` and `MCP_AUTH_SECRET` is set:
- OAuth 2.1 + PKCE (S256) via the MCP SDK, plus CIMD for ChatGPT/Claude
- Login page at `/authorize` requires `MCP_AUTH_SECRET`
- Timing-safe secret comparison via `node:crypto`
- 24h access tokens, rotating 30-day refresh tokens, 10-min auth codes
- Protected resource URL is `{MCP_BASE_URL}/mcp`
- `requireBearerAuth` middleware protects `/mcp` endpoints
- Optional file store at `AUTH_STORE_PATH` (Docker default `/data/auth.json`)

### HTTP and Errors (`http.js`)

- Only https URLs on allowed JW.org hosts are fetched, also after redirects. Responses over 5 MB are refused.
- One time budget per request covers redirects, one retry (network errors, 502/503/504) and reading the body: `JW_MCP_FETCH_TIMEOUT_MS`, default 20000 ms, max 600000. `deadline` caps a whole multi-request call. A call that joins another call's in-flight `cached()` load retries on its own budget when that load timed out.
- Sends browser-like headers (`DEFAULT_HEADERS`); JW.org needs them.
- Failures throw `JwFetchError` with `kind` (`timeout`, `http`, `too_large`, `blocked_host`, `network`, `bad_content`), `status`, `url` and a `hint`. Pass `hints` to tailor the hint per status. A 401/403 says JW.org refused this server (its CDN blocks some networks); links do not expire. A timeout set by the call's `deadline` says the call ran out of its budget, not to raise `JW_MCP_FETCH_TIMEOUT_MS`.

### Languages (`languages.js`)

`resolveLanguage(input)` accepts a JW.org code (`E`, `S`, `CHS`), an ISO tag (`es`, `pt-BR`, `zh-Hant`) or a name (`Spanish`, `español`) and returns `{code, iso, name, jwPath, wol: {r, lp, path}, ...}`. 19 built-in languages never touch the network; any other is looked up in the mediator language list and the WOL finder (cached a day). The built-in table is searched before the full list, and in each, all-uppercase input is read as a JW code first, anything else as an ISO tag first, so free-text `TL` is Tagalog (ISO `tl`); for the ten all-caps ISO tags that are also another language's JW code (`ISO_CODE_CLASHES`: `TL`, `RU`, `EN`, ...) the entry carries a `note`, which the tools put first in the result's `note`. Names ignore word order and parentheses (`Traditional Chinese` = `Chinese (Traditional)`), and a miss suggests up to three directory names. Pass `deadline` from a tool's call budget. A value that is certainly a JW code (an entry's `code`, `wtlocale=`, a key's language) must be resolved with `resolveLanguage(code, { as: 'code' })`, which matches codes only: `TL` is then Tamil. `wolUrl(lang, type, ...)` builds WOL URLs; `wol` is null for languages without a WOL library.

### Bible Scripture Tools
- `bible-books.js` is offline: book names and abbreviations, NWT chapter and verse counts (John 7 has 52 verses, Mark 16 has 8), the 16 omitted verses and the two passages without verse numbers (a range that runs into one is trimmed, with a note), the reference parser (`referencesFromArgs(args, { lang })`) and jw.org finder links. Arguments longer than 100 (book) or 1000 (verse, reference) characters are refused before any regex runs. `registerBookNames(code, editionData.books)` teaches it a language's names; with `lang`, a local name exactly as written beats an English alias (French `Éz` is Ezekiel), which beats an accent-folded local name (Vietnamese `Dan.` is Daniel, not `Dân`). The scripture tools load the names (`loadBookNames`, one cached request) before they parse a reference with letters in it, so the result never depends on call order. Part-verse letters (`16b`, `16ff`) are dropped with a note; a `;` list can come as an array (`referenceListText`). `normalizeReferenceText` reads reference text the way the parser does (NFKC, Arabic-Indic digits and `،`/`؛` as ASCII, every dash as `-`); local names with a digit after a letter (Korean `요한 1서`, `요1`) are matched first (`digitNames`). The study notes' `, ftn.` / `; ftn.` sets `ref.footnote` (the verse's footnotes are returned, with a note when there are none). `verse` with a whole-chapter `reference` selects its verses; otherwise it must match (`applyVerse`).
- `bible-api.js` reads jw.org's study-Bible JSON (`/<lang>/library/bible/study-bible/books/json/data/<BBCCC000-BBCCC999>`), one whole chapter per request: the id jw.org's own chapter pages request, so the CDN keeps it warm, and a second verse of a chapter comes from the cache. It is the main source for verse text, study notes, footnotes (with the `phrase` their marker follows), cross references and outlines (`getBibleDataMany` serves a `;` list, 4 chapters at a time). Poetry (`style-l`/`style-z` lines) keeps one line per `\n` and sets `poetry: true` on the verse. Cross references and footnotes are sorted by the position of their markers in the verse (jw.org's lists are often out of order). Pinyin/furigana `<ruby>` readings are dropped and CJK lines joined without spaces. When it fails, `get_bible_verse` reads WOL chapter pages instead, at most 4 at a time (`mapPool`), stopping at the first 429/5xx/timeout; a 429 gets no fallback at all. Fields of the wrong type are read as empty; unusable verses are a `bad_content` JwFetchError, so the WOL text fallback runs.
- `wol-scraper.js` reads WOL Bible chapter pages for the Research Guide (`study_articles`) and as the fallback for verse text. English pages pair a title link with an unlinked citation; other languages use a citation index (every line a link, publication in `<em>`/`<strong>`, `p.sk` issue lines grouped under a `p.su` publication line), where the citation becomes the title. Arabic items hold both (titled pairs first, then an index). The verse-text fallback keeps poetry lines (`p.sl`/`p.sz`, `poetry`) and joins prose segments with `joinText`.
- Book numbers: 1-39 Hebrew Scriptures, 40-66 Christian Greek Scriptures. Finder links encode `BBCCCVVV` (book 19, chapter 83, verse 18 → `19083018`); a whole chapter is `BBCCC000`.
- In English the Study Edition has study notes for Matthew to James only.

### Meeting Workbook and Watchtower (`rtf-utils.js`)
- A week (Monday to Sunday) belongs to the month of its Monday.
- **Workbook** (`mwb`): bimonthly since 2021, so the issue is that month rounded down to an odd month (`20261100` = November–December 2026).
- **Watchtower** (`w`): issue M holds the study weeks whose Monday falls in month M+2 (the August 2026 issue covers October 5 to November 1, 2026). Before 2016 the study edition was dated the 15th: issue codes are `YYYYMM15` (`issueCode(year, month, pub)`).
- The tools take `date` (YYYY-MM-DD) and default to the server's local date. In Docker (UTC) the descriptions tell the AI to pass the user's local date. `date` with `week` must agree.
- A call makes one pub-media listing request plus one file download; listings and parsed files are cached for an hour. One budget covers the call: `max(50 s, 2 x JW_MCP_FETCH_TIMEOUT_MS)`. A song video link in `links` is followed by its lyrics page (`finder?docid=`, `songbook.js`). Languages without RTF (e.g. Japanese) fall back to TXT. Sign-language editions have only video (`MP4`, `3GP`; one file per resolution, so weeks are numbered per distinct start date).
- A week the issue skips (Memorial week in the workbook) is an error that names the undated item filed between the weeks around it (`gapEntry`: the Memorial Bible Reading Schedule) and its `url`. A `url` read looks up the issue's listing (the same cached request) for `pubName`, `language` and `link`.
- pub-media takes the JW code itself, so when the mediator language list is down a code-like `langwritten` is used as given (`periodicalLanguage`, iso `und`; month names then come from the listing's locale).
- Content results page `parsedText` with `pageByTokens` (`offset`/`next_offset` appear only when a file needs more than one page); a listing returns at most 200 entries.

### RTF Parsing
`rtf-parser.js` keeps the published text verbatim: one line per paragraph, a blank line before headings, `\line` as a space, bullets as `•`, table cells joined with ` | `. Its output matches LibreOffice's text export word for word. Parsed text is about 22-27% of the RTF size. Do not post-process it with heuristics. `parseRTFDocument()` also returns the title, headings and links.

### WOL Tools (`wol-tools.js`)
- `get_daily_text` reads `/wol/h/<r>/<lp>/YYYY/M/D` (one page holds three days). WOL has recent years only. Memorial-season headings are `<br>`-separated lines (joined with ` · `), and `.closingContent` holds that day's Memorial Bible reading (`memorial_reading`, else null).
- `read_wol_document` follows `/wol/pc/`, `/tc/` and `/bc/` citation links (they redirect to `/wol/d/...#h=` or `/wol/b/...#v=`; a citation of several ranges answers 200 with a list of excerpt cards, whose `/wol/d/` links are read instead), opens jw.org `finder?docid=` links as `/wol/d/<docid>` in the `wtlocale` language, opens a www.jw.org article page through the docid in its `<body>` (`mid<docid>` / `docId-<docid>`, language `ml-<code>`; one cached request; never the first `docid=` on the page), pages long text with `offset`/`next_offset` (`max_chars` at most 80000, and a page at most `PAGE_TOKENS`), marks cited paragraphs with `▶` (`cited.paragraphs` are their printed numbers), and `cited_only` returns the cited paragraphs. `citedParts` gives `{i, start, end}` per block: `#h=` cites whole blocks, `#v=` only its verses (a Bible `<p>` holds several; blocks carry `starts`). `citedText` adds the footnotes the cited parts mark (blocks carry `notes: [{id, at}]`, footnote blocks `fnid`). Bible chapter pages keep their footnotes outside `#article` (`li[data-extract-id=verseFootnote-<id>]`); they are appended as `[*n] <verse>: <text>`. Picture captions are marked `🖼 ` (language-neutral, like `▶`). A song video link (`lank=pub-sjjm_<n>_VIDEO`) opens the song's lyrics docid. `get_daily_text` with `sources: true` reads the cited paragraphs of each source link. Each WOL tool call has one budget (`CALL_BUDGET_MS`, 2x the request timeout), language lookups included.
- `search_wol` uses WOL's search page (40 results per page, total in `#searchResultsTotal`). Page 1 also has a glossary card (`ul.resultContentTopic`) whatever the filter; it is returned as `glossary` and never counted as a result. `wolQueryText` removes punctuation WOL would treat as part of a word (`—`, word-final `, . ; : ? !`) and the result says so (`searched`, `note`).

### Captions (`captions-tool.js`)
Mediator `media-items/<code>/<key>?clientType=www`, then the WebVTT file on `*.jw-cdn.org`. A docid or page link may need the finder or the page HTML first; a category link or `latest:<Category>` reads `categories/<code>/<Category>?clientType=www`: `LatestVideos` and `StudioMonthlyPrograms` list newest first (`limit=6`, more for `~N`), other categories are in jw.org's curated order, so they are read whole (`limit=100`, up to 5 pages) and sorted by `firstPublished`. The note lists the five videos before the one returned; `latest:<Category>~N` and "previous ..." read further back, and "August 2026 broadcast" pages `StudioMonthlyPrograms` by `firstPublished`. A group of categories (`type: container`) lists its categories only with `detailed=1`. Free text such as "latest morning worship" maps to a key through `CATEGORY_ALIASES`; a camel-case key is used as given. "last/this month's broadcast" and a month without a year ("September broadcast") are dated by `parseVideoReference(input, { now })` (default: the server's local date); other categories are not found by date. Category listings are cached as slim items (`slimItem`: key, title, string firstPublished, trimmed media), and every `~N` within the same pages shares one listing. "Governing Body update" is a `SERIES` within `StudioNewsReports`: only the items whose English title is "<year> Governing Body Update #n" count (excerpts and news reports share the category), matched across languages by `languageAgnosticNaturalKey`. One 40 s deadline covers the call. The result is a JSON metadata block plus the transcript as a second text block; a video with no caption file returns metadata with `captions_available: false` (not an error); for a song video (`songbook.js`) its `next_step` names the lyrics page. Parts default to 60,000 characters (a monthly program), at most 80,000 (50,000 for vtt) and `PAGE_TOKENS`, and a longer transcript is split into equal parts. Wrapped lines inside a cue join tight in CJK; English captions (`closedDashes`, keyed on the captions' language) join at a closed em dash; cue breaks stay a space unless the cue ends in CJK punctuation (JW's Japanese captions have no `。`). Identical cues are merged only when they overlap in time (repeated lyrics and replies stay), and the text formats drop the opening quotation marks English captions repeat at the start of every cue of an open quotation (`dropContinuationMarks`).

## MCP Response Format

Implementations wrapped with `wrapTool` can return:
- plain data → compact JSON text result (`jsonResult`; `jsonText` is the serializer, so size checks measure the same text)
- a string → text result
- a full MCP result `{ content: [...] }` → passed through (use this for several content blocks)

Errors become:
```javascript
{
  content: [{ type: 'text', text: 'What failed.\nNext step: how to fix the call.' }],
  isError: true
}
```

## Docker Deployment

Docker image published to `ghcr.io/advenimus/jw-mcp` on each release. Environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_TRANSPORT` | No | `stdio` | Set to `http` for Docker |
| `MCP_PORT` | No | `8080` | HTTP listen port |
| `MCP_BASE_URL` | Yes (http) | — | Public origin, no path, no port (`https://jw-mcp.example.com`). Claude.ai only connects on 443. |
| `MCP_AUTH` | No | `true` | Leave `true`. HTTP with auth off is loopback-only. Do not disable auth in Docker. |
| `MCP_AUTH_SECRET` | Yes (http) | — | Access key (min 16 chars) |
| `MCP_TRUST_PROXY` | No | unset | Set `true` only when exactly one proxy (Caddy, nginx, Cloudflare Tunnel) sets or appends the client IP in `X-Forwarded-For`. Trusts one hop. |
| `AUTH_STORE_PATH` | No | `/data/auth.json` in Docker | File store for clients and tokens |
| `CLOUDFLARE_TUNNEL_TOKEN` | No | — | Token for the optional `cloudflared` compose service (`--profile tunnel`) |
| `JW_MCP_FETCH_TIMEOUT_MS` | No | `20000` | Time limit per JW.org request, including reading the body (max 600000); a tool call's budget is twice this (at least 50 s for the periodicals) |

## Language Support

Every content tool takes `langwritten` (default `E`): a JW.org code (`E` English, `S` Spanish, `F` French, `T` Portuguese, `X` German, `J` Japanese, `KO` Korean, `CHS` Chinese Simplified, ...), an ISO tag (`es`) or a language name (`Spanish`). `search_bible_books` takes it only to match that language's book names. `read_wol_document` reads `docid`, finder links, jw.org article links and `/wol/d/` links in it; other WOL links are read as given, with a note. `get_jw_captions` defaults to the language in the link. Not every publication exists in every language; the tools say so in an `isError` result.
