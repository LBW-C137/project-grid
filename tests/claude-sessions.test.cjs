const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { encodeClaudeCwd, findClaudeSession, listClaudeSessions, promptTitle, READ_BUDGET } = require('../electron/claude-sessions.cjs');
const { TranscriptTail, ActionLog, claudeRecord } = require('../electron/agent-actions.cjs');
const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
const { monitorActivity } = require('../electron/codex-activity.cjs');
const { claudeResumeCommand } = require('../electron/session-restore.cjs');
const { HISTORY_WINDOW } = require('../electron/transcript-window.cjs');

const user = content => ({ type: 'user', uuid: 'prompt', message: { content } });
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-claude-sessions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = 'E:\\不负芳华\\project', folder = path.join(home, 'projects', encodeClaudeCwd(cwd));
  await fs.mkdir(folder, { recursive: true });
  const write = async (id, records, when = 1000000) => {
    const file = path.join(folder, `${id}.jsonl`);
    await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    await fs.utimes(file, when / 1000, when / 1000);
    return file;
  };
  return { home, cwd, folder, write };
}

test('Claude cwd encoding replaces every separator, punctuation and Unicode character separately', () => {
  assert.equal(encodeClaudeCwd('E:\\不负芳华\\pg-worktrees\\bisect\\.test-output\\narrow-claude-1791451017450\\one'),
    'E-------pg-worktrees-bisect--test-output-narrow-claude-1791451017450-one');
  assert.equal(encodeClaudeCwd('/tmp/a_b.c +é😀'), '-tmp-a-b-c----');
});

test('session lookup prefers the encoded project and scans folders only when it is absent', async t => {
  const f = await fixture(t), known = await f.write('known', [user('hello')]);
  const other = path.join(f.home, 'projects', 'edge-encoding'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'other.jsonl'), '{}\n');
  assert.equal(await findClaudeSession(f.cwd, 'known', f.home), known);
  assert.equal(await findClaudeSession(f.cwd, 'other', f.home), null);
  await fs.rename(f.folder, path.join(f.home, 'projects', 'legacy-encoding'));
  assert.equal(await findClaudeSession(f.cwd, 'known', f.home), path.join(f.home, 'projects', 'legacy-encoding', 'known.jsonl'));
  assert.equal(await findClaudeSession(f.cwd, 'missing', f.home), null);
  for (const id of ['../other', 'bad\rcommand', '', null]) assert.equal(await findClaudeSession(f.cwd, id, f.home), null);
});

test('titles accept text blocks, trim whitespace and skip metadata, tool results, commands and caveats', () => {
  assert.equal(promptTitle(user('  Fix\n this   project  ')), 'Fix this project');
  assert.equal(promptTitle(user([{ type: 'image' }, { type: 'text', text: 'A prompt' }])), 'A prompt');
  assert.equal(promptTitle(user('好'.repeat(130))).length, 120);
  for (const record of [
    { ...user('meta'), isMeta: true }, { ...user('child'), isSidechain: true },
    { type: 'assistant', message: { content: 'answer' } },
    user([{ type: 'text', text: 'hidden' }, { type: 'tool_result' }]),
    user('<command-name>/resume</command-name>'), user('<command-message>help</command-message>'),
    user('<local-command-stdout>done</local-command-stdout>'), user('<local-command-caveat>hidden</local-command-caveat>'),
    user('[Caveat: The messages below were generated while running local commands.]'), user('Caveat: local commands'), user([]),
  ]) assert.equal(promptTitle(record), '');
});

test('session list extracts the first real prompt, counts records and excludes the current id', async t => {
  const f = await fixture(t);
  await f.write('current', [user('current')], 3000000);
  await f.write('older', [user('old')], 1000000);
  await f.write('newer', [{ ...user('meta'), isMeta: true }, user('<command-name>/model</command-name>'),
    user([{ type: 'tool_result' }]), user('First real prompt'), user('Later prompt'), { type: 'assistant' }], 2000000);
  await fs.writeFile(path.join(f.folder, 'ignore.txt'), 'nothing');
  await fs.mkdir(path.join(f.folder, 'child.jsonl'));
  const list = await listClaudeSessions(f.cwd, 'current', f.home);
  assert.deepEqual(list, [
    { id: 'newer', title: 'First real prompt', updatedAt: 2000000, messages: 6 },
    { id: 'older', title: 'old', updatedAt: 1000000, messages: 1 },
  ]);
});

