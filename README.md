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

Every content tool takes `langwritten` (default `E`, English). It accepts:

- a JW.org language code: `E` English, `S` Spanish, `F` French, `T` Portuguese (Brazil), `X` German, `I` Italian, `J` Japanese, `KO` Korean, `CHS` Chinese (Simplified), `U` Russian, and so on;
- an ISO tag such as `es`, `pt-BR` or `zh-Hant` (region subtags are dropped when needed, so `es-MX` gives `S`);
- a language name in English or in the language itself, such as `Spanish` or `español`; word order and qualifiers are free (`Traditional Chinese`, `Brazilian Portuguese`, `Cantonese`), and an unknown name gets a "Did you mean" list.

An all-caps value that is both a built-in language's ISO tag and another language's JW.org code is read as the ISO tag, with a `note` that says so: `TL` is Tagalog (pass `Tamil` or `ta` for Tamil, whose JW.org code is `TL`).

19 common languages resolve instantly. Any other language is looked up in JW.org's language list (cached for a day). Not every publication exists in every language; when one is missing, the error says so.

### Dates

The workbook and Watchtower tools accept `date` as `YYYY-MM-DD` and default to today on the server, in its local time zone. A server running in UTC (Docker) can be a day off from the user, so pass the user's local date when it matters.

### Errors

Every failure is a normal tool result with `isError: true`. The message says what failed, and a `Next step:` line says how to fix the call, for example `John has 21 chapters, so there is no chapter 22.` followed by `Next step: Use a chapter from 1 to 21.`

---

### Bible

Bible text is the New World Translation from jw.org's study Bible data. If that source fails, `get_bible_verse` reads the verse text from wol.jw.org instead and says so in `note`.

Every verse tool accepts either `reference` (a string, or an array of references read as a `;` list) or `book` + `chapter` + `verse`:

```json
{ "reference": "John 3:16" }
{ "reference": "Ps. 83:18" }
{ "reference": "1 Cor. 13:4-7" }
{ "reference": "Psalm 23" }
{ "book": 40, "chapter": 5, "verse": "3-5" }
```

`book` is 1-66 (1-39 Hebrew Scriptures, 40-66 Christian Greek Scriptures). `verse` can be one verse (`"16"`), a range (`"16-18"`) or a list (`"1,3,5"`); leave it out for the whole chapter. In Psalms, verse `0` is the superscription. References are checked against NWT chapter and verse counts, and verses the NWT leaves out (such as Matthew 17:21) come back with `omitted: true` and a note explaining why. A range that runs into John 7:53–8:11 or Mark 16:9-20, which have no verse numbers in the NWT, is cut to the numbered verses with a note (`"John 7:53-8:20"` reads John 8:12-20), and a range that runs past the end of the chapter stops at its last verse with a note (`"John 3:16-100"` reads John 3:16-36). A trailing translation tag such as `NWT` or `(nwtsty)` is ignored, and so are part-verse letters (`"John 3:16b"`, `"16-17a"`, `"16ff"` read whole verses, with a note). The study notes' `", ftn."` ("see the footnote", as in `"Eph 4:11, ftn."` or `"2Pe 1:13; ftn."`) reads the verse and returns its footnotes, with a note when the current NWT has none there. `verse` sent with a whole-chapter `reference` picks its verses (`{"reference": "Psalm 83", "verse": "18"}` is Psalm 83:18); with a `reference` that already names other verses it is an error, as a disagreeing `book` or `chapter` is. A whole Mark 16 or John 7 notes that the chapter stops before the passage other Bibles print.

Book names are read in English, and also in the `langwritten` language: with `"langwritten": "S"`, `"Juan 3:16"` and `"Salmo 23"` work, as do the references the tools return, including Arabic citations with Arabic-Indic digits and `،`/`؛` (`"روما ٥:٨؛ يوحنا ٦:٤٠"`) and Korean names with a digit inside (`"요한 1서 4:9"`, `"요1 4:8"`). The first call in a language learns its names from jw.org (one request) before it parses, so a local abbreviation that is also an English one (French `Éz`, Ezekiel, not Ezra) reads the same on every call.

