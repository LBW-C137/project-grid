const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');

// macOS: the general pasteboard through JavaScript for Automation, which every Mac has. Copy writes file URLs,
// the form Finder pastes; read gives the paths of the file URLs on it (Finder's Copy), or none.
const MAC_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  if (argv[0] === 'copy') {
    const urls = $.NSMutableArray.array;
    argv.slice(1).forEach(file => urls.addObject($.NSURL.fileURLWithPath(file)));
    pasteboard.clearContents;
    if (!pasteboard.writeObjects(urls)) throw new Error('The pasteboard refused the files.');
    return JSON.stringify({ count: Number(urls.count) });
  }
  const options = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
  const found = pasteboard.readObjectsForClassesOptions($([$.NSURL]), options), files = [];
  if (found && !found.isNil()) for (let index = 0; index < found.count; index++) files.push(ObjC.unwrap(found.objectAtIndex(index).path));
  return JSON.stringify(files);
}`;
function macFileClipboard(action, paths) {
  if (!['copy', 'read'].includes(action)) return Promise.reject(new Error('无法访问文件剪贴板。'));
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT, action, ...(action === 'copy' ? paths : [])], { timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, output) => {
      if (error) { reject(new Error(error.killed ? '剪贴板暂时不可用，请重试。' : '无法访问文件剪贴板。')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('文件剪贴板返回了无效数据。')); }
    });
  });
}

// Linux: file managers (Files, Dolphin, Thunar, Nemo, Caja) copy files as text/uri-list and GNOME's
// x-special/gnome-copied-files. Copy writes both through Electron. Read asks wl-paste or xclip where one is
// installed, and Electron's own clipboard otherwise.
const rawFormat = format => `electron application/osclipboard;format="${format}"`;
const FILE_FORMATS = ['text/uri-list', 'x-special/gnome-copied-files'];
// The local paths in a uri-list or a gnome-copied-files list; the latter starts with "copy" or "cut".
function parseFileList(text) {
  const files = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('file://')) continue;
    try { files.push(fileURLToPath(line.trim(), { windows: false })); } catch { }
  }
  return files;
}
// A tool's output; '' when it fails (an empty clipboard), null when it is not installed.
function run(file, args, timeout = 5000) {
  return new Promise(resolve => {
    try { execFile(file, args, { timeout, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (error, output) => resolve(error ? error.code === 'ENOENT' ? null : '' : output)); }
    catch { resolve(null); }
  });
}
async function readFileList({ env = process.env, runTool = run, electron = () => require('electron') } = {}) {
  const tools = [
    env.WAYLAND_DISPLAY && { list: ['wl-paste', ['--list-types']], read: format => ['wl-paste', ['--no-newline', '--type', format]] },
    env.DISPLAY && { list: ['xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']], read: format => ['xclip', ['-selection', 'clipboard', '-t', format, '-o']] },
  ].filter(Boolean);
  for (const tool of tools) {
    const types = await runTool(...tool.list);
    if (types === null) continue;
    const format = FILE_FORMATS.find(name => types.split(/\r?\n/).includes(name));
    return format ? parseFileList(await runTool(...tool.read(format))) : [];
  }
  const { clipboard } = electron();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('剪贴板暂时不可用，请重试。')), 10000).unref?.());
  const item = (await Promise.race([clipboard.read(), timeout]))[0];
  const type = item && FILE_FORMATS.flatMap(name => [name, rawFormat(name)]).find(name => item.types.includes(name));
  return type ? parseFileList(await (await Promise.race([item.getType(type), timeout])).text()) : [];
}
async function linuxFileClipboard(action, paths, { electron = () => require('electron'), read = readFileList } = {}) {
  if (action === 'read') return read();
  if (action !== 'copy') throw new Error('无法访问文件剪贴板。');
  const { clipboard, ClipboardItem } = electron();
  const uris = paths.map(file => pathToFileURL(file, { windows: false }).href);
  await clipboard.write([new ClipboardItem({
    [rawFormat('x-special/gnome-copied-files')]: ['copy', ...uris].join('\n'),
    [rawFormat('text/uri-list')]: uris.map(uri => uri + '\r\n').join(''),
    'text/plain': paths.join('\n'),
  })]);
  return { count: paths.length };
}

function fileClipboard(integrationDir, action, paths) {
  if (process.platform === 'darwin') return macFileClipboard(action, paths);
  if (process.platform === 'linux') return linuxFileClipboard(action, paths);
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(integrationDir, 'file-clipboard.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('剪贴板暂时不可用，请重试。')); }, 10000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; if (output.length > 2 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', value => { error = (error + value).slice(-2000); });
    child.on('error', value => { clearTimeout(timer); reject(value); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code) { reject(new Error(error.trim() || '无法访问文件剪贴板。')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('文件剪贴板返回了无效数据。')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ action, paths }));
  });
}
module.exports = { fileClipboard, linuxFileClipboard, readFileList, parseFileList };