test('session list takes the newest 30 and missing project folders return an empty list', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 35; index++) await f.write(`session-${index}`, [user(`prompt ${index}`)], 1000000 + index * 1000);
  const list = await listClaudeSessions(f.cwd, null, f.home);
  assert.equal(list.length, 30); assert.equal(list[0].id, 'session-34'); assert.equal(list.at(-1).id, 'session-5');
  assert.deepEqual(await listClaudeSessions('/missing', null, f.home), []);
});

test('large transcripts never read titles beyond 256 KiB and estimate message density', async t => {
  const f = await fixture(t);
  const line = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(500) } }) + '\n';
  const records = Math.ceil(READ_BUDGET / Buffer.byteLength(line)) + 30;
  await fs.writeFile(path.join(f.folder, 'large.jsonl'), line.repeat(records) + JSON.stringify(user('Too late to be read')) + '\n');
  await fs.writeFile(path.join(f.folder, 'broken.jsonl'), '{bad json}\n' + JSON.stringify(user('Valid prompt')) + '\n{"type":"user"');
  const list = await listClaudeSessions(f.cwd, null, f.home);
  assert.equal(list.find(item => item.id === 'large').title, '');
  assert.ok(Math.abs(list.find(item => item.id === 'large').messages - records) <= 2);
  assert.equal(list.find(item => item.id === 'broken').title, 'Valid prompt');
  assert.equal(list.find(item => item.id === 'broken').messages, 1);
});

const main = syncFs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function mainHarness(t, f) {
  const project = { id: 'project', path: f.cwd, kind: 'local' };
  const restore = { cwd: f.cwd, agent: 'claude' };
  let resets = 0;
  const s = { terminalId: 'terminal', projectId: project.id, sessionKey: 'key', agent: 'claude', codexActive: true,
    actions: new ActionLog(), conversation: new ConversationLog(), promptQueue: { reset() {} }, submissions: { reset() {} } };
  const reset = s.conversation.reset.bind(s.conversation); s.conversation.reset = () => { resets++; reset(); };
  const sessions = new Map([[s.terminalId, s]]);
  const store = { projects: [project], findTerminal: () => ({ record: { restore } }),
    setRestore: (_id, value) => Object.assign(restore, value), expectCompletion() {} };
  const context = vm.createContext({ path, sessions, store, TranscriptTail, monitorActivity, claudeConversation, claudeRecord,
    claudeConfigDir: () => f.home, findClaudeSession: (cwd, id) => findClaudeSession(cwd, id, f.home),
    describeActions() {}, broadcast() {}, acceptShellEvent: () => true,
    quitting: false, Date, claudeResumeCommand, restorePlans: new Map(),
    // The handoff of earlier work is written on start (handoff.cjs, tested on its own).
    writeHandoff: async () => false, handoffFile: id => path.join(f.home, 'handoff', `${id}.md`), memoryDir: () => path.join(f.home, 'memory'), scrubProjectSkills: async () => [],
  });
  vm.runInContext(main.slice(main.indexOf('function followClaude('), main.indexOf('// One place turns an agent')), context);
  vm.runInContext(main.slice(main.indexOf('function onEvent('), main.indexOf('function remoteFor(')), context);
  t.after(() => s.activityMonitor?.stop());
  return { project, s, store, sessions, context, restore, resets: () => resets };
}

