const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WorkspaceStore } = require('../electron/state.cjs');
const { SubmissionTracker } = require('../electron/terminal-input.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');
const { ConversationLog, codexConversation } = require('../electron/conversation.cjs');
const { PromptQueue } = require('../electron/prompt-queue.cjs');
const { resumeCommand, claudeResumeCommand } = require('../electron/session-restore.cjs');
const { isLocalAgentCommand } = require('../electron/agent-commands.cjs');

const main = syncFs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
async function harness(t, kind = 'local', agent = 'codex') {
  const scratch = path.resolve(__dirname, '../.test-output/bug-fixes-work/backend/unit-tmp');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(path.join(directory, 'workspace.json'));
  const project = store.add(directory).project; project.kind = kind;
  const s = { terminalId: project.id, projectId: project.id, agent, codexActive: true, status: 'running',
    activitySince: 1000, activityInputAt: 0, promptQueue: new PromptQueue(), submissions: new SubmissionTracker(),
    actions: { settle() {} }, gate: { input() {} } };
  const sessions = new Map([[s.terminalId, s]]);
  let now = 2000, alerts = 0;
  const context = vm.createContext({ sessions, store, summarizeTask: () => '', isLocalAgentCommand,
    notifyCompletion: () => alerts++, broadcast() {}, publishConversation() {},
    memoryFolder: () => directory, memoryDir: () => directory, roundsOf: () => [], remember: async () => {},
    setTimeout: () => ({ unref() {} }), scrubProjectSkills: async () => {},
    followClaude() {}, followClaudeSession: async () => {}, resumeCommand, claudeResumeCommand,
    restorePlans: new Map(), Date: class extends Date { static now() { return now; } },
  });
  vm.runInContext(main.slice(main.indexOf('function applyActivity('), main.indexOf('function onEvent(')), context);
  vm.runInContext(main.slice(main.indexOf('async function resumeAfterPrompt('), main.indexOf('function remoteFor(')), context);
  // Use the actual terminal's conversation callback, including its input/history filter.
  context.s = s; context.project = project; context.ConversationLog = ConversationLog;
  const start = main.indexOf('  s.conversation = new ConversationLog(');
  vm.runInContext(main.slice(start, main.indexOf('\n  sessions.set(id, s);', start)), context);
  const listeners = {};
  registerTerminalIpc({ handle() {}, listen: (name, fn) => { listeners[name] = fn; },
    getSession: id => sessions.get(id), getProjectById: () => project,
    acknowledgeProject: id => store.acknowledge(id), expectCompletion: id => store.expectCompletion(id),
    scheduleState() {}, pollAfterSubmission() {}, applyActivity: context.applyActivity, now: () => now,
  });
  return { project, s, store, sessions, context, alerts: () => alerts, now: value => { now = value; },
    write: text => listeners['terminal:write'](s.terminalId, text),
    apply: (state, turnId, updatedAt = now) => context.applyActivity(project, s, { state, turnId, threadId: 'thread', updatedAt }),
    user: (text, at = now) => codexConversation(s.conversation, { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'user_message', message: text } }),
  };
}

test('actual activity + store alerts once per input, stays quiet after acknowledgment and automatically acknowledges next send', async t => {
  for (const kind of ['local', 'ssh']) for (const agent of ['codex', 'claude']) {
    const h = await harness(t, kind, agent);
    h.write('first task\r');
    h.apply('working', null, 2100); h.apply('complete', 'first', 2200);
    assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 1);
    h.store.acknowledge(h.project.id);
    h.apply('complete', 'first', 2200); // duplicate callback
    h.apply('working', null, 2300); // idle/background work
    h.apply('complete', 'background', 2400); // distinct background completion
    assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 0); assert.equal(h.project.completionArmed, false);
    assert.ok(h.project.seenEvents.includes('thread:background'));
    h.now(2500); h.write('second task\r'); h.apply('complete', 'second', 2600);
    assert.equal(h.alerts(), 2); assert.equal(h.project.unread, 1);
    h.now(2700); h.write('third task\r');
    assert.equal(h.project.unread, 0, 'real terminal IPC acknowledges the preceding result');
    h.apply('complete', 'second', 2600); // stale completion cannot consume third input
    assert.equal(h.project.completionArmed, true);
    h.apply('complete', 'third', 2800);
    assert.equal(h.alerts(), 3); assert.equal(h.project.unread, 1);
    h.now(2900); h.write('interrupted task\r'); h.apply('interrupted', null, 3000);
    h.apply('complete', 'after-interruption', 3100);
    assert.equal(h.alerts(), 3); assert.equal(h.project.completionArmed, false);
    h.now(3200); h.write('fresh task after interruption\r'); h.apply('complete', 'recovery', 3300);
    assert.equal(h.alerts(), 4); assert.equal(h.project.unread, 1);
    const persisted = JSON.parse(await fs.readFile(h.store.filename, 'utf8')).projects[0];
    assert.equal(persisted.completionArmed, false); assert.equal(persisted.unread, 1);
  }
});

