#!/usr/bin/env node
import { getWorkbookLinks, getWorkbookContent } from './src/tools/workbook-tools.js';

async function testWorkbookTools() {
  console.log('🔍 Testing getWorkbookLinks...');
  
  try {
    // Test getWorkbookLinks with current May 2025 issue
    const links = await getWorkbookLinks('mwb', 'E', '20250500', 'RTF');
    
    console.log('✅ getWorkbookLinks successful!');
    console.log(`📚 Publication: ${links.pubName}`);
    console.log(`📅 Date: ${links.formattedDate}`);
    console.log(`🌐 Language: ${links.language}`);
    console.log(`📄 Available weeks (${links.weekFiles.length}):`);
    
    links.weekFiles.forEach((week, index) => {
      console.log(`  ${index + 1}. ${week.title}`);
      console.log(`     URL: ${week.url}`);
      console.log(`     Size: ${(week.filesize / 1024).toFixed(1)} KB`);
      console.log('');
    });

    if (links.weekFiles.length > 0) {
      console.log('\n🔍 Testing getWorkbookContent with first week...');
      
      const firstWeek = links.weekFiles[0];
      const content = await getWorkbookContent(firstWeek.url);
      
      console.log('✅ getWorkbookContent successful!');
      console.log(`📄 Content size: ${(content.size / 1024).toFixed(1)} KB`);
      console.log(`🎯 Content type: ${content.contentType}`);
      console.log(`📝 First 200 characters:`);
      console.log(content.content.substring(0, 200) + '...');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testWorkbookTools();
