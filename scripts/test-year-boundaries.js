#!/usr/bin/env node

// Simulate the getCurrentWatchtowerIssue function with different input dates
function testWatchtowerIssue(year, month, day) {
  // Simulate what getCurrentWatchtowerIssue does with a specific date
  const mockDate = new Date(year, month - 1, day); // month is 0-based in JS
  const targetDate = new Date(mockDate.getFullYear(), mockDate.getMonth() - 2, 1);
  const resultYear = targetDate.getFullYear();
  const resultMonth = String(targetDate.getMonth() + 1).padStart(2, '0');
  return `${resultYear}${resultMonth}00`;
}

console.log('🔄 Year Boundary Test for Watchtower Date Calculation');
console.log('Testing edge cases where subtracting 2 months crosses year boundaries\n');

const testCases = [
  // Year boundary cases
  { input: [2025, 1, 15], expected: [2024, 11], description: 'January 2025 → November 2024' },
  { input: [2025, 2, 10], expected: [2024, 12], description: 'February 2025 → December 2024' },
  { input: [2025, 3, 5], expected: [2025, 1], description: 'March 2025 → January 2025' },
  { input: [2025, 4, 20], expected: [2025, 2], description: 'April 2025 → February 2025' },
  { input: [2025, 5, 27], expected: [2025, 3], description: 'May 2025 → March 2025 (current)' },
  
  // Additional year boundary test
  { input: [2024, 1, 1], expected: [2023, 11], description: 'January 2024 → November 2023' },
  { input: [2024, 2, 29], expected: [2023, 12], description: 'February 2024 (leap year) → December 2023' },
];

let allPassed = true;

testCases.forEach(({ input, expected, description }) => {
  const result = testWatchtowerIssue(input[0], input[1], input[2]);
  const expectedFormatted = `${expected[0]}${String(expected[1]).padStart(2, '0')}00`;
  const passed = result === expectedFormatted;
  const status = passed ? '✅' : '❌';
  
  console.log(`${status} ${description}`);
  console.log(`   Input: ${input[0]}-${String(input[1]).padStart(2, '0')}-${String(input[2]).padStart(2, '0')}`);
  console.log(`   Expected: ${expectedFormatted}`);
  console.log(`   Actual: ${result}`);
  
  if (!passed) {
    allPassed = false;
    console.log(`   ❌ FAILED!`);
  }
  console.log('');
  
  if (!passed) allPassed = false;
});

console.log(allPassed ? '🎉 All year boundary tests passed!' : '💥 Some tests failed!');
