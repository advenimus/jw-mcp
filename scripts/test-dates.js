#!/usr/bin/env node
import { getCurrentIssue, getCurrentWatchtowerIssue } from '../src/tools/rtf-utils.js';

console.log('📅 Date Calculation Test');
console.log('Current date: May 27, 2025');
console.log('');
console.log('📚 Workbook (current month):');
console.log(`  Issue: ${getCurrentIssue()}`);
console.log('');
console.log('📰 Watchtower (2 months behind for current studies):');
console.log(`  Issue: ${getCurrentWatchtowerIssue()}`);
console.log('');
console.log('✅ This means:');
console.log('  - Workbook: May-June 2025 weeks');
console.log('  - Watchtower: March 2025 issue with May 2025 studies');