test('Codex received user records preserve command-line, recalled and custom-command rounds without rearming replayed history', async t => {
  for (const kind of ['local', 'ssh']) {
    const h = await harness(t, kind);
    h.s.activityClockOffset = kind === 'ssh' ? 100000 : 0;
    const remoteAt = at => at - h.s.activityClockOffset;
    // First command-line prompt is received after CLI startup; no active-terminal key event exists for it.
    h.user('initial command-line task', remoteAt(2000));
    h.apply('complete', 'initial', 2100); h.store.acknowledge(h.project.id);
    h.s.conversation.reset(); h.user('initial command-line task', remoteAt(2000));
    h.user('older history', remoteAt(900));
    h.apply('working', null, 2200); h.apply('complete', 'idle', 2300);
    assert.equal(h.alerts(), 1); assert.equal(h.project.completionArmed, false);
    for (const [keys, prompt, at] of [['\x1b[A\r', 'recalled task', 3000], ['/custom-task\r', 'expanded custom task', 4000]]) {
      h.now(at); h.write(keys);
      assert.equal(h.project.completionArmed, false, 'an unknown menu choice/slash command alone is not a round');
      h.user(prompt, remoteAt(at + 1)); h.apply('complete', `turn-${at}`, at + 100);
      h.store.acknowledge(h.project.id);
    }
    assert.equal(h.alerts(), 3);
    h.user('late prompt from already completed work', remoteAt(4050));
    h.apply('complete', 'late-background', 4300);
    assert.equal(h.alerts(), 3); assert.equal(h.project.unread, 0);
    codexConversation(h.s.conversation, { type: 'event_msg', timestamp: new Date(remoteAt(4500)).toISOString(),
      payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'modern-user', content: [{ type: 'input_text', text: 'modern prompt' }] } } });
    h.apply('complete', 'modern-turn', 4600);
    assert.equal(h.alerts(), 4);
    h.s.conversation.put({ id: 'answer', role: 'user', answer: true, at: remoteAt(5000), text: 'permission answer' });
    assert.equal(h.project.completionArmed, false);
  }
});

test('Claude UserPromptSubmit arms actual rounds, while local commands, duplicate hooks and generic working snapshots do not', async t => {
  for (const kind of ['local', 'ssh']) {
    const h = await harness(t, kind, 'claude');
    const hook = (state, id, prompt) => h.context.claudeActivity(h.project, h.s, { state, eventId: `session:${id}`, sessionId: 'session', prompt });
    hook('working', 'start', 'first actual prompt'); h.now(2100); hook('complete', 'stop');
    h.store.acknowledge(h.project.id);
    hook('working', 'start', 'first actual prompt'); hook('complete', 'background-stop');
    assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 0);
    hook('working', 'local-command', '/context'); hook('complete', 'local-command-stop');
    assert.equal(h.project.completionArmed, false);
    h.now(2300); hook('working', 'custom-command', '/custom-task');
    h.now(2400); hook('complete', 'custom-stop');
    assert.equal(h.alerts(), 2);
  }
});

