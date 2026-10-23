const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { cliInputDraft, hasCliInput, isCliIdle, isAtPrompt } = require('../src/features/reading/cli-panel.ts');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/screens', name + '.txt'), 'utf8').split('\n');
const inspect = (agent, rows) => parseAgentScreen(agent, rows);
const footer = agent => agent === 'claude' ? ['  ⏺ Opus 5.5 · demo · ctx 4%   ● high · /effort', '  ⏸ manual mode on · ← for agents'] : ['  GPT-6.1-Sol high · C:\\work\\demo · 90% left', '? for shortcuts'];
const input = (agent, text = '') => agent === 'claude' ? ['────', '❯ ' + text, '────', ...footer(agent)] : ['› ' + text, '', ...footer(agent)];
const marker = agent => agent === 'claude' ? '❯' : '›';

for (const agent of ['claude', 'codex']) {
  test(agent + ': startup is idle, and a draft stays readable at the prompt', () => {
    const startup = fixture(agent + '-startup');
    assert.equal(isCliIdle(agent, startup, inspect(agent, startup)), true);
    for (const text of ['', '/status', 'Try my prompt', '! echo hello']) {
      const rows = input(agent, text), screen = inspect(agent, rows);
      assert.equal(hasCliInput(agent, rows, screen), true);
      assert.equal(cliInputDraft(agent, rows, screen), text.replace(/^!\s*/, '!'));
      if (!text.startsWith('/')) assert.equal(isAtPrompt(agent, rows, screen), true);
      assert.equal(isCliIdle(agent, rows, screen), text === '');
    }
    assert.equal(isAtPrompt(agent, [marker(agent)], inspect(agent, [marker(agent)])), false);
  });
  for (const suffix of ['model-menu', 'permission', 'slash-typed', 'mention', 'shortcuts']) {
    test(agent + ': ' + suffix + ' is not the agent prompt', () => {
      const rows = fixture(agent + '-' + suffix);
      assert.equal(isAtPrompt(agent, rows, inspect(agent, rows)), false);
    });
  }
  test(agent + ': a historical input above a panel is not a live prompt', () => {
    const rows = [marker(agent) + ' old command', 'Panel contents', 'Esc to close'];
    assert.equal(hasCliInput(agent, rows, inspect(agent, rows)), false);
    assert.equal(isAtPrompt(agent, rows, inspect(agent, rows)), false);
  });
}

test('Claude wrapped draft and its working line remain distinct from a dialog', () => {
  const rows = fixture('claude-wrapped-draft'), screen = inspect('claude', rows);
  assert.equal(hasCliInput('claude', rows, screen), true);
  assert.equal(cliInputDraft('claude', rows, screen).replace(/\s+/g, ''), '这是一段用语音说出来的很长的话，'.repeat(14) + '说完了。');
  assert.equal(isAtPrompt('claude', rows, screen), false);
  const done = ['✻ Worked for 25s', ...input('claude')];
  assert.equal(isCliIdle('claude', done, inspect('claude', done)), true);
});

test('captured Claude and Codex shell editors keep their draft, and a running Bash is not idle', () => {
  for (const agent of ['claude', 'codex']) {
    const rows = fixture(agent + '-bang-typed'), screen = inspect(agent, rows);
    assert.equal(hasCliInput(agent, rows, screen), true);
    assert.ok(cliInputDraft(agent, rows, screen).startsWith('!echo '));
    assert.equal(isCliIdle(agent, rows, screen), false);
  }
  for (const name of ['claude-bang-running', 'claude-bang-empty-running']) {
    const rows = fixture(name);
    assert.equal(isAtPrompt('claude', rows, inspect('claude', rows)), false);
  }
});

test('captured config, usage, plugins and under-input menus cannot take a normal message', () => {
  for (const [agent, name] of [['claude', 'claude-config-working'], ['claude', 'claude-usage-working'], ['codex', 'codex-0-163-permissions'], ['codex', 'codex-plugins-view']]) {
    const rows = fixture(name);
    assert.equal(isAtPrompt(agent, rows, inspect(agent, rows)), false, name);
  }
  const rows = [...input('codex'), 'Copy user message', '↑/↓ select · Enter confirm · Esc cancel'];
  assert.equal(isAtPrompt('codex', rows, inspect('codex', rows)), false);
});
