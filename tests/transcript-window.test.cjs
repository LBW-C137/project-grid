const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HISTORY_WINDOW, LIVE_READ_LIMIT, transcriptWindow } = require('../electron/transcript-window.cjs');
const { TranscriptTail } = require('../electron/agent-actions.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');
const { records, sessionMeta } = require('../electron/session-files.cjs');

const line = value => JSON.stringify(value) + '\n';
const sizedLine = (n, size) => {
  const empty = line({ n, data: '' });
  return line({ n, data: 'x'.repeat(size - Buffer.byteLength(empty)) });
};
// The seek lands on valid JSON embedded in a cut, invalid line. It must not even be parsed.
const largeFile = (prefix, label = 'tail') => {
  const cut = line({ n: 'cut' }), rows = [];
  let remaining = HISTORY_WINDOW - Buffer.byteLength(cut);
  for (let index = 0; remaining; index++) {
    const size = Math.min(65536, remaining);
    rows.push(sizedLine(`${label}:${index}`, size)); remaining -= size;
  }
  return { text: prefix + 'old partial line ' + cut + rows.join(''), ids: rows.map((_, index) => `${label}:${index}`) };
};

test('the history window uses bytes and preserves files at or below 8 MiB', () => {
  for (const size of [0, 1, HISTORY_WINDOW]) assert.deepEqual(transcriptWindow(size), { offset: 0, skipping: false });
  assert.deepEqual(transcriptWindow(HISTORY_WINDOW + 123), { offset: 123, skipping: true });
});

for (const kind of ['Claude', 'Codex']) {
  async function fixture(t) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-window-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(path.join(home, 'sessions'));
    const id = randomUUID(), filename = path.join(home, 'sessions', `rollout-${id}.jsonl`);
    const meta = line({ type: 'session_meta', payload: { id, cwd: home, source: 'cli' } });
    const history = [], seen = [];
    const reader = kind === 'Claude' ? new TranscriptTail(filename, { onHistory: ready => history.push(ready) })
      : new CodexActivityReader(home, home, 0, { threadId: () => id, onHistory: ready => history.push(ready), onRecord: record => seen.push(record) });
    const read = () => kind === 'Claude' ? reader.read(record => seen.push(record)) : reader.read();
    return { home, id, filename, meta, history, seen, reader, read };
  }

  test(`${kind} parses only the last window, skips the cut line, and finishes history in one poll`, async t => {
    const f = await fixture(t), data = largeFile(f.meta + sizedLine('outside', 65536));
    await fs.writeFile(f.filename, data.text);
    // Prime the intentionally separate metadata lookup so all counted parses belong to history.
    if (kind === 'Codex') await sessionMeta(f.filename);
    const parse = JSON.parse, parsed = [];
    t.mock.method(JSON, 'parse', text => { parsed.push(text); return parse(text); });
    await f.read();
    assert.deepEqual(f.seen.map(record => record.n), data.ids);
    assert.equal(parsed.length, data.ids.length, 'no record before the window or cut fragment is JSON-parsed');
    assert.deepEqual(f.history, [false, true]);
    assert.equal(f.reader.historyPending, false);
    assert.equal(f.reader.offset, Buffer.byteLength(data.text));
  });

  test(`${kind} reads small files whole and bounds subsequent live growth to 4 MiB per poll`, async t => {
    const f = await fixture(t);
    await fs.writeFile(f.filename, f.meta + line({ n: 'first' }) + line({ n: 'second' }));
    await f.read();
    assert.deepEqual(f.seen.filter(record => record.n).map(record => record.n), ['first', 'second']);
    const before = f.reader.offset;
    const append = Array.from({ length: 80 }, (_, index) => sizedLine(`live:${index}`, 65536)).join('');
    await fs.appendFile(f.filename, append);
    const snapshot = await f.read();
    if (kind === 'Codex') assert.equal(snapshot, null, 'publish state only after catching up');
    assert.equal(f.reader.offset - before, LIVE_READ_LIMIT);
    assert.equal(f.seen.filter(record => record.n?.startsWith('live:')).length, 64);
    assert.deepEqual(f.history, [false, true]);
    await f.read();
    assert.equal(f.seen.filter(record => record.n?.startsWith('live:')).length, 80);
    assert.equal(f.reader.offset, before + Buffer.byteLength(append));
  });

  test(`${kind} starts a fresh window on truncation and on same-path rotation to a larger file`, async t => {
    const f = await fixture(t), initial = largeFile(f.meta + sizedLine('old', 3 * 1024 * 1024), 'initial');
    await fs.writeFile(f.filename, initial.text); await f.read();
    const truncated = largeFile(f.meta, 'truncated');
    await fs.writeFile(f.filename, truncated.text); f.seen.length = 0; await f.read();
    assert.deepEqual(f.seen.map(record => record.n), truncated.ids);
    assert.deepEqual(f.history, [false, true, false, true]);
    await fs.rename(f.filename, `${f.filename}.old`);
    const rotated = largeFile(f.meta + sizedLine('excluded', 4 * 1024 * 1024), 'rotated');
    await fs.writeFile(f.filename, rotated.text); f.seen.length = 0; await f.read();
    assert.deepEqual(f.seen.map(record => record.n), rotated.ids);
    assert.deepEqual(f.history, [false, true, false, true, false, true]);
  });
}

test('session records opt into the same window while sessionMeta still reads the first record', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-record-window-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'rollout.jsonl'), meta = { id: randomUUID(), cwd: folder, source: 'cli' };
  const data = largeFile(line({ type: 'session_meta', payload: meta }));
  await fs.writeFile(file, data.text);
  const seen = [];
  for await (const record of records(file, { historyWindow: true })) seen.push(record.n);
  assert.deepEqual(seen, data.ids);
  assert.deepEqual(await sessionMeta(file), meta);
});