test('restore routes Claude to its own local/SSH gate and only interrupted work arms completion', async t => {
  const id = '00000000-0000-4000-8000-000000000001';
  for (const kind of ['local', 'ssh']) for (const interrupted of [false, true]) {
    const h = await harness(t, kind, 'claude'), writes = [], follows = [];
    h.store.setRestore(h.s.terminalId, { agent: 'claude', threadId: id, interrupted });
    Object.assign(h.s, { ready: true, codexActive: false, claudeAvailable: true, codexAvailable: false,
      gate: { input: text => writes.push(['input', text]), afterPrompt: text => writes.push(['afterPrompt', text]) },
      terminal: { request: () => assert.fail('Claude must never request Codex resume-info') } });
    h.context.followClaudeSession = async (...args) => follows.push(args);
    h.context.restorePlans.set(h.s.terminalId, { codex: true });
    await h.context.resumeAfterPrompt(h.project, h.s);
    assert.deepEqual(writes, [[kind === 'ssh' ? 'input' : 'afterPrompt', `claude --resume ${id}${interrupted ? ' "继续"' : ''}\r`]]);
    assert.equal(follows.length, kind === 'ssh' ? 0 : 1); assert.equal(h.s.claudeResumeId, id);
    assert.equal(h.project.completionArmed, interrupted);
    // Exercise the real activity/store boundary after restart, with no new manually typed prompt.
    h.s.codexActive = true; h.apply('complete', 'restored', 3000);
    assert.equal(h.alerts(), interrupted ? 1 : 0);
    h.store.acknowledge(h.project.id); h.apply('working', null, 3100); h.apply('complete', 'background', 3200);
    assert.equal(h.alerts(), interrupted ? 1 : 0);
  }
});

test('restore preserves plan/readiness/input safeguards and the recorded newest-Claude fallback', async t => {
  for (const change of ['no-plan', 'not-ready', 'dirty', 'active', 'not-installed', 'terminal-only']) {
    const h = await harness(t, 'ssh', 'claude'), writes = [];
    h.store.setRestore(h.s.terminalId, { agent: 'claude' });
    Object.assign(h.s, { ready: true, codexActive: false, claudeAvailable: true, gate: { input: text => writes.push(text) } });
    h.context.restorePlans.set(h.s.terminalId, { codex: true });
    if (change === 'no-plan') h.context.restorePlans.clear();
    if (change === 'not-ready') h.s.ready = false;
    if (change === 'dirty') h.s.inputDirty = true;
    if (change === 'active') h.s.codexActive = true;
    if (change === 'not-installed') h.s.claudeAvailable = false;
    if (change === 'terminal-only') h.context.restorePlans.set(h.s.terminalId, { codex: false });
    await h.context.resumeAfterPrompt(h.project, h.s);
    assert.deepEqual(writes, [], change);
  }
  const h = await harness(t, 'ssh', 'claude'), writes = [];
  h.store.setRestore(h.s.terminalId, { agent: 'claude' });
  Object.assign(h.s, { ready: true, codexActive: false, claudeAvailable: true, gate: { input: text => writes.push(text) } });
  h.context.restorePlans.set(h.s.terminalId, { codex: true });
  await h.context.resumeAfterPrompt(h.project, h.s);
  assert.deepEqual(writes, ['claude --continue\r']);
});

test('local and remote Codex restoration retain routing, interrupted continuation and in-flight input guards', async t => {
  const id = '00000000-0000-4000-8000-000000000002';
  for (const kind of ['local', 'ssh']) for (const state of ['complete', 'interrupted']) {
    const h = await harness(t, kind), writes = [], requests = [];
    h.store.setRestore(h.s.terminalId, { agent: 'codex', threadId: id });
    const info = { id, state };
    h.context.recentSession = async () => info;
    Object.assign(h.s, { ready: true, codexActive: false, codexAvailable: true,
      gate: { input: text => writes.push(['input', text]), afterPrompt: text => writes.push(['afterPrompt', text]) },
      terminal: { request: async (op, args) => { requests.push([op, args.threadId]); return info; } } });
    h.context.restorePlans.set(h.s.terminalId, { codex: true });
    await h.context.resumeAfterPrompt(h.project, h.s);
    assert.deepEqual(writes, [[kind === 'ssh' ? 'input' : 'afterPrompt', `codex resume ${id}${state === 'interrupted' ? ' "继续"' : ''}\r`]]);
    assert.deepEqual(requests, kind === 'ssh' ? [['resume-info', id]] : []);
    assert.equal(h.project.completionArmed, state === 'interrupted');
    h.s.codexActive = true; h.apply('complete', 'codex-restored', 3000);
    assert.equal(h.alerts(), state === 'interrupted' ? 1 : 0);
  }
  const h = await harness(t, 'ssh');
  Object.assign(h.s, { ready: true, codexActive: false, codexAvailable: true,
    gate: { input: () => assert.fail('typed input must cancel in-flight restore') },
    terminal: { request: async () => { h.s.inputDirty = true; return { id, state: 'interrupted' }; } } });
  h.context.restorePlans.set(h.s.terminalId, { codex: true });
  await h.context.resumeAfterPrompt(h.project, h.s);
  assert.equal(h.project.completionArmed, false);
});

