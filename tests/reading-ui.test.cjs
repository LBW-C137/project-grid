const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { choiceKeys, selectedChoiceIndex, choiceIdentity, writeChoiceKeys } = require('../src/features/reading/choice-keys.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const en = require('../electron/locales/en.json');

// Components use test-only screen values until feat/screen-parser replaces the stub.
const fakeScreen = overrides => ({
  banner: { product: 'Claude Code', version: '2.1.293', model: 'Opus 5.5', effort: 'high', plan: 'Claude Max', directory: 'C:\\work\\demo-app' },
  status: { model: null, effort: null, context: 'ctx 4%', mode: 'manual mode on', notes: [] },
  choice: null, overlay: 'none', ...overrides,
});
const fakeChoice = () => ({
  kind: 'permission', title: 'Run this command?', context: ['$ echo hello', 'Reason: write hello.txt'],
  options: [
    { number: 1, label: 'Yes', detail: '', hotkey: 'y', selected: false },
    { number: 2, label: 'Always allow', detail: 'Commands starting with echo', hotkey: 'p', selected: true },
    { number: 3, label: 'No', detail: '', hotkey: 'esc', selected: false },
  ], hint: 'Enter to confirm · Esc to cancel',
});

// Transpile only these UI modules. No Electron, DOM, terminal or production parser is started.
function loadUI(name, overrides = {}) {
  const filename = path.join(__dirname, '..', 'src', name);
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = name => {
    const key = name.startsWith('.') ? './' + path.basename(name) : name;
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (name.endsWith('.css')) return {};
    // Every icon renders as a plain svg carrying its class name.
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => props => React.createElement('svg', { className: props.className }) });
    if (key === './i18n') return { currentLanguage: () => 'en', t: (text, values = {}) => (en[text] ?? text).replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) };
    if (key === './choice-keys') return require('../src/features/reading/choice-keys.ts');
    if (key === './approval-action') return require('../src/features/reading/approval-action.ts');
    if (key === './dictation-send') return require('../src/features/reading/dictation-send.ts');
    if (key === './reading-sessions') return require('../src/features/reading/reading-sessions.ts');
    if (key === './reply-files') return require('../src/features/reading/reply-files.ts');
    if (key === './ReadingSignIn') return { ReadingSignIn: () => null };
    if (key === './AgentCommandRun') return { AgentCommandRun: () => null };
    if (key === './AgentSettingsTag') return { AgentSettingsTag: () => null };
    if (key === './Timeline') return loadUI('features/reading/Timeline.tsx');
    if (key === './typing') return require('../src/features/reading/typing.ts');
    if (key === './composer-prefill') return require('../src/features/reading/composer-prefill.ts');
    if (key === './image-thumbnail') return require('../src/features/reading/image-thumbnail.ts');
    if (key === './markdown-escape') return require('../src/features/reading/markdown-escape.ts');
    if (key === './pasted-pictures') return require('../src/features/reading/pasted-pictures.ts');
    if (key === './sign-in-screen') return require('../src/features/agents/sign-in-screen.ts');
    if (key === './file-popup') return { showPopup: () => {}, closePopup: () => {}, usePopup: () => null };
    return originalRequire(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}

test('named timeline heads show their time even in the same minute as the previous step', () => {
  const { TimelineStep, stepTime } = loadUI('features/reading/Timeline.tsx');
  const at = new Date(2026, 9, 17, 16, 16, 20).getTime();
  for (const who of ['你', 'Claude Code', 'Codex']) {
    const html = renderToStaticMarkup(React.createElement(TimelineStep, {
      at, kind: who === '你' ? 'user' : 'agent', who, showTime: false, mark: null,
    }, 'message'));
    assert.ok(html.includes(`<b class="reading-step-label">${who}</b><time dateTime="${new Date(at).toISOString()}">${stepTime(at)}</time>`), who);
  }
});

test('child replies and tools show minute changes without adding main rail nodes', () => {
  const { AgentTurnItem } = loadUI('features/reading/Timeline.tsx');
  const at = new Date(2026, 9, 17, 16, 16, 40).getTime();
  for (const kind of ['message', 'tools']) {
    const render = showTime => renderToStaticMarkup(React.createElement(AgentTurnItem, { at, kind, showTime, mark: null }, 'step'));
    assert.doesNotMatch(render(false), /<time|reading-step-head|reading-node|class="reading-step /);
    assert.match(render(true), /<time dateTime=/);
    if (kind === 'tools') assert.match(render(true), /step<time/);
  }
});

test('choice keys move up, down or confirm in place using option positions', () => {
  assert.deepEqual(choiceKeys(1, 3), ['\x1b[B', '\x1b[B', '\r']);
  assert.deepEqual(choiceKeys(3, 0), ['\x1b[A', '\x1b[A', '\x1b[A', '\r']);
  assert.deepEqual(choiceKeys(2, 2), ['\r']);
  assert.equal(selectedChoiceIndex(fakeChoice()), 1);
  assert.equal(selectedChoiceIndex({ ...fakeChoice(), options: [] }), 0);
});

test('choice identity survives cursor redraws and changes for the next menu', () => {
  const choice = fakeChoice();
  assert.equal(choiceIdentity(choice), choiceIdentity({ ...choice, options: choice.options.map(option => ({ ...option, selected: !option.selected })) }));
  assert.notEqual(choiceIdentity(choice), choiceIdentity({ ...choice, title: 'Select effort' }));
  assert.notEqual(choiceIdentity(choice), choiceIdentity({ ...choice, options: choice.options.slice(1) }));
});

test('choice writes are separate and spaced 25 ms apart, with Enter last', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const written = [];
  const pending = writeChoiceKeys(0, 2, key => written.push(key));
  assert.deepEqual(written, ['\x1b[B']);
  t.mock.timers.tick(24); await Promise.resolve(); assert.equal(written.length, 1);
  t.mock.timers.tick(1); await Promise.resolve(); assert.deepEqual(written, ['\x1b[B', '\x1b[B']);
  t.mock.timers.tick(25); await pending; assert.deepEqual(written, ['\x1b[B', '\x1b[B', '\r']);
});

test('dismissing a choice aborts its remaining keys', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = true; const written = [];
  const pending = writeChoiceKeys(2, 0, key => written.push(key), () => active);
  active = false; t.mock.timers.tick(25); await pending;
  assert.deepEqual(written, ['\x1b[A']);
});

test('screen parser stub preserves its replacement contract', () => {
  for (const agent of ['claude', 'codex']) assert.deepEqual(parseAgentScreen(agent, ['anything']), {
    banner: null, status: { model: null, effort: null, context: null, mode: null, notes: [] }, choice: null, overlay: 'none',
  });
});

test('welcome renders CLI metadata and the cached agent commands without a terminal toggle', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  for (const agent of ['claude', 'codex']) {
    const names = agent === 'claude' ? ['/init', '/help', '/model', '/status', '/review'] : ['/init', '/model', '/status', '/review', '/permissions'];
    const commands = names.map(name => ({ name, source: 'builtin', description: '审查代码', view: 'reading' }));
    const html = renderToStaticMarkup(React.createElement(ReadingWelcome, { agent, screen: fakeScreen(), commands, complete: () => {}, disabled: false }));
    assert.match(html, /Claude Code/); assert.match(html, /v2\.1\.293/); assert.match(html, /Opus 5\.5/); assert.match(html, /high/);
    assert.match(html, /Claude Max/); assert.match(html, /C:\\work\\demo-app/); assert.match(html, /Review code/);
    assert.equal((html.match(/<button/g) ?? []).length, 5);
    for (const name of names) assert.ok(html.includes(name));
    assert.doesNotMatch(html, /切换到终端|Switch to terminal/);
  }
});