function activityHarness(t, f) {
  const h = mainHarness(t, f);
  h.project.seenEvents = [];
  h.s.promptQueue.finish = () => {};
  h.store.complete = () => false;
  Object.assign(h.context, {
    summarizeTask: () => '', isLocalAgentCommand: () => false, notifyCompletion() {},
    memoryFolder: () => f.cwd, roundsOf: () => [], remember: async () => {},
    setTimeout: () => ({ unref() {} }),
  });
  vm.runInContext(main.slice(main.indexOf('function applyActivity('), main.indexOf('function onEvent(')), h.context);
  return h;
}

const pendingTool = id => ({ type: 'assistant', uuid: id, message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `${id}.txt` } }] } });

test('Claude Stop polls the last transcript records before settling both action and conversation tools', async t => {
  const f = await fixture(t), file = await f.write('session', [user('Question'), pendingTool('failed'), pendingTool('unanswered')]);
  const h = activityHarness(t, f);
  await h.context.followClaudeSession(h.project, h.s, 'session');
  h.s.codexActivity = 'working';
  await fs.appendFile(file, [
    user([{ type: 'tool_result', tool_use_id: 'failed', is_error: true }]), pendingTool('last'),
  ].map(record => JSON.stringify(record) + '\n').join(''));
  h.context.claudeActivity(h.project, h.s, { state: 'complete', sessionId: 'session', eventId: 'session:round', transcriptPath: file });
  await h.s.activityMonitor.poll();
  await new Promise(setImmediate);
  assert.equal(h.s.codexActivity, 'complete');
  assert.deepEqual(h.s.actions.list.map(action => [action.id, action.done, action.failed]), [['failed', true, true], ['unanswered', true, false], ['last', true, false]]);
  assert.deepEqual(h.s.conversation.list.filter(entry => entry.role === 'tool').map(entry => [entry.id, entry.tool.done, entry.tool.failed]), [['failed', true, true], ['unanswered', true, false], ['last', true, false]]);
});

test('Escape interruption settles both Claude views through the existing terminal IPC activity flow', async t => {
  const f = await fixture(t);
  await f.write('session', [user('Question'), pendingTool('pending')]);
  const h = activityHarness(t, f);
  await h.context.followClaudeSession(h.project, h.s, 'session');
  const listeners = {}, keys = [];
  Object.assign(h.s, { codexActivity: 'working', status: 'running', needsInput: null,
    submissions: { write: () => false, sent: [] }, gate: { input: key => keys.push(key) } });
  require('../electron/features/terminal/ipc.cjs').registerTerminalIpc({ handle() {}, listen: (name, callback) => { listeners[name] = callback; },
    getSession: id => h.sessions.get(id), getProjectById: () => h.project, applyActivity: h.context.applyActivity });
  listeners['terminal:write']('terminal', '\x1b');
  await h.s.activityMonitor.poll();
  await new Promise(setImmediate);
  assert.deepEqual(keys, ['\x1b']);
  assert.equal(h.s.codexActivity, 'interrupted');
  assert.equal(h.s.actions.list[0].done, true);
  assert.equal(h.s.conversation.list.at(-1).tool.done, true);
});

test('a delayed Claude final poll cannot settle a newer round, submission or replacement session', async t => {
  const f = await fixture(t);
  for (const change of ['round', 'submission', 'replacement']) {
    const h = activityHarness(t, f);
    claudeRecord(h.s.actions, pendingTool('pending'), f.cwd);
    claudeConversation(h.s.conversation, pendingTool('pending'), f.cwd);
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    h.s.activityMonitor = { poll: () => pending, stop() {} };
    h.context.claudeActivity(h.project, h.s, { state: 'complete', sessionId: 'session', eventId: 'session:old' });
    assert.equal(h.s.conversation.list[0].tool.done, false, 'settlement waits for the poll');
    if (change === 'round') h.context.claudeActivity(h.project, h.s, { state: 'working', sessionId: 'session', eventId: 'session:new', prompt: 'Next question' });
    else if (change === 'submission') { h.s.codexActivity = 'working'; h.s.activityInputAt = Date.now() + 1; }
    else h.sessions.delete('terminal');
    finish(); await pending; await new Promise(setImmediate);
    assert.equal(h.s.actions.list[0].done, false, change);
    assert.equal(h.s.conversation.list[0].tool.done, false, change);
  }
});

