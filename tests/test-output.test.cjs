const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const helpers = import('../scripts/test-output.mjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-test-output-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const output = path.join(root, '.test-output');
  await fs.mkdir(output);
  const folder = async (name, content = '') => {
    const target = path.join(output, name);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'payload'), content);
    return target;
  };
  const names = async () => (await fs.readdir(output)).sort();
  return { root, output, folder, names };
}

test('testRun keeps the newest N timestamps of exactly its family, ignoring files and other names', async t => {
  const { testRun } = await helpers;
  const { root, output, folder, names } = await fixture(t);
  for (const name of ['navigation-9', 'navigation-100', 'navigation-20', 'navigation-extra-1', 'other-1', 'navigation-old']) await folder(name);
  // Make the oldest timestamp have the newest mtime: names determine retention.
  await fs.utimes(path.join(output, 'navigation-9'), new Date(), new Date());
  await fs.writeFile(path.join(output, 'navigation-200'), 'single file');
  t.mock.method(Date, 'now', () => 300);
  const result = await testRun('navigation', { root, keep: 2 });
  assert.equal(result, path.join(output, 'navigation-300'));
  assert.ok((await fs.stat(result)).isDirectory());
  assert.deepEqual(await names(), ['navigation-100', 'navigation-200', 'navigation-300', 'navigation-extra-1', 'navigation-old', 'other-1']);
});

test('testRun defaults to three runs and creates fresh folders even within the same millisecond', async t => {
  const { testRun } = await helpers;
  const { root, names } = await fixture(t);
  t.mock.method(Date, 'now', () => 100);
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await testRun('linux-bash', { root }));
  assert.equal(new Set(runs).size, 5);
  assert.deepEqual(await names(), ['linux-bash-102', 'linux-bash-103', 'linux-bash-104']);
});

test('testRun treats punctuation in family names literally', async t => {
  const { testRun } = await helpers;
  const { root, folder, names } = await fixture(t);
  await folder('smoke.+-1'); await folder('smoke-other-1');
  t.mock.method(Date, 'now', () => 100);
  await testRun('smoke.+', { root, keep: 1 });
  assert.deepEqual(await names(), ['smoke-other-1', 'smoke.+-100']);
});

test('a locked old profile is best effort and does not prevent other deletions or the new run', async t => {
  const { testRun } = await helpers;
  const { root, folder, names } = await fixture(t);
  const locked = await folder('navigation-1');
  await folder('navigation-2');
  const rm = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target === locked) {
      assert.deepEqual(options, { recursive: true, force: true, maxRetries: 3 });
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    }
    return rm(target, options);
  });
  t.mock.method(Date, 'now', () => 100);
  await testRun('navigation', { root, keep: 1 });
  assert.deepEqual(await names(), ['navigation-1', 'navigation-100']);
});

test('cleanup survives a folder disappearing between discovery and deletion', async t => {
  const { pruneTestOutput } = await helpers;
  const { root, folder, names } = await fixture(t);
  const missing = await folder('smoke-1');
  await folder('smoke-2'); await folder('smoke-3');
  const rm = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target === missing) {
      await rm(target, options);
      throw Object.assign(new Error('already gone'), { code: 'ENOENT' });
    }
    return rm(target, options);
  });
  const result = await pruneTestOutput({ root, keep: 1 });
  assert.equal(result.removed.length, 1);
  assert.deepEqual(await names(), ['smoke-3']);
});

test('default pruning keeps three newest runs of every family and reports removed file bytes', async t => {
  const { pruneTestOutput } = await helpers;
  const { root, output, folder, names } = await fixture(t);
  for (const family of ['desktop', 'linux-zsh']) {
    for (const timestamp of [2, 9, 10, 100]) await folder(`${family}-${timestamp}`, '12345');
  }
  await folder('manual'); await fs.writeFile(path.join(output, 'desktop-1'), 'keep');
  const result = await pruneTestOutput({ root });
  assert.deepEqual(result.removed.map(entry => path.basename(entry.path)).sort(), ['desktop-2', 'linux-zsh-2']);
  assert.equal(result.bytesFreed, 10);
  assert.deepEqual(await names(), ['desktop-1', 'desktop-10', 'desktop-100', 'desktop-9', 'linux-zsh-10', 'linux-zsh-100', 'linux-zsh-9', 'manual']);
});

test('age pruning uses name timestamps, preserves the cutoff and ignores non-run folders', async t => {
  const { pruneTestOutput } = await helpers;
  const { root, folder, names } = await fixture(t);
  t.mock.method(Date, 'now', () => 3 * 86400000);
  for (const name of ['desktop-1', `desktop-${86400000}`, `desktop-${2 * 86400000}`, 'manual']) await folder(name);
  await pruneTestOutput({ root, olderThanDays: 2 });
  assert.deepEqual(await names(), [`desktop-${2 * 86400000}`, `desktop-${86400000}`, 'manual']);
});

test('--all semantics remove every real folder, preserve files and never follow links outside the output', async t => {
  const { pruneTestOutput } = await helpers;
  const { root, output, folder, names } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'untouched'), 'outside');
  const run = await folder('desktop-1', '123');
  await fs.symlink(outside, path.join(run, 'nested-link'), 'junction');
  await fs.symlink(outside, path.join(output, 'linked-1'), 'junction');
  await folder('manual-folder', '12345');
  await fs.writeFile(path.join(output, 'dev-empty.png'), 'single file');
  const result = await pruneTestOutput({ root, all: true });
  assert.equal(result.removed.length, 2);
  assert.equal(result.bytesFreed, 8);
  assert.deepEqual(await names(), ['dev-empty.png', 'linked-1']);
  assert.equal(await fs.readFile(path.join(outside, 'untouched'), 'utf8'), 'outside');
});

test('missing output is a no-op; testRun creates it', async t => {
  const { testRun, pruneTestOutput } = await helpers;
  const { root, output } = await fixture(t);
  await fs.rmdir(output);
  assert.deepEqual(await pruneTestOutput({ root, all: true }), { removed: [], bytesFreed: 0 });
  assert.ok((await fs.stat(await testRun('new', { root }))).isDirectory());
});

test('helpers reject traversal and a linked .test-output directory', async t => {
  const { testRun, pruneTestOutput } = await helpers;
  const { root, output } = await fixture(t);
  for (const name of ['../outside', '..', 'nested/name', 'nested\\name', 'C:outside', '']) {
    await assert.rejects(testRun(name, { root }), /single folder name/);
  }
  await assert.rejects(testRun('smoke', { root, keep: 0 }), /positive integer/);
  await assert.rejects(pruneTestOutput({ root, olderThanDays: -1 }), /non-negative/);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside); await fs.mkdir(path.join(outside, 'smoke-1'));
  await fs.rmdir(output); await fs.symlink(outside, output, 'junction');
  await assert.rejects(pruneTestOutput({ root, all: true }), /real directory/);
  await assert.rejects(testRun('smoke', { root }), /real directory/);
  assert.deepEqual(await fs.readdir(outside), ['smoke-1']);
});

test('cleanup CLI defaults to three runs, implements --all and prints removals and freed space', async t => {
  const { root, output, folder, names } = await fixture(t);
  const scripts = path.join(root, 'scripts');
  await fs.mkdir(scripts);
  for (const name of ['test-output.mjs', 'clean-test-output.mjs']) {
    await fs.copyFile(path.join(__dirname, '../scripts', name), path.join(scripts, name));
  }
  for (const timestamp of [1, 2, 3, 4]) await folder(`navigation-${timestamp}`, '1234');
  await folder('manual', '1234');
  await fs.writeFile(path.join(output, 'dev-empty.png'), 'keep');
  const cli = path.join(scripts, 'clean-test-output.mjs');
  const run = args => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const regular = run([]);
  assert.match(regular, /Removed .*navigation-1 \(4 bytes\)/);
  assert.match(regular, /Removed 1 folder\(s\); freed 4 bytes/);
  assert.deepEqual(await names(), ['dev-empty.png', 'manual', 'navigation-2', 'navigation-3', 'navigation-4']);
  assert.match(run(['--all']), /Removed 4 folder\(s\); freed 16 bytes/);
  assert.deepEqual(await names(), ['dev-empty.png']);
});