test('the local-only Claude session follower rejects SSH before accessing any local transcript', async t => {
  const h = await harness(t, 'ssh', 'claude');
  h.context.findClaudeSession = () => assert.fail('must not look for remote Claude sessions locally');
  vm.runInContext(main.slice(main.indexOf('async function followClaudeSession('), main.indexOf('// One place turns an agent')), h.context);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'remote-session'), false);
});

test('two SSH Claude terminals restore their own recorded conversations through their own gates', async t => {
  const h = await harness(t, 'ssh', 'claude'), writes = [];
  const secondId = h.store.addTerminal(h.project.id);
  const second = { terminalId: secondId };
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  [h.s, second].forEach((s, index) => {
    Object.assign(s, { ready: true, inputDirty: false, codexActive: false, claudeAvailable: true, codexAvailable: false,
      gate: { input: command => writes.push([s.terminalId, command]) },
      terminal: { request: () => assert.fail('no extra remote query or login is needed') } });
    h.sessions.set(s.terminalId, s);
    h.store.setRestore(s.terminalId, { agent: 'claude', threadId: ids[index] });
    h.context.restorePlans.set(s.terminalId, { codex: true });
  });
  await Promise.all([h.context.resumeAfterPrompt(h.project, h.s), h.context.resumeAfterPrompt(h.project, second)]);
  assert.deepEqual(writes, [[h.s.terminalId, `claude --resume ${ids[0]}\r`], [secondId, `claude --resume ${ids[1]}\r`]]);
  assert.equal(h.s.claudeResumeId, ids[0]); assert.equal(second.claudeResumeId, ids[1]);
});

test('desktop task fixture emits a fresh received prompt that completes through the real reader and store, and releases its shell', async t => {
  const { runDesktopTask } = await import('./helpers/desktop-task-fixture.mjs');
  const { CodexActivityReader } = require('../electron/codex-activity.cjs');
  for (const observationFails of [false, true]) {
    const h = await harness(t), home = path.join(h.project.path, 'codex-home'), records = [], waits = [];
    h.s.codexActive = false;
    const page = { evaluate: async (_callback, args) => {
      if (args) {
        assert.equal(args.id, h.project.id);
        assert.ok(args.command.includes("Send-AgentrixEvent 'codex-started'"));
        assert.ok(args.command.includes("Send-AgentrixEvent 'codex-exited'"));
        assert.ok(args.command.includes('Test-Path -LiteralPath'));
        // Simulate only shell startup, leaving notification arming to the real rollout/input path below.
        h.s.codexActive = true; h.s.activitySince = Date.now(); h.now(h.s.activitySince);
        return;
      }
      return { value: { projects: [{ ...h.project, codexActive: h.s.codexActive, shellReady: !h.s.codexActive }] } };
    } };
    const waitFor = async (predicate, label) => {
      waits.push(label);
      if (label === 'interactive parent task completion') {
        const reader = new CodexActivityReader(h.project.path, home, h.s.activitySince, {
          onRecord: record => { records.push(record); codexConversation(h.s.conversation, record, h.project.path); },
        });
        const snapshot = await reader.read();
        assert.equal(snapshot.state, 'complete');
        h.context.applyActivity(h.project, h.s, snapshot);
        if (observationFails) throw new Error('completion observation failed');
      }
      if (label === 'offline task returns to shell') {
        const release = (await fs.readdir(h.project.path)).find(name => name.startsWith('.task-'));
        assert.equal(await fs.readFile(path.join(h.project.path, release), 'utf8'), 'done');
        h.s.codexActive = false;
      }
      assert.equal(await predicate(), true, label);
    };
    const running = runDesktopTask(page, h.project, home, 'fixture-input-turn', waitFor);
    if (observationFails) await assert.rejects(running, /completion observation failed/);
    else await running;
    assert.deepEqual(records.map(record => record.type === 'event_msg' ? record.payload.type : record.type),
      ['session_meta', 'task_started', 'user_message', 'task_complete']);
    const [meta, started, prompt, completed] = records;
    assert.match(meta.payload.id, /^[a-f\d-]{36}$/i);
    assert.equal(meta.payload.source, 'cli'); assert.equal(meta.payload.cwd, h.project.path);
    assert.equal(started.payload.turn_id, 'fixture-input-turn'); assert.equal(completed.payload.turn_id, started.payload.turn_id);
    assert.equal(prompt.payload.message, 'Run desktop test task fixture-input-turn.');
    assert.ok(Date.parse(prompt.timestamp) >= h.s.activitySince, 'received input is newer than shell startup');
    assert.ok(Date.parse(started.timestamp) <= Date.parse(prompt.timestamp) && Date.parse(prompt.timestamp) <= Date.parse(completed.timestamp));
    assert.equal(h.project.unread, 1); assert.equal(h.project.completionArmed, false); assert.equal(h.alerts(), 1);
    assert.equal(h.project.lastCompletedAt, Date.parse(completed.timestamp));
    assert.equal(await fs.readFile(path.join(h.project.path, `.task-${meta.payload.id}.done`), 'utf8'), 'done', 'finally releases the occupied shell on success or failure');
    assert.deepEqual(waits, ['offline task starts', 'interactive parent task completion', ...(observationFails ? [] : ['offline task returns to shell'])]);
  }
});

