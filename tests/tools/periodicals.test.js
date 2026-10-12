// Offline tests for the issue the workbook and Watchtower tools pick by default.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getCurrentIssue, getCurrentWatchtowerIssue, workbookIssue } from '../../src/tools/rtf-utils.js';

const day = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

describe('getCurrentIssue (workbook)', () => {
  it('uses the odd-month issue that holds the week, never an even month', () => {
    for (const [date, issue] of [
      ['2026-09-14', '20260900'],
      ['2026-10-12', '20260900'], // October is in the September–October issue
      ['2026-11-01', '20260900'], // Sunday of the week starting Monday Oct 26
      ['2026-11-02', '20261100'],
      ['2026-12-31', '20261100'],
      ['2027-01-01', '20261100'], // Dec 28–Jan 3 is in the November issue
      ['2027-01-04', '20270100'],
      ['2026-02-10', '20260100'],
    ]) {
      assert.equal(getCurrentIssue(day(date)), issue, date);
    }
  });

  it('keeps monthly issues before 2021', () => {
    assert.equal(getCurrentIssue(day('2020-06-15')), '20200600');
    assert.equal(getCurrentIssue(day('2020-12-31')), '20201200');
  });

  it('defaults to today', () => {
    assert.match(getCurrentIssue(), /^\d{4}(0[13579]|11)00$/);
  });
});

describe('getCurrentWatchtowerIssue', () => {
  it('uses the issue whose studies cover the week (two months earlier)', () => {
    for (const [date, issue] of [
      ['2026-10-12', '20260800'],
      ['2026-11-01', '20260800'], // Sunday of the week starting Monday Oct 26
      ['2026-11-02', '20260900'],
      ['2027-01-03', '20261000'], // week starting Monday Dec 28, 2026
      ['2027-01-04', '20261100'],
      ['2027-02-15', '20261200'],
    ]) {
      assert.equal(getCurrentWatchtowerIssue(day(date)), issue, date);
    }
  });
});

describe('workbookIssue', () => {
  it('reads an even month from 2021 on as the odd-month issue that covers it', () => {
    assert.equal(workbookIssue('20261000'), '20260900');
    assert.equal(workbookIssue('20261200'), '20261100');
    assert.equal(workbookIssue('20210200'), '20210100');
    assert.equal(workbookIssue(' 20260400 '), '20260300');
  });

  it('leaves odd months, earlier years and anything else unchanged', () => {
    for (const issue of ['20260900', '20201000', '2026-10', 'abc', '', null, undefined]) {
      assert.equal(workbookIssue(issue), issue);
    }
  });
});
