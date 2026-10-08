const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldStickToBottom, countNewEntries } = require('../src/useStickToBottom.ts');

const metrics = (scrollTop, scrollHeight = 1000, clientHeight = 200) => ({ scrollTop, scrollHeight, clientHeight });

test('a user scrolling upward beyond 40px releases the bottom', () => {
  assert.equal(shouldStickToBottom(true, metrics(700), metrics(800), false, true), false);
});

test('a user gesture with no upward movement cannot unstick', () => {
  assert.equal(shouldStickToBottom(true, metrics(500), metrics(500), false, true), true);
  assert.equal(shouldStickToBottom(true, metrics(600), metrics(500), false, true), true);
});

test('a user within the inclusive 40px threshold remains stuck', () => {
  assert.equal(shouldStickToBottom(true, metrics(760), metrics(800), false, true), true);
  assert.equal(shouldStickToBottom(true, metrics(759), metrics(800), false, true), false);
});

test('scrolling back near the bottom re-sticks', () => {
  assert.equal(shouldStickToBottom(false, metrics(760), metrics(500), false, true), true);
});

test('scrolling down while still far from the bottom preserves reading position', () => {
  assert.equal(shouldStickToBottom(false, metrics(700), metrics(500), false, true), false);
});

test('our write in the same frame cannot release the bottom', () => {
  assert.equal(shouldStickToBottom(true, metrics(500), metrics(800), true, true), true);
});

test('smooth jump intermediate frames stay stuck outside the threshold', () => {
  for (const top of [100, 200, 400, 600, 750, 800]) {
    assert.equal(shouldStickToBottom(true, metrics(top), metrics(100), true, false), true);
  }
});

test('content growth without user input stays stuck', () => {
  assert.equal(shouldStickToBottom(true, metrics(800, 1400), metrics(800), false, false), true);
});

test('container resizing and content shrinking do not look like an upward gesture', () => {
  assert.equal(shouldStickToBottom(true, metrics(600, 1000, 300), metrics(800), false, true), true);
  assert.equal(shouldStickToBottom(true, metrics(500, 800), metrics(800), false, true), true);
});

test('an unexplained upward scroll cannot release the bottom', () => {
  assert.equal(shouldStickToBottom(true, metrics(500), metrics(800), false, false), true);
});

test('non-overflowing content and bottom overscroll count as at the bottom', () => {
  assert.equal(shouldStickToBottom(false, metrics(0, 100, 200), metrics(0), false, true), true);
  assert.equal(shouldStickToBottom(false, metrics(801), metrics(700), false, true), true);
});

test('replacing or streaming an existing entry does not count a new message', () => {
  assert.equal(countNewEntries(new Set(['a', 'b']), [{ id: 'a', text: 'updated' }, { id: 'b', done: true }]), 0);
});

test('new message count includes arrivals in a rolling list with unchanged length', () => {
  assert.equal(countNewEntries(new Set(['a', 'b', 'c']), [{ id: 'b' }, { id: 'c' }, { id: 'd' }]), 1);
});

test('message count includes multiple new IDs and ignores removals', () => {
  assert.equal(countNewEntries(new Set(['a', 'b']), [{ id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]), 3);
  assert.equal(countNewEntries(new Set(['a', 'b']), [{ id: 'b' }]), 0);
});