test('welcome uses startup spinner and status model before a banner is available', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  const screen = fakeScreen({ banner: null, status: { model: 'GPT-6.1-Sol', effort: 'high', context: null, mode: null, notes: [] } });
  const html = renderToStaticMarkup(React.createElement(ReadingWelcome, { agent: 'codex', screen, commands: [], complete: () => {}, disabled: false }));
  assert.match(html, /Codex/); assert.match(html, /Starting…/); assert.match(html, /loading-spinner/); assert.match(html, /GPT-6\.1-Sol/);
});

test('welcome without a banner settles to the agent name and parsed status without a spinner', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  const html = renderToStaticMarkup(React.createElement(ReadingWelcome, {
    agent: 'claude', screen: fakeScreen({ banner: null }), commands: [], complete() {}, disabled: false, starting: false,
  }));
  assert.match(html, /Claude Code/); assert.doesNotMatch(html, /Starting…|loading-spinner/);
  const withModel = renderToStaticMarkup(React.createElement(ReadingWelcome, {
    agent: 'claude', screen: fakeScreen({ banner: null, status: { model: 'Opus 5.5', effort: 'high', notes: [] } }), commands: [], complete() {}, disabled: false, starting: false,
  }));
  assert.match(withModel, /Opus 5\.5/); assert.match(withModel, /high/); assert.doesNotMatch(withModel, /Starting…|loading-spinner/);
});

function sessionsHarness(t, initialSessions = []) {
  const slots = [initialSessions], written = [], followed = [], sent = [], errors = []; let cursor = 0, closed = 0;
  const hooks = {
    useState: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() {},
  };
  const previous = globalThis.window;
  globalThis.window = { agentrix: {
    writeTerminal: (id, text) => written.push({ id, text }),
    followAgentSession: async (id, sessionId) => { followed.push({ id, sessionId }); return { ok: true, value: true }; },
  } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const { ReadingSessions } = loadUI('features/reading/ReadingSessions.tsx', { react: hooks });
  const render = () => {
    cursor = 0;
    const root = ReadingSessions({ terminalId: 'resume-terminal', onClose: () => { closed++; }, onSent: text => sent.push(text), onError: error => errors.push(error) });
    root.props.ref.current = { focus() {} }; return root;
  };
  const press = key => {
    let prevented = false;
    render().props.onKeyDown({ key, nativeEvent: {}, preventDefault: () => { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
  };
  const options = () => elements(render()).filter(node => node.props.className === 'reading-choice-option');
  return { render, press, options, written, followed, sent, errors, closed: () => closed };
}

test('native session card arrows highlight, Enter types a targeted resume and follows after Enter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sessions = ['first', 'second'].map(id => ({ id, title: id, updatedAt: Date.now() - 180000, messages: 3 }));
  const h = sessionsHarness(t, sessions);
  assert.equal(h.options()[0].props['data-highlighted'], true);
  h.press('ArrowDown'); assert.equal(h.options()[1].props['data-highlighted'], true);
  h.press('ArrowUp'); assert.equal(h.options()[0].props['data-highlighted'], true);
  h.press('ArrowDown'); h.press('Enter'); h.press('Enter'); h.press('Escape');
  // What waits in Claude's input is cleared first, then the command is typed.
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }]); assert.deepEqual(h.followed, []);
  assert.ok(h.options().every(option => option.props.disabled));
  t.mock.timers.tick(60); for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }, { id: 'resume-terminal', text: '/resume second' }]);
  t.mock.timers.tick(150);
  for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }, { id: 'resume-terminal', text: '/resume second' }, { id: 'resume-terminal', text: '\r' }]);
  assert.deepEqual(h.followed, [{ id: 'resume-terminal', sessionId: 'second' }]);
  assert.deepEqual(h.sent, ['/resume second']); assert.equal(h.closed(), 1); assert.deepEqual(h.errors, []);
});

test('native session card click chooses and Esc closes without sending terminal keys', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = sessionsHarness(t, [{ id: 'clicked', title: 'Restore this prompt', updatedAt: Date.now(), messages: 2 }]);
  const option = h.options()[0]; void option.props.onClick();
  t.mock.timers.tick(60); for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }, { id: 'resume-terminal', text: '/resume clicked' }]);
  t.mock.timers.tick(150); for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.equal(h.closed(), 1);
  const empty = sessionsHarness(t);
  empty.press('ArrowDown'); empty.press('Enter'); empty.press('Escape');
  assert.equal(empty.closed(), 1); assert.deepEqual(empty.written, []);
  const labels = elements(empty.render()).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []);
  assert.ok(labels.includes('This project has no other Claude sessions yet'));
});

test('choice renders context, printed numbers, details, hotkeys and CLI selection', () => {
  const { ReadingChoice } = loadUI('features/reading/ReadingChoice.tsx');
  const html = renderToStaticMarkup(React.createElement(ReadingChoice, { choice: fakeChoice(), terminalId: 'test', onError: () => {} }));
  assert.match(html, /is-permission/); assert.match(html, /Run this command\?/); assert.match(html, /\$ echo hello/);
  assert.match(html, /Commands starting with echo/); assert.match(html, /<kbd>p<\/kbd>/);
  assert.match(html, /is-cli-selected/); assert.match(html, /data-highlighted="true"/);
  assert.match(html, /data-approval-mode="terminal-only"/); assert.match(html, /Open terminal/);
  assert.match(html, /Confirm or reject this request in the source terminal/); assert.doesNotMatch(html, /Enter to confirm|Cancel/);
});

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

