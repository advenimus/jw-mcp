# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a **Model Context Protocol (MCP) server** that provides tools for accessing JW.org content. The server has a single entry point (`src/index.js`) with two transport modes controlled by `MCP_TRANSPORT`:

1. **stdio** (default) — For local Claude Desktop / Claude Code integration
2. **http** — Docker/cloud deployment with OAuth 2.1 authentication

## Project Structure

```
src/
├── index.js              # Unified entry point (stdio + http modes)
├── auth.js               # OAuth 2.1 provider (MCP_AUTH_SECRET gated)
└── tools/
    ├── captions-tool.js      # Single tool example
    ├── scripture-tools.js    # Multiple tools (Bible lookup)
    ├── workbook-tools.js     # Multiple tools (CLM workbook)
    ├── watchtower-tools.js   # Multiple tools (Watchtower articles)
    ├── bible-books.js        # Bible book utilities & data
    ├── wol-scraper.js        # Web scraper for wol.jw.org
    ├── rtf-parser.js         # RTF to plain text converter
    └── rtf-utils.js          # Shared HTTP utilities
```

## Tool Structure Pattern

Each tool file exports three things:

1. **Tool definitions** - Object with name, description, inputSchema
2. **Implementation functions** - Async functions that do the work
3. **Handler function** - Routes tool calls to implementations

Example from `scripture-tools.js`:

```javascript
// 1. Tool definition
export const searchBibleBooksTool = {
  name: 'search_bible_books',
  description: 'Search for Bible books...',
  inputSchema: { /* JSON Schema */ }
};

// 2. Implementation
export async function searchBibleBooksImplementation(query, limit) {
  // ... logic here
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: false  // optional
  };
}

// 3. Handler
export async function handleScriptureTools(request) {
  const toolName = request.params.name;
  const args = request.params.arguments;

  switch (toolName) {
    case 'search_bible_books':
      return await searchBibleBooksImplementation(args.query, args.limit);
    default:
      return null;  // MUST return null for unhandled tools
  }
}
```

## Adding New Tools

### Step 1: Create/Update Tool File

Add your tool definition, implementation, and update the handler in the appropriate file under `src/tools/`.

### Step 2: Register in `src/index.js`

Import and add to the `allTools` array and `toolHandlers` array at the top of `index.js`. Only one file to update — both stdio and http modes share the same tool registration.

```javascript
import { newTool, handleNewTools } from './tools/new-tools.js';

const allTools = [
  // ... existing tools
  newTool,  // ADD THIS
];

const toolHandlers = [
  // ... existing handlers
  handleNewTools,  // ADD THIS
];
```

## Running the Server

### Local Development (stdio mode)
```bash
npm start
```

### HTTP Mode with OAuth
```bash
MCP_TRANSPORT=http MCP_AUTH_SECRET=my-secret MCP_BASE_URL=http://localhost:8080 npm run start:http
```

### Docker
```bash
docker compose up
```
Requires `.env` with `MCP_BASE_URL` and `MCP_AUTH_SECRET`.

## Key Technical Details

### Transport Modes

**stdio mode** creates a single Server+Transport pair. **http mode** creates a new Server+Transport pair per session (SDK limitation: one transport per Server instance). The `createServer()` factory function is shared.

### OAuth Authentication (`src/auth.js`)

When `MCP_AUTH` is not `false` and `MCP_AUTH_SECRET` is set:
- OAuth 2.1 + PKCE (S256) flow via MCP SDK's `mcpAuthRouter`
- Login page at `/authorize` requires `MCP_AUTH_SECRET`
- Timing-safe secret comparison via `node:crypto`
- 24h access tokens, 30-day refresh tokens, 10-min auth codes
- `requireBearerAuth` middleware protects `/mcp` endpoints

### RTF Parsing
Tools that fetch RTF files (Workbook, Watchtower) use `rtf-parser.js` to convert RTF markup to clean plain text, achieving ~70% token reduction.

### Bible Scripture Tools
- Use `bible-books.js` for book number/name mappings (1-66)
- Use `wol-scraper.js` for fetching content from wol.jw.org
- Book numbers: 1-39 (Old Testament), 40-66 (New Testament)
- Bible verse URLs use jw.org/finder format with zero-padded encoding (e.g., book 19, chapter 83, verse 18 → `19083018`)

### Date Handling
- **Workbook**: Uses current month (e.g., May 2025 = `20250500`)
- **Watchtower**: Uses issue from 2 months ago (e.g., May 2025 = `20250300`)
  - Watchtower studies are published 2 months ahead of their study period
  - Automatically handles year boundaries (January 2025 → November 2024)

## MCP Response Format

All tool implementations must return:
```javascript
{
  content: [{ type: 'text', text: 'result' }],
  isError: false  // optional, only include when true
}
```

For structured data, use `JSON.stringify(data, null, 2)` for pretty printing.

## Docker Deployment

Docker image published to `ghcr.io/advenimus/jw-mcp` on each release. Environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_TRANSPORT` | No | `stdio` | Set to `http` for Docker |
| `MCP_PORT` | No | `8080` | HTTP listen port |
| `MCP_BASE_URL` | Yes (http) | — | Public HTTPS URL |
| `MCP_AUTH` | No | `true` | Set `false` to disable OAuth |
| `MCP_AUTH_SECRET` | Yes (http) | — | Access key (min 8 chars) |

## Language Support

All tools support multiple languages via the `langwritten` parameter:
- `E` - English (default)
- `S` - Spanish
- `F` - French
- And many others per JW.org availability
