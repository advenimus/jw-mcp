import fetch from 'node-fetch';

// Tool definition
export const captionsTool = {
  name: 'get_jw_captions',
  description: 'Fetches video captions from JW.org by video ID or URL. Accepts either a direct video ID (e.g., "pub-jwbvod25_17_VIDEO") or a JW.org URL (e.g., "https://www.jw.org/finder?srcid=jwlshare&wtlocale=E&lank=pub-jwbvod25_17_VIDEO")',
  inputSchema: {
    type: 'object',
    properties: {
      video_id: {
        type: 'string',
        description: 'The JW.org video ID or a JW.org URL containing the video ID. If a URL is provided, the video ID will be automatically extracted.',
      },
    },
    required: ['video_id'],
  },
};

/**
 * Extract video ID from JW.org URL or return the input if it's already a video ID
 */
function extractVideoId(input) {
  // If it's already a video ID (doesn't contain http/https), return as-is
  if (!input.includes('http')) {
    return input;
  }
  
  // Extract video ID from various JW.org URL formats
  try {
    const url = new URL(input);
    
    // Check for 'lank' parameter (most common format)
    const lank = url.searchParams.get('lank');
    if (lank) {
      return lank;
    }
    
    // Check for 'docid' parameter (alternative format)
    const docid = url.searchParams.get('docid');
    if (docid) {
      return docid;
    }
    
    // Check if video ID is in the pathname
    const pathMatch = url.pathname.match(/\/(pub-[^\/]+)/);
    if (pathMatch) {
      return pathMatch[1];
    }
    
    // If no video ID found, return the original input and let the API handle the error
    return input;
  } catch (error) {
    // If URL parsing fails, assume it's a direct video ID
    return input;
  }
}

// Tool implementation
export async function getCaptionsImplementation(video_id) {
  try {
    // Extract video ID from URL if needed
    const extractedVideoId = extractVideoId(video_id);
    
    // Step 1: Get JSON data for JW video
    const mediaUrl = `https://b.jw-cdn.org/apis/mediator/v1/media-items/E/${extractedVideoId}?clientType=www`;
    const mediaResponse = await fetch(mediaUrl);
    
    if (!mediaResponse.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to fetch video data for ID "${extractedVideoId}": ${mediaResponse.statusText}`,
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

// Tool handler
export async function handleCaptionsTool(request) {
  if (request.params.name === 'get_jw_captions') {
    const { video_id } = request.params.arguments;
    return await getCaptionsImplementation(video_id);
  }
  return null;
}