// Run ReadingView's composer handlers and effect cleanup without starting a browser or Electron.
function dictationHarness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slots = [], effects = [], written = [], pasted = [], echoed = [];
  let cursor = 0, root, insert, closed = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(make) { cursor++; return make(); },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      const slot = slots[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const node = { value: '', selectionStart: 0, selectionEnd: 0, dataset: {},
    focus() { document.activeElement = node; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  globalThis.document = { activeElement: node, body: {}, getElementById: () => null, createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, agentrix: {
    terminalCommands: async () => ({ ok: true, value: [] }),
    writeTerminal: (id, text) => written.push({ id, text }),
    pasteTerminal: async (id, text) => { pasted.push({ id, text }); return { ok: true }; },
  } };
  const cli = { busy: false, panel: null, close() { closed++; }, begin() {} };
  const props = { projectId: 'project', terminal: { id: 'dictation', sessionId: 'session', agent: 'codex', codexActive: true, needsInput: null },
    autoFocus: false, onShowTerminal() {}, onError: message => assert.fail(message), onOpenLink() {},
  };
  const screen = fakeScreen();
  const { ReadingView } = loadUI('features/reading/ReadingView.tsx', {
    react: hooks, dompurify: { default: () => ({ sanitize: html => html }) },
    './action-text': {}, './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    './voice-input': { dictateInto: (id, take) => { insert = take; return () => { insert = null; }; } },
    './terminal-screen': { useScreen: () => null, readScreen: () => null },
    './agent-screen': { parseAgentScreen: () => screen },
    './ReadingWelcome': {}, './ReadingChoice': {}, './ReadingQuestion': {}, './ReadingSessions': {},
    './reading-mode': { setChoiceVisible() {} }, './typing': { markTyping() {}, isTyping: () => false },
    './useStickToBottom': { useStickToBottom: () => ({ stuck: true, unseen: 0, ready: true, holdPosition() {}, toBottom() {} }) },
    './useReadingConversation': { conversationKey: () => 'session', useReadingConversation: () => [] },
    './useVisibleTail': { blocks: () => [], conversationTurns: () => [], useVisibleTail: () => ({ earlier: 0, visible: [] }) },
    './useMentions': { useMentions: () => ({ open: false, keys: () => false }) }, './MentionPalette': {},
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: [], echo: (text, images) => { echoed.push({ text, images }); return null; }, cancelEcho() {} }) },
    './PendingPromptEntries': {}, './markdown-parse': {}, './FileCards': {},
    './reading-welcome': { useWelcomeStarting: () => false }, './ReadingCliPanel': {},
    './useReadingCli': { useReadingCli: () => ({ ...cli, entries: [] }) },
    './image-thumbnail': { thumbnail: async () => 'data:image/png;base64,picture' },
    ...overrides,
  });
  const render = () => {
    cursor = 0; root = ReadingView(props);
    const box = elements(root).find(element => element.type === 'textarea');
    box.props.ref.current = node; node.value = box.props.value;
    while (effects.length) effects.shift()();
    return box;
  };
  const unmount = () => { for (const slot of slots) if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; } };
  t.after(() => { unmount(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  render(); render();
  return { props, screen, cli, node, written, pasted, echoed, render, unmount, tree: () => root, closed: () => closed,
    dictate: (text, submit = true) => { insert(text, submit); render(); },
    edit: text => { render().props.onChange({ target: { value: text } }); render(); },
    pending: () => elements(root).some(element => /\bis-sending-soon\b/.test(element.props.className)),
    press(key) {
      const event = { key, currentTarget: node, nativeEvent: {}, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      render().props.onKeyDown(event); render(); return event;
    },
    async tick(ms) { t.mock.timers.tick(ms); for (let i = 0; i < 12; i++) await Promise.resolve(); render(); },
  };
}

test('submitted dictation appears at the caret for half a second, then uses the composer send with pictures', async t => {
  const h = dictationHarness(t);
  h.edit('before replace after'); h.node.setSelectionRange(7, 14);
  h.render().props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ size: 1 }) }] } });
  await h.tick(0);
  h.dictate('spoken');
  assert.equal(h.node.value, 'before spoken after');
  assert.equal(document.activeElement, h.node);
  assert.equal(h.node.selectionStart, 13); assert.equal(h.node.selectionEnd, 13);
  assert.equal(h.pending(), true);
  await h.tick(499); assert.deepEqual(h.pasted, []);
  await h.tick(1);
  assert.deepEqual(h.pasted, [{ id: 'dictation', text: 'before spoken after' }]);
  assert.deepEqual(h.echoed, [{ text: 'before spoken after', images: ['data:image/png;base64,picture'] }]);
  assert.equal(h.pending(), false); assert.equal(h.node.value, '');
  await h.tick(2000); assert.equal(h.pasted.length, 1);
});

test('Enter sends pending dictation at once and disarms its timer', async t => {
  const h = dictationHarness(t);
  h.dictate('send now'); h.press('Enter'); await h.tick(0);
  assert.deepEqual(h.pasted, [{ id: 'dictation', text: 'send now' }]);
  assert.equal(h.pending(), false);
  await h.tick(2000); assert.equal(h.pasted.length, 1);
});

test('Escape only cancels pending dictation, leaving text and an open command alone', async t => {
  const h = dictationHarness(t);
  h.props.terminal.codexActivity = 'working'; h.cli.panel = { command: '/usage', rows: [] };
  h.dictate('keep for editing');
  const event = h.press('Escape');
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(h.closed(), 0); assert.deepEqual(h.written, []);
  assert.equal(h.node.value, 'keep for editing'); assert.equal(h.pending(), false);
  await h.tick(1000); assert.deepEqual(h.pasted, []);
});

test('editing, clearing and starting IME input cancel dictation without sending', async t => {
  for (const action of ['edit', 'clear', 'compose']) await t.test(action, async t => {
    const h = dictationHarness(t); h.dictate('keep');
    if (action === 'compose') h.render().props.onCompositionStart();
    else h.edit(action === 'clear' ? '' : 'keep editing');
    await h.tick(1000);
    assert.deepEqual(h.pasted, []); assert.equal(h.pending(), false);
    assert.equal(h.node.value, action === 'clear' ? '' : action === 'edit' ? 'keep editing' : 'keep');
  });
});

test('terminal changes, split selection and unmount cancel pending dictation', async t => {
  for (const action of ['terminal', 'session', 'selection', 'unmount']) await t.test(action, async t => {
    const h = dictationHarness(t); h.props.autoFocus = true; h.render(); h.dictate('cancel on leaving');
    if (action === 'terminal') h.props.terminal = { ...h.props.terminal, id: 'other' };
    if (action === 'session') h.props.terminal = { ...h.props.terminal, sessionId: 'other' };
    if (action === 'selection') h.props.autoFocus = false;
    if (action === 'unmount') h.unmount(); else h.render();
    await h.tick(1000); assert.deepEqual(h.pasted, []);
  });
});

test('the delayed send respects a newly blocked composer', async t => {
  const h = dictationHarness(t); h.dictate('wait');
  h.screen.choice = fakeChoice(); h.render();
  await h.tick(1000);
  assert.deepEqual(h.pasted, []); assert.equal(h.node.value, 'wait'); assert.equal(h.pending(), false);
});

test('dictation without submit inserts and focuses without scheduling a send', async t => {
  const h = dictationHarness(t); document.activeElement = null;
  h.dictate('insert only', false);
  assert.equal(h.node.value, 'insert only'); assert.equal(document.activeElement, h.node);
  assert.equal(h.node.selectionStart, 11); assert.equal(h.pending(), false);
  await h.tick(2000); assert.deepEqual(h.pasted, []);
});

