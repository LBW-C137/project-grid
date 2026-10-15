const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findMatches, matchFrom, stepMatch } = require('../src/features/files/editor-find.ts');

test('a search finds every place the words occur, ignoring case unless asked, never overlapping', () => {
  const text = 'Alpha alpha ALPHA aa\naaaa';
  assert.deepEqual(findMatches(text, 'alpha', false).map(match => match.start), [0, 6, 12]);
  assert.deepEqual(findMatches(text, 'alpha', true).map(match => match.start), [6]);
  assert.deepEqual(findMatches(text, 'aa', true).map(match => [match.start, match.end]), [[18, 20], [21, 23], [23, 25]], 'next one after the end of the last');
  assert.deepEqual(findMatches(text, '', false), []);
  assert.deepEqual(findMatches('中文 搜索 中文', '中文', false).map(match => match.start), [0, 6]);
  assert.deepEqual(findMatches('İstanbul istanbul', 'istanbul', false).map(match => match.start), [9], 'a text whose lower case is longer keeps its case');
});

test('the match shown first is the one at or after the caret, going round at either end', () => {
  const matches = [{ start: 2, end: 4 }, { start: 10, end: 12 }, { start: 20, end: 22 }];
  assert.equal(matchFrom(matches, 0), 0);
  assert.equal(matchFrom(matches, 10), 1);
  assert.equal(matchFrom(matches, 21), 0, 'after the last: the first');
  assert.equal(matchFrom([], 5), -1);
  assert.deepEqual([stepMatch(0, 3, 1), stepMatch(2, 3, 1), stepMatch(0, 3, -1), stepMatch(0, 0, 1)], [1, 0, 2, -1]);
});