test('visual smoke fixture records arm only its two fresh submissions, while duplicate completion and reopened history stay quiet', async t => {
  const { CodexActivityReader } = require('../electron/codex-activity.cjs');
  const h = await harness(t), home = path.join(h.project.path, 'visual-home');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  const thread = '00000000-0000-4000-8000-000000000003';
  const transcript = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  // Execute just the real fixture's record builders and file writes, without importing its GUI runner.
  const source = await fs.readFile(path.join(__dirname, '../scripts/visual-smoke.mjs'), 'utf8');
  const lines = source.split(/\r?\n/);
  const builders = lines.filter(line => /^\s*const (record|submitted) =/.test(line));
  const writes = lines.filter(line => /^\s*await fs\.(writeFile|appendFile)\(transcript,/.test(line));
  assert.equal(builders.length, 2); assert.equal(writes.length, 5);
  Object.assign(h.context, { fs, thread, transcript, projects: [h.project] });
  const Clock = h.context.Date;
  h.context.Date = class extends Clock { constructor(...args) { super(...(args.length ? args : [Clock.now()])); } };
  vm.runInContext(builders.join('\n'), h.context);
  const records = [];
  const reader = new CodexActivityReader(h.project.path, home, h.s.activitySince, {
    onRecord: record => { records.push(record); codexConversation(h.s.conversation, record, h.project.path); },
  });
  for (let index = 0; index < writes.length; index++) {
    h.now(2000 + index * 100);
    await vm.runInContext(`(async () => { ${writes[index]} })()`, h.context);
    h.context.applyActivity(h.project, h.s, await reader.read());
    if (index === 0 || index === 3) {
      assert.equal(h.s.codexActivity, 'working'); assert.equal(h.project.completionArmed, true);
    } else {
      assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.project.completionArmed, false);
    }
    assert.equal(h.alerts(), index === 0 ? 0 : index < 4 ? 1 : 2);
    if (index === 1) h.store.acknowledge(h.project.id);
    if (index === 2 || index === 3) assert.equal(h.project.unread, 0, 'duplicate completion cannot rearm the acknowledged result');
  }
  assert.equal(records[0].payload.id, thread); assert.equal(records[0].payload.cwd, h.project.path);
  const prompts = records.filter(record => record.payload.type === 'user_message');
  assert.deepEqual(prompts.map(record => record.payload.message), ['验证独立项目的任务状态', '继续验证下一轮任务完成后的提醒']);
  assert.deepEqual(prompts.map(record => Date.parse(record.timestamp)), [2000, 2300]);
  assert.equal(h.project.unread, 1); assert.equal(h.project.lastCompletedAt, 2400);
  h.store.acknowledge(h.project.id);
  h.s.activitySince = 2500; h.s.activityPromptAt = 0;
  const reopened = new CodexActivityReader(h.project.path, home, h.s.activitySince, {
    onRecord: record => codexConversation(h.s.conversation, record, h.project.path),
  });
  h.context.applyActivity(h.project, h.s, await reopened.read());
  assert.equal(h.alerts(), 2); assert.equal(h.project.unread, 0); assert.equal(h.project.completionArmed, false);
});