// Exercise the component's handlers with persistent hook slots, without a DOM or native GUI.
function choiceHarness(t, choice = { ...fakeChoice(), kind: 'menu' }) {
  const slots = []; let cursor = 0;
  const hooks = {
    useState: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect: () => {},
  };
  const written = [], previous = globalThis.window;
  globalThis.window = { agentrix: { writeTerminal: (id, key) => written.push({ id, key }) } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const { ReadingChoice } = loadUI('features/reading/ReadingChoice.tsx', { react: hooks });
  const render = () => {
    cursor = 0;
    const root = ReadingChoice({ choice, terminalId: 'native-choice', onError: message => assert.fail(message) });
    root.props.ref.current = { focus: () => {} };
    return root;
  };
  const press = key => {
    let prevented = false;
    render().props.onKeyDown({ key, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    assert.equal(prevented, true);
  };
  const options = () => elements(render()).filter(node => node.props.className?.split(' ').includes('reading-choice-option'));
  return { written, render, press, options };
}

test('welcome command rows call the existing completion callback with the cached command', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  const command = { name: '/model', source: 'builtin', description: '切换模型', view: 'terminal' };
  const picked = [];
  const root = ReadingWelcome({ agent: 'claude', screen: fakeScreen(), commands: [command], complete: value => picked.push(value), disabled: false });
  elements(root).find(node => node.type === 'button').props.onClick();
  assert.deepEqual(picked, [command]);
});

test('choice arrows move a local highlight; Enter submits once and keeps a pending card', t => {
  const harness = choiceHarness(t);
  assert.equal(harness.options()[1].props['data-highlighted'], true);
  harness.press('ArrowDown'); assert.equal(harness.options()[2].props['data-highlighted'], true);
  harness.press('ArrowUp'); assert.equal(harness.options()[1].props['data-highlighted'], true);
  assert.deepEqual(harness.written, []);
  harness.press('Enter'); harness.press('Enter'); harness.press('Escape');
  assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\r' }]);
  assert.equal(harness.render().props['aria-busy'], true);
  assert.ok(harness.options().every(option => option.props.disabled));
  assert.ok(elements(harness.options()[1]).some(node => node.props.className === 'loading-spinner'));
});

test('choice number keys target printed numbers and write relative to the CLI cursor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const choice = { ...fakeChoice(), kind: 'menu' }; choice.options.forEach((option, index) => { option.number = [4, 7, 9][index]; });
  const harness = choiceHarness(t, choice);
  harness.press('4'); harness.options()[2].props.onClick();
  assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\x1b[A' }]);
  t.mock.timers.tick(25); await Promise.resolve();
  assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\x1b[A' }, { id: 'native-choice', key: '\r' }]);
});

test('Enter on a focused button presses that button, never the highlighted option (Cancel never approves)', t => {
  const harness = choiceHarness(t);
  let prevented = false;
  const button = { closest: selector => selector === 'button' ? button : null };
  harness.render().props.onKeyDown({ key: 'Enter', target: button, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
  assert.equal(prevented, false, 'the button keeps its own Enter');
  assert.deepEqual(harness.written, [], 'nothing chosen for it');
});

test('choice Esc and cancel button each send a single Escape and wait for CLI dismissal', t => {
  for (const action of ['Escape', 'button']) {
    const harness = choiceHarness(t);
    if (action === 'Escape') harness.press('Escape');
    else elements(harness.render()).find(node => node.props.className === 'text-button').props.onClick();
    harness.press('Escape'); harness.press('Enter');
    assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\x1b' }]);
    assert.equal(harness.render().props['aria-busy'], true);
  }
});

function readingMode() {
  return loadUI('features/reading/reading-mode.ts', { react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() } });
}
const terminal = (id, needsInput = 'Allow command?') => ({ id, sessionId: 'session', codexActive: true, needsInput });
const isReading = (mode, value) => mode.readingShown(value, mode.useTerminalChoice());

test('needsInput falls back at 1.5 seconds and automatically returns after acknowledgment', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('fallback');
  mode.syncReading(value); assert.equal(isReading(mode, value), true);
  t.mock.timers.tick(1499); assert.equal(isReading(mode, value), true);
  t.mock.timers.tick(1); assert.equal(isReading(mode, value), false);
  mode.syncReading(terminal(value.id, null)); assert.equal(isReading(mode, value), true);
});

test('a parsed choice cancels a pending handoff and its disappearance does not rearm that notice', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('native');
  mode.syncReading(value); t.mock.timers.tick(1000); mode.setChoiceVisible(value.id, true);
  t.mock.timers.tick(1000); assert.equal(isReading(mode, value), true);
  mode.setChoiceVisible(value.id, false); mode.syncReading(value); t.mock.timers.tick(2000);
  assert.equal(isReading(mode, value), true);
  mode.syncReading(terminal(value.id, null)); mode.syncReading(value); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), false, 'a new notice gets its own timeout');
});

test('a choice already visible keeps reading open for a permission hook', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('already-visible');
  mode.setChoiceVisible(value.id, true); mode.syncReading(value); t.mock.timers.tick(5000);
  assert.equal(isReading(mode, value), true);
});

test('permission notice clearing or agent exit cancels its timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('cancel');
  mode.syncReading(value); mode.syncReading(terminal(value.id, null)); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
  mode.syncReading(value); mode.syncReading({ ...value, codexActive: false }); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
});

test('one automatic handoff per notice and manual toggles cancel automatic return', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('manual');
  mode.syncReading(value); t.mock.timers.tick(1500); assert.equal(isReading(mode, value), false);
  mode.setReading(value.id, true); mode.syncReading(value); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
  mode.syncReading(terminal(value.id, null)); mode.syncReading(value); t.mock.timers.tick(1500);
  mode.setReading(value.id, false); mode.syncReading(terminal(value.id, null));
  assert.equal(isReading(mode, value), false);
  mode.agentExited({ ...value, codexActive: false }); assert.equal(isReading(mode, value), true);
});

test('manual choice during the delay cancels the pending handoff', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('manual-delay');
  mode.syncReading(value); mode.setReading(value.id, false); mode.setReading(value.id, true); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
});

test('choice visibility and handoff timers are isolated per terminal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), first = terminal('first'), second = terminal('second');
  mode.syncReading(first); mode.syncReading(second); mode.setChoiceVisible(first.id, true); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, first), true); assert.equal(isReading(mode, second), false);
});

test('reading view requires an active agent and a live terminal session', () => {
  const mode = readingMode(), value = terminal('shell', null);
  assert.equal(mode.readingShown({ ...value, codexActive: false }, []), false);
  assert.equal(mode.readingShown({ ...value, sessionId: null }, []), false);
});

function readingHarness(t, entries = [], overrides = {}) {
  const tail = require('../src/features/reading/useVisibleTail.ts');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  });
  const state = { entries, pending: [], terminal: { id: 'terminal', sessionId: 'session', agent: 'codex', codexActive: true, needsInput: null } };
  const parsed = [], icon = () => React.createElement('svg');
  const { ReadingView } = loadUI('features/reading/ReadingView.tsx', {
    './markdown-escape': { readingMarked: { parse: text => { parsed.push(text); return text; } } },
    dompurify: { default: () => ({ sanitize: html => html }) },
    '@phosphor-icons/react': new Proxy({}, { get: () => icon }),
    './action-text': { stepVerb: tool => tool.kind, actionText: tool => tool.target }, './voice-input': {}, './terminal-screen': { useScreen: () => null },
    './agent-screen': { parseAgentScreen: () => fakeScreen() },
    './ReadingWelcome': { ReadingWelcome: () => React.createElement('p', null, 'welcome preserved') },
    './ReadingChoice': {}, './ReadingQuestion': {}, './reading-mode': {},
    './useStickToBottom': { useStickToBottom: () => ({ stuck: true, unseen: 0, ready: true, holdPosition() {}, toBottom() {} }) },
    './useReadingConversation': { conversationKey: () => 'session', useReadingConversation: () => state.entries },
    './useVisibleTail': tail, './reading.css': {},
    './useMentions': { useMentions: () => ({ open: false }) }, './MentionPalette': { MentionPalette: () => null },
    './pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: state.pending, echo() {}, cancelEcho() {} }) },
    './PendingPromptEntries': loadUI('features/reading/PendingPromptEntries.tsx'),
    './markdown-parse': { parseMarkdown: async () => null, parsedMarkdown: () => undefined },
    './FileCards': { FileCards: ({ files }) => React.createElement('div', { className: 'file-cards' }, files.join(',')), previewable: () => true },
    './ReadingSessions': { ReadingSessions: () => null }, './reading-sessions': require('../src/features/reading/reading-sessions.ts'),
    './reading-welcome': { useWelcomeStarting: () => false },
    './ReadingCliPanel': { ReadingCliPanel: () => null }, './ReadingCommandOutput': { ReadingCommandOutput: () => null },
    './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './useReadingCli': { useReadingCli: (id, session, agent, list) => ({ entries: list, busy: false, panel: null, begin() {} }) },
    './i18n': { currentLanguage: () => 'en', t: (text, values) => (en[text] ?? text).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? name)) },
    ...overrides,
  });
  const render = () => renderToStaticMarkup(React.createElement(ReadingView, {
    projectId: 'project', terminal: state.terminal,
    autoFocus: false, onShowTerminal() {}, onError() {}, onOpenLink() {},
  }));
  return { state, render, parsed, ReadingView };
}

