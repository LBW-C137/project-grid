const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileOperations, cleanName, selections } = require('../electron/file-operations.cjs');

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-file-ops-');
  const directory = await fs.mkdtemp(prefix);
  const project = { id: 'test-project', kind: 'local', path: path.join(directory, 'project') };
  await fs.mkdir(project.path); await fs.mkdir(path.join(directory, 'trash')); await fs.mkdir(path.join(directory, 'outside'));
  let clipboard = []; let confirm = true;
  const service = new FileOperations({ integrationDir: path.resolve(__dirname, '../integration'), cacheRoot: path.join(directory, 'cache'),
    clipboard: async (action, paths) => action === 'copy' ? (clipboard = paths) : clipboard,
    trash: filename => fs.rename(filename, path.join(directory, 'trash', path.basename(filename))), confirmDelete: async () => confirm,
  });
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(prefix)); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, project, service, getClipboard: () => clipboard, setClipboard: paths => { clipboard = paths; }, confirm: value => { confirm = value; } };
}

test('file creation and rename preserve existing content and accept Chinese names', async t => {
  const { project, service } = await fixture(t);
  assert.deepEqual(await service.create(project, '', '素材', 'directory'), { path: '素材', kind: 'directory' });
  await service.create(project, '素材', '说明.txt', 'file');
  await fs.writeFile(path.join(project.path, '素材/说明.txt'), '保留内容');
  await assert.rejects(service.create(project, '素材', '说明.txt', 'file'));
  await service.rename(project, '素材/说明.txt', '说明 新版.txt');
  assert.equal(await fs.readFile(path.join(project.path, '素材/说明 新版.txt'), 'utf8'), '保留内容');
  await service.create(project, '素材', 'existing.txt', 'file');
  await assert.rejects(service.rename(project, '素材/说明 新版.txt', 'existing.txt'), /已存在/);
  assert.equal(await fs.readFile(path.join(project.path, '素材/说明 新版.txt'), 'utf8'), '保留内容');
  for (const name of ['..', '../outside', 'name.', 'name ', 'CON', 'bad:name', 'bad\0name']) assert.throws(() => cleanName(name));
});

test('file clipboard copy uses actual files; paste chooses a fresh name and keeps source data', async t => {
  const { project, service, getClipboard } = await fixture(t);
  await fs.writeFile(path.join(project.path, '报告.txt'), 'COPY CONTENT');
  await service.copy(project, ['报告.txt']);
  assert.deepEqual(getClipboard(), [await fs.realpath(path.join(project.path, '报告.txt'))]);
  const result = await service.paste(project, '');
  assert.deepEqual(result.pasted, ['报告 - 副本.txt']);
  assert.equal(await fs.readFile(path.join(project.path, '报告 - 副本.txt'), 'utf8'), 'COPY CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, '报告.txt'), 'utf8'), 'COPY CONTENT');
  const next = await service.paste(project, '');
  assert.deepEqual(next.pasted, ['报告 - 副本 (2).txt']);
});

test('folder paste is recursive and cannot copy a folder into itself', async t => {
  const { directory, project, service, setClipboard } = await fixture(t);
  const source = path.join(directory, 'outside', '素材'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'image.bin'), Buffer.alloc(1024 * 1024 + 17, 7));
  setClipboard([source]); await service.paste(project, '');
  assert.deepEqual(await fs.readFile(path.join(project.path, '素材/image.bin')), await fs.readFile(path.join(source, 'image.bin')));
  setClipboard([path.join(project.path, '素材')]);
  await assert.rejects(service.paste(project, '素材'), /自身内部/);
  assert.deepEqual(selections(['folder', 'folder/a.txt', 'file.txt']), ['folder', 'file.txt']);
});

test('delete honors cancellation, uses the trash callback and protects the project root', async t => {
  const { project, service, directory, confirm } = await fixture(t);
  await fs.writeFile(path.join(project.path, 'delete.txt'), 'RECOVERABLE');
  confirm(false); assert.deepEqual(await service.remove(project, ['delete.txt']), { deleted: [] });
  assert.equal(await fs.readFile(path.join(project.path, 'delete.txt'), 'utf8'), 'RECOVERABLE');
  confirm(true); await service.remove(project, ['delete.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'trash/delete.txt'), 'utf8'), 'RECOVERABLE');
  await assert.rejects(service.remove(project, ['']));
  await assert.rejects(service.remove(project, ['../outside']));
});

test('mutations reject escaping links and deleting a link preserves its target', async t => {
  const { project, service, directory } = await fixture(t);
  const outside = path.join(directory, 'outside'); await fs.writeFile(path.join(outside, 'keep.txt'), 'KEEP');
  await fs.symlink(outside, path.join(project.path, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.create(project, 'external', 'new.txt', 'file'), /项目/);
  await assert.rejects(service.rename(project, 'external/keep.txt', 'renamed.txt'), /项目/);
  await service.remove(project, ['external']);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'KEEP');
});

function remoteFiles(service, entries, onRead = () => {}) {
  service.remote = () => ({ ready: Promise.resolve(), info: { root: '/srv/project' }, request: async (op, args) => {
    const entry = entries[args.path];
    if (!entry) throw new Error(`Missing fixture: ${args.path}`);
    if (op === 'stat') return { size: typeof entry === 'string' ? Buffer.byteLength(entry) : 0,
      file: typeof entry === 'string', directory: Array.isArray(entry), link: entry.link === true };
    if (op === 'read') {
      await onRead(args.path);
      return Buffer.from(entry).subarray(args.offset, args.offset + args.length).toString('base64');
    }
    if (op === 'directory') return { entries: entry.map(name => ({ name, path: `${args.path}/${name}`, kind: entries[`${args.path}/${name}`]?.link === true ? 'link' : 'file' })), nextOffset: null };
    throw new Error(`Unexpected request: ${op}`);
  } });
}

test('SSH copy isolates equal basenames, preserves folder contents and pastes both selections under their actual names', async t => {
  const { project, service, getClipboard } = await fixture(t);
  service.move = fs.rename;
  remoteFiles(service, { 'a/index.ts': 'A', 'b/index.ts': 'B',
    'left/assets': ['child.txt'], 'left/assets/child.txt': 'LEFT',
    'right/assets': ['child.txt'], 'right/assets/child.txt': 'RIGHT' });
  const result = await service.copy({ id: 'remote', kind: 'ssh' }, ['a/index.ts', 'b/index.ts', 'left/assets', 'right/assets', 'left/assets/child.txt']);
  assert.deepEqual(result, { count: 4 });
  const files = getClipboard();
  assert.deepEqual(files.map(file => path.basename(file)), ['index.ts', 'index.ts', 'assets', 'assets']);
  assert.equal(new Set(files.map(file => path.dirname(file))).size, 4);
  assert.equal(await fs.readFile(files[0], 'utf8'), 'A'); assert.equal(await fs.readFile(files[1], 'utf8'), 'B');
  assert.equal(await fs.readFile(path.join(files[2], 'child.txt'), 'utf8'), 'LEFT');
  assert.equal(await fs.readFile(path.join(files[3], 'child.txt'), 'utf8'), 'RIGHT');
  const pasted = await service.paste(project, '');
  assert.deepEqual(pasted.pasted, ['index.ts', 'index - 副本.ts', 'assets', 'assets - 副本']);
  assert.equal(await fs.readFile(path.join(project.path, 'index.ts'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(project.path, 'index - 副本.ts'), 'utf8'), 'B');
  assert.equal(await fs.readFile(path.join(project.path, 'assets/child.txt'), 'utf8'), 'LEFT');
  assert.equal(await fs.readFile(path.join(project.path, 'assets - 副本/child.txt'), 'utf8'), 'RIGHT');
});

test('SSH copy removes the full staging batch on failure, cancellation, supersession and clipboard failure', async t => {
  for (const failure of ['read', 'cancel', 'superseded', 'clipboard', 'link', 'nested-link']) {
    const { service } = await fixture(t);
    let clipboardCalls = 0;
    service.clipboard = async () => { clipboardCalls++; if (failure === 'clipboard') throw new Error('clipboard unavailable'); };
    remoteFiles(service, { 'a/index.ts': 'A', 'b/index.ts': failure === 'link' ? { link: true } : 'B',
      folder: ['link'], 'folder/link': { link: true } }, async relative => {
      if (relative !== 'b/index.ts') return;
      if (failure === 'read') throw new Error('transfer failed');
      if (failure === 'cancel') service.cancel(); // even after the last chunk, before clipboard commit
      if (failure === 'superseded') service.clipboardWrites.reserve(); // newer text/image copy intent
    });
    const copying = service.copy({ id: 'remote', kind: 'ssh' }, ['a/index.ts', failure === 'nested-link' ? 'folder' : 'b/index.ts']);
    if (failure === 'superseded') assert.deepEqual(await copying, { count: 0, superseded: true });
    else await assert.rejects(copying, /transfer failed|取消|clipboard unavailable|链接/);
    assert.equal(clipboardCalls, failure === 'clipboard' ? 1 : 0, failure);
    assert.deepEqual(await fs.readdir(service.cacheRoot), [], failure);
    assert.equal(service.busy, null);
  }
});
