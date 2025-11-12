#!/usr/bin/env node
import { getWatchtowerLinks, getWatchtowerContent } from '../src/tools/watchtower-tools.js';

async function testWatchtowerTools() {
  console.log('🔍 Testing getWatchtowerLinks...');
  
  try {
    // Test getWatchtowerLinks with current issue (auto-detected)
    const links = await getWatchtowerLinks();
    
    console.log('✅ getWatchtowerLinks successful!');
    console.log(`📰 Publication: ${links.pubName}`);
    console.log(`📅 Date: ${links.formattedDate}`);
    console.log(`🌐 Language: ${links.language}`);
    console.log(`📄 Available articles (${links.articles.length}):`);
    
    links.articles.forEach((article, index) => {
      const sizeKB = (article.filesize / 1024).toFixed(1);
      console.log(`  ${index + 1}. ${article.title}`);
      console.log(`     URL: ${article.url}`);
      console.log(`     Size: ${sizeKB} KB\n`);
    });

    // Test getWatchtowerContent with first article
    if (links.articles.length > 0) {
      console.log('🔍 Testing getWatchtowerContent with first article...');
      const firstArticle = links.articles[0];
      const content = await getWatchtowerContent(firstArticle.url);
      
      console.log('✅ getWatchtowerContent successful!');
      console.log(`📄 Content size: ${(content.size / 1024).toFixed(1)} KB`);
      console.log(`🎯 Content type: ${content.contentType}`);
      console.log(`📝 First 200 characters:`);
      console.log(content.content.substring(0, 200) + '...');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testWatchtowerTools();