test('reading entry rendering parses only the last 40 blocks inside a turn and leaves the welcome branch intact', t => {
  const { state, render, parsed } = readingHarness(t, Array.from({ length: 400 }, (_, index) => ({ id: String(index), at: 0, role: 'assistant', text: `answer-${index}` })));
  const html = render();
  assert.equal(parsed.length, 40);
  assert.equal(parsed[0], 'answer-360'); assert.equal(parsed.at(-1), 'answer-399');
  assert.match(html, /Show earlier conversation \(360\)/);
  assert.doesNotMatch(html, /answer-359/);
  assert.equal((html.match(/class="reading-step is-agent/g) || []).length, 1);
  state.entries = []; parsed.length = 0;
  assert.match(render(), /welcome preserved/); assert.equal(parsed.length, 0);
});

const timelineSections = html => html.split(/(?=<div class="reading-step is-)/).filter(part => part.startsWith('<div class="reading-step is-'));
const readingEntry = (id, role, minute, extra = {}) => ({ id, role, at: new Date(2026, 9, 17, 16, minute).getTime(), ...extra });
const readingTool = (id, minute, extra = {}) => readingEntry(id, 'tool', minute, { tool: { kind: 'command', tool: 'shell', target: id, done: true, failed: false, ...extra } });

test('Claude and Codex render user and agent parents with ordered child replies, leading tools and tools-only turns', t => {
  const { state, render } = readingHarness(t, [
    readingEntry('u1', 'user', 10, { text: 'first prompt' }), readingTool('skill', 11, { kind: 'skill' }),
    readingEntry('a1', 'assistant', 12, { text: 'first reply' }), readingEntry('a2', 'assistant', 13, { text: 'second reply' }),
    readingTool('cmd', 14), readingEntry('a3', 'assistant', 15, { text: 'third reply' }),
    readingEntry('u2', 'user', 16, { text: 'next prompt' }),
    readingTool('edit', 17, { kind: 'edit', written: ['report.md'] }), readingTool('failed command', 17, { failed: true }),
    readingTool('running command', 18, { done: false, detail: 'still processing' }),
  ]);
  for (const agent of ['claude', 'codex']) {
    state.terminal.agent = agent;
    const html = render(), sections = timelineSections(html);
    assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['user', 'agent', 'user', 'agent']);
    assert.equal((html.match(/class="reading-node"/g) || []).length, 4);
    assert.equal((html.match(/class="reading-turn-tools/g) || []).length, 3);
    assert.equal((html.match(/class="reading-assistant /g) || []).length, 3);
    assert.equal((html.match(new RegExp(`<b class="reading-step-label">${agent === 'claude' ? 'Claude Code' : 'Codex'}</b>`, 'g')) || []).length, 2);
    assert.deepEqual([...sections[1].matchAll(/class="reading-turn-(tools|message)/g)].map(match => match[1]), ['tools', 'message', 'message', 'tools', 'message']);
    assert.match(sections[1], /first reply[\s\S]*second reply[\s\S]*third reply/);
    for (const minute of [10, 11, 12, 13, 14, 15, 16, 17]) {
      assert.ok(html.includes(`dateTime="${new Date(2026, 9, 17, 16, minute).toISOString()}"`));
    }
    assert.match(sections[3], /is-running/); assert.match(sections[3], /has-failed/);
    assert.match(sections[3], /aria-expanded="true"/); assert.match(sections[3], /reading-tools-tree/);
    assert.match(sections[3], /failed command/); assert.match(sections[3], /still processing/);
    assert.match(sections[3], /class="file-cards">report.md/);
  }
});

test('live thinking and confirmation stay inside the latest agent, including a tools-only history', t => {
  const { state, render } = readingHarness(t, [readingTool('leading', 11)]);
  state.terminal.codexActivity = 'working';
  let sections = timelineSections(render());
  assert.equal(sections.length, 1); assert.match(sections[0], /reading-turn-tools[\s\S]*role="status"/);
  assert.match(sections[0], /Codex is thinking/);
  state.terminal.needsInput = 'confirm this command';
  sections = timelineSections(render());
  assert.equal(sections.length, 1); assert.match(sections[0], /confirm this command/);
  state.entries = [readingEntry('user', 'user', 12, { text: 'new prompt' })];
  sections = timelineSections(render());
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['user', 'agent']);
  state.entries = [readingTool('failed only', 13, { failed: true })];
  state.terminal.codexActivity = 'idle'; state.terminal.needsInput = null;
  sections = timelineSections(render());
  assert.equal(sections.length, 1); assert.match(sections[0], /class="reading-step is-agent is-codex is-failed"/);
  assert.match(sections[0], /reading-turn-tools is-failed/); assert.match(sections[0], /aria-expanded="false"/);
  assert.doesNotMatch(sections[0], /reading-tools-tree|role="status"/);
});

test('pending users retain their cards and a new sending prompt separates live agent turns; queued users wait after the active agent', t => {
  const { state, render } = readingHarness(t, [readingEntry('reply', 'assistant', 11, { text: 'answer' })]);
  state.terminal.codexActivity = 'working';
  state.pending = [{ id: 'pending', at: readingEntry('', 'user', 12).at, text: 'next prompt', sending: true }];
  let sections = timelineSections(render());
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['agent', 'user', 'agent']);
  assert.match(sections[1], /reading-pending is-sending/); assert.match(sections[2], /role="status"/);
  state.entries.push(readingEntry('queued', 'user', 12, { text: 'next prompt', queued: true }));
  sections = timelineSections(render());
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['agent', 'user']);
  assert.match(sections[0], /role="status"/); assert.match(sections[1], /reading-pending is-queued/);
});

test('real Claude queue records render without an echo and promote once in producer order', t => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const log = new ConversationLog(), timestamp = '2026-10-17T01:00:00Z';
  log.put(readingEntry('active', 'assistant', 0, { text: 'active reply' }));
  claudeConversation(log, { type: 'queue-operation', operation: 'enqueue', timestamp, content: 'QUEUED_FROM_TERMINAL' });
  const { state, render } = readingHarness(t, log.list);
  state.terminal.agent = 'claude'; state.terminal.codexActivity = 'working';
  let html = render(), sections = timelineSections(html);
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['agent', 'user']);
  assert.match(sections[0], /role="status"/); assert.match(sections[1], /reading-pending is-queued/);
  assert.equal((html.match(/QUEUED_FROM_TERMINAL/g) || []).length, 1);
  assert.match(sections[1], new RegExp(`dateTime="${timestamp.replace('Z', '.000Z')}"`));
  state.pending = [{ id: 'echo', role: 'user', text: 'QUEUED_FROM_TERMINAL', at: Date.parse(timestamp) - 100, sending: true }];
  assert.equal((render().match(/QUEUED_FROM_TERMINAL/g) || []).length, 1, 'an echo adds no duplicate');
  claudeConversation(log, { type: 'queue-operation', operation: 'dequeue', timestamp, content: 'QUEUED_FROM_TERMINAL' });
  claudeConversation(log, { type: 'attachment', uuid: 'accepted', timestamp, attachment: { type: 'queued_command', prompt: 'QUEUED_FROM_TERMINAL' } });
  state.entries = log.list;
  const prompts = require('../src/features/reading/pending-prompts.ts');
  state.pending = prompts.reconcilePendingPrompts({ sessionId: 'session', seen: [], prompts: state.pending }, 'session', state.entries, Date.parse(timestamp)).prompts;
  html = render(); sections = timelineSections(html);
  assert.equal((html.match(/QUEUED_FROM_TERMINAL/g) || []).length, 1);
  assert.match(sections[0], /active reply/); assert.match(sections[1], /QUEUED_FROM_TERMINAL/);
  assert.doesNotMatch(html, /is-queued/);
  state.entries = log.list.filter(entry => entry.role === 'user').map(entry => ({ ...entry, queued: true }));
  html = render(); assert.match(html, /QUEUED_FROM_TERMINAL/); assert.doesNotMatch(html, /welcome preserved/);
});

test('an expanded visible tool group keeps its component state through rolling eviction and snapshot refreshes', t => {
  const { applyConversationPacket } = require('../src/features/reading/conversation-buffer.ts');
  // Retain hook state at React's keyed ancestry, so a changed parent or child key resets ToolGroup's open state.
  const instances = new Map(); let slots, cursor;
  const hooks = {
    useState(initial) { const index = cursor++; if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial; const own = slots; return [own[index], value => { own[index] = typeof value === 'function' ? value(own[index]) : value; }]; },
    useRef(initial) { return hooks.useState(() => ({ current: initial }))[0]; },
    useMemo(make) { return make(); }, useEffect() {}, useLayoutEffect() {},
  };
  const run = (key, component, props) => { if (!instances.has(key)) instances.set(key, []); slots = instances.get(key); cursor = 0; return component(props); };
  const initial = Array.from({ length: 400 }, (_, index) => index === 398 ? readingTool('visible-tool', 10) : readingEntry('a' + index, 'assistant', 9, { text: 'reply' }));
  const tail = require('../src/features/reading/useVisibleTail.ts');
  let count = 40;
  const { state, ReadingView } = readingHarness(t, applyConversationPacket([], { list: initial }), { react: hooks, './useVisibleTail': { ...tail, useVisibleTail: grouped => tail.visibleTail(grouped, count) } });
  const props = { projectId: 'project', terminal: state.terminal, autoFocus: false, onShowTerminal() {}, onError() {}, onOpenLink() {} };
  const group = () => {
    const root = run('root', ReadingView, props); let found;
    const visit = (node, path = '') => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(child => visit(child, path)); return; }
      const key = path + '/' + String(node.key ?? (typeof node.type === 'function' ? node.type.name : node.type));
      if (node.type?.name === 'ToolGroup') found = { key, node: run(key, node.type, node.props) };
      else visit(node.props?.children, key);
    };
    visit(root); return found;
  };
  const before = group();
  elements(before.node).find(element => element.type === 'button').props.onClick();
  assert.equal(elements(group().node).find(element => element.type === 'button').props['aria-expanded'], true);
  count = 80;
  assert.equal(group().key, before.key);
  assert.equal(elements(group().node).find(element => element.type === 'button').props['aria-expanded'], true);
  count = 40;
  for (let index = 400; index < 425; index++) {
    const entry = readingEntry('a' + index, 'assistant', 11, { text: 'next' });
    state.entries = applyConversationPacket(state.entries, index % 2 ? { list: [...state.entries, entry].slice(-400).map(entry => ({ ...entry })) } : { changes: [entry] });
    const after = group();
    assert.equal(state.entries.length, 400); assert.equal(after.key, before.key);
    assert.equal(elements(after.node).find(element => element.type === 'button').props['aria-expanded'], true);
    assert.ok(elements(after.node).some(element => element.type === 'ul'));
  }
});

test('unrelated user records cannot discard a stalled prompt; retries stay bounded and queued prompts never resend', async t => {
  const prompts = require('../src/features/reading/pending-prompts.ts');
  let clock = 30000, sequence = 0;
  t.mock.method(Date, 'now', () => clock);
  const records = [{ id: 'unrelated', role: 'user', text: 'DIFFERENT_MESSAGE', at: 2000 }], cancellations = [];
  let state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'lost', 'NEVER_DELIVERED', 1000);
  state = prompts.reconcilePendingPrompts(state, 'session', records, clock);
  const h = dictationHarness(t, {
    './useReadingConversation': { conversationKey: (id, session) => session, useReadingConversation: () => records },
    './usePendingPrompts': { usePendingPrompts: () => {
      state = prompts.reconcilePendingPrompts(state, 'session', records, clock);
      return { pending: state.prompts,
        echo(text, images) { const id = 'retry-' + ++sequence; state = prompts.addPendingPrompt(state, id, text, clock, images); return id; },
        cancelEcho(id) { cancellations.push(id); state = prompts.removePendingPrompt(state, id); },
      };
    } },
  });
  h.props.terminal.codexActivity = 'idle';
  clock += 6000; await h.tick(6000);
  assert.deepEqual(h.pasted.map(item => item.text), ['NEVER_DELIVERED']);
  assert.deepEqual(cancellations, ['lost'], 'a replacement echo follows a real resend, never a timestamp-only acknowledgment');
  await h.tick(400); await h.tick(2000); await h.tick(1000);
  clock += 21000; h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 2);
  await h.tick(400); await h.tick(2000); await h.tick(1000);
  clock += 21000; h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 2, 'at most two automatic resends');
  assert.equal(state.prompts.length, 1, 'an undelivered prompt remains visible');
  const card = elements(h.tree()).find(element => element.props?.undelivered);
  assert.equal(card.props.undelivered(state.prompts[0]), true);
  records.push({ id: 'q', role: 'user', text: 'NEVER_DELIVERED', at: clock, queued: true });
  clock += 30000; h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 2);
  assert.equal(elements(h.tree()).find(element => element.props?.queued).props.queued(state.prompts[0]), true);
  records.pop();
  h.props.terminal.sessionId = 'next-session';
  // The actual pending hook clears old-session echoes; give this new session its own stalled send.
  state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'new-send', 'NEVER_DELIVERED', clock - 21000);
  h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 3, 'the previous session cannot exhaust the new session retry budget');
});

test('a question renders as its own card: progress, the question, options, an own answer or notes, Submit and Chat', () => {
  const icon = props => React.createElement('svg', { className: props.className });
  const icons = { CircleNotch: icon, CaretLeft: icon, CaretRight: icon, Check: icon, PaperPlaneRight: icon };
  const { ReadingQuestion } = loadUI('features/reading/ReadingQuestion.tsx', { '@phosphor-icons/react': icons, './question-keys': require('../src/features/reading/question-keys.ts') });
  const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
  const screen = name => parseAgentScreen(name.startsWith('claude') ? 'claude' : 'codex', fs.readFileSync(path.join(__dirname, 'fixtures/questions', name + '.txt'), 'utf8').split('\n')).choice;
  const render = name => renderToStaticMarkup(React.createElement(ReadingQuestion, { choice: screen(name), terminalId: 'terminal', onError: () => {} }));
  const multi = render('claude-question-multi-checked');
  assert.match(multi, /要清理哪些目录？/); assert.match(multi, /aria-pressed="true"/); assert.match(multi, /Submit this question/);
  assert.match(multi, /Talk it over instead/); assert.match(multi, /placeholder="Type your own answer…"/); assert.match(multi, /清理目录/);
  assert.doesNotMatch(multi, /Chat about this|Type something/, 'the CLI\'s own English rows are shown in the window\'s words');
  const review = render('claude-question-review');
  assert.match(review, /Review your answers/); assert.match(review, /node_modules, abc/); assert.match(review, /Submit answers/);
  const codex = render('codex-question');
  assert.match(codex, /Question 1\/2/); assert.match(codex, /Notes \(optional\)/); assert.doesNotMatch(codex, /Optionally, add details/);
});

for (const agent of ['claude', 'codex']) {
  test(agent + ': slash feedback begins before typed Enter, slow hooks never cause an automatic resubmit', async t => {
    const cli = { busy: false, panel: null, begin(text) { assert.equal(h.written.length, 0); this.busy = true; this.panel = { command: text, rows: [] }; }, close() { this.panel = null; this.busy = false; }, recover() { this.feedback = 'recovery'; } };
    const rows = fs.readFileSync(path.join(__dirname, 'fixtures/screens', agent === 'claude' ? 'claude-idle-2-1-296.txt' : 'codex-fresh-default.txt'), 'utf8').split('\n');
    let h;
    h = dictationHarness(t, {
      './useReadingCli': { useReadingCli: () => cli },
      './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows: h?.written.length ? rows.map(row => row.trim().startsWith(agent === 'claude' ? '❯' : '› Ask Codex') ? (agent === 'claude' ? '❯ /status' : '› /status') : row) : rows }) },
    });
    h.props.terminal.agent = agent;
    h.edit('/status'); h.press('Enter');
    assert.equal(cli.panel.command, '/status');
    assert.deepEqual(h.written.map(item => item.text), ['/status']);
    await h.tick(150);
    assert.deepEqual(h.written.map(item => item.text), ['/status', '\r']);
    await h.tick(30000);
    assert.deepEqual(h.written.map(item => item.text), ['/status', '\r']);
  });

  test(agent + ': Escape before Enter stops the scheduled submission and retains terminal recovery feedback', async t => {
    const cli = { busy: false, panel: null, begin(text) { this.busy = true; this.panel = { command: text, rows: [] }; }, close() { this.panel = null; this.busy = false; }, recover() { this.feedback = 'recovery'; } };
    const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli } });
    h.props.terminal.agent = agent;
    h.edit('/status'); h.press('Enter'); h.press('Escape');
    await h.tick(150); await h.tick(30000);
    assert.deepEqual(h.written.map(item => item.text), ['/status'], 'no unverified Escape, Ctrl+C or subsequent Enter');
    assert.equal(cli.feedback, 'recovery'); assert.equal(cli.panel.command, '/status');
  });

  test(agent + ': switching PTY during a slash send cancels the old scheduled Enter', async t => {
    const cli = { busy: false, panel: null, begin(text) { this.busy = true; this.panel = { command: text, rows: [] }; }, close() {}, recover() {} };
    const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli } });
    h.props.terminal.agent = agent;
    h.edit('/status'); h.press('Enter');
    h.props.terminal.sessionId = 'replacement-pty'; h.render();
    await h.tick(30000);
    assert.deepEqual(h.written.map(item => item.text), ['/status']);
  });

  test(agent + ': Enter waits for the exact live slash echo, not a fixed delay or a matching prefix', async t => {
    const fresh = fs.readFileSync(path.join(__dirname, 'fixtures/screens', agent === 'claude' ? 'claude-2-1-302-start.txt' : 'codex-0-163-status.txt'), 'utf8').split('\n');
    const withDraft = text => fresh.map(row => row.trim().startsWith(agent === 'claude' ? '❯' : '› Ask Codex') ? (agent === 'claude' ? '❯ ' : '› ') + text : row);
    let rows = fresh, confirmed = 0, submitted = 0;
    const cli = { busy: false, panel: null, begin(text) { this.busy = true; this.panel = { command: text, rows: [] }; return 'receipt'; }, confirmInput(id) { assert.equal(id, 'receipt'); confirmed++; return true; }, submitted() { submitted++; }, close() {}, recover() { this.feedback = 'recovery'; } };
    const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli }, './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows }) }, './agent-screen': { parseAgentScreen } });
    h.props.terminal.agent = agent;
    h.edit('/status'); h.press('Enter');
    for (let i = 0; i < 12; i++) await h.tick(25);
    assert.deepEqual(h.written.map(item => item.text), ['/status'], '300 ms alone never sends Enter');
    rows = withDraft('/status-extra'); await h.tick(25);
    assert.equal(confirmed, 0); assert.equal(h.written.length, 1);
    rows = withDraft('/status'); await h.tick(25);
    assert.deepEqual(h.written.map(item => item.text), ['/status', '\r']);
    assert.equal(confirmed, 1); assert.equal(submitted, 1);
    await h.tick(30000); assert.equal(h.written.length, 2, 'one Enter, no automatic repeat');
  });

  test(agent + ': missing slash echo times out safely without an Enter or a false completion', async t => {
    const cli = { busy: false, panel: null, begin(text) { this.busy = true; this.panel = { command: text, rows: [] }; }, close() {}, recover() { this.feedback = 'recovery'; } };
    const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli } });
    h.props.terminal.agent = agent;
    h.edit('/status'); h.press('Enter');
    for (let i = 0; i < 80; i++) await h.tick(25);
    assert.equal(cli.feedback, 'recovery'); assert.equal(cli.panel.done, undefined);
    await h.tick(60000); assert.deepEqual(h.written.map(item => item.text), ['/status']);
  });

  test(agent + ': UI Escape clears four stale trackers at verified idle and lets the next model command execute', async t => {
    const fresh = fs.readFileSync(path.join(__dirname, 'fixtures/screens', agent === 'claude' ? 'claude-2-1-302-start.txt' : 'codex-0-163-status.txt'), 'utf8').split('\n');
    let rows = fresh, closes = 0;
    const cli = { busy: false, panel: null, begin(text) { this.busy = true; this.panel = { command: text, rows: [] }; return 'new-model'; }, confirmInput: () => true, submitted() {}, close() { this.busy = false; this.panel = null; this.feedback = undefined; closes++; }, recover() { this.feedback = 'recovery'; } };
    const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli }, './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows }) }, './agent-screen': { parseAgentScreen } });
    h.props.terminal.agent = agent;
    for (let i = 0; i < 4; i++) {
      cli.busy = true; cli.panel = { command: '/status', rows: [] }; cli.feedback = 'recovery'; h.render();
      h.press('Escape'); assert.equal(cli.busy, true, 'close must verify idle across reads');
      await h.tick(100);
      assert.equal(cli.panel, null); assert.equal(cli.busy, false);
    }
    assert.equal(closes, 4); assert.deepEqual(h.written, [], 'UI Escape never sends a raw key to idle CLI input');
    h.edit('/model'); h.press('Enter');
    rows = fresh.map(row => row.trim().startsWith(agent === 'claude' ? '❯' : '› Ask Codex') ? (agent === 'claude' ? '❯ /model' : '› /model') : row);
    await h.tick(25);
    assert.equal(cli.panel.command, '/model'); assert.deepEqual(h.written.map(item => item.text), ['/model', '\r']);
  });

  test(agent + ': idle cancellation cannot clear a draft that appears during verification', async t => {
    const fresh = fs.readFileSync(path.join(__dirname, 'fixtures/screens', agent === 'claude' ? 'claude-2-1-302-start.txt' : 'codex-0-163-status.txt'), 'utf8').split('\n');
    let rows = fresh;
    const cli = { busy: true, panel: { command: '/status', rows: [] }, close() { assert.fail('a non-idle CLI must keep its tracker'); }, recover() { this.feedback = 'recovery'; } };
    const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli }, './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows }) }, './agent-screen': { parseAgentScreen } });
    h.props.terminal.agent = agent; h.press('Escape');
    rows = fresh.map(row => row.trim().startsWith(agent === 'claude' ? '❯' : '› Ask Codex') ? (agent === 'claude' ? '❯ held' : '› held') : row);
    await h.tick(100);
    assert.equal(cli.feedback, 'recovery'); assert.deepEqual(h.written, []);
  });
}

