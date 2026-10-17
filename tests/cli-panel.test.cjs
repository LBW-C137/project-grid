const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { claudeAtWork, cliCloseKey, cliDialogShown, cliEscapeSafe, cliInputDraft, commandInputText, hasCliInput, isSideConversation, cliHistory, isCliIdle, isAtPrompt, extractCliPanelRows, extractCliOutputRows, advanceCliCommand, cliPanelKey } = require('../src/features/reading/cli-panel.ts');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/screens', name + '.txt'), 'utf8').split('\n');
const inspect = (agent, rows) => parseAgentScreen(agent, rows);
const footer = agent => agent === 'claude' ? ['  ⏺ Opus 5.5 · demo · ctx 4%   ● high · /effort', '  ⏸ manual mode on · ← for agents'] : ['  GPT-6.1-Sol high · C:\\work\\demo · 90% left', '? for shortcuts'];
const input = (agent, text = '') => agent === 'claude' ? ['────', '❯ ' + text, '────', ...footer(agent)] : ['› ' + text, '', ...footer(agent)];
const marker = agent => agent === 'claude' ? '❯' : '›';

test('captured Claude bang editor acknowledges the mode prefix and exact command body', () => {
  const rows = fixture('claude-bang-typed'), screen = inspect('claude', rows);
  assert.equal(hasCliInput('claude', rows, screen), true);
  assert.equal(cliInputDraft('claude', rows, screen), '!echo BANG_CAPTURE_OK');
  assert.equal(commandInputText('! echo BANG_CAPTURE_OK'), '!echo BANG_CAPTURE_OK');
  assert.notEqual(cliInputDraft('claude', rows, screen), commandInputText('!echo BANG_CAPTURE'));
  assert.equal(isCliIdle('claude', rows, screen), false);
  for (const name of ['running', 'empty-running']) {
    const running = fixture('claude-bang-' + name);
    assert.equal(isCliIdle('claude', running, inspect('claude', running)), false, 'Running… is not completed idle');
    assert.equal(cliCloseKey('claude', running, inspect('claude', running)), null, 'closing the popup must not interrupt Bash/model work');
  }
});

test('captured Codex bang editor retains its model footer and acknowledges exact shell input', t => {
  const rows = fixture('codex-bang-typed'), screen = inspect('codex', rows);
  assert.equal(hasCliInput('codex', rows, screen), true); assert.equal(isCliIdle('codex', rows, screen), false);
  assert.equal(cliInputDraft('codex', rows, screen), '!echo CODEX_BANG_INPUT');
  const h = rendererHarness(t, 'codex'); h.emit('a', fixture('codex-fresh-default'));
  const id = h.render().begin('!echo CODEX_BANG_INPUT'); h.emit('a', rows);
  assert.equal(h.render().confirmInput(id), true);
});

test('captured Bash results exclude model replies and earlier commands, including real multiline output', () => {
  for (const [name, command, expected] of [['output', '!echo BANG_CAPTURE_OK', ['BANG_CAPTURE_OK']], ['empty-done', '!true', []], ['multiline', "!printf 'BANG_LINE1\\nBANG_LINE2\\n'", ['BANG_LINE1', 'BANG_LINE2']]]) {
    const rows = fixture('claude-bang-' + name);
    assert.deepEqual(extractCliOutputRows('claude', rows, inspect('claude', rows), command, []), expected);
  }
});

for (const agent of ['claude', 'codex']) {
  test(agent + ': startup fixture is idle with its own placeholder', () => {
    const rows = fixture(agent + '-startup');
    assert.equal(isCliIdle(agent, rows, inspect(agent, rows)), true);
  });
  for (const suffix of ['model-menu', 'permission', 'slash-typed', 'mention', 'shortcuts']) {
    test(agent + ': ' + suffix + ' fixture is not idle', () => {
      const rows = fixture(agent + '-' + suffix);
      assert.equal(isCliIdle(agent, rows, inspect(agent, rows)), false);
    });
  }
  test(agent + ': empty input needs a parsed footer; arbitrary text is not a placeholder', () => {
    for (const [rows, expected] of [[input(agent), true], [input(agent, '/status'), false], [input(agent, 'Try my prompt'), false], [[marker(agent)], false]]) {
      assert.equal(isCliIdle(agent, rows, inspect(agent, rows)), expected);
    }
  });
  test(agent + ': result excludes history, command, composer and footer, preserving spacing', () => {
    const command = '! dir';
    const output = ['  Directory: C:\\work', '', '    42    file.txt'];
    const rows = ['old answer', marker(agent) + ' ' + command, '', ...output, '', ...input(agent), ''];
    assert.deepEqual(extractCliOutputRows(agent, rows, inspect(agent, rows), command), output);
  });
  test(agent + ': dialog without printed text produces no output', () => {
    const rows = [marker(agent) + ' /config', '', ...input(agent)];
    assert.deepEqual(extractCliOutputRows(agent, rows, inspect(agent, rows), '/config'), []);
  });
  test(agent + ': repeated echo uses the latest command and never old output', () => {
    const rows = [marker(agent) + ' /cost', 'old cost', marker(agent) + ' /cost', 'new cost', ...input(agent)];
    assert.deepEqual(extractCliOutputRows(agent, rows, inspect(agent, rows), '/cost'), ['new cost']);
  });
  test(agent + ': command arguments with repeated spaces still anchor output', () => {
    const command = '! dir  /a';
    const rows = [marker(agent) + ' ' + command, '  file.txt', ...input(agent)];
    assert.deepEqual(extractCliOutputRows(agent, rows, inspect(agent, rows), command), ['  file.txt']);
  });
  test(agent + ': missing echo produces no fabricated result', () => {
    const rows = ['old answer', '────', 'panel', ...input(agent)];
    assert.deepEqual(extractCliOutputRows(agent, rows, inspect(agent, rows), '/config'), []);
  });
  test(agent + ': live panel removes echo and footer, retains search input and hints', () => {
    const rows = ['old answer', marker(agent) + ' /config', '', '────', '  Config   Status', '  search: ', '', ...input(agent, 'search'), ''];
    assert.deepEqual(extractCliPanelRows(agent, rows, inspect(agent, rows), '/config'), ['────', '  Config   Status', '  search: ', '', ...input(agent, 'search').slice(0, agent === 'claude' ? 3 : 2)].filter((row, i, all) => i < all.length - 1 || row.trim()));
  });
  test(agent + ': missing echo falls back to last upper panel rule', () => {
    const rows = ['old answer', '────', 'other text', '╌╌╌╌', '', '  Status   Config', '  CLI content', '', ...input(agent, 'search')];
    const result = extractCliPanelRows(agent, rows, inspect(agent, rows), '/status');
    assert.deepEqual(result.slice(0, 2), ['  Status   Config', '  CLI content']);
    assert.ok(!result.includes('old answer'));
    assert.ok(!result.some(row => row.includes('ctx 4%') || row.includes('90% left')));
  });
  test(agent + ': submitted composer echo does not become panel content', () => {
    const rows = ['old text', '────', ...input(agent, '/status')];
    assert.ok(!extractCliPanelRows(agent, rows, inspect(agent, rows), '/status').some(row => row.includes('/status')));
  });
  test(agent + ': input history cannot be mistaken for an idle composer', () => {
    const rows = [marker(agent) + ' old command', '  panel contents', 'Esc to close'];
    assert.equal(isCliIdle(agent, rows, inspect(agent, rows)), false);
  });
}

