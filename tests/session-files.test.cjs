const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { rolloutFiles, sessionMeta } = require('../electron/session-files.cjs');

const names = async directory => (await rolloutFiles(directory)).map(file => file.name).sort();
// Watcher events arrive shortly after the write that caused them.
async function eventually(read, expected, deadline = 5000) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    try { assert.deepEqual(value, expected); return; }
    catch (error) { if (Date.now() - started > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('the shared listing follows new, changed and removed session files', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-session-files-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'sessions'), day = path.join(directory, '2026', '10', '02');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, 'rollout-first.jsonl'), '{}\n');
  await fs.writeFile(path.join(day, 'notes.txt'), 'not a session');
  assert.deepEqual(await names(directory), ['rollout-first.jsonl']);
  const [first, again] = [rolloutFiles(directory), rolloutFiles(directory)];
  assert.equal(first, again, 'terminals asking at the same time share one read');
  await first;

  const next = path.join(directory, '2026', '10', '03');
  await fs.mkdir(next);
  await fs.writeFile(path.join(next, 'rollout-second.jsonl'), '{}\n');
  await eventually(() => names(directory), ['rollout-first.jsonl', 'rollout-second.jsonl']);

  const later = new Date(Date.now() + 60000);
  await fs.utimes(path.join(day, 'rollout-first.jsonl'), later, later);
  await eventually(async () => (await rolloutFiles(directory)).find(file => file.name === 'rollout-first.jsonl').modified >= later.getTime() - 1000, true);

  await fs.rm(path.join(next, 'rollout-second.jsonl'));
  await eventually(() => names(directory), ['rollout-first.jsonl']);
});

test('deleting the sessions folder ends its watcher, and a new folder is picked up again', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-session-files-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'sessions');
  assert.deepEqual(await names(directory), [], 'a missing folder lists nothing');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'rollout-one.jsonl'), '{}\n');
  await eventually(() => names(directory), ['rollout-one.jsonl']);
  await fs.rm(directory, { recursive: true });
  await eventually(() => names(directory), []);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'rollout-two.jsonl'), '{}\n');
  await eventually(() => names(directory), ['rollout-two.jsonl']);
});

test('the first record of a session file is read once and an empty file is asked again', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-session-meta-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'rollout-meta.jsonl'), other = path.join(home, 'rollout-other.jsonl');
  await fs.writeFile(file, '');
  assert.equal(await sessionMeta(file), null);
  await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'thread', cwd: home, source: 'cli', instructions: 'long text' } }) + '\n');
  assert.deepEqual(await sessionMeta(file), { id: 'thread', cwd: home, source: 'cli' });
  await fs.rm(file);
  assert.deepEqual(await sessionMeta(file), { id: 'thread', cwd: home, source: 'cli' }, 'answered from memory');
  await fs.writeFile(other, JSON.stringify({ type: 'event_msg', payload: {} }) + '\n');
  assert.equal(await sessionMeta(other), null);
});
