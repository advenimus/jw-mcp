#!/usr/bin/env node

console.log('🎥 Testing Video ID Extraction from URLs');
console.log('');

// Function to extract video ID (simplified version for testing)
function extractVideoId(input) {
  console.log(`Processing input: ${input}`);
  
  // If it's already a video ID (doesn't contain http/https), return as-is
  if (!input.includes('http')) {
    console.log('  → Direct video ID detected');
    return input;
  }
  
  // Extract video ID from various JW.org URL formats
  try {
    const url = new URL(input);
    console.log(`  → Parsed URL: ${url.href}`);
    
    // Check for 'lank' parameter (most common format)
    const lank = url.searchParams.get('lank');
    if (lank) {
      console.log(`  → Found 'lank' parameter: ${lank}`);
      return lank;
    }
    
    // Check for 'docid' parameter (alternative format)
    const docid = url.searchParams.get('docid');
    if (docid) {
      console.log(`  → Found 'docid' parameter: ${docid}`);
      return docid;
    }
    
    // Check if video ID is in the pathname
    const pathMatch = url.pathname.match(/\/(pub-[^\/]+)/);
    if (pathMatch) {
      console.log(`  → Found video ID in path: ${pathMatch[1]}`);
      return pathMatch[1];
    }
    
    console.log('  → No video ID found in URL');
    return input;
  } catch (error) {
    console.log(`  → URL parsing failed: ${error.message}`);
    return input;
  }
}

// Test cases
const testCases = [
  'pub-jwbvod25_17_VIDEO',
  'https://www.jw.org/finder?srcid=jwlshare&wtlocale=E&lank=pub-jwbvod25_17_VIDEO',
  'https://www.jw.org/en/library/videos/?docid=pub-jwbvod25_17_VIDEO',
  'https://www.jw.org/en/library/videos/pub-jwbvod25_17_VIDEO/'
];

testCases.forEach((testCase, index) => {
  console.log(`\n📋 Test ${index + 1}:`);
  const result = extractVideoId(testCase);
  console.log(`✅ Result: ${result}`);
});