test('Claude interruption without a transcript monitor still settles, while stale activity is ignored', async t => {
  const h = activityHarness(t, await fixture(t));
  claudeRecord(h.s.actions, pendingTool('pending'));
  claudeConversation(h.s.conversation, pendingTool('pending'));
  h.s.activitySince = 20; h.s.activityInputAt = 30; h.s.codexActivity = 'working';
  h.context.applyActivity(h.project, h.s, { state: 'interrupted', updatedAt: 25 });
  await Promise.resolve();
  assert.equal(h.s.conversation.list[0].tool.done, false);
  h.context.applyActivity(h.project, h.s, { state: 'interrupted', updatedAt: 31 });
  await Promise.resolve();
  assert.equal(h.s.actions.list[0].done, true);
  assert.equal(h.s.conversation.list[0].tool.done, true);
});

test('following a known id loads history immediately, and same-session hooks preserve the tail and log', async t => {
  const f = await fixture(t), file = await f.write('session', [user('Before resume'), { type: 'assistant', uuid: 'reply', message: { content: [{ type: 'text', text: 'Previous answer' }] } }]);
  const h = mainHarness(t, f);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'session'), true);
  assert.deepEqual(h.s.conversation.list.map(entry => entry.text), ['Before resume', 'Previous answer']);
  assert.equal(h.restore.threadId, 'session');
  const tail = h.s.claudeTranscript;
  h.context.followClaude(h.project, h.s, { sessionId: 'session', transcriptPath: file });
  await h.s.activityMonitor.poll();
  assert.equal(h.s.claudeTranscript, tail); assert.equal(h.resets(), 1); assert.equal(h.s.conversation.list.length, 2);
});

test('both Claude followers load a large session window and clear old consumers when it is replaced', async t => {
  const f = await fixture(t), file = await f.write('large', [user('excluded'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'excluded', name: 'Skill', input: { skill: 'excluded-skill' } }] } },
    { padding: 'x'.repeat(HISTORY_WINDOW + 1000) },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'excluded' }] } },
    { type: 'assistant', uuid: 'recent', message: { content: [{ type: 'text', text: 'Recent answer' },
      { type: 'tool_use', id: 'recent-skill', name: 'Skill', input: { skill: 'recent-skill' } }] } }]);
  const h = mainHarness(t, f), described = [];
  h.context.skillDescription = async name => { described.push(name); return 'Recent skill description'; };
  vm.runInContext(main.slice(main.indexOf('function describeActions('), main.indexOf('// Claude Code writes each tool call')), h.context);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'large'), true);
  assert.equal(h.s.claudeTranscript.historyPending, false);
  assert.deepEqual(h.s.conversation.snapshot().filter(entry => entry.text).map(entry => entry.text), ['Recent answer']);
  assert.deepEqual(described, ['recent-skill'], 'only in-window skill calls reach describeActions');
  assert.deepEqual(h.s.actions.list.map(action => action.id), ['recent-skill']);
  assert.equal(h.s.actions.list[0].description, 'Recent skill description');
  const tail = h.s.claudeTranscript;
  h.context.followClaude(h.project, h.s, { sessionId: 'large', transcriptPath: file });
  await h.s.activityMonitor.poll();
  assert.equal(h.s.claudeTranscript, tail); assert.equal(h.resets(), 1);
  await fs.rename(file, `${file}.old`);
  h.s.lastTask = 'Previous task';
  await fs.writeFile(file, JSON.stringify({ padding: 'x'.repeat(HISTORY_WINDOW + 2000) }) + '\n'
    + JSON.stringify({ type: 'assistant', uuid: 'new', message: { content: [{ type: 'tool_use', id: 'new-tool', name: 'Read', input: { file_path: 'new.txt' } }] } }) + '\n');
  await h.s.activityMonitor.poll();
  assert.equal(h.resets(), 2);
  assert.equal(h.s.lastTask, 'Previous task', 'history callbacks preserve the task remembered from live hooks, including continue prompts');
  assert.deepEqual(h.s.conversation.snapshot().map(entry => entry.role), ['tool']);
  assert.deepEqual(h.s.actions.list.map(action => action.id), ['new-tool']);
});

