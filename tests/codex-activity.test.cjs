const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CodexActivityReader, monitorActivity } = require('../electron/codex-activity.cjs');
const { TerminalTitleTracker } = require('../electron/terminal-title.cjs');
const { HISTORY_WINDOW } = require('../electron/transcript-window.cjs');
const line = value => JSON.stringify(value) + '\n';
const event = (type, turn) => line({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } });

test('two terminals in the same folder bind to different Codex session titles', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-two-sessions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) await fs.writeFile(path.join(home, 'sessions', `rollout-${id}.jsonl`), line({ type: 'session_meta', payload: { id, cwd: home, source: 'cli' } }) + event('task_started', id) + (index ? event('task_complete', id) : ''));
  const left = new CodexActivityReader(home, home, Date.now(), { threadId: () => ids[0], requireBinding: () => true });
  const right = new CodexActivityReader(home, home, Date.now(), { threadId: () => ids[1], requireBinding: () => true });
  assert.equal((await left.read()).state, 'working');
  assert.equal((await right.read()).state, 'complete');
  const unbound = new CodexActivityReader(home, home, Date.now(), { requireBinding: () => true });
  assert.equal(await unbound.read(), null);
  const titles = new TerminalTitleTracker();
  assert.deepEqual(titles.write('\x1b]0;' + ids[0].slice(0, 15)), []);
  assert.deepEqual(titles.write(ids[0].slice(15) + '\x07' + 'output'.repeat(20000)), [ids[0]]);
  assert.deepEqual(titles.write('\x1b]2;' + ids[1] + '\x1b\\'), [ids[1]]);
  assert.deepEqual(titles.write('normal output ' + ids[0]), []);
});

test('a child completion and stale turn never complete the interactive parent', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-activity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'sessions'); await fs.mkdir(directory);
  const thread = randomUUID(), child = randomUUID();
  const file = path.join(directory, `rollout-${thread}.jsonl`);
  await fs.writeFile(file, line({ type: 'session_meta', payload: { id: thread, cwd: home, source: 'cli' } }) + event('task_started', 'parent-turn'));
  await fs.writeFile(path.join(directory, `rollout-${child}.jsonl`), line({ type: 'session_meta', payload: { id: child, cwd: home, source: { subagent: 'parent' } } }) + event('task_started', 'child-turn') + event('task_complete', 'child-turn'));
  const reader = new CodexActivityReader(home, home, Date.now() - 1000);
  assert.equal((await reader.read()).state, 'working');
  assert.equal(reader.snapshot.threadId, thread);
  const offset = reader.offset;
  await reader.read(); assert.equal(reader.offset, offset, 'idle polling does not reread history');
  await fs.appendFile(file, event('task_complete', 'older-turn'));
  assert.equal((await reader.read()).state, 'working');
  const completion = event('task_complete', 'parent-turn');
  await fs.appendFile(file, completion.slice(0, -1));
  assert.equal((await reader.read()).state, 'working', 'a partial record is not a completion');
  await fs.appendFile(file, '\n');
  assert.equal((await reader.read()).state, 'complete');
  await fs.appendFile(file, event('task_started', 'next-turn') + event('turn_aborted', 'next-turn'));
  assert.equal((await reader.read()).state, 'interrupted');
});

test('oversized output remains bounded and cannot hide later lifecycle events', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-large-activity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const thread = randomUUID(), file = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  await fs.writeFile(file, line({ type: 'session_meta', payload: { id: thread, cwd: home, source: 'cli' } }) + event('task_started', 'turn') + line({ type: 'response_item', payload: 'x'.repeat(5 * 1024 * 1024) }) + event('task_complete', 'turn'));
  const reader = new CodexActivityReader(home, home, Date.now());
  assert.equal((await reader.read()).state, 'complete', 'initial history catches up in one poll');
  assert.ok(reader.buffer.length <= 1024 * 1024);
});

test('monitor coalesces slow reads, deduplicates snapshots, and cancels late responses', async () => {
  let resolve, reads = 0, changed = 0;
  const monitor = monitorActivity(() => { reads++; return new Promise(done => { resolve = done; }); }, () => changed++, { interval: 10000 });
  const first = monitor.poll(), second = monitor.poll();
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(reads, 1);
  resolve({ state: 'working' }); await first; assert.equal(changed, 1);
  const third = monitor.poll(); await Promise.resolve();
  resolve({ state: 'working' }); await third; assert.equal(changed, 1);
  const late = monitor.poll(); await Promise.resolve(); monitor.stop();
  resolve({ state: 'complete' }); await late;
  assert.equal(changed, 1);
  await monitor.poll(); assert.equal(reads, 3);
});

test('a single-poll Codex history publishes only its final conversation snapshot', async t => {
  const { ConversationLog, codexConversation } = require('../electron/conversation.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-reading-codex-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const thread = randomUUID(), file = path.join(home, 'sessions', `rollout-${thread}.jsonl`), published = [];
  const log = new ConversationLog(change => { if (!log.loading) published.push(change); });
  const message = (id, text) => line({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'item_completed', item: { type: 'AgentMessage', id, content: [{ text }] } } });
  await fs.writeFile(file, line({ type: 'session_meta', payload: { id: thread, cwd: home, source: 'cli' } }) + Array.from({ length: 100 }, (_, index) => message(String(index), 'x'.repeat(60000))).join(''));
  const reader = new CodexActivityReader(home, home, Date.now(), {
    threadId: () => thread,
    onHistory: ready => ready ? log.endHistory() : log.beginHistory(),
    onRecord: record => {
      codexConversation(log, record, home);
      assert.deepEqual(log.snapshot(), [], 'history remains private while records are processed');
      assert.deepEqual(published, []);
    },
  });
  await reader.read();
  assert.equal(log.snapshot().length, 100);
  assert.deepEqual(published, [{ reset: true }]);
  reader.options.onRecord = record => codexConversation(log, record, home);
  await fs.appendFile(file, message('live', 'new answer')); await reader.read();
  assert.equal(published.length, 2); assert.equal(published[1].entry.id, 'a:live');
  await reader.read(); assert.equal(published.length, 2);
});

test('a turn started before the window stays unknown despite later activity and completion records', async t => {
  const { ActionLog, codexRecord } = require('../electron/agent-actions.cjs');
  const { ConversationLog, codexConversation } = require('../electron/conversation.cjs');
  const { codexReply } = require('../electron/round-summary.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-cut-turn-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const thread = randomUUID(), file = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  const actions = new ActionLog(), conversation = new ConversationLog(), replies = [];
  const item = payload => line({ type: 'response_item', payload });
  await fs.writeFile(file, line({ type: 'session_meta', payload: { id: thread, cwd: home, source: 'cli' } })
    + event('task_started', 'cut-turn')
    + line({ type: 'event_msg', payload: { type: 'user_message', message: 'excluded prompt' } })
    + item({ type: 'function_call', name: 'exec_command', call_id: 'excluded', arguments: '{"cmd":"old"}' })
    + item({ type: 'function_call_output', output: 'x'.repeat(HISTORY_WINDOW + 1000) })
    + item({ type: 'function_call_output', call_id: 'excluded', output: 'done' })
    + line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Window answer' } })
    + event('task_complete', 'cut-turn'));
  const reader = new CodexActivityReader(home, home, 0, {
    threadId: () => thread,
    onRecord: record => { codexRecord(actions, record, home); codexConversation(conversation, record, home); replies.push(codexReply(record)); },
  });
  const snapshot = await reader.read();
  assert.equal(snapshot.state, 'unknown'); assert.equal(snapshot.turnId, null); assert.equal(snapshot.updatedAt, 0);
  assert.equal(snapshot.prompt, undefined, 'a prompt outside the window is not recovered');
  assert.deepEqual(actions.list, [], 'orphan results do not invent actions');
  assert.deepEqual(conversation.list.map(entry => entry.text), ['Window answer']);
  assert.ok(replies.every(reply => reply === null));
  await fs.appendFile(file, line({ type: 'event_msg', payload: { type: 'user_message', message: 'New prompt' } })
    + event('task_started', 'live-turn')
    + item({ type: 'function_call', name: 'exec_command', call_id: 'live', arguments: '{"cmd":"npm test"}' })
    + item({ type: 'function_call_output', call_id: 'live', output: 'done' }));
  const live = await reader.read();
  assert.equal(live.state, 'working'); assert.equal(live.prompt, 'New prompt');
  assert.equal(actions.list.length, 1); assert.equal(actions.current().done, true);
  assert.equal(conversation.list.at(-1).tool.done, true);
  await fs.appendFile(file, event('task_complete', 'live-turn'));
  assert.equal((await reader.read()).state, 'complete');
  // Truncation must forget the previous turn and its prompt even if the replacement has no start.
  await fs.writeFile(file, event('task_complete', 'live-turn'));
  const truncated = await reader.read();
  assert.equal(truncated.state, 'unknown'); assert.equal(truncated.prompt, undefined);
});

test('binding another Codex thread starts its own window without carrying an earlier turn or buffer', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-window-rebind-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const ids = [randomUUID(), randomUUID()], files = ids.map(id => path.join(home, 'sessions', `rollout-${id}.jsonl`));
  const meta = id => line({ type: 'session_meta', payload: { id, cwd: home, source: 'cli' } });
  await fs.writeFile(files[0], meta(ids[0]) + event('task_started', 'first') + '{"partial":');
  await fs.writeFile(files[1], meta(ids[1]) + event('task_started', 'excluded')
    + line({ padding: 'x'.repeat(HISTORY_WINDOW + 1000) }) + event('task_complete', 'excluded'));
  let bound = ids[0]; const history = [], seen = [];
  const reader = new CodexActivityReader(home, home, 0, { threadId: () => bound, onHistory: ready => history.push(ready), onRecord: record => seen.push(record) });
  assert.equal((await reader.read()).state, 'working'); assert.ok(reader.buffer.length);
  bound = ids[1]; seen.length = 0;
  const snapshot = await reader.read();
  assert.equal(snapshot.threadId, ids[1]); assert.equal(snapshot.state, 'unknown'); assert.equal(snapshot.turnId, null);
  assert.equal(reader.buffer.length, 0); assert.deepEqual(seen.map(record => record.payload.type), ['task_complete']);
  assert.deepEqual(history, [false, true, false, true]);
});
