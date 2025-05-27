#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';

// Create server instance
const server = new Server(
  {
    name: 'jw-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool to get JW video captions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_jw_captions',
        description: 'Fetches video captions from JW.org by video ID',
        inputSchema: {
          type: 'object',
          properties: {
            video_id: {
              type: 'string',
              description: 'The JW.org video ID',
            },
          },
          required: ['video_id'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'get_jw_captions') {
    const { video_id } = request.params.arguments;

    try {
      // Step 1: Get JSON data for JW video
      const mediaUrl = `https://b.jw-cdn.org/apis/mediator/v1/media-items/E/${video_id}?clientType=www`;
      const mediaResponse = await fetch(mediaUrl);
      
      if (!mediaResponse.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to fetch video data: ${mediaResponse.statusText}`,
            },
          ],
        };
      }

      const mediaData = await mediaResponse.json();

      // Check if media exists and has files
      if (!mediaData.media || !mediaData.media[0] || !mediaData.media[0].files) {
        return {
          content: [
            {
              type: 'text',
              text: 'No media found for this video ID',
            },
          ],
        };
      }

      const media = mediaData.media[0];
      
      // Extract video metadata
      const title = media.title || 'Unknown Title';
      const thumbnail = media.images?.wss?.sm || '';

      // Check for subtitles URL
      const subtitlesUrl = media.files[1]?.subtitles?.url;

      if (!subtitlesUrl) {
        return {
          content: [
            {
              type: 'text',
              text: 'No subtitle file was found for this video. Unable to provide further info.',
            },
          ],
          isError: true,
        };
      }

      // Step 2: Get subtitles from JW.org
      const subtitlesResponse = await fetch(subtitlesUrl);
      
      if (!subtitlesResponse.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to fetch subtitles: ${subtitlesResponse.statusText}`,
            },
          ],
        };
      }

      const subtitlesData = await subtitlesResponse.text();

      // Return the result matching the n8n workflow output
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title,
              thumbnail,
              subtitles: subtitlesData,
            }, null, 2),
          },
        ],
      };

    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
    isError: true,
  };
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('JW MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
}); 