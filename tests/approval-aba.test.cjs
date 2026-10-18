const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const vm = require('node:vm');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { ApprovalGuard, approvalStamp } = require('../electron/features/terminal/approval-guard.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

const fixture = agent => fs.readFileSync(path.join(__dirname, `fixtures/screens/${agent}-permission.txt`), 'utf8').split(/\r?\n/);
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];

function backend(agent) {
  const writes = [], handles = {}, listeners = {};
  let scheduled = 0, raw, current;
  const s = current = { sessionId: 'session', terminalId: 'aba', projectId: 'p', status: 'codex', codexActive: true, agent,
    approval: new ApprovalGuard('session'), gate: { open: 0, held: [], input: key => writes.push(key), output() {} },
    terminal: { write: key => writes.push(key) }, submissions: { write: () => false, sent: [] },
    titles: { write: () => [] }, chunks: [], bytes: 0, pending: '', seq: 0 };
  approvalStamp(s);
  registerTerminalIpc({ handle: (name, fn) => { handles[name] = fn; }, listen: (name, fn) => { listeners[name] = fn; },
    getSession: () => current, getProjectById: () => ({ id: 'p' }), scheduleState: () => scheduled++,
    applyActivity: () => assert.fail('approval must not interrupt the round'), getActiveTerminal: () => null });
  // Exercise the production raw-output callback, before its 16 ms flush. No Electron or PTY is loaded.
  const context = vm.createContext({ terminal: { onData(fn) { raw = fn; } }, s, id: 'aba', sessions: new Map([['aba', s]]),
    setTimeout: () => 1, flush() {}, onEvent() {}, store: {}, wholeThread: () => false });
  const start = main.indexOf('  terminal.onData(data => {');
  vm.runInContext(main.slice(start, main.indexOf('  terminal.onExit(', start)), context);
  return { s, writes, raw: data => raw(data), handles, listeners, scheduled: () => scheduled,
    session(value) { current = value; },
    send(key, stamp = s.approval.stamp(), actionId = 'action') { return handles['terminal:approval']('aba', key, stamp, actionId); },
    async invoke(_id, key, stamp, actionId) {
      try { return { ok: true, value: handles['terminal:approval']('aba', key, stamp, actionId) }; }
      catch (error) { return { ok: false, error: error.message }; }
    },
  };
}

// Keep the real reading card mounted, including its live ref and its 25 ms delayed action. Only React/DOM and
// terminal IO are stand-ins. A/B/A is actually drawn, without a React render or a 100 ms screen publication.
function cardHarness(t, agent, view = 'reading') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = globalThis.window, slots = [], effects = [], errors = [], done = [], b = backend(agent), writes = b.writes;
  let cursor = 0, parsed, rows = fixture(agent), beforeSend = () => {};
  globalThis.window = { setTimeout, agentrix: { writeTerminal: (_id, key) => writes.push(key),
    writeApproval: (...args) => { beforeSend(...args); return b.invoke(...args); }, terminalFocus() {} } };
  const service = require('../src/features/terminal/terminal-screen.ts');
  const terminal = { get rows() { return rows.length; }, buffer: { active: { baseY: 0, getLine: i => ({ translateToString: () => rows[i] ?? '' }) } },
    onWriteParsed(fn) { parsed = fn; return { dispose() {} }; }, onResize() { return { dispose() {} }; },
    write(data, done) { rows = JSON.parse(data); parsed(); done?.(); } };
  const unregister = service.registerScreen('aba', terminal, 'session');
  const draw = next => {
    b.raw(JSON.stringify(next)); rows = next;
    if (service.writeScreen) service.writeScreen('aba', JSON.stringify(next), b.s.approval.stamp());
    else parsed();
  };
  draw(rows);
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useEffect(fn, deps) {
      const i = cursor++, previous = slots[i];
      if (previous && deps && deps.every((value, at) => value === previous.deps?.[at])) return;
      const slot = slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
    },
  };
  const filename = path.join(__dirname, view === 'reading' ? '../src/features/reading/ReadingChoice.tsx' : '../src/features/home/DecisionCard.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === 'react' ? hooks : name === '@phosphor-icons/react' ? new Proxy({}, { get: () => () => null })
    : name.endsWith('/i18n') ? { t: text => text } : name === './decisions' ? { snooze() {} }
    : /ReviewCard|ReadingQuestion/.test(name) ? {} : name.startsWith('.') ? original(name + '.ts') : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const choice = () => service.screenChoice ? service.screenChoice(agent, service.readScreen('aba')) : parseAgentScreen(agent, rows).choice;
  let root;
  const render = () => {
    cursor = 0; const c = choice();
    const props = { choice: c, terminalId: 'aba', agent, onError: error => errors.push(error) };
    const decision = { id: `${c.approval?.instance}:${c.title}`, kind: 'approval', terminalId: 'aba', agent, choice: c,
      identity: require('../src/features/reading/choice-keys.ts').choiceIdentity(c), title: c.title, context: c.context, projectName: 'fixture' };
    root = view === 'reading' ? mod.exports.ReadingChoice(props) : mod.exports.DecisionCard({ decision, now: 1, onDone: message => done.push(message), onError: props.onError });
    if (root.props.ref) root.props.ref.current = { focus() {}, querySelector() {} };
    while (effects.length) effects.shift()();
    return root;
  };
  render();
  t.after(() => { for (const slot of slots) if (typeof slot?.cleanup === 'function') slot.cleanup(); unregister(); globalThis.window = before; });
  return { service, writes, errors, done, choice, draw, render, backend: b,
    paint(next) { rows = next; parsed(); },
    beforeSend(fn) { beforeSend = fn; },
    pick(index) { return nodes(root).filter(node => node.type === 'button' && /reading-choice-option/.test(node.props.className))[index].props.onClick(); },
    capturePick(index) { return nodes(root).filter(node => node.type === 'button' && /reading-choice-option/.test(node.props.className))[index].props.onClick; },
    select(index) { nodes(root).filter(node => node.type === 'input')[index].props.onChange(); render(); },
    confirm() { return nodes(root).find(node => node.props.className === 'button primary').props.onClick(); },
    captureConfirm() { return nodes(root).find(node => node.props.className === 'button primary').props.onClick; },
    cancel() { return nodes(root).find(node => node.props.className === 'text-button').props.onClick(); },
    async tick(ms) { for (let i = 0; i < 20; i++) await Promise.resolve(); t.mock.timers.tick(ms); for (let i = 0; i < 20; i++) await Promise.resolve(); },
    a: rows, b: rows.map(row => row.replaceAll('hello.txt', 'different.txt')),
  };
}

for (const agent of ['claude', 'codex']) {
  test(`${agent}: mounted reading card must stop a delayed old action after actual byte-identical A/B/A`, async t => {
    const h = cardHarness(t, agent);
    h.pick(1); // one navigation key, then a delayed Enter
    assert.deepEqual(h.writes, ['\x1b[B']);
    h.draw(h.b); h.draw(h.a);
    await h.tick(25);
    assert.equal(h.writes.includes('\r'), false, 'old A must never approve later A while the card is still mounted');
  });

  for (const view of ['reading', 'decision']) {
    test(`${agent}/${view}: retained old handler cannot borrow a later identical card's fresh selection`, async t => {
      const h = cardHarness(t, agent, view);
      if (view === 'decision') h.select(0);
      const old = view === 'reading' ? h.capturePick(0) : h.captureConfirm();
      h.draw(h.b); h.draw(h.a); h.render();
      if (view === 'decision') h.select(0);
      old(); await h.tick(0);
      assert.deepEqual(h.writes, []); assert.equal(h.errors.length, 1); assert.deepEqual(h.done, []);
      if (view === 'reading') h.pick(0); else h.confirm();
      await h.tick(0); assert.deepEqual(h.writes, ['\r']);
    });

    test(`${agent}/${view}: an old captured action cannot be rebound to byte-identical later A`, async t => {
      const h = cardHarness(t, agent, view), first = h.choice();
      if (view === 'decision') h.select(0);
      h.draw(h.b); h.draw(h.a);
      assert.notEqual(h.choice().approval.instance, first.approval.instance);
      if (view === 'reading') h.pick(0); else h.confirm();
      await h.tick(0);
      assert.deepEqual(h.writes, []); assert.equal(h.errors.length, 1); assert.deepEqual(h.done, []);
    });

    test(`${agent}/${view}: a final-send A/B/A after renderer recheck is rejected by the real IPC handler`, async t => {
      const h = cardHarness(t, agent, view);
      if (view === 'decision') h.select(0);
      h.beforeSend((_id, key) => {
        assert.equal(key, '\r');
        // Both output callbacks have reached main, but neither its 16 ms batch nor xterm has seen the bytes.
        h.backend.raw(JSON.stringify(h.b)); h.backend.raw(JSON.stringify(h.a));
      });
      if (view === 'reading') h.pick(0); else h.confirm();
      await h.tick(0);
      assert.deepEqual(h.writes, []); assert.equal(h.errors.length, 1); assert.deepEqual(h.done, []);
    });

    test(`${agent}/${view}: stable same-request repaints permit a fresh action and consume its final stamp once`, async t => {
      const h = cardHarness(t, agent, view), first = h.choice();
      h.paint(h.a); h.paint(h.a); // parsed redraw notifications with no new bytes
      assert.deepEqual(h.choice().approval, first.approval);
      h.draw(h.a); // new raw bytes: same request incarnation, fresh conservative output epoch
      assert.equal(h.choice().approval.instance, first.approval.instance);
      assert.notEqual(h.choice().approval.stamp.revision, first.approval.stamp.revision);
      h.render();
      if (view === 'reading') h.pick(0); else { h.select(0); h.confirm(); }
      await h.tick(0);
      assert.deepEqual(h.writes, ['\r']); assert.deepEqual(h.errors, []);
      assert.equal(h.done.length, view === 'decision' ? 1 : 0);
      assert.throws(() => h.backend.send('\r', h.choice().approval.stamp), /审批操作已失效/);
      assert.deepEqual(h.writes, ['\r']);
    });
  }

  test(`${agent}: delayed decision action aborts before Enter, and a repaint cannot refresh a picked answer`, async t => {
    const h = cardHarness(t, agent, 'decision');
    h.select(1); h.confirm(); assert.deepEqual(h.writes, ['\x1b[B']);
    h.draw(h.b); h.draw(h.a); await h.tick(25);
    assert.deepEqual(h.writes, ['\x1b[B']); assert.deepEqual(h.done, []);
  });

  test(`${agent}: an identical raw repaint invalidates an in-flight action, without inventing another request ID`, async t => {
    const h = cardHarness(t, agent), first = h.choice();
    h.pick(1); h.draw(h.a); await h.tick(25);
    assert.equal(h.choice().approval.instance, first.approval.instance);
    assert.deepEqual(h.writes, ['\x1b[B']); assert.equal(h.errors.length, 1);
  });

  test(`${agent}: parsed A/B/A and A/absent/A are observed before a throttled React publication`, async t => {
    const h = cardHarness(t, agent), first = h.choice();
    h.paint(h.b); h.paint(h.a);
    assert.equal(h.choice().approval.stamp.revision, first.approval.stamp.revision, 'isolate parsed-incarnation protection');
    assert.notEqual(h.choice().approval.instance, first.approval.instance);
    h.pick(0); await h.tick(0); assert.deepEqual(h.writes, []);
    const second = h.choice(); h.paint([]); h.paint(h.a);
    assert.notEqual(h.choice().approval.instance, second.approval.instance);
  });

  test(`${agent}: a decision selected before a raw repaint keeps its old stamp even after the card rerenders`, async t => {
    const h = cardHarness(t, agent, 'decision');
    h.select(0); h.draw(h.a); h.render(); h.confirm(); await h.tick(0);
    assert.deepEqual(h.writes, []); assert.equal(h.errors.length, 1); assert.deepEqual(h.done, []);
  });

  test(`${agent}: repaint clears the picked decision so the same option can be selected afresh`, async t => {
    const h = cardHarness(t, agent, 'decision');
    h.select(0); h.draw(h.a); h.render();
    const root = h.render();
    assert.ok(nodes(root).filter(node => node.type === 'input').every(node => !node.props.checked));
    assert.equal(nodes(root).find(node => node.props.className === 'button primary').props.disabled, true);
    h.select(0); h.confirm(); await h.tick(0);
    assert.deepEqual(h.writes, ['\r']); assert.equal(h.done.length, 1);
  });

  test(`${agent}: permission Cancel sends one guarded Escape and never interrupts or approves another request`, async t => {
    const h = cardHarness(t, agent); h.backend.s.needsInput = { message: 'Approve', since: 1 };
    h.cancel(); await h.tick(0);
    assert.deepEqual(h.writes, ['\x1b']); assert.deepEqual(h.errors, []);
    assert.equal(h.backend.scheduled(), agent === 'claude' ? 1 : 0);
    if (agent === 'claude') assert.equal(h.backend.s.needsInput, null);
    assert.throws(() => h.backend.send('\r', h.choice().approval.stamp), /审批操作已失效/);
  });

  test(`${agent}: a changed terminal session between check and send rejects the old action`, async t => {
    const h = cardHarness(t, agent);
    h.beforeSend(() => h.backend.session({ ...h.backend.s, sessionId: 'next-session', approval: new ApprovalGuard('next-session') }));
    h.pick(0); await h.tick(0);
    assert.deepEqual(h.writes, []); assert.equal(h.errors.length, 1);
  });

  test(`${agent}: production activity identity catches session/turn ABA and ignores duplicate observations`, () => {
    const h = backend(agent), s = h.s;
    Object.assign(s, { activitySince: 0, activityInputAt: 0, promptQueue: {} });
    const context = vm.createContext({ sessions: new Map([['aba', s]]), summarizeTask: () => '',
      store: { setRestore() {} }, broadcast() {} });
    const start = main.indexOf('function applyActivity(');
    vm.runInContext(main.slice(start, main.indexOf('// Claude Code hooks:', start)), context);
    const observe = (threadId, turnId) => context.applyActivity({ id: 'p' }, s, { threadId, turnId, state: 'working', updatedAt: 100 });
    observe('thread-A', 'turn-A'); const first = s.approval.stamp();
    observe('thread-A', 'turn-A'); assert.deepEqual(s.approval.stamp(), first);
    observe('thread-A', 'turn-B'); observe('thread-A', 'turn-A');
    assert.throws(() => h.send('\r', first), /审批操作已失效/);
    const second = s.approval.stamp();
    observe('thread-B', 'turn-A'); observe('thread-A', 'turn-A');
    assert.throws(() => h.send('\r', second), /审批操作已失效/); assert.deepEqual(h.writes, []);
  });

  test(`${agent}: native input, resize, pending gate and competing transactions cannot sneak a final key through`, () => {
    const h = backend(agent), first = h.s.approval.stamp();
    h.listeners['terminal:write']('aba', '\x1b[B');
    assert.throws(() => h.send('\r', first), /审批操作已失效/);
    const afterInput = h.s.approval.stamp();
    h.s.terminal.resize = () => {};
    h.listeners['terminal:resize']('aba', 80, 24);
    assert.throws(() => h.send('\r', afterInput), /审批操作已失效/);
    const ready = h.s.approval.stamp(); h.writes.length = 0;
    for (const gate of [{ open: 1 }, { held: ['queued'] }, { expecting: true }, { settling: true }]) {
      const before = h.s.gate; h.s.gate = { ...before, ...gate };
      assert.throws(() => h.send('\r', ready), /等待响应/); assert.deepEqual(h.writes, []); h.s.gate = before;
    }
    h.send('\x1b[B', ready, 'first');
    assert.throws(() => h.send('\r', ready, 'other-card'), /另一项审批/);
    h.send('\r', ready, 'first');
    assert.throws(() => h.send('\r', ready, 'first'), /审批操作已失效/);
    assert.deepEqual(h.writes, ['\x1b[B', '\r']);
  });

  test(`${agent}: SSH approval card routes fail closed before any queued remote write`, () => {
    const h = backend(agent); h.s.approvalRemote = true;
    for (const key of ['\r', '\x1b', '\x1b[B']) assert.throws(() => h.send(key), /SSH 审批请切换到终端/);
    assert.deepEqual(h.writes, []);
    h.listeners['terminal:write']('aba', '\r');
    assert.deepEqual(h.writes, ['\r'], 'explicit terminal input remains available, with terminal-mode limitations');
  });

  test(`${agent}: IPC rechecks live session/agent/thread binding even if a lifecycle callback has not invalidated it`, () => {
    for (const change of [{ sessionId: 'next' }, { agent: agent === 'codex' ? 'claude' : 'codex' }, { rootThreadId: 'next-thread' }]) {
      const h = backend(agent), first = h.s.approval.stamp();
      Object.assign(h.s, change);
      assert.throws(() => h.send('\r', first), /审批操作已失效/); assert.deepEqual(h.writes, []);
    }
  });
}

test('raw output epochs reject coalesced ABA even when no intermediate screen is ever parsed', () => {
  for (const agent of ['claude', 'codex']) {
    const h = backend(agent), a = fixture(agent).join('\n'), b = a.replaceAll('hello.txt', 'different.txt');
    h.raw(a); const old = h.s.approval.stamp();
    h.raw(b + a); // one data callback; no screen parser observes B
    assert.throws(() => h.send('\r', old), /审批操作已失效/); assert.deepEqual(h.writes, []);
  }
});

test('queued ordinary input invalidates an approval again at the actual InputGate release boundary', () => {
  const { InputGate, isTerminalResponse } = require('../electron/terminal-input.cjs');
  const h = backend('codex'), s = h.s;
  const context = vm.createContext({ s, id: 'aba', sessions: new Map([['aba', s]]), terminal: s.terminal, InputGate, isTerminalResponse });
  const start = main.indexOf('  s.gate = new InputGate(');
  vm.runInContext(main.slice(start, main.indexOf('  s.promptQueue =', start)), context);
  s.gate.afterPrompt('queued-input');
  const before = s.approval.stamp();
  assert.throws(() => h.send('\r', before), /等待响应/);
  s.gate.release();
  assert.throws(() => h.send('\r', before), /审批操作已失效/);
  assert.deepEqual(h.writes, ['queued-input']); s.gate.dispose();
});

test('approval IPC rejects missing/malformed epochs, unavailable sessions and arbitrary key strings', () => {
  const h = backend('codex');
  for (const stamp of [undefined, null, {}, { sessionId: 'other', revision: 1 }, { sessionId: 'session', revision: NaN }, { sessionId: 'session', revision: '1' }]) {
    assert.throws(() => h.handles['terminal:approval']('aba', '\r', stamp, 'action'), /审批操作已失效/);
  }
  for (const key of ['y', '1', '\r\r', '\x1b[B\r', 'echo hello\r']) assert.throws(() => h.send(key), /无效的审批按键/);
  h.s.status = 'exited'; assert.throws(() => h.send('\r'), /尚未就绪/);
  h.session(null); assert.throws(() => h.send('\r'), /尚未就绪/); assert.deepEqual(h.writes, []);
});

test('xterm pending writes and late callbacks cannot bind a new epoch to stale rows or a remounted terminal', t => {
  const service = require('../src/features/terminal/terminal-screen.ts'), before = globalThis.window;
  globalThis.window = { setTimeout };
  let rows = fixture('codex'), parsed; const queued = [];
  const terminal = { get rows() { return rows.length; }, buffer: { active: { baseY: 0, getLine: i => ({ translateToString: () => rows[i] ?? '' }) } },
    onWriteParsed(fn) { parsed = fn; return { dispose() {} }; }, onResize() { return { dispose() {} }; }, write(data, done) { queued.push({ data, done }); } };
  const off = service.registerScreen('queue', terminal, 'one');
  service.writeScreen('queue', 'first', { sessionId: 'one', revision: 1 });
  service.writeScreen('queue', 'second', { sessionId: 'one', revision: 2 });
  assert.equal(service.readScreen('queue').approval, null);
  queued[0].done(); parsed(); assert.equal(service.readScreen('queue').approval, null);
  queued[1].done(); parsed(); assert.deepEqual(service.readScreen('queue').approval, { sessionId: 'one', revision: 2 });
  const first = service.screenChoice('codex', service.readScreen('queue'));
  service.writeScreen('queue', 'stale', { sessionId: 'one', revision: 3 });
  off(); const again = service.registerScreen('queue', terminal, 'two'); t.after(again);
  queued[2].done();
  assert.equal(service.readScreen('queue').approval, null);
  assert.notEqual(service.screenChoice('codex', service.readScreen('queue')).approval.instance, first.approval.instance);
  t.after(() => { globalThis.window = before; });
});