test('Claude after-deny fixture is idle', () => {
  const rows = fixture('claude-after-deny');
  assert.equal(isCliIdle('claude', rows, inspect('claude', rows)), true);
});
test('Claude model fixture panel cuts everything through echoed /model', () => {
  const rows = fixture('claude-model-menu');
  const panel = extractCliPanelRows('claude', rows, inspect('claude', rows), '/model');
  assert.ok(panel.some(row => row.includes('Select model')));
  assert.ok(panel.at(-1).includes('Esc to cancel'));
  assert.ok(!panel.some(row => row.includes('AGENTRIX') || row.includes('❯ /model')));
});
test('live slash overlays retain CLI suggestions instead of stripping them as footer rows', () => {
  for (const agent of ['claude', 'codex']) {
    const rows = fixture(agent + '-slash-typed');
    const panel = extractCliPanelRows(agent, rows, inspect(agent, rows), '/model');
    assert.ok(panel.some(row => row.includes(agent === 'claude' ? 'Set the AI model' : 'choose what model')));
    assert.ok(!panel.some(row => row.includes('872K wi')));
  }
});
test('replacement panel without composer strips status footer and retains keyboard hints', () => {
  const rows = ['❯ /status', '  Status', '  Tab to switch · Esc to close', ...footer('claude')];
  assert.deepEqual(extractCliPanelRows('claude', rows, inspect('claude', rows), '/status'), ['  Status', '  Tab to switch · Esc to close']);
});
test('panel extraction ignores historical status and does not treat tab hints as a footer', () => {
  const claude = [...footer('claude'), '❯ /status', '  Status', '  Esc to close', ...footer('claude')];
  assert.deepEqual(extractCliPanelRows('claude', claude, inspect('claude', claude), '/status'), ['  Status', '  Esc to close']);
  const noFooter = [...footer('claude'), '❯ /status', '  Status', '  Esc to close'];
  assert.deepEqual(extractCliPanelRows('claude', noFooter, inspect('claude', noFooter), '/status'), ['  Status', '  Esc to close']);
  const codex = ['› /config', '  Config', '  Tab to switch · Enter to select · Esc to close'];
  assert.deepEqual(extractCliPanelRows('codex', codex, inspect('codex', codex), '/config'), ['  Config', '  Tab to switch · Enter to select · Esc to close']);
});
test('idle debounce needs post-submit observation, survives ticks, resets when panel returns', () => {
  let command = { id: 'one', command: '/cost', at: 0, anchor: null, observed: false, idleSince: null, output: [] };
  const rows = ['❯ /cost', '  Total $1.00', ...input('claude')];
  const step = (now, observation = false, live = rows) => {
    const next = advanceCliCommand(command, 'claude', live, inspect('claude', live), now, observation);
    command = next.command;
    return next.done;
  };
  assert.equal(step(1000), false);
  assert.equal(step(1100, true), false);
  assert.equal(step(1499), false);
  assert.equal(step(1500), true);
  assert.deepEqual(command.output, ['  Total $1.00']);
  assert.equal(step(1600, true, ['❯ /cost', '  Cost dialog', 'Esc to close']), false);
  assert.equal(command.idleSince, null);
  assert.equal(step(1700, true), false);
  assert.equal(step(2100), true);
});
test('live output updates during idle debounce and dialog close adds nothing', () => {
  const command = { id: 'one', command: '/cost', at: 0, anchor: null, observed: true, idleSince: 0, output: ['old'] };
  const rows = ['❯ /cost', '  final', ...input('claude')];
  assert.deepEqual(advanceCliCommand(command, 'claude', rows, inspect('claude', rows), 400, true).command.output, ['  final']);
  const empty = ['❯ /cost', ...input('claude')];
  assert.deepEqual(advanceCliCommand(command, 'claude', empty, inspect('claude', empty), 400, true).command.output, []);
});
test('panel keys forward navigation, editing, search, tabs and control keys', () => {
  for (const [key, data] of [['ArrowUp', '\x1b[A'], ['ArrowDown', '\x1b[B'], ['ArrowLeft', '\x1b[D'], ['ArrowRight', '\x1b[C'], ['Enter', '\r'], ['Escape', '\x1b'], ['Tab', '\t'], ['Backspace', '\x7f'], [' ', ' '], ['a', 'a'], ['中', '中']]) assert.equal(cliPanelKey({ key }), data);
  assert.equal(cliPanelKey({ key: 'Tab', shiftKey: true }), '\x1b[Z');
  assert.equal(cliPanelKey({ key: 'c', ctrlKey: true }), '\x03');
  assert.equal(cliPanelKey({ key: 'x', altKey: true }), '\x1bx');
  assert.equal(cliPanelKey({ key: 'Shift' }), null);
});

