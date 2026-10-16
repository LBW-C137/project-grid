const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claudeResetsSaid, codexResetsSaid } = require('../src/features/agents/reset-count.ts');

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

test("Claude's weekly session reset, as Claude Code last said on its screen", () => {
  // Offered at the 5-hour limit, the words wrapped over two rows.
  assert.deepEqual(claudeResetsSaid(["  ⎿  You've hit your session limit · resets 4pm", '     /limit-reset to reset your session limit now · uses', '     weekly limit · 1/week']), { left: 1, again: null });
  // Used: when the next one comes, as Claude wrote it.
  assert.deepEqual(claudeResetsSaid(['  /limit-reset to reset your session limit now · uses weekly limit · 1/week', '> /limit-reset', '  ⎿  Session limit reset · next reset available Oct 23 · your weekly limit still applies']), { left: 0, again: 'Oct 23' });
  assert.deepEqual(claudeResetsSaid(['  ⎿  Weekly reset used · available again Oct 23, 4pm', '', '> ']), { left: 0, again: 'Oct 23, 4pm' });
  // A failure says nothing about what is left.
  assert.equal(claudeResetsSaid(["  ⎿  Couldn't reset your session limit right now · try again in a moment"]), null);
  assert.equal(claudeResetsSaid(['> 帮我看看 limit reset 怎么用']), null);
});
