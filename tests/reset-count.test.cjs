const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codexResetsSaid, codexResetCount } = require('../src/features/agents/reset-count.ts');

test('scoped official counts include zero and supersede stale terminal text; unknown is never zero', () => {
  for (const left of [0, 2]) assert.equal(codexResetCount({ resets: { left }, resetQuery: { state: 'ready' } }, 7), left);
  for (const state of ['loading', 'unavailable', 'error']) assert.equal(codexResetCount({ resets: { left: 2 }, resetQuery: { state } }, 7), null);
  assert.equal(codexResetCount({ resetQuery: { state: 'ready' }, resets: null }, 7), null);
  assert.equal(codexResetCount(undefined, null), null);
  assert.equal(codexResetCount(undefined, 2), 2);
});

test('the limit resets Codex last said are left, wherever it said so on screen', () => {
  assert.equal(codexResetsSaid(['• Hit your limit.', '  You have 2 resets available. Run /usage to use one.']), 2);
  assert.equal(codexResetsSaid(['  You have 1 usage limit reset available. Run /usage to use one.']), 1);
  // The latest word wins: after a reset, what is left.
  assert.equal(codexResetsSaid(['  You have 2 resets available. Run /usage to use one.', '', '• Usage reset. You have 1 reset left.']), 1);
  assert.equal(codexResetsSaid(["  You don't have any usage limit resets available."]), 0);
  // A sentence wrapped over two rows still reads.
  assert.equal(codexResetsSaid(['  You have 3 resets', '  available. Run /usage to use one.']), 3);
  assert.equal(codexResetsSaid(['› 帮我看看重置', '• 第 1 次回答。']), null);
});