test('pending and recovery popups expose a terminal action, keep Escape local and block arbitrary CLI input', () => {
  const hooks = { useRef: value => ({ current: value }), useMemo: make => make(), useEffect() {}, useLayoutEffect() {} };
  const { ReadingCliPanel } = loadUI('features/reading/ReadingCliPanel.tsx', { react: hooks, './cli-panel': require('../src/features/reading/cli-panel.ts'), './cli-render': require('../src/features/reading/cli-render.ts') });
  for (const feedback of ['waiting', 'recovery']) {
    const writes = []; let closes = 0, terminals = 0;
    const root = ReadingCliPanel({ command: '/status', rows: [], done: false, terminalId: 'test', feedback, interactive: false, onWrite: key => { writes.push(key); return true; }, onClose: () => closes++, onShowTerminal: () => terminals++ });
    const dialog = elements(root).find(element => element.props.role === 'dialog');
    for (const key of ['Enter', 'a', 'ArrowDown']) dialog.props.onKeyDown({ key, nativeEvent: {}, stopPropagation() {}, preventDefault() {} });
    dialog.props.onCompositionEnd({ data: 'text' }); dialog.props.onPaste({ clipboardData: { getData: () => 'text' }, preventDefault() {} });
    dialog.props.onKeyDown({ key: 'Escape', nativeEvent: {}, stopPropagation() {}, preventDefault() {} });
    elements(root).find(element => element.type === 'button').props.onClick();
    assert.deepEqual(writes, []); assert.equal(closes, 1); assert.equal(terminals, 1);
    assert.ok(elements(root).some(element => element.props.role === 'status'));
  }
});

test('disposing a command popup cancels delayed navigation keys', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cleanup;
  const hooks = { useRef: value => ({ current: value }), useMemo: make => make(), useEffect: effect => { cleanup = effect(); }, useLayoutEffect() {} };
  const { ReadingCliPanel } = loadUI('features/reading/ReadingCliPanel.tsx', { react: hooks, './cli-panel': require('../src/features/reading/cli-panel.ts'), './cli-render': require('../src/features/reading/cli-render.ts') });
  const writes = [];
  const root = ReadingCliPanel({ command: '/effort', rows: ['Effort'], done: false, terminalId: 'test', interactive: true, onWrite: key => { writes.push(key); return true; }, onClose() {}, onShowTerminal() {} });
  elements(root).find(element => element.type?.name === 'CliBlocks').props.onKeys(['\x1b[C', '\x1b[C']);
  assert.deepEqual(writes, ['\x1b[C']);
  cleanup(); t.mock.timers.tick(1000); await Promise.resolve();
  assert.deepEqual(writes, ['\x1b[C'], 'the old popup cannot type into a replacement session');
});

test('bang sends wait for the captured exact Claude shell editor before one Enter', async t => {
  let rows = fs.readFileSync(path.join(__dirname, 'fixtures/screens/claude-2-1-302-start.txt'), 'utf8').split('\n'), receipts = 0, submitted = 0;
  const cli = { busy: false, panel: null, begin(text) { this.busy = true; this.panel = { command: text, rows: [] }; return 'bang'; }, confirmInput(id) { assert.equal(id, 'bang'); receipts++; return true; }, submitted() { submitted++; }, close() {}, recover() { this.feedback = 'recovery'; } };
  const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli }, './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows }) }, './agent-screen': { parseAgentScreen } });
  h.props.terminal.agent = 'claude'; h.edit('!echo BANG_CAPTURE_OK'); h.press('Enter');
  for (let i = 0; i < 12; i++) await h.tick(25);
  assert.deepEqual(h.written.map(item => item.text), ['!echo BANG_CAPTURE_OK'], 'the old 150 ms bang delay is not receipt');
  rows = fs.readFileSync(path.join(__dirname, 'fixtures/screens/claude-bang-typed.txt'), 'utf8').split('\n');
  await h.tick(25);
  assert.deepEqual(h.written.map(item => item.text), ['!echo BANG_CAPTURE_OK', '\r']);
  assert.equal(receipts, 1); assert.equal(submitted, 1);
  await h.tick(30000); assert.equal(h.written.length, 2);
});

test('closing a completed Bash popup never interrupts the captured subsequent model reply', async t => {
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures/screens/claude-bang-empty-model-working.txt'), 'utf8').split('\n');
  const cli = { busy: false, panel: { command: '!true', rows: [], done: true }, close() { this.panel = null; }, recover() { assert.fail('a finished Bash result can close locally'); } };
  const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli }, './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows }) }, './agent-screen': { parseAgentScreen } });
  h.props.terminal.agent = 'claude'; h.props.terminal.codexActivity = 'working'; h.render();
  h.press('Escape'); await h.tick(1000);
  assert.equal(cli.panel, null); assert.deepEqual(h.written, []); assert.equal(h.props.terminal.codexActivity, 'working');
});

test('Codex bang delivery waits for the captured shell-mode editor instead of a fixed sleep', async t => {
  let rows = fs.readFileSync(path.join(__dirname, 'fixtures/screens/codex-fresh-default.txt'), 'utf8').split('\n'), receipts = 0;
  const cli = { busy: false, panel: null, begin(text) { this.busy = true; this.panel = { command: text, rows: [] }; return 'codex-bang'; }, confirmInput() { receipts++; return true; }, submitted() {}, close() {}, recover() {} };
  const h = dictationHarness(t, { './useReadingCli': { useReadingCli: () => cli }, './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows }) }, './agent-screen': { parseAgentScreen } });
  h.edit('!echo CODEX_BANG_INPUT'); h.press('Enter');
  for (let i = 0; i < 12; i++) await h.tick(25);
  assert.deepEqual(h.written.map(item => item.text), ['!echo CODEX_BANG_INPUT']);
  rows = fs.readFileSync(path.join(__dirname, 'fixtures/screens/codex-bang-typed.txt'), 'utf8').split('\n'); await h.tick(25);
  assert.deepEqual(h.written.map(item => item.text), ['!echo CODEX_BANG_INPUT', '\r']); assert.equal(receipts, 1);
});
