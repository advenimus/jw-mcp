# JW MCP Server

[![npm version](https://img.shields.io/npm/v/jw-mcp)](https://www.npmjs.com/package/jw-mcp)
[![GitHub Release](https://img.shields.io/github/v/release/advenimus/jw-mcp)](https://github.com/advenimus/jw-mcp/releases)

An MCP server for working with JW.org content — Bible scripture lookup with study notes, workbook materials, Watchtower articles, and video captions.

## Quick Start

Requires Node.js 20.18.1 or newer (Node 22 LTS recommended). On older Node the server prints the required version and exits.

### Claude Code (Recommended)

```bash
claude mcp add jw-mcp -- npx -y jw-mcp
```

### Claude Desktop

Download the latest `jw-mcp.mcpb` from [Releases](https://github.com/advenimus/jw-mcp/releases) and open it — Claude Desktop will install it automatically.

Or add manually to your config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "jw-mcp": {
      "command": "npx",
      "args": ["-y", "jw-mcp"]
    }
  }
}
```

### Other MCP Clients (Cursor, Windsurf, etc.)

```bash
npx -y jw-mcp
```

---

## Docker (self-hosted)

Run this server on a machine with a public HTTPS URL, then paste that URL into Grok, Claude.ai, or ChatGPT as a custom connector.

Compose binds the container to loopback only (`127.0.0.1:8080`). Do not publish port 8080 on the public internet. Put a reverse proxy on the host, terminate TLS there, and proxy to `127.0.0.1:8080`.

> **Use port 443.** Claude.ai never connects to a custom connector on any other port. It only says "Couldn't reach the MCP server". Grok accepts other ports, so a URL like `https://host:18443/mcp` can work in Grok and still fail in Claude. The server logs a warning at startup when `MCP_BASE_URL` has a port.

1. Copy `.env.example` to `.env`.
2. Set `MCP_BASE_URL` to your public origin, with no path and no port. Example: `https://jw-mcp.example.com`.
3. Set `MCP_AUTH_SECRET` to a long access key (at least 16 characters).
4. Keep `MCP_AUTH=true`. HTTP mode with auth off is loopback-only. Do not disable auth in Docker.
5. Set `MCP_TRUST_PROXY=true` only when exactly one proxy sits in front of the server and sets or appends the real client IP in `X-Forwarded-For` (Caddy, nginx, or a Cloudflare Tunnel). Leave it unset otherwise.
6. Start it:

```bash
docker compose up --build -d
```

The connector URL is:

```
https://your-host/mcp
```

When you add the connector, the AI site opens a login page. Type the same access key you put in `MCP_AUTH_SECRET`.

| Client | Where to add it |
|---|---|
| Grok | [grok.com/connectors](https://grok.com/connectors) → New Connector → Custom |
| Claude.ai | Customize → Connectors → Add custom connector |
| ChatGPT | Settings → enable Developer mode → add the server URL |

Local HTTP (`http://localhost:8080`) is fine for testing because compose binds loopback. Claude, ChatGPT, and Grok must reach a public HTTPS URL. A tunnel such as ngrok or Cloudflare Tunnel can expose that loopback port for a live click-test. Do not publish `8080` on `0.0.0.0`.

Auth codes, clients, and tokens are stored in the `jw-mcp-auth` Docker volume so a container restart does not drop every connection.

### Home hosting with Cloudflare Tunnel

Use this when the server runs on a home or office network. The tunnel makes an outbound-only connection to Cloudflare, so you open no router ports and your home IP stays out of DNS. Requests to jw.org still leave from your own network. Your domain's DNS must be on Cloudflare.

1. In Cloudflare, go to **Zero Trust → Networks → Tunnels** and create a tunnel (type **Cloudflared**). Copy its token.
2. In the tunnel's **Public hostname** tab, add your hostname (for example `jw-mcp.example.com`) with service `http://jw-mcp:8080`. If a DNS record for that name already exists, delete it first.
3. In `.env`, set:

   ```bash
   MCP_BASE_URL=https://jw-mcp.example.com
   MCP_TRUST_PROXY=true
   CLOUDFLARE_TUNNEL_TOKEN=<token from step 1>
   ```

4. Start both containers:

   ```bash
   docker compose --profile tunnel up --build -d
   ```

5. Remove any old router port forward or reverse-proxy site for this server. Nothing needs to reach it from the internet directly.

If the tunnel doesn't come up, run `docker compose logs cloudflared`. A missing or wrong `CLOUDFLARE_TUNNEL_TOKEN` makes it restart over and over.

Cloudflare settings that can block AI connectors. Check them for this hostname:

- **Security → Bots:** keep Bot Fight Mode off. On the free plan it can't be skipped for one hostname, and it can challenge server-to-server calls from Claude and Grok.
- **AI Crawl Control / Block AI bots:** don't block Claude or Grok user agents on this hostname.
- **Cloudflare Access:** don't put an Access login in front of this hostname. Claude's servers can't pass it. The server's own access key already protects it.
- If you use WAF rules, allow Anthropic's outbound range `160.79.104.0/21`.

---

## Tools

### Languages

The workbook and Watchtower tools take `langwritten` (default `E`, English). It accepts:

- a JW.org language code: `E` English, `S` Spanish, `F` French, `T` Portuguese (Brazil), `X` German, `I` Italian, `J` Japanese, `KO` Korean, `CHS` Chinese (Simplified), `U` Russian, and so on;
- an ISO tag such as `es`, `pt-BR` or `zh-Hant` (region subtags are dropped when needed, so `es-MX` gives `S`);
- a language name in English or in the language itself, such as `Spanish` or `español`; word order and qualifiers are free (`Traditional Chinese`, `Brazilian Portuguese`, `Cantonese`), and an unknown name gets a "Did you mean" list.

An all-caps value that is both a built-in language's ISO tag and another language's JW.org code is read as the ISO tag, with a `note` that says so: `TL` is Tagalog (pass `Tamil` or `ta` for Tamil, whose JW.org code is `TL`).

19 common languages resolve instantly. Any other language is looked up in JW.org's language list (cached for a day). Not every publication exists in every language; when one is missing, the error says so.

### Dates

The workbook and Watchtower tools accept `date` as `YYYY-MM-DD` and default to today on the server, in its local time zone. A server running in UTC (Docker) can be a day off from the user, so pass the user's local date when it matters.

### Bible Scripture Tools

#### `search_bible_books`
Search for Bible books by name, abbreviation, or number.

```json
{ "query": "matthew" }
```

#### `get_bible_verse`
Get plain verse text from wol.jw.org. Books are numbered 1-66 (1-39 OT, 40-66 NT).

```json
{ "book": 43, "chapter": 3, "verse": 16 }
```

#### `get_verse_with_study`
Get verses with study notes, cross-references, and research articles. Supports ranges.

```json
{
  "book": 40, "chapter": 5, "verse": "3-5",
  "fields": ["verses", "study_notes", "study_articles"]
}
```

Available fields: `verses`, `study_notes`, `study_articles`, `cross_references`, `chapter_level`, `combined_text`

![Scripture Tools Demo](assets/images/scripture-tools-demo.png)

#### `get_bible_verse_url`
Generate JW.org URLs for verses, ranges, or chapters — useful for adding clickable links to documents.

```json
{ "book": 19, "chapter": 83, "verse": "18" }
{ "book": 23, "chapter": 46, "verse": "9-11" }
{ "book": 40, "chapter": 5 }
```

![Get Verse URL Example](assets/images/get-verse-url.png)

---

### Meeting workbook and Watchtower study

One call gets the text. With no arguments, `getWorkbookContent` returns this week's midweek meeting and `getWatchtowerContent` returns this week's Watchtower study article.

```json
{}
{ "date": "2026-11-16" }
{ "langwritten": "S" }
{ "issue": "20260900", "week": 2 }
```

They return `{title, week_start, week_end, issue, pubName, language, langwritten, fileformat, url, link, parsedText}`. `url` is the source file and `link` the jw.org page to show or cite. For the workbook, `parsedText` is the meeting outline (songs, parts, minutes) followed by the scriptures and reference material JW.org inserts after each part. For the Watchtower, it is the article with its paragraphs, questions and review box. You can also pass `url`: the file `url` (an RTF or TXT link, not the jw.org `link`) of any entry from the Links tools. A `url` call returns the same fields: `title`, `week_start`/`week_end` when the title names a week, and `pubName`, `language` and `link` from the issue's listing (one cached request; when the listing cannot be loaded they are left out with a `note`). `links` lists the songs and publications the week links to; each song video link is followed by the song's lyrics page (`"Song 103 lyrics"`, a `finder?docid=` link), since song videos have no captions. For a week the issue skips, such as Memorial week in the workbook, the error says there is no meeting that week and gives the `url` of what the issue files there (the Memorial Bible Reading Schedule).

`week` is the week number within the issue (from the Links tools), not the week of the month. `date` and `week` are alternatives: with both, `week` must be the week that holds `date`, or the call is an error naming the right week.

A long file comes in pages: the result then has `offset`, `next_offset` and `total_chars`, and while `next_offset` is not null, call again with the same arguments and `offset` set to it. A page holds at most `max_chars` characters (default 60000, at most 80000; not in the tool schema) and about 20,000 tokens. Ordinary week files fit in one page and keep the shape above.

How issues map to weeks: a week belongs to the month of its Monday. Workbook issues are bimonthly, odd months only (`20261100` covers November and December 2026). A Watchtower issue is studied two months after its month (the August 2026 issue, `20260800`, covers October 5 to November 1, 2026). Before 2016 the study edition was dated the 15th, so its issue codes are `YYYYMM15` (`20150115`); `20150100`, `201501` and dates in those years are read that way.

![Workbook Content Example](assets/images/get-clm-workbook-info.png)

#### `getWorkbookLinks` / `getWatchtowerLinks`

List the weeks (workbook) or articles (Watchtower) of one issue, by default the issue that holds the current week. Each entry has `title`, `type` (`week`, `study` or `other`; absent for whole-issue formats such as PDF, EPUB and JWPUB), `week`, `week_start`, `week_end`, `is_current_week`, the file `url` and, when available, a jw.org `link`. `current_week` is the entry for this week (or for `date`); pass its `week` to the Content tools.

```json
{ "issue": "20260900", "langwritten": "E" }
{ "date": "2026-10-11", "fileformat": "PDF" }
```

`fileformat` is `RTF` by default (TXT for languages that have no RTF). `PDF`, `EPUB`, `JWPUB`, `MP3`, `MP4`, `3GP`, `BRL` and `DAISY` return download links only; the Content tools read RTF and TXT. Sign-language editions (`ASL`, `BSL` ...) have no RTF or TXT: ask for `MP4` or `3GP`. Their entries carry `resolution` (`240p`, `720p`), and the files of one week share its `week` number. A listing returns at most 200 entries (`total_entries` gives the full count).

![Watchtower Content Example](assets/images/get-wt-info.png)

---

### Video Caption Tools

#### `get_jw_captions`
Fetch video captions and metadata by video ID or any JW.org URL.

```json
{ "video_id": "pub-jwbvod25_17_VIDEO" }
```

Also accepts full JW.org URLs — the video ID is extracted automatically.

![Video Captions Example](assets/images/get-video-captions.png)

---

## Upgrading from 1.3

- Node.js 20.18.1 or newer is required (it was 18).
- A tool call that fails unexpectedly names the tool and ends with a `Next step:` hint (1.3.3 returned the bare JavaScript error).
- Argument names are checked: `lang` and `language` mean `langwritten` on every tool that has it, and `link` means `url`. An argument that looks like a misspelt parameter (`langauge`, `field` for `fields`) or a language under another name (`locale`, `wtlocale`) is an error that names the parameter you probably meant. Any other unknown argument is ignored, as in 1.3.3, and the result ends with a note naming it.

- Workbook and Watchtower link entries no longer carry `filesize`, `checksum`, `modifiedDatetime` or `track` (use `week`). Content results for a `url` no longer carry `contentType`, `originalSize` or `parsedSize`, and `parsedText` no longer has the "Your answer" placeholder lines. The Content tools take `date`, `issue` + `week` or `langwritten` directly, so the Links step is optional. Their JSON results are compact (no indentation).
- `langwritten` also accepts ISO tags and names, and a two-letter all-caps value that is both a built-in ISO tag and another language's JW.org code is read as the ISO tag: `TL` is Tagalog (was Tamil), `RU` Russian (was Kirundi), and likewise `EN`, `FR`, `IT`, `JA`, `UK`, `VI`, `ID`, `AR`. The result's `note` says so; pass the language name (`Tamil`) or ISO tag (`ta`) for the other language.
- The workbook and Watchtower helpers `getWorkbookLinks`/`getWorkbookContent` (workbook-tools.js), `getWatchtowerLinks`/`getWatchtowerContent` (watchtower-tools.js), `downloadRtfContent`, `fetchPublicationData`, `getCurrentIssue`, `getCurrentWatchtowerIssue` and `workbookIssue` (rtf-utils.js) are gone. jw-mcp is an MCP server, not a library: call the tools instead.

All tool names and earlier parameter names still work.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `JW_MCP_FETCH_TIMEOUT_MS` | `20000` | Time limit for each request to JW.org, including reading the response (max 600000; a larger value is capped with a warning). The workbook and Watchtower tools also have an overall budget per call: twice this value, at least 50 s. |
| `MCP_TRANSPORT` | `stdio` | `http` for the Docker/remote mode described above. |

Results from JW.org are cached in memory: workbook and Watchtower listings and files for 1 hour, and the language list for a day.

## Troubleshooting

1. **"jw-mcp requires Node >=20.18.1"**: install Node 22 LTS (or 20.18.1+) and restart the client.
2. **"Could not read package.json"**: use an absolute path in the Claude Desktop config.
3. **Server disconnects**: make sure Node.js is installed and run `npm install`.
4. **Permission denied**: `chmod +x start-server.sh`.
5. **"returned 403 Forbidden ... JW.org refused the request"** on every tool: JW.org's CDN is refusing this server's network, which happens on VPNs and datacenter IP ranges, or after many requests. Wait a few minutes, or run jw-mcp from another network.

## Development

```bash
npm start              # stdio mode (local)
npm run start:http     # HTTP mode (testing)
npm test               # offline tests: OAuth, HTTP connector, tools, the assembled server
npm run test:live      # live tests against JW.org (sets JW_MCP_LIVE=1)
```

The offline tests never touch the network: they stub `fetch` and use small synthetic fixtures. The live tests under `tests/live/` skip unless `JW_MCP_LIVE=1`.

Built with Node.js, MCP SDK, node-fetch, and cheerio.

## License

MIT