test('restored sessions follow before a hook and keep history when the agent-started event arrives', async t => {
  const f = await fixture(t), id = '12345678-1234-1234-1234-123456789abc';
  await f.write(id, [user('Restored prompt')]);
  const h = mainHarness(t, f);
  Object.assign(h.restore, { threadId: id });
  const written = [];
  Object.assign(h.s, { ready: true, inputDirty: false, claudeAvailable: true, codexActive: false, gate: { afterPrompt: text => written.push(text) } });
  h.context.restorePlans.set('terminal', { codex: true });
  await h.context.resumeAfterPrompt(h.project, h.s);
  assert.deepEqual(written, [`claude --resume ${id}\r`]);
  assert.equal(h.s.conversation.list[0].text, 'Restored prompt');
  const tail = h.s.claudeTranscript;
  h.context.onEvent({ projectId: 'terminal', sessionKey: 'key', type: 'codex-started', agent: 'claude', cwd: f.cwd });
  await h.s.activityMonitor.poll();
  assert.equal(h.s.claudeTranscript, tail); assert.equal(h.resets(), 1); assert.equal(h.s.conversation.list[0].text, 'Restored prompt');
});

test('following a different session replaces history, and invalid ids or closed terminals cannot bind', async t => {
  const f = await fixture(t); await f.write('first', [user('first')]); await f.write('second', [user('second')]);
  const h = mainHarness(t, f);
  await h.context.followClaudeSession(h.project, h.s, 'first');
  await h.context.followClaudeSession(h.project, h.s, 'second');
  assert.deepEqual(h.s.conversation.list.map(entry => entry.text), ['second']); assert.equal(h.resets(), 2);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, '../bad'), false);
  h.s.codexActive = false;
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'first'), false);
  h.sessions.delete('terminal');
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'first'), false);
});

test('session IPC lists Codex conversations its own way and only follows active local Claude terminals', async t => {
  const f = await fixture(t); await f.write('current', [user('current')]); await f.write('other', [user('other')]);
  const h = mainHarness(t, f), handlers = {};
  h.s.claudeSessionId = 'current';
  require('../electron/features/agents/ipc.cjs').registerAgentsIpc({ handle: (name, handler) => { handlers[name] = handler; },
    findProject: () => h.project, getSession: id => h.sessions.get(id), getRestoreCwd: id => h.context.store.findTerminal(id)?.record.restore?.cwd,
    followClaudeSession: (...args) => h.context.followClaudeSession(...args), listClaudeSessions: (cwd, id) => listClaudeSessions(cwd, id, f.home),
    listCodexSessions: async (cwd, id) => [{ id: 'codex-other', cwd, current: id }] });
  assert.deepEqual((await handlers['terminal:agentSessions']('terminal')).map(item => item.id), ['other']);
  h.s.claudeSessionId = null; h.restore.threadId = 'current';
  assert.equal((await handlers['terminal:agentSessions']('terminal')).length, 2, 'an old restore id is not the current fresh session');
  assert.equal(await handlers['terminal:followAgentSession']('terminal', 'other'), true);
  h.s.agent = 'codex'; h.s.rootThreadId = 'codex-current';
  assert.deepEqual((await handlers['terminal:agentSessions']('terminal')).map(item => [item.id, item.current]), [['codex-other', 'codex-current']], 'Codex lists its own, leaving out the one it is in');
  assert.equal(await handlers['terminal:followAgentSession']('terminal', 'other'), false);
  h.s.agent = 'claude'; h.project.kind = 'ssh';
  assert.equal((await handlers['terminal:agentSessions']('terminal')).length, 0);
  assert.equal(await handlers['terminal:followAgentSession']('terminal', 'other'), false);
});