`get_bible_verse` and `get_verse_with_study` also take several references separated by `;` (or the full-width `；` of Chinese and Japanese text, or Arabic `؛`; up to 12, for example a verse's cross references): `{"reference": "Luke 10:25-28; Acts 17:26, 27; 1 John 5:20"}` returns `{reference, passages_count, passages: [...], langwritten}` with one result per reference. A reference that cannot be read (`"John 3:99"`, an unknown book) gets `{reference, error, hint}` in its place; the call is an error only when none can be read. Two references joined by `,` or `and` get a hint to use `;`.

Each chapter is one cached request (the one jw.org's own chapter pages make), so a second verse of a chapter needs no new request. If jw.org's study Bible fails, the WOL fallback reads at most 4 chapter pages at a time and stops at the first failure; after a rate limit (HTTP 429) it sends nothing more.

#### `get_bible_verse`

Verse text for a verse, range, list or whole chapter (up to 200 verses; a longer passage is an error that names where to split it, e.g. `Genesis 1-7`, then `Genesis 8-10`). Returns `{reference, book_number, book_name, chapter, verse, text, url, langwritten}`, plus `footnotes`, `heading`, `superscription` (Psalms) and `note` when they apply. Footnotes are `[{phrase, note}]`, where `phrase` is the words the footnote marker follows (`{"phrase": "He refreshes me", "note": "Or “my soul.”"}`). For one verse `footnotes` is at the top level, and a psalm's superscription brings its own as `superscription_footnotes`. For several verses, `text` numbers each verse (`"16 For God... 17 For God sent..."`), and `verses` lists only the verses with footnotes or left out, as `[{verse, footnotes?, omitted?}]` (with `chapter` when the passage spans chapters; verse `0` is a superscription's). Poetry (the Psalms, much of the prophets) keeps its printed lines, separated by `\n`. Acrostic letters (Psalm 119, Proverbs 31, Lamentations 1-4 and others) stand before the verse they head (`"8 I will observe... ב [Beth] 9 How can a young man..."`); one verse returns its letter in `heading`. A psalm's superscription is `superscription` when the passage stays inside that psalm, else `superscriptions` keyed by psalm (`{"23": "A melody of David."}`).

Names keep the NWT's pronunciation marks (`Jo·haʹnan`), as jw.org prints them. `pronunciation_marks: false` removes them from verse text (`Johanan`) in English, German, Swedish, Dutch and Russian (`E`, `X`, `Z`, `O`, `U`); study notes keep them. The same option works in `get_verse_with_study`.

```json
{ "reference": "John 3:16", "langwritten": "S" }
```

#### `get_verse_with_study`

Verses with study material from the NWT Study Edition: any one chapter, or up to 60 verses in up to 5 chapters (200 verses when `fields` are text-only: `verses`, `combined_text`, `footnotes`, `cross_references`, `chapter_level`). Choose content with `fields`:

| Field | Content |
|---|---|
| `verses` (default) | `[{chapter, verse, text}]` |
| `study_notes` (default) | `{verse: [{term, note}]}` and `has_study_notes`. In English, the Study Edition has notes for Matthew to James. |
| `footnotes` (default) | `{verse: [{phrase, note}]}`; `phrase` is the words the marker follows |
| `combined_text` | the passage as one numbered string (the same text as `verses`) |
| `cross_references` | one entry per `+` marker, in the order the markers appear in the verse, as WOL shows them: `[{chapter, verse, phrase, targets}]`, where `phrase` is the words the marker follows (`"the only true God"`); a verse can have several. `cross_references_count` counts the references. |
| `study_articles` | Research Guide entries `[{title, source, publication, url}]`, capped by `limit` (default 5; `0` or less, or anything above 100, means 100; a decimal is rounded down; `study_articles_total` gives the full count and `note` says how to get the rest). Outside English the Research Guide is a citation index, so `title` is the citation (`"Perspicacia, págs. 437"`). |
| `chapter_level` | the chapter outline |
| `chapter_articles` | Research Guide entries for the whole chapter `[{title, source, publication, url, verses}]`, capped by `limit`, returned in `chapter_level.study_articles` with `study_articles_total` (or `chapter_level.study_articles_same_as: "study_articles"` when the passage is the whole chapter and `study_articles` is also requested) |

```json
{ "reference": "Matt. 24:14", "fields": ["verses", "study_notes", "study_articles"] }
```

`fetch: true` skips the 6-hour cache. A result is kept under about 22,000 tokens, estimated from its text (Claude Code's default limit is 25,000 tokens; Japanese, Chinese and link-heavy text take more tokens a character than English): when a long passage with many fields would be larger, `combined_text` is dropped first, then the article lists are shortened to 5, then `cross_references` (the last verses' first; `note` says up to which verse), then the rest of the article lists, then `chapter_level.outline`, and `note` says what was cut. When even that is too long, the error names the largest fields and a verse range that fits (`John 1:1-26 fits with these fields`).

![Scripture Tools Demo](assets/images/scripture-tools-demo.png)

#### `get_bible_verse_url`

jw.org links for a reference, ready for markdown. Returns `{reference, url, markdown, langwritten}`. When the verses are not one passage (`"1,3,5"`, `"Matt. 5:3–6:4"`, or several references separated by `;`), `links` has one `{reference, url, markdown}` per passage. `langwritten` sets the language of the linked page. Links are built locally; only a language outside the built-in 19 needs one lookup of JW.org's language list, and a reference with `langwritten` other than English one lookup of that language's book names.

```json
{ "reference": "Ps. 83:18; John 17:3" }
{ "book": 23, "chapter": 46, "verse": "9-11" }
```

![Get Verse URL Example](assets/images/get-verse-url.png)

#### `search_bible_books`

Book numbers, chapter counts and JW.org abbreviations from a name, abbreviation or number (`"jn"`, `"1 Cor."`, `"Song of Songs"`, `"40"`). A full reference is parsed too. A near-miss spelling (`"Jhon"`) comes back with `match: "spelling_guess"` and a `note`; a name that is no book (`"Tobit"`) is an error. With `langwritten`, that language's book names match as well (`{"query": "Juan", "langwritten": "S"}`, with `local_name` in the result). A `limit` above 66, or `0` or less, returns every match; a decimal is rounded down. The verse tools take references directly, so this is rarely needed first.

```json
{ "query": "matt" }
```

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

### Video transcripts

#### `get_jw_captions`

A video's transcript and metadata. `video_id` takes a media key (`pub-jwb-142_1_VIDEO`, `docid-502014331_1_VIDEO`), a docid number, or any jw.org video link (a `finder?lank=` or `finder?docid=` share link, an address-bar link such as `www.jw.org/en/library/videos/#en/mediaitems/...`, or a video page; `https://` is optional). A category link (`#en/categories/<Category>`) or `latest:<Category>` reads that category's newest video by publish date, and the note lists the keys of the five before it; `latest:<Category>~N` (or `"previous broadcast"`) reads the Nth before the newest, and `"August 2026 broadcast"` the monthly program first published that month; `"September broadcast"` is the latest September up to today, and `"this month's broadcast"` and `"last month's broadcast"` count from the server's local date. Other categories are not found by date (`"last week's morning worship"` is an error that suggests `"latest morning worship"`, whose note lists the earlier keys with dates). `"latest broadcast"` or `latest:StudioMonthlyPrograms` is the newest JW Broadcasting monthly program, `"latest morning worship"` (`latest:VODPgmEvtMorningWorship`), `"latest Governing Body update"` (the newest video titled "<year> Governing Body Update #n" in `StudioNewsReports`, skipping news reports and excerpts) or `"latest news"` (`latest:StudioNewsReports`, the whole category) and `"latest talk"` (`latest:StudioTalks`) work the same way, and `"latest"` is the newest video on jw.org. A category key such as `VODProgramsEvents` is read as given. A group of categories is an error that lists its categories.

```json
{ "video_id": "https://www.jw.org/finder?wtlocale=E&lank=pub-jwb-142_1_VIDEO" }
{ "video_id": "pub-jwb-142_1_VIDEO", "langwritten": "S", "format": "plain" }
{ "video_id": "latest broadcast" }
```

The result has two text blocks: a JSON metadata block (`title`, `key`, `language`, `duration`, `published`, `category`, `url`, `truncated`, `next_offset`, ...) and the transcript as paragraphs with `[m:ss]` time markers. `format` is `text` (default), `plain` (no markers) or `vtt` (the raw WebVTT file). Long programs come in parts of `max_chars` (default 60000, enough for a monthly program; at most 80000, and 50000 for `vtt`) and about 20,000 tokens, so Japanese and Chinese transcripts come in shorter parts: when `truncated` is true, call again with `offset` = `next_offset`. A longer transcript is split into parts of about equal size. In Japanese and Chinese transcripts a caption break without punctuation is kept as a space, since JW's captions often have no `。`. A line said or sung again keeps every repeat, and the opening quotation marks English captions repeat at the start of each caption show once (`format: "vtt"` stays as JW.org wrote it).

`langwritten` defaults to the language in the link, else English. If the video has no captions in that language, English captions are returned with a note: the title and link stay those of the requested language's video, and `captions_language` is `"E"`. A video with no caption file at all (for example, subtitles burned into the picture) returns its metadata with `captions_available: false`, the reason and a `next_step`. Song videos (`pub-sjjm_..._VIDEO`) show the words on screen and have no caption file in any language, so their `next_step` gives the song's lyrics page in the songbook. English transcripts close an em dash that a caption break split (`facing—anxious times`); Spanish and French keep their spaced dashes.

![Video Captions Example](assets/images/get-video-captions.png)

---

## Upgrading from 1.3

- Node.js 20.18.1 or newer is required (it was 18).
- JSON results are compact (no indentation).
- `reference` strings follow jw.org style: `Psalm 83:18` (was `Psalms 83:18`; `book_name` is still `Psalms`), `John 3:16, 17` for two verses in a row (was `John 3:16-17`), and `Jude 3` for one-chapter books (was `Jude 1:3`).
- `get_bible_verse` `text` no longer starts with the verse number or contains `+` cross-reference markers. For several verses `text` numbers each verse and `verses` lists only the verses with footnotes or left out (`[{verse, footnotes?, omitted?}]`).
- `get_bible_verse` `verse` is a string in the input schema (`"16"`, `"16-18"`, `"1,3,5"`), as in the other verse tools; it was a number in 1.3. The server still accepts a number such as `16`, but a client that validates arguments against the schema before sending must send a string, or pass `reference` (`"John 3:16"`).
- `get_bible_verse_url` returns JSON `{reference, url, markdown, ...}` instead of a bare URL.
- `get_verse_with_study` returns `verses` as `[{chapter, verse, text}]` (was `book_num`, `book_name`, `verse_num`, `verse_text`), includes footnotes by default, and `study_notes_count` now counts notes rather than verses. `cross_references` has one entry per reference marker (`[{chapter, verse, phrase, targets}]`), so a verse can have several.
- `get_verse_with_study` `study_notes` values are `[{term, note}]` objects (were `"term: note"` strings), and `study_articles` entries are `{title, source, publication, url, verses}` (no `type`).
- `get_verse_with_study`: `chapter_level` now holds only the chapter outline. The chapter's Research Guide articles (1.3's `chapter_level.study_articles`) come back only when `fields` includes `chapter_articles`. They are deduplicated `{title, source, publication, url, verses}`, capped by `limit` (default 5, `0` = 100), with `study_articles_total`. `chapter_level.cross_references`, which was always empty in 1.3, is gone; use the `cross_references` field.
- `get_verse_with_study` `limit` takes any number as before (a decimal is rounded down; `0` or less means 100), but returns at most 100 articles; `study_articles_total` gives the full count and `note` says how to see the rest.
- `get_jw_captions` no longer has a `subtitles` field with the raw VTT. The transcript is the second text block; pass `format: "vtt"` for the raw file. 1.3.3 returned the whole transcript in one result; a long one now comes in parts of `max_chars` (default 60000, at most 80000; 50000 for `vtt`): when `truncated` is true, call again with `offset` = `next_offset`.
- `get_jw_captions` follows the language of the link: a share link with `wtlocale=S` now gives the Spanish title and transcript, where 1.3.3 always returned English. Pass `langwritten: "E"` for English.
- Workbook and Watchtower link entries no longer carry `filesize`, `checksum`, `modifiedDatetime` or `track` (use `week`). Content results for a `url` no longer carry `contentType`, `originalSize` or `parsedSize`, and `parsedText` no longer has the "Your answer" placeholder lines. The Content tools take `date`, `issue` + `week` or `langwritten` directly, so the Links step is optional.
- Errors are `isError` results with a `Next step:` hint, including "no match" from `search_bible_books`.
- `langwritten` also accepts ISO tags and names, and a two-letter all-caps value that is both a built-in ISO tag and another language's JW.org code is read as the ISO tag: `TL` is Tagalog (was Tamil), `RU` Russian (was Kirundi), and likewise `EN`, `FR`, `IT`, `JA`, `UK`, `VI`, `ID`, `AR`. The result's `note` says so; pass the language name (`Tamil`) or ISO tag (`ta`) for the other language.
- Argument names are checked: `lang` and `language` mean `langwritten` on every tool, and `link` means `url`. An argument that looks like a misspelt parameter (`referense`, `langauge`, `field` for `fields`) or a language under another name (`locale`, `wtlocale`) is an error that names the parameter you probably meant. Any other unknown argument is ignored, as in 1.3.3, and the result ends with a note naming it.
- `footnotes` (new) are `[{phrase, note}]` objects, and verse `text` keeps poetic line breaks (`\n`).
- jw-mcp is an MCP server, not a library. Deep imports of the old internal helpers break: `getWorkbookLinks`/`getWorkbookContent` (workbook-tools.js), `getWatchtowerLinks`/`getWatchtowerContent` (watchtower-tools.js), `downloadRtfContent`, `fetchPublicationData`, `getCurrentIssue` and `getCurrentWatchtowerIssue` (rtf-utils.js), `WOLScraper`/`scraper` (wol-scraper.js) and `fetchWithTimeout` (fetch-with-timeout.js). Call the tools instead.

All tool names and earlier parameter names still work (see the `verse` type note above).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `JW_MCP_FETCH_TIMEOUT_MS` | `20000` | Time limit for each request to JW.org, including reading the response (max 600000; a larger value is capped with a warning). Tools that make several requests also have an overall budget per call: twice this value (at least 50 s for the workbook and Watchtower tools). |
| `MCP_TRANSPORT` | `stdio` | `http` for the Docker/remote mode described above. |

Results from JW.org are cached in memory: Bible data for 6 hours, workbook and Watchtower listings and files for 1 hour, video lookups and captions for 30 minutes, and the language list for a day.

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

Built with Node.js, the MCP SDK, and cheerio.

## License

MIT
