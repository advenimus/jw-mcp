#!/usr/bin/env node
import { getCaptionsImplementation } from './src/tools/captions-tool.js';

console.log('🎥 Final Test: Video Captions Tool with URL Support');
console.log('='.repeat(60));

// Test the example URL from the user's request
const testUrl = 'https://www.jw.org/finder?srcid=jwlshare&wtlocale=E&lank=pub-jwbvod25_17_VIDEO';
const testVideoId = 'pub-jwbvod25_17_VIDEO';

console.log('\n📋 Test Cases:');
console.log('1. Direct video ID:', testVideoId);
console.log('2. JW.org URL:', testUrl);

console.log('\n🔍 Testing URL extraction...');

async function testCaptions(input, description) {
  console.log(`\n🎬 ${description}`);
  console.log(`Input: ${input}`);
  
  try {
    const result = await getCaptionsImplementation(input);
    
    if (result.content && result.content[0] && result.content[0].text) {
      const text = result.content[0].text;
      
      if (text.includes('Failed to fetch video data')) {
        console.log('❌ API Error:', text);
        return false;
      } else if (text.includes('No subtitle file was found')) {
        console.log('⚠️  Video found but no subtitles available');
        console.log('✅ URL extraction working (video was found)');
        return true;
      } else {
        console.log('✅ Success! Video and subtitles found');
        // Extract just the title line
        const lines = text.split('\n');
        const titleLine = lines.find(line => line.trim() && !line.includes('Thumbnail:'));
        if (titleLine) {
          console.log(`📹 Title: ${titleLine.trim()}`);
        }
        return true;
      }
    } else {
      console.log('❓ Unexpected response format');
      console.log('Response:', JSON.stringify(result, null, 2));
      return false;
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return false;
  }
}

// Run tests
const results = [];
results.push(await testCaptions(testVideoId, 'Testing Direct Video ID'));
results.push(await testCaptions(testUrl, 'Testing JW.org URL'));

console.log('\n' + '='.repeat(60));
console.log('📊 Test Summary:');
const passed = results.filter(r => r).length;
const total = results.length;
console.log(`${passed}/${total} tests passed`);

if (passed === total) {
  console.log('🎉 All tests passed! URL extraction is working correctly.');
  console.log('');
  console.log('✅ The tool now accepts both:');
  console.log('   • Direct video IDs: pub-jwbvod25_17_VIDEO');
  console.log('   • JW.org URLs: https://www.jw.org/finder?srcid=jwlshare&wtlocale=E&lank=pub-jwbvod25_17_VIDEO');
} else {
  console.log('⚠️  Some tests failed. Check the errors above.');
}
