# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a **Model Context Protocol (MCP) server** that provides tools for accessing JW.org content. The server runs in two modes:

1. **stdio mode** (`src/index.js`) - For local Claude Desktop integration
2. **HTTP mode** (`src/http-server.js`) - For Smithery deployment and web-based clients

### Critical: Dual Server Architecture

**IMPORTANT**: When adding new tools, you MUST update BOTH server files:
- `src/index.js` (stdio server for local use)
- `src/http-server.js` (HTTP server for Smithery)

Smithery uses the HTTP server exclusively. If you only update `index.js`, the tool will work locally but NOT appear in Smithery.

## Project Structure

```
src/
├── index.js              # stdio MCP server (local Claude Desktop)
├── http-server.js        # HTTP MCP server (Smithery deployment)
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

### Step 2: Update BOTH Server Files

**This is critical for Smithery compatibility!**

#### In `src/index.js`:
```javascript
// Import the new tool
import {
  existingTool,
  newTool,  // ADD THIS
  handleTools
} from './tools/your-tools.js';

// Add to allTools array
const allTools = [
  existingTool,
  newTool  // ADD THIS
];
```

#### In `src/http-server.js`:
```javascript
// SAME imports and registration as index.js
import {
  existingTool,
  newTool,  // ADD THIS
  handleTools
} from './tools/your-tools.js';

const allTools = [
  existingTool,
  newTool  // ADD THIS
];
```

### Step 3: Commit and Push

After updating both files:
```bash
git add src/index.js src/http-server.js src/tools/your-tools.js
git commit -m "Add new_tool to MCP server"
git push
```

Smithery will automatically rebuild and pick up the new tool within a few minutes.

## Running the Server

### Local Development (stdio mode)
```bash
npm start
# or
node src/index.js
```

### HTTP Mode (for testing Smithery integration)
```bash
npm run start:http
# or
node src/http-server.js
```

The HTTP server runs on port 8081 by default. Health check: `http://localhost:8081/health`

## Key Technical Details

### HTTP Server: Stateless Mode
The HTTP server creates fresh `Server` and `Transport` instances for EVERY request. This is required for Smithery's distributed architecture where requests may hit different container instances.

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

## Smithery Deployment

The server is deployed on Smithery at `@advenimus/jw-mcp`. Configuration is in `smithery.yaml`:
- Runtime: container
- Start command type: http
- No configuration schema required

## Language Support

All tools support multiple languages via the `langwritten` parameter:
- `E` - English (default)
- `S` - Spanish
- `F` - French
- And many others per JW.org availability