// Test the renderer's screen subscriptions with fake clocks; no DOM, Electron or
// actual agent sessions are started. This also exercises state across remounts.
function rendererHarness(t, agent = 'claude', screenService) {
  const Module = require('node:module');
  const ts = require('typescript');
  const filename = path.join(__dirname, '..', 'src/features/reading/useReadingCli.ts');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const screens = new Map(), watchers = new Map();
  let prior = null, focused = 0, parses = 0;
  const react = {
    useMemo: fn => fn(), useRef: () => prior ??= { current: null },
    useLayoutEffect: fn => fn(), useSyncExternalStore: (_subscribe, read) => read(),
  };
  const originalRequire = mod.require.bind(mod);
  mod.require = name => name === 'react' ? react : name.endsWith('/terminal-screen') ? screenService ?? {
    readScreen: id => screens.get(id) ?? null,
    subscribeScreen: (id, fn) => {
      watchers.set(id, fn);
      if (screens.has(id)) fn(screens.get(id));
      return () => { if (watchers.get(id) === fn) watchers.delete(id); };
    },
  } : name.endsWith('/agent-screen') ? { ...require('../src/features/agents/agent-screen.ts'), parseAgentScreen: (...args) => { parses++; return parseAgentScreen(...args); } } : name.endsWith('/cli-panel') ? require('../src/features/reading/cli-panel.ts') : originalRequire(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval, setTimeout, clearTimeout };
  t.after(() => { mod.exports.pruneReadingCli(new Set()); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const render = (id = 'a', session = 'session') => mod.exports.useReadingCli(id, session, agent, { current: { focus: () => focused++ } }, true);
  const emit = (id, rows) => { screens.set(id, { rows }); watchers.get(id)?.({ rows }); };
  return { render, emit, tick: ms => t.mock.timers.tick(ms), remount: () => { prior = null; }, focused: () => focused, watchers, parses: () => parses, prune: () => mod.exports.pruneReadingCli(new Set()) };
}

test('real Claude bang captures finish on fresh Bash completion evidence, including explicit no-output', t => {
  const h = rendererHarness(t, 'claude');
  h.emit('a', fixture('claude-2-1-302-start')); let id = h.render().begin('!echo BANG_CAPTURE_OK');
  h.emit('a', fixture('claude-bang-typed')); assert.equal(h.render().confirmInput(id), true); h.render().submitted(id);
  h.emit('a', fixture('claude-bang-running')); h.tick(1000);
  assert.equal(h.render().busy, true); assert.equal(h.render().panel.done, undefined);
  h.emit('a', fixture('claude-bang-output')); h.tick(400);
  assert.deepEqual(h.render().panel, { command: '!echo BANG_CAPTURE_OK', rows: ['BANG_CAPTURE_OK'], done: true });
  id = h.render().begin('!true'); h.emit('a', fixture('claude-bang-empty-typed'));
  assert.equal(h.render().confirmInput(id), true); h.render().submitted(id);
  h.emit('a', fixture('claude-bang-empty-running')); h.tick(1200); assert.equal(h.render().busy, true);
  h.emit('a', fixture('claude-bang-empty-done')); h.tick(399); assert.equal(h.render().busy, true);
  h.tick(1); assert.deepEqual(h.render().panel, { command: '!true', rows: [], done: true });
});

test('old identical Bash markers and idle alone never confirm another bang execution', t => {
  const h = rendererHarness(t, 'claude'), done = fixture('claude-bang-empty-done');
  h.emit('a', done); h.render().begin('!true'); h.emit('a', done.map(row => row.replace('Local probe.', 'A different model reply.'))); h.tick(10000);
  assert.equal(h.render().feedback, 'recovery'); assert.equal(h.render().panel.done, undefined);
  h.render().close(); h.emit('a', input('claude')); const id = h.render().begin('!unknown');
  h.emit('a', input('claude', '!unknown')); assert.equal(h.render().confirmInput(id), true); h.render().submitted(id);
  h.emit('a', input('claude')); h.tick(10000);
  assert.equal(h.render().feedback, 'recovery'); assert.equal(h.render().panel.done, undefined);
});

test('Bash completion and subsequent model work have independent lifecycles', t => {
  const h = rendererHarness(t, 'claude'), working = fixture('claude-bang-empty-model-working');
  assert.equal(claudeAtWork('claude', working), true); assert.equal(isCliIdle('claude', working, inspect('claude', working)), false);
  h.emit('a', fixture('claude-bang-output')); const id = h.render().begin('!true');
  h.emit('a', fixture('claude-bang-empty-typed')); assert.equal(h.render().confirmInput(id), true); h.render().submitted(id);
  h.emit('a', working); h.tick(400);
  assert.deepEqual(h.render().panel, { command: '!true', rows: [], done: true });
});

for (const agent of ['claude', 'codex']) {
  test(agent + ': no screen starts visible pending feedback, recovers within budget and accepts late output', t => {
    const h = rendererHarness(t, agent);
    h.render().begin('/status');
    assert.deepEqual(h.render().panel, { command: '/status', rows: [] });
    assert.equal(h.render().feedback, 'waiting'); assert.equal(h.render().interactive, false);
    h.tick(9999); assert.equal(h.render().feedback, 'waiting');
    h.tick(1); assert.equal(h.render().feedback, 'recovery'); assert.equal(h.render().panel.done, undefined);
    const count = h.parses(); h.tick(60000); assert.equal(h.parses(), count, 'recovery stops timer work');
    h.emit('a', ['Earlier answer must stay out', ...input(agent)]);
    assert.deepEqual(h.render().panel.rows, [], 'the first late input screen is only a baseline');
    const echo = agent === 'claude' ? '❯ /status' : '/status';
    h.emit('a', ['Earlier answer must stay out', echo, '  NEW RESULT', ...input(agent)]);
    assert.deepEqual(h.render().panel.rows, ['  NEW RESULT']);
    h.tick(400); assert.equal(h.render().busy, false);
    assert.deepEqual(h.render().panel.rows, ['  NEW RESULT']);
  });

  test(agent + ': unchanged redraws cannot reuse an old identical result or reparse on every tick', t => {
    const h = rendererHarness(t, agent), echo = agent === 'claude' ? '❯ /status' : '/status';
    const before = [echo, '  SAME RESULT', ...input(agent)];
    h.emit('a', before); h.render().begin('/status');
    const firstId = h.render().commandId;
    for (let index = 0; index < 30; index++) { h.emit('a', [...before]); h.tick(100); }
    assert.deepEqual(h.render().panel.rows, []); assert.equal(h.render().busy, true);
    const count = h.parses(); h.tick(7000); assert.equal(h.parses(), count);
    assert.equal(h.render().feedback, 'recovery');
    const repeated = [echo, '  SAME RESULT', echo, '  SAME RESULT', ...input(agent)];
    h.emit('a', repeated); h.tick(400);
    assert.deepEqual(h.render().panel.rows, ['  SAME RESULT']); assert.equal(h.render().busy, false);
    h.render().begin('/status'); assert.notEqual(h.render().commandId, firstId);
    assert.deepEqual(h.render().panel.rows, [], 'repeated command starts fresh feedback');
  });

  test(agent + ': streaming resets settling and command/session disposal rejects late callbacks', t => {
    const h = rendererHarness(t, agent), echo = agent === 'claude' ? '❯ /status' : '/status';
    h.emit('a', input(agent)); h.render().begin('/status');
    const old = h.watchers.get('a');
    h.emit('a', [echo, '  first', ...input(agent)]); h.tick(300);
    h.emit('a', [echo, '  final', ...input(agent)]); h.tick(399);
    assert.equal(h.render().busy, true); assert.deepEqual(h.render().panel.rows, ['  final']);
    h.tick(1); assert.equal(h.render().busy, false);
    h.render().begin('/config'); old({ rows: [echo, '  STALE RESULT', ...input(agent)] });
    assert.equal(h.render().panel.command, '/config'); assert.deepEqual(h.render().panel.rows, []);
    const previous = h.watchers.get('a');
    h.render('a', 'new-pty'); previous({ rows: fixture(agent + '-model-menu') });
    h.tick(30000); assert.equal(h.render('a', 'new-pty').panel, null);
    h.render('a', 'new-pty').begin('/status'); h.prune();
    const count = h.parses(); h.tick(30000); assert.equal(h.watchers.size, 0); assert.equal(h.parses(), count);
  });

  test(agent + ': a command leaving the input without any output or setting change is unconfirmed, not successful', t => {
    const h = rendererHarness(t, agent);
    h.emit('a', input(agent)); h.render().begin('/quiet');
    h.emit('a', input(agent, '/quiet')); h.emit('a', input(agent)); h.tick(10000);
    assert.equal(h.render().feedback, 'recovery'); assert.equal(h.render().busy, true);
    assert.equal(h.render().panel.done, undefined); assert.deepEqual(h.render().panel.rows, []);
  });

  test(agent + ': captured dialogs remain visible during redraws and expose recovery without losing their contents', t => {
    const h = rendererHarness(t, agent), command = agent === 'claude' ? '/usage' : '/plugins';
    h.emit('a', agent === 'codex' ? fixture('codex-plugins-view-before') : input(agent)); h.render().begin(command);
    const rows = fixture(agent === 'claude' ? 'claude-usage-working' : 'codex-plugins-view');
    h.emit('a', rows);
    const shown = h.render().panel.rows;
    assert.ok(shown.length); assert.equal(h.render().interactive, true);
    h.tick(10000); assert.equal(h.render().interactive, true, 'a real dialog may wait for the reader without timing out');
    assert.equal(h.render().feedback, undefined);
    h.emit('a', []); assert.deepEqual(h.render().panel.rows, shown);
    assert.equal(h.render().interactive, false, 'a disappearing dialog cannot take keys through its old card');
    h.tick(10000); assert.equal(h.render().feedback, 'recovery'); assert.deepEqual(h.render().panel.rows, shown);
    h.emit('a', rows); assert.equal(h.render().interactive, true);
    assert.equal(h.render().feedback, undefined);
  });
}

test('Codex 0.163 captured permission dialog has current popup contents and a safe Escape; model picker keeps its own card', t => {
  const h = rendererHarness(t, 'codex');
  h.emit('a', fixture('codex-0-163-status')); h.render().begin('/permissions');
  const rows = fixture('codex-0-163-permissions');
  h.emit('a', rows);
  assert.equal(h.render().interactive, true);
  assert.ok(h.render().panel.rows.some(row => row.includes('Update Model Permissions')));
  assert.ok(h.render().panel.rows.every(row => !row.includes('Model provider:') && !row.includes('Session:')));
  assert.equal(cliCloseKey('codex', rows, inspect('codex', rows), '/permissions'), '\x1b');
  h.render().begin('/model'); h.emit('a', fixture('codex-0-163-model'));
  assert.equal(h.render().panel, null); assert.equal(h.render().busy, true);
  h.render().begin('/memories'); h.emit('a', fixture('codex-0-163-memories'));
  assert.equal(h.render().panel, null, 'the overlaid choice takes priority over old status content');
  const memoryRows = fixture('codex-0-163-memories');
  const memoryOutput = extractCliPanelRows('codex', memoryRows, inspect('codex', memoryRows), '/memories');
  assert.ok(memoryOutput.some(row => row.includes('Enable memories?')));
  assert.ok(memoryOutput.every(row => !/Model provider:|Token usage:|Session:|\/status/.test(row)));
});

test('fresh Claude 2.1.302 captures show status and config promptly and keep safe Escape available', t => {
  const h = rendererHarness(t, 'claude');
  for (const name of ['status', 'config']) {
    h.emit('a', fixture('claude-2-1-302-start')); h.render().begin('/' + name);
    const rows = fixture('claude-2-1-302-' + name);
    h.emit('a', rows);
    assert.ok(h.render().panel.rows.some(row => row.includes(name === 'status' ? 'Version:' : 'Search settings')));
    assert.equal(h.render().interactive, true);
    assert.equal(cliCloseKey('claude', rows, inspect('claude', rows), '/' + name), '\x1b');
    h.tick(15000); assert.equal(h.render().interactive, true); assert.equal(h.render().feedback, undefined);
    h.render().close();
  }
});

test('Codex 0.163 identical status results finish when the tracker saw the new command enter and leave the input', t => {
  const h = rendererHarness(t, 'codex'), rows = fixture('codex-0-163-status');
  h.emit('a', rows); const id = h.render().begin('/status');
  h.emit('a', rows.map(row => row.trim() === '› Ask Codex to do anything' ? '› /status' : row));
  assert.equal(h.render().confirmInput(id), true); h.render().submitted(id);
  h.emit('a', rows); h.tick(400);
  assert.equal(h.render().busy, false);
  assert.ok(h.render().panel.rows.some(row => row.includes('OpenAI Codex (v0.163.0)')));
  assert.equal(h.render().panel.rows.filter(row => row.includes('OpenAI Codex')).length, 1, 'one latest result, not all earlier cards');
});

// Real registerScreen/readScreen implementation with an in-memory xterm surface. Its 100 ms publication can drop
// the whole typed -> idle transition; no GUI, PTY, screen-shape assumptions or real sessions are involved.
function coalescedTerminal(t, screenService, initial) {
  let rows = initial, parsed;
  const terminal = { get rows() { return rows.length; }, buffer: { active: { baseY: 0, getLine: index => ({ translateToString: () => rows[index] ?? '' }) } },
    onWriteParsed: fn => { parsed = fn; return { dispose() {} }; }, onResize: () => ({ dispose() {} }) };
  const unregister = screenService.registerScreen('a', terminal);
  t.after(unregister);
  return { draw(next) { rows = next; parsed(); } };
}

for (const agent of ['claude', 'codex']) {
  test(agent + ': exact live input receipt survives a missed intermediate producer publication through four repeats and the next command', t => {
    const service = require('../src/features/terminal/terminal-screen.ts');
    const h = rendererHarness(t, agent, service);
    const idle = fixture(agent === 'codex' ? 'codex-0-163-status' : 'claude-2-1-302-start');
    const result = fixture(agent === 'codex' ? 'codex-0-163-status' : 'claude-2-1-302-status');
    const terminal = coalescedTerminal(t, service, idle), published = [];
    const off = service.subscribeScreen('a', screen => published.push(screen.rows)); t.after(off);
    const typed = command => idle.map(row => row.trim().startsWith(agent === 'claude' ? '❯' : '› Ask Codex') ? (agent === 'claude' ? '❯ ' : '› ') + command : row);
    for (let repeat = 0; repeat < 4; repeat++) {
      terminal.draw(idle); const id = h.render().begin('/status');
      terminal.draw(typed('/status'));
      assert.equal(h.render().confirmInput(id), true, 'the live read acknowledges input before the producer publishes');
      h.render().submitted(id); terminal.draw(result);
      h.tick(100); h.tick(400);
      assert.equal(published.some(rows => rows.some(row => row.trim() === (agent === 'claude' ? '❯ /status' : '› /status'))), false);
      assert.equal(h.render().feedback, undefined); assert.ok(h.render().panel.rows.length);
      if (agent === 'codex') {
        assert.equal(h.render().busy, false, 'identical /status finishes within 500 ms, not after an eight-second timer');
        assert.equal(h.render().panel.rows.filter(row => row.includes('OpenAI Codex')).length, 1);
      } else assert.equal(h.render().interactive, true);
      h.render().close();
    }
    terminal.draw(idle); const id = h.render().begin('/model');
    terminal.draw(typed('/model')); assert.equal(h.render().confirmInput(id), true); h.render().submitted(id);
    terminal.draw(fixture(agent === 'codex' ? 'codex-0-163-model' : 'claude-model-menu')); h.tick(100);
    assert.equal(h.render().panel, null, 'the next model command reaches its own choice card');
    assert.equal(h.render().feedback, 'waiting');
  });

  test(agent + ': exact acknowledgment rejects a mismatched draft, old command token and disposed PTY', t => {
    const h = rendererHarness(t, agent);
    h.emit('a', input(agent)); const id = h.render().begin('/status');
    h.emit('a', input(agent, '/status-extra')); assert.equal(h.render().confirmInput(id), false);
    h.emit('a', input(agent, '/status')); assert.equal(h.render().confirmInput('older'), false);
    assert.equal(h.render().confirmInput(id), true);
    h.render('a', 'replacement'); assert.equal(h.render('a', 'replacement').confirmInput(id), false);
  });

  test(agent + ': arbitrary unconfirmed commands never become complete merely from exact receipt and idle', t => {
    const h = rendererHarness(t, agent);
    const earlier = [agent === 'claude' ? '❯ /unknown-action' : '/unknown-action', '  OLD RESULT'];
    h.emit('a', [...earlier, ...input(agent)]); const id = h.render().begin('/unknown-action');
    h.emit('a', [...earlier, ...input(agent, '/unknown-action')]); assert.equal(h.render().confirmInput(id), true); h.render().submitted(id);
    h.emit('a', [...earlier, ...input(agent)]); h.tick(10000);
    assert.equal(h.render().busy, true); assert.equal(h.render().feedback, 'recovery');
    assert.equal(h.render().panel.done, undefined); assert.deepEqual(h.render().panel.rows, [], 'unknown command old results stay out');
  });
}

test('Codex repeated status cannot finish from input acknowledgment without an explicit submitted Enter', t => {
  const h = rendererHarness(t, 'codex'), rows = fixture('codex-0-163-status');
  h.emit('a', rows); const id = h.render().begin('/status');
  h.emit('a', rows.map(row => row.trim() === '› Ask Codex to do anything' ? '› /status' : row));
  assert.equal(h.render().confirmInput(id), true);
  h.emit('a', rows); h.tick(10000);
  assert.equal(h.render().busy, true); assert.equal(h.render().feedback, 'recovery');
  assert.deepEqual(h.render().panel.rows, []);
});

test('renderer waits for screen output, keeps the finished popup until it is closed, then restores the composer', t => {
  const harness = rendererHarness(t);
  harness.emit('a', input('claude'));
  harness.render().begin('/status');
  harness.tick(1000);
  assert.equal(harness.render().busy, true, 'stale pre-submit idle cannot finish the command');
  harness.emit('a', ['❯ /status', '  Status tabs', 'Esc to close']);
  assert.deepEqual(harness.render().panel.rows, ['  Status tabs', 'Esc to close']);
  harness.emit('a', ['❯ /status', '  Printed status', ...input('claude')]);
  harness.tick(399);
  assert.equal(harness.render().busy, true);
  harness.tick(1);
  const done = harness.render();
  assert.equal(done.busy, false);
  // The popup stays on what the command showed: the dialog it drew, then what it printed on closing.
  assert.deepEqual(done.panel, { command: '/status', rows: ['  Status tabs', 'Esc to close', '', '  Printed status'], done: true });
  assert.equal(harness.focused(), 0);
  assert.equal(harness.watchers.size, 0);
  done.close();
  assert.equal(harness.render().panel, null);
  assert.equal(harness.focused(), 1, 'the message box takes the keyboard back once the popup closes');
});
test('Codex /fast before the first message (a footer with no context part) ends with what it printed', t => {
  const fresh = fixture('codex-fresh-default'), done = fixture('codex-fast-done');
  assert.equal(isCliIdle('codex', fresh, inspect('codex', fresh)), true);
  const harness = rendererHarness(t, 'codex');
  harness.emit('a', fresh);
  harness.render().begin('/fast');
  assert.equal(harness.render().busy, true);
  harness.emit('a', done);
  harness.tick(400);
  const finished = harness.render();
  assert.equal(finished.busy, false, 'not a spinner that never stops');
  assert.deepEqual(finished.panel, { command: '/fast', rows: ['• Service tier set to priority'], done: true });
});
test('Codex\'s tip under its last answer going away is no reason to take the whole conversation for /fast\'s output', t => {
  // Codex 0.162.1 after a few rounds (shortened): the tip under the last answer is gone once /fast runs.
  const answer = round => ['• 已创建：Markdown 示例文件。', '', '  ## 任务清单', '', '  ☑ 创建 Markdown 文件', '', `  第 ${round} 次回答。`];
  const earlier = ['› 创建一个md文件在对话框给我看 2', '', ...answer(3), '', '  Worked for <1s • 19:34', '', '', '› 创建一个md文件在对话框给我看 3', '', ...answer(5)];
  const before = [...earlier, '  └ Tip: Moving from Claude Code? Use /import to bring over your setup, project, and recent chats.', '', '  Worked for <1s • 19:34', '', '', ...input('codex')];
  const after = [...earlier.slice(1), '', '  Worked for <1s • 19:34', '', '• Service tier set to default', '', '', ...input('codex')];
  const harness = rendererHarness(t, 'codex');
  harness.emit('a', before);
  harness.render().begin('/fast');
  harness.emit('a', after);
  harness.tick(400);
  assert.deepEqual(harness.render().panel, { command: '/fast', rows: ['• Service tier set to default'], done: true });
});
test('Codex output is found under the history\'s last row when the row above it changed, and the screen is the output only once the history left it', () => {
  const before = ['• Earlier answer', '  note that will change', '  Worked for 2s', ''];
  const live = ['• Earlier answer', '  note, changed', '  Worked for 2s', '', '• Printed', '', ...input('codex')];
  assert.deepEqual(extractCliPanelRows('codex', live, inspect('codex', live), '/x', before), ['• Printed']);
  const gone = ['• A tall result', '  that filled the screen', '', ...input('codex')];
  assert.deepEqual(extractCliPanelRows('codex', gone, inspect('codex', gone), '/x', before), ['• A tall result', '  that filled the screen']);
  const still = ['• Earlier answer', '  Worked for 2s, but redrawn', '', ...input('codex')];
  assert.deepEqual(extractCliPanelRows('codex', still, inspect('codex', still), '/x', before), [], 'history still on screen is never the output');
});
test('a Codex command that prints nothing ends once its footer shows the change, and its popup says it is done', t => {
  const { parseAgentScreen: parse } = require('../src/features/agents/agent-screen.ts');
  const { cliFooter } = require('../src/features/reading/cli-panel.ts');
  const before = ['• Earlier answer', '', ...input('codex')];
  const harness = rendererHarness(t, 'codex');
  harness.emit('a', before);
  harness.render().begin('/fast', undefined, cliFooter(parse('codex', before)));
  harness.emit('a', ['• Earlier answer', '', '› ', '', '  GPT-6.1-Sol high fast · C:\\work\\demo · 90% left', '? for shortcuts']);
  harness.tick(400);
  const done = harness.render();
  assert.equal(done.busy, false, 'not the eight seconds a command that changed nothing is given');
  assert.deepEqual(done.panel, { command: '/fast', rows: [], done: true });
});
test('a Codex command with no observable receipt stays visible for recovery instead of claiming success', t => {
  const { parseAgentScreen: parse } = require('../src/features/agents/agent-screen.ts');
  const { cliFooter } = require('../src/features/reading/cli-panel.ts');
  const screen = ['• Earlier answer', '', ...input('codex')];
  const harness = rendererHarness(t, 'codex');
  harness.emit('a', screen);
  harness.render().begin('/quiet', undefined, cliFooter(parse('codex', screen)));
  harness.emit('a', screen);
  harness.tick(7000);
  assert.equal(harness.render().busy, true);
  harness.tick(1200);
  assert.deepEqual(harness.render().panel, { command: '/quiet', rows: [] });
  harness.tick(1800);
  assert.equal(harness.render().feedback, 'recovery');
  assert.equal(harness.render().busy, true);
});
test('renderer choice takes priority and a dialog closed without content leaves no popup', t => {
  const harness = rendererHarness(t);
  harness.render().begin('/model');
  harness.emit('a', fixture('claude-model-menu'));
  assert.equal(harness.render().panel, null);
  assert.equal(harness.render().busy, true);
  harness.emit('a', ['❯ /model', ...input('claude')]);
  harness.tick(400);
  assert.equal(harness.render().busy, false);
  assert.equal(harness.render().panel, null);
});
test('renderer popup survives remount, remains terminal-specific and resets for a new PTY session', t => {
  const harness = rendererHarness(t);
  harness.emit('a', input('claude'));
  harness.render().begin('! dir');
  harness.remount(); // Opening the raw terminal does not stop the command's watcher.
  harness.emit('a', ['❯ ! dir', '  file.txt', ...input('claude')]);
  harness.tick(400);
  assert.deepEqual(harness.render().panel.rows, ['  file.txt']);
  assert.equal(harness.render('b').panel, null);
  assert.equal(harness.render('a', 'new-session').panel, null);
  assert.deepEqual(harness.render().panel.rows, ['  file.txt']);
});
test('renderer stops an old PTY watcher when the terminal session changes', t => {
  const harness = rendererHarness(t);
  harness.render().begin('/config');
  assert.equal(harness.watchers.size, 1);
  const next = harness.render('a', 'new-session');
  assert.equal(next.busy, false);
  assert.equal(harness.watchers.size, 0);
  harness.tick(1000);
  assert.equal(harness.render('a', 'new-session').panel, null);
});

test('a Claude dialog in a tall terminal shows itself, not the welcome banner above a run of blank rows', () => {
  // Claude Code 2.1 /add-dir in a 45-row terminal: banner at the top, the dialog under its overline (which carries
  // the effort indicator set into it) at the bottom.
  const rows = [
    ' ▐▛███▛█   Claude Code v2.1.294', '▝▜██████▀  Opus 5.5 with xhigh effort · Claude Pro', ' ▝▝   ▝▝   ~/demo',
    ...Array(24).fill(''),
    '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ◉ xhigh · /effort ▔',
    '   Add directory to workspace', '', '   Claude Code will be able to read files in this directory.', '', '',
    '   Enter the path to the directory:', '   ╭──────────────────────╮', '   │ Directory path…      │', '   ╰──────────────────────╯', '',
    '   Tab to complete · Enter to add · Esc to cancel',
  ];
  const panel = extractCliPanelRows('claude', rows, inspect('claude', rows), '/add-dir');
  assert.equal(panel[0], '   Add directory to workspace');
  assert.equal(panel.at(-1), '   Tab to complete · Enter to add · Esc to cancel', 'keyboard hints stay');
  assert.ok(!panel.some(row => row.includes('Claude Code v2')), 'no banner');
  assert.ok(!panel.some((row, index) => !row.trim() && !panel[index - 1]?.trim()), 'blank rows never run together');
});

test('a Claude command still in the composer (its hooks running) shows no panel, and the banner never heads one', () => {
  const banner = [' ▐▛███▛█   Claude Code v2.1.294', '▝▜██████▀  Opus 5.5 with xhigh effort · Claude Pro', ' ▝▝   ▝▝   ~/demo', ''];
  // Enter was pressed; Claude still shows /btw in its input while UserPromptSubmit hooks run.
  const waiting = [...banner, ...Array(10).fill(''), ...input('claude', '/btw')];
  assert.deepEqual(extractCliPanelRows('claude', waiting, inspect('claude', waiting), '/btw'), []);
  // A dialog drawn straight under the banner, with neither an echo nor an overline above it.
  const dialog = [...banner, '   Select export method', '   1. Copy to clipboard', '   2. Save to file', '', '   Esc to cancel'];
  const panel = extractCliPanelRows('claude', dialog, inspect('claude', dialog), '/export');
  assert.equal(panel[0], '   Select export method');
  assert.ok(!panel.some(row => row.includes('Claude Code v2')));
});

test('Claude is not idle while its spinner runs, even with an empty input; a finished turn summary is not a spinner', () => {
  const hooks = ['❯ /release-notes', '', '✶ Osmosing… (running UserPromptSubmit hooks… 1/2 · 0s)', '', ...input('claude')];
  assert.equal(isCliIdle('claude', hooks, inspect('claude', hooks)), false);
  const thinking = ['· Beboppin\'… (3s · thinking with xhigh effort)', ...input('claude')];
  assert.equal(isCliIdle('claude', thinking, inspect('claude', thinking)), false);
  const done = ['❯ fix it', '⏺ Fixed.', '✻ Worked for 25s', '', ...input('claude')];
  assert.equal(isCliIdle('claude', done, inspect('claude', done)), true);
});

test('a command sent while the agent is not drawing yet (updating itself in the shell) shows nothing of the shell', () => {
  const shell = ['  AGENTRIX', '  Type codex to start, or codex resume to continue a session.', '', 'PS C:\work> codex resume 01a1', 'Updating Codex via `powershell ...`', '==> Downloading Codex CLI'];
  assert.deepEqual(extractCliPanelRows('codex', shell, inspect('codex', shell), '/model'), []);
});

test('a Codex command shows only what it printed since it was sent, never the banner above it', () => {
  const banner = ['>_ OpenAI Codex (v0.162.0)', '   ~\work\demo', '   permissions: YOLO mode', ''];
  const sent = [...banner, '• Earlier answer', '', ...input('codex', '/copy')];
  const before = cliHistory('codex', sent, inspect('codex', sent));
  const printed = [...banner, '• Earlier answer', '', '• Copied the last message to the clipboard.', '', ...input('codex')];
  assert.deepEqual(extractCliPanelRows('codex', printed, inspect('codex', printed), '/copy', before), ['• Copied the last message to the clipboard.']);
  assert.deepEqual(extractCliOutputRows('codex', printed, inspect('codex', printed), '/copy', before), ['• Copied the last message to the clipboard.']);
  // Nothing printed yet: an empty card, not the banner.
  const quiet = [...banner, '• Earlier answer', '', ...input('codex')];
  assert.deepEqual(extractCliPanelRows('codex', quiet, inspect('codex', quiet), '/copy', before), []);
  // A screen drawn anew shares no row with what was there: nothing is taken from it.
  const fresh = [...banner, ...input('codex')];
  assert.deepEqual(extractCliOutputRows('codex', fresh, inspect('codex', fresh), '/clear', before), []);
});

test('Codex output taller than the screen is all the command\'s; a screen drawn anew under the banner gives nothing', () => {
  const sent = ['• Earlier answer', '', ...input('codex', '/status')];
  const before = cliHistory('codex', sent, inspect('codex', sent));
  const tall = ['│ Model: gpt-6.1-sol │', '│ Directory: C:\\work │', '╰────────────────────╯', '', ...input('codex')];
  assert.deepEqual(extractCliOutputRows('codex', tall, inspect('codex', tall), '/status', before), ['│ Model: gpt-6.1-sol │', '│ Directory: C:\\work │', '╰────────────────────╯']);
  const cleared = ['>_ OpenAI Codex (v0.162.0)', '   ~\\work', '', ...input('codex')];
  assert.deepEqual(extractCliOutputRows('codex', cleared, inspect('codex', cleared), '/clear', before), []);
});

test('a Codex side conversation closes with Ctrl+C; a pager with q; an open dialog with Escape; the input with nothing', () => {
  const side = ['› what is a side conversation', '', '• An answer.', '', ...input('codex')];
  assert.equal(cliCloseKey('codex', side, inspect('codex', side), '/side'), '\x03');
  const pager = ['/ D I F F', '+ added', '↑/↓ to scroll · pgup/pgdn to page · home/end to jump', 'q close'];
  assert.equal(cliCloseKey('codex', pager, inspect('codex', pager), '/diff'), 'q');
  const idle = ['• Done.', '', ...input('codex')];
  assert.equal(cliCloseKey('codex', idle, inspect('codex', idle), '/pwd'), null);
  // Refused in a conversation with nothing in it yet: no side conversation opened, and Ctrl+C would quit Codex.
  const refused = ["■ '/side' is unavailable until the current conversation has started."];
  assert.equal(cliCloseKey('codex', idle, inspect('codex', idle), '/side', refused), null);
  assert.equal(isSideConversation('codex', '/side', refused), false);
  assert.equal(isSideConversation('codex', '/side'), true);
  const shown = [...refused, '', ...input('codex')];
  assert.equal(cliCloseKey('codex', shown, inspect('codex', shown), '/side'), null, 'the refusal on screen before the command printed anything');
  const later = [...refused, '', '› /side', '', 'Side conversation', '', ...input('codex')];
  assert.equal(cliCloseKey('codex', later, inspect('codex', later), '/side'), '\x03', 'an older refusal above a side conversation');
});

test('a Codex command waits for output that comes a moment after its input returns, then for it to settle', () => {
  const sent = ['• Earlier answer', '', ...input('codex', '/status')];
  let command = { id: 'c', command: '/status', at: 0, anchor: null, observed: true, idleSince: null, output: [], dialog: [], before: cliHistory('codex', sent, inspect('codex', sent)) };
  const step = (rows, now) => { const next = advanceCliCommand(command, 'codex', rows, inspect('codex', rows), now, true); command = next.command; return next.done; };
  const quiet = ['• Earlier answer', '', ...input('codex')];
  assert.equal(step(quiet, 100), false); assert.equal(step(quiet, 600), false, 'nothing printed yet: keep waiting');
  const printed = ['• Earlier answer', '', '│ Model: gpt-6.1-sol │', '', ...input('codex')];
  assert.equal(step(printed, 900), false, 'output just changed');
  assert.equal(step(printed, 1350), true, 'output settled');
  assert.deepEqual(command.output, ['│ Model: gpt-6.1-sol │']);
  command = { ...command, output: [], idleSince: null };
  assert.equal(step(quiet, 2000), false); assert.equal(step(quiet, 8100), false, 'without observable receipt, a wait budget cannot prove completion');
});

test('a Codex picker drawn under the input (/copy) fills the card and closes with Escape', () => {
  const sent = ['• MAIN-1', '', ...input('codex', '/copy')];
  const before = cliHistory('codex', sent, inspect('codex', sent));
  const picker = ['› 只回复：MAIN-1', ...input('codex', 'Ask Codex to do anything'), '  Copy user message', '  ↑/↓/j/k select · g/G ends · enter copy · esc close'];
  assert.deepEqual(extractCliPanelRows('codex', picker, inspect('codex', picker), '/copy', before), ['  Copy user message', '  ↑/↓/j/k select · g/G ends · enter copy · esc close']);
  assert.equal(cliCloseKey('codex', picker, inspect('codex', picker), '/copy'), '\x1b');
});

test('Codex /status, whose card repeats the banner, is found by its echo when the history above changed meanwhile', () => {
  const banner = ['>_ OpenAI Codex (v0.162.0)', '   ~\\work\\demo', '   permissions: YOLO mode', ''];
  const sent = [...banner, '  Tip: try /review', '', ...input('codex', '/status')];
  const before = cliHistory('codex', sent, inspect('codex', sent));
  const card = ['  >_ OpenAI Codex (v0.162.0)', '  Model:               GPT-6.1-Sol (reasoning high)', '  Weekly limit:        [███████████████████░] 96% left'];
  const printed = [...banner, '/status', ...card, '', ...input('codex')];
  assert.deepEqual(extractCliOutputRows('codex', printed, inspect('codex', printed), '/status', before), card);
  assert.deepEqual(extractCliPanelRows('codex', printed, inspect('codex', printed), '/status', before), card);
});

test('the command line newer Codex prints above its output is not repeated in the result', () => {
  const sent = ['• MAIN-1', '', ...input('codex', '/status')];
  const before = cliHistory('codex', sent, inspect('codex', sent));
  const printed = ['• MAIN-1', '', '/status', '', '  Model:   gpt-6.1-sol', '', ...input('codex')];
  assert.deepEqual(extractCliOutputRows('codex', printed, inspect('codex', printed), '/status', before), ['  Model:   gpt-6.1-sol']);
});

test('a Claude dialog opened while Claude works is still a dialog: the next command closes it first', () => {
  // Claude 2.1.296 with a round under way: its working line stays above the /status dialog.
  const working = ['· Razzmatazzing… (11s · thinking with high effort)', '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔', '   Settings  Status   Config   Usage   Stats', '',
    '   Version:           2.1.296', '   Session kind:      interactive', '   Model:             opus (claude-opus-5-5)', '', '   Esc to cancel'];
  assert.equal(cliCloseKey('claude', working, inspect('claude', working), '/status'), '\x1b');
  // Working with no dialog: nothing to close (Escape there would interrupt the round).
  const busy = ['● Writing the poem', '', '✶ Razzmatazzing… (11s · esc to interrupt)', '', ...input('claude')];
  assert.equal(cliCloseKey('claude', busy, inspect('claude', busy), '/status'), null);
  const answering = ['✶ Razzmatazzing… (3s · esc to interrupt)', '', '● Line one of the poem'];
  assert.equal(cliCloseKey('claude', answering, inspect('claude', answering), '/status'), null);
});

test('a Claude dialog closed while Claude still works ends its command at once, with what the dialog showed', () => {
  const working = ['· Razzmatazzing… (11s · thinking with high effort)', '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔', '   Settings  Status   Config   Usage   Stats', '',
    '   Current session    ██▌ 5% used', '', '   Esc to cancel'];
  const shown = { id: 'c', command: '/usage', at: 0, observed: true, idleSince: null, output: [], dialog: ['   Current session    ██▌ 5% used'] };
  assert.equal(advanceCliCommand(shown, 'claude', working, inspect('claude', working), 100, true).done, false, 'still open');
  const busy = ['● Writing the poem', '', '✶ Razzmatazzing… (12s · esc to interrupt)', '', ...input('claude')];
  assert.equal(advanceCliCommand(shown, 'claude', busy, inspect('claude', busy), 200, true).done, true, 'closed, Claude still working');
  assert.equal(advanceCliCommand({ ...shown, dialog: [] }, 'claude', busy, inspect('claude', busy), 200, true).done, false, 'no dialog seen yet: wait');
});

test('a Codex command that asked something ends once the question is gone, without waiting for output', () => {
  const sent = ['• Earlier answer', '', ...input('codex', '/model')];
  let command = { id: 'c', command: '/model', at: 0, observed: true, idleSince: null, output: [], dialog: [], before: cliHistory('codex', sent, inspect('codex', sent)) };
  const step = (rows, now) => { const next = advanceCliCommand(command, 'codex', rows, inspect('codex', rows), now, true); command = next.command; return next.done; };
  const menu = fixture('codex-model-menu');
  assert.ok(inspect('codex', menu).choice, 'the fixture is a picker');
  assert.equal(step(menu, 100), false);
  const back = ['• Earlier answer', '', ...input('codex')];
  assert.equal(step(back, 200), false);
  assert.equal(step(back, 600), true, 'done after the usual 400 ms idle, not the eight seconds a silent command gets');
});

test('the same Codex command twice shows its output again, not nothing', () => {
  const first = ['• Earlier answer', '', '/pwd', '• Current working directory: C:\work'];
  const before = cliHistory('codex', [...first, '', ...input('codex')], inspect('codex', [...first, '', ...input('codex')]));
  const rows = [...first, '', '/pwd', '• Current working directory: C:\work', '', ...input('codex')];
  assert.deepEqual(extractCliPanelRows('codex', rows, inspect('codex', rows), '/pwd', before), ['• Current working directory: C:\work']);
  assert.deepEqual(extractCliOutputRows('codex', rows, inspect('codex', rows), '/pwd', before), ['• Current working directory: C:\work']);
  // Older Codex prints no echo row: what came in under the history is still the command's.
  const plain = ['• Earlier answer', '', '• Status: ok'], again = [...plain, '', '• Status: ok', '', ...input('codex')];
  const was = cliHistory('codex', [...plain, '', ...input('codex')], inspect('codex', [...plain, '', ...input('codex')]));
  assert.deepEqual(extractCliPanelRows('codex', again, inspect('codex', again), '/status', was), ['• Status: ok']);
});

test('the same Codex command twice on a full screen: the new card lands where the old one was, and is still the output', () => {
  // Codex 0.162.1 (shortened): /status run again after a conversation. The screen scrolled by one card, the new card
  // sits on the rows the old one had, and Codex redrew the top row (the prompt above the last answer).
  const card = ['  >_ OpenAI Codex (v0.162.1)', '', '  Model:               GPT-6-Sol (reasoning medium, summaries auto)', '  Directory:           ~\\work\\demo', '',
    '  Context window:      100% left (0 used / 258K)', '  Limits:              data not available yet'];
  const answer = ['• 已创建：Markdown 示例文件。', '', '  > 这是一段引用文字。', '', '  ## 任务清单', '', '  ☑ 创建 Markdown 文件', '', '  第 5 次回答。', '', '  Worked for <1s • 15:16', ''];
  const sent = ['', '', ...answer, '/status', '', ...card, '', '', ...input('codex', '/status')];
  const before = cliHistory('codex', sent, inspect('codex', sent));
  const rows = ['› 创建一个md文件在对话框给我看 3', ...answer.slice(9), '/status', '', ...card, '', '/status', '', ...card, '', '', ...input('codex')];
  assert.equal(rows.length, sent.length, 'a full screen');
  const shown = card.filter((row, index) => row || card[index - 1]);
  assert.deepEqual(extractCliPanelRows('codex', rows, inspect('codex', rows), '/status', before), shown);
  assert.deepEqual(extractCliOutputRows('codex', rows, inspect('codex', rows), '/status', before), card);
  // Before the new card comes in, the old one is still the history, not the output.
  const quiet = [...sent.slice(0, -input('codex', '/status').length), ...input('codex')];
  assert.deepEqual(extractCliOutputRows('codex', quiet, inspect('codex', quiet), '/status', before), []);
  // A third time, with two cards in the history and the turn's prompt pinned to the top row: the new card is the
  // output, not the old two (which match the history's last rows as far back as the screen goes).
  const pinned = '› 创建一个md文件在对话框给我看 3';
  const third = [pinned, '', '  ## 任务清单', '', '  第 5 次回答。', '', '  Worked for <1s • 15:16', '', '/status', '', ...card, '', '/status', '', ...card, '', '', ...input('codex', '/status')];
  const twice = cliHistory('codex', third, inspect('codex', third));
  const again = [pinned, ...card.slice(1), '', '/status', '', ...card, '', '/status', '', ...card, '', '', ...input('codex')];
  assert.equal(again.length, third.length, 'a full screen');
  assert.deepEqual(extractCliOutputRows('codex', again, inspect('codex', again), '/status', twice), card);
  const still = [...third.slice(0, -input('codex', '/status').length), ...input('codex')];
  assert.deepEqual(extractCliOutputRows('codex', still, inspect('codex', still), '/status', twice), []);
  // A fourth time an identical redraw cannot establish whether another /status ran. Leave it unconfirmed rather
  // than reporting old cards as new output; the hook provides bounded terminal recovery feedback.
  const run = (screen, before) => {
    let command = { id: 'c', command: '/status', at: 0, observed: true, idleSince: null, output: [], dialog: [], before };
    const step = now => { const next = advanceCliCommand(command, 'codex', screen, inspect('codex', screen), now, true); command = next.command; return next.done; };
    return [step(100), step(600), step(8100), command.output];
  };
  assert.deepEqual(run(again, cliHistory('codex', again, inspect('codex', again))), [false, false, false, []], 'an identical redraw cannot prove another command ran');
  // Not all the screen is that card over again (an answer below an earlier /status): nothing of it is this run's.
  const later = [...still.slice(0, -input('codex').length - 2), '', '• 已切换。', '', '', ...input('codex')];
  assert.deepEqual(run(later, cliHistory('codex', later, inspect('codex', later))), [false, false, false, []]);
  assert.deepEqual(run(still, twice), [false, false, false, []], 'the history above the cards is not a card');
});

test('a Claude dialog under its edge shows only itself, not an earlier run of the same command above it', () => {
  const rows = ['❯ /usage', '  ⎿  Status dialog dismissed', '', '❯ fix the bug', '', '⏺ Fixed it.', '', '▔'.repeat(40), '  Settings   Status   Usage', '', '  Current session  12% used', '', '  Esc to cancel'];
  const result = extractCliPanelRows('claude', rows, inspect('claude', rows), '/usage');
  assert.deepEqual(result, ['  Settings   Status   Usage', '', '  Current session  12% used', '', '  Esc to cancel']);
});

test("Claude Code 2.1.296's effort over its input box and the input box are never a command's output", () => {
  const fs = require('node:fs'), path = require('node:path');
  const { parseAgentScreen: parse } = require('../src/features/agents/agent-screen.ts');
  const idle = fs.readFileSync(path.join(__dirname, 'fixtures/screens/claude-idle-2-1-296.txt'), 'utf8').split('\n');
  const effort = idle.findIndex(row => /◉ xhigh · \/effort/.test(row));
  const rows = [...idle.slice(0, effort), '❯ /cost', '  ⎿  Total cost:            $0.0000', '     Total duration (API):  0s', '', ...idle.slice(effort)];
  const screen = parse('claude', rows);
  const output = extractCliOutputRows('claude', rows, screen, '/cost'), panel = extractCliPanelRows('claude', rows, screen, '/cost');
  // Once Claude is idle the popup shows the output, up to the input box; while a dialog is open, what is drawn down to
  // the footer (a dialog's own search field included), never the effort.
  assert.ok(output.some(row => /Total cost/.test(row)) && !output.some(row => /\/effort|^\s*❯/.test(row)), JSON.stringify(output));
  assert.ok(panel.some(row => /Total cost/.test(row)) && !panel.some(row => /\/effort/.test(row)), JSON.stringify(panel));
  assert.ok(!cliHistory('claude', rows, screen).some(row => /\/effort/.test(row)));
});

// Codex 0.162.1's interactive commands: /memories draws its dialog over the conversation with the input still below it,
// /plugins puts its view in the input's place. Each is the command's popup alone, and the command waits for it.
test("Codex's dialogs over the conversation and views in its input's place show alone, and keep the command waiting", () => {
  const dialog = fixture('codex-memories-dialog'), dialogScreen = inspect('codex', dialog);
  assert.equal(dialogScreen.choice?.title, 'Enable memories?', 'the dialog asks in the reading view');
  assert.equal(isAtPrompt('codex', dialog, dialogScreen), false);
  assert.equal(cliCloseKey('codex', dialog, dialogScreen), '\x1b', 'Escape closes it');
  // A dialog without numbered options (a view of figures) is shown as it is, from its left edge on.
  const view = dialog.map(row => row.replace(/›\s1\.\s/, '›    ').replace(/(\s)2\.\s/, '$1   ')), viewScreen = inspect('codex', view);
  assert.equal(viewScreen.choice, null);
  assert.equal(isAtPrompt('codex', view, viewScreen), false);
  assert.deepEqual(extractCliPanelRows('codex', view, viewScreen, '/memories', cliHistory('codex', fixture('codex-memories-dialog-before'), inspect('codex', fixture('codex-memories-dialog-before')))), [
    '  Enable memories?', '  Memories are disabled in this TUI session.', '', '›    Yes, enable  Save on the server for new threads without changing',
    '                  this thread', '     Not now      Keep memories disabled', '', '  Learn more: https://developers.openai.com/codex/memories', '  enter select · esc back',
  ]);
  const before = fixture('codex-plugins-view-before'), plugins = fixture('codex-plugins-view'), screen = inspect('codex', plugins);
  assert.deepEqual(extractCliPanelRows('codex', plugins, screen, '/plugins', cliHistory('codex', before, inspect('codex', before))), [
    '  Plugins', '  Browse plugins from available marketplaces.', '  Installed 0 of 0 available plugins.', '',
    '   All Plugins   Installed (0)   OpenAI Curated   Workspace   Shared with me   Add Marketplace', '', '  Type to search plugins', '',
    '› No marketplace plugins available  No plugins are available in the discovered marketplaces', '', '  ←/→ tabs · enter details · space toggle · esc close',
  ], 'the prompt Codex pins to its top row is not taken for its input');
  assert.equal(isAtPrompt('codex', plugins, screen), false);
  assert.equal(cliCloseKey('codex', plugins, screen, '/plugins'), '\x1b');
});

test("a long draft wrapped over Claude's input is its input; words quoted in the conversation are no dialog; a working Claude gets no Escape", () => {
  // Claude Code 2.1.301 at work, a long dictated message left unsent in its input (wrapped over three rows), and an
  // earlier message quoting a dialog's key hint ("esc to cancel") in the conversation above.
  const rows = fixture('claude-wrapped-draft'), screen = inspect('claude', rows);
  assert.equal(hasCliInput('claude', rows, screen), true, 'the wrapped input is still the input');
  assert.equal(cliInputDraft('claude', rows, screen).replace(/\s+/g, ''), '这是一段用语音说出来的很长的话，'.repeat(14) + '说完了。', 'its rows read as one draft');
  assert.equal(cliDialogShown('claude', rows, screen), false, 'a key hint in the conversation is not a dialog');
  assert.equal(cliCloseKey('claude', rows, screen), null, 'nothing to close');
  assert.equal(claudeAtWork('claude', rows), true);
  assert.equal(cliEscapeSafe('claude', rows), false, 'a quoted hint must not let Escape interrupt the round');
  // Even with its input box out of sight, a working Claude is never taken for a dialog by words higher up.
  const boxless = rows.filter(row => !/^\s*─{5,}/.test(row)), bare = inspect('claude', boxless);
  assert.equal(hasCliInput('claude', boxless, bare), false);
  assert.equal(cliDialogShown('claude', boxless, bare), false);
  assert.equal(cliEscapeSafe('claude', boxless), false, 'missing input does not make a historical hint safe');
  assert.equal(cliCloseKey('claude', boxless, bare), null);
  assert.equal(claudeAtWork('codex', rows), false);
});

test('Claude 2.1.302 usage dialog takes Escape while the round keeps working', () => {
  const rows = fixture('claude-usage-working'), screen = inspect('claude', rows);
  assert.equal(claudeAtWork('claude', rows), true);
  assert.equal(cliDialogShown('claude', rows, screen), true);
  assert.equal(cliEscapeSafe('claude', rows), true);
  assert.equal(cliCloseKey('claude', rows, screen, '/usage'), '\x1b');
  for (const action of ['cancel', 'close', 'exit', 'go back', 'dismiss']) {
    const hinted = rows.map(row => row.replace('Esc to cancel', 'Esc to ' + action));
    assert.equal(cliEscapeSafe('claude', hinted), true, action);
    assert.equal(cliCloseKey('claude', hinted, inspect('claude', hinted), '/usage'), '\x1b', action);
  }
  const closed = rows.slice(0, 2);
  assert.equal(claudeAtWork('claude', closed), true, 'the round continues after the dialog closes');
  assert.equal(cliEscapeSafe('claude', closed), false, 'no second Escape after the dialog is gone');
  assert.equal(cliCloseKey('claude', closed, inspect('claude', closed), '/usage'), null);
});

test('Claude 2.1.302 config dialog takes Escape while working, but its interrupt footer alone never does', () => {
  const rows = fixture('claude-config-working'), screen = inspect('claude', rows);
  assert.equal(claudeAtWork('claude', rows), true);
  assert.equal(cliDialogShown('claude', rows, screen), true);
  assert.equal(cliEscapeSafe('claude', rows), true);
  assert.equal(cliCloseKey('claude', rows, screen, '/config'), '\x1b');

  const footer = '  ⏸ manual mode on · esc to interrupt';
  assert.equal(cliDialogShown('claude', [footer], inspect('claude', [footer])), false);
  for (const closed of [[...rows.slice(0, 2), footer], [...rows.slice(0, 2), ...input('claude'), footer]]) {
    assert.equal(claudeAtWork('claude', closed), true);
    assert.equal(cliDialogShown('claude', closed, inspect('claude', closed)), false, 'the working footer is not a dialog');
    assert.equal(cliCloseKey('claude', closed, inspect('claude', closed), '/config'), null);
    assert.equal(cliEscapeSafe('claude', closed), false);
  }
  const historical = ['Esc to clear', ...Array(8).fill('  Earlier output'), ...rows.slice(0, 2), footer];
  assert.equal(cliDialogShown('claude', historical, inspect('claude', historical)), false, 'clear hints only count at the bottom');
  assert.equal(cliEscapeSafe('claude', historical), false);
  assert.equal(cliCloseKey('claude', historical, inspect('claude', historical), '/config'), null);
});

test('ReadingView closes config after clearing its filter and stops sending Escape as soon as it closes', async () => {
  // Exercise the actual close loop without mounting the view or starting a terminal.
  const ts = require('typescript');
  const filename = path.join(__dirname, '..', 'src/features/reading/ReadingView.tsx');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const find = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'closeDialog') initializer = node.initializer;
    ts.forEachChild(node, find);
  };
  find(source);
  assert.ok(initializer, 'the view owns the close loop');
  const code = ts.transpileModule('return ' + initializer.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const bind = new Function('{ readScreen, terminal, parseAgentScreen, cliEscapeSafe, cliCloseKey, cliDialogShown, cli, hasCliInput, window, setTimeout, sendOwner, mounted }', code);
  const empty = fixture('claude-config-working');
  const filtered = empty.map(row => row.replace('Search settings…', 'motion'));
  const closed = [...empty.slice(0, 2), '  ⏸ manual mode on · esc to interrupt'];
  for (const untilInput of [false, true]) {
    for (const screens of [[empty, closed], [filtered, empty, closed]]) {
      let at = 0;
      const writes = [];
      const close = bind({
        readScreen: () => ({ rows: screens[at] }), terminal: { id: 'config-test' },
        parseAgentScreen, cliEscapeSafe, cliCloseKey, cliDialogShown, cli: { panel: { rows: empty } }, hasCliInput, sendOwner: { current: 'session' }, mounted: { current: true },
        window: { agentrix: { writeTerminal: (id, key) => {
          assert.equal(id, 'config-test');
          assert.ok(at < screens.length - 1, 'no Escape after the dialog disappears');
          writes.push(key); at++;
        } } },
        setTimeout: resolve => resolve(),
      });
      assert.equal(await close('claude', '/config', untilInput), true);
      assert.equal(at, screens.length - 1, 'the dialog closed while Claude kept working');
      assert.deepEqual(writes, Array(screens.length - 1).fill('\x1b'));
    }
  }
  for (const agent of ['claude', 'codex']) {
    for (const rows of [[], ['Unknown screen without a dialog close hint']]) {
      const writes = [];
      const close = bind({ readScreen: () => ({ rows }), terminal: { id: 'unknown' }, parseAgentScreen, cliEscapeSafe, cliCloseKey, cliDialogShown, cli: { panel: { rows: [] } }, hasCliInput,
        sendOwner: { current: 'owner' }, mounted: { current: true }, window: { agentrix: { writeTerminal: (...args) => writes.push(args) } }, setTimeout: resolve => resolve() });
      assert.equal(await close(agent, '/status'), false);
      assert.deepEqual(writes, [], 'an unknown screen never receives an arbitrary close key');
    }
    const rows = fixture(agent === 'claude' ? 'claude-config-working' : 'codex-0-163-permissions');
    const sendOwner = { current: 'old-pty' }, writes = [];
    const close = bind({ readScreen: () => ({ rows }), terminal: { id: 'switch' }, parseAgentScreen, cliEscapeSafe, cliCloseKey, cliDialogShown, cli: { panel: { rows } }, hasCliInput,
      sendOwner, mounted: { current: true }, window: { agentrix: { writeTerminal: (id, key) => writes.push(key) } }, setTimeout: resolve => { sendOwner.current = 'new-pty'; resolve(); } });
    assert.equal(await close(agent, '/config'), false);
    assert.deepEqual(writes, ['\x1b'], 'no close retries can reach a replacement PTY');
  }
});

test('Escape safety preserves idle Claude and every Codex screen', () => {
  assert.equal(cliEscapeSafe('claude', fixture('claude-startup')), true);
  for (const name of fs.readdirSync(path.join(__dirname, 'fixtures/screens')).filter(name => name.startsWith('codex-'))) {
    assert.equal(cliEscapeSafe('codex', fixture(name.slice(0, -4))), true, name);
  }
  assert.equal(cliEscapeSafe('codex', fixture('claude-wrapped-draft')), true, 'Claude working glyphs do not guard Codex');
});
