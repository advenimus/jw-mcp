# JW MCP Server
[![smithery badge](https://smithery.ai/badge/@advenimus/jw-mcp)](https://smithery.ai/server/@advenimus/jw-mcp)

An MCP (Model Context Protocol) server that provides tools for working with JW.org content, including video caption retrieval and more.

## Features

This MCP server currently includes:
- **Video Caption Fetching**: Retrieves video metadata and subtitle content from JW.org by video ID
- More tools coming soon!

The caption fetching functionality replicates an n8n workflow that:
- Fetches video metadata from JW.org API
- Retrieves subtitle files for videos
- Returns video title, thumbnail URL, and subtitle content

## Installation

### Installing via Smithery

To install jw-mcp for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@advenimus/jw-mcp):

```bash
npx -y @smithery/cli install @advenimus/jw-mcp --client claude
```

### Local Development
1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Global Installation (Optional)
If you want to install globally:
```bash
npm install -g .
```

Then you can use this simpler Claude Desktop configuration:
```json
{
  "mcpServers": {
    "jw-mcp": {
      "command": "jw-mcp"
    }
  }
}
```

## Usage

### Running the Server

Start the MCP server:
```bash
npm start
```

### Using with Claude Desktop

1. Add the server to your Claude Desktop configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jw-mcp": {
      "command": "node",
      "args": ["/Users/<username>/jw-mcp/src/index.js"]
    }
  }
}
```

**Important:** Replace `/Users/<username>/jw-mcp` with the actual absolute path to your project directory.

**Alternative configuration using shell script (more reliable):**
```json
{
  "mcpServers": {
    "jw-mcp": {
      "command": "/Users/<username>/jw-mcp/start-server.sh"
    }
  }
}
```

2. Restart Claude Desktop

3. The server exposes these tools:
   - `get_jw_captions`: Fetches video captions and metadata by video ID

### Tool: get_jw_captions

**Input:**
- `video_id` (string, required): The JW.org video ID

**Output:**
Returns a JSON object containing:
- `title`: Video title
- `thumbnail`: Thumbnail image URL
- `subtitles`: Complete subtitle content (VTT format)

**Example:**
```
Tool: get_jw_captions
Arguments: {
  "video_id": "YOUR_VIDEO_ID_HERE"
}
```

### Error Handling

The server handles several error cases:
- Invalid video ID: Returns error message if video not found
- Missing subtitles: Returns "No subtitle file was found for this video"
- Network errors: Returns appropriate error messages

## How It Works

### Video Caption Fetching

1. The server receives a video ID
2. Makes a request to `https://b.jw-cdn.org/apis/mediator/v1/media-items/E/{video_id}?clientType=www`
3. Extracts the subtitle URL from the response
4. Fetches the subtitle content
5. Returns the combined data (title, thumbnail, subtitles)

## Development

The server is built using:
- Node.js with ES modules
- MCP SDK (@modelcontextprotocol/sdk)
- node-fetch for HTTP requests

## Troubleshooting

### Common Issues

1. **"Could not read package.json" error**: This usually means the working directory is not set correctly. Use the shell script approach instead of the npm command.

2. **Server disconnects immediately**: Check that:
   - The path to your project directory is correct and absolute
   - Node.js is installed and accessible
   - All dependencies are installed (`npm install`)

3. **Permission denied**: Make sure the shell script is executable:
   ```bash
   chmod +x start-server.sh
   ```

### Testing the Server

You can test the server manually by running:
```bash
./start-server.sh
```

The server should start and display "JW MCP Server running on stdio" in the error output.

## License

MIT 