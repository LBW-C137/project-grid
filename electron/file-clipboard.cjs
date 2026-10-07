const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

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

function fileClipboard(integrationDir, action, paths) {
  if (process.platform === 'darwin') return macFileClipboard(action, paths);
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
module.exports = { fileClipboard };
