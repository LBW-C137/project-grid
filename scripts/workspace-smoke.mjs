import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { waitFor } from './wait.mjs';
const require = createRequire(import.meta.url), exec = promisify(execFile);
const { fileClipboard } = require('../electron/file-clipboard.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `workspace-${Date.now()}`), dataDir = path.join(output, 'profile');
const project = { id: randomUUID(), name: '文件与语音', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
await fs.mkdir(project.path, { recursive: true }); await fs.mkdir(dataDir); await fs.mkdir(path.join(output, 'external'));
await fs.writeFile(path.join(project.path, 'source.txt'), 'FILE_CLIPBOARD_CONTENT');
await fs.writeFile(path.join(project.path, 'microphone-check.html'), '<button id="check">Check microphone</button><output id="result"></output><script>document.querySelector("#check").onclick=async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(track=>track.stop());document.querySelector("#result").textContent="ALLOWED"}catch{document.querySelector("#result").textContent="BLOCKED"}}</script>');
await fs.writeFile(path.join(output, 'external', 'external.txt'), 'PASTE_IN_CONTENT');
await fs.mkdir(path.join(output, 'external', '外部文件夹'));
await fs.writeFile(path.join(output, 'external', '外部文件夹', 'nested.txt'), 'NESTED_PASTE_CONTENT');
await fs.mkdir(path.join(project.path, '目标目录'));
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { notifications: false, closeToTray: false } }));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const speech = path.join(output, 'speech.wav');
try { await exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/voice-fixture.ps1'), '-Destination', speech], { windowsHide: true }); }
catch (error) {
  if (process.argv.includes('--voice-assets')) throw error;
  const { wavFromSamples } = require('../src/voice-audio.ts');
  const tone = Float32Array.from({ length: 16000 * 5 }, (_, index) => Math.sin(index * Math.PI * 880 / 16000) * .08);
  await fs.writeFile(speech, Buffer.from(wavFromSamples(tone)));
  console.log('UI-only test uses a generated tone because system speech synthesis is unavailable.');
}
const assetIndex = process.argv.indexOf('--voice-assets');
const assets = assetIndex >= 0 ? path.resolve(process.argv[assetIndex + 1]) : null;
if (assets) {
  // A folder holding the downloaded SenseVoice files, so the real recognizer runs without a download.
  const { MODEL_DIRECTORY, MODEL_FILES } = require('../electron/voice.cjs');
  await fs.mkdir(path.join(dataDir, 'voice', MODEL_DIRECTORY), { recursive: true });
  for (const file of MODEL_FILES) await fs.copyFile(path.join(assets, file.name), path.join(dataDir, 'voice', MODEL_DIRECTORY, file.name));
}
const packaged = process.argv.includes('--packaged');
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
let application, page;
async function filesFinished() { await waitFor(async () => { const result = await page.evaluate(() => window.projectGrid.getFileProgress()); return result.ok && result.value === null; }, 'all files in the paste operation finish'); }
async function backupClipboard() { await application.evaluate(async ({ clipboard, ClipboardItem }) => { globalThis.clipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); }); }
async function ownClipboard() { await application.evaluate(async ({ clipboard }) => { globalThis.clipboardOwnedText = await clipboard.readText(); }); }
async function restoreClipboard() { if (!application) return; await application.evaluate(async ({ clipboard }) => { if (globalThis.clipboardBackup && await clipboard.readText() === globalThis.clipboardOwnedText) { if (globalThis.clipboardBackup.length) await clipboard.write(globalThis.clipboardBackup); else clipboard.clear(); } globalThis.clipboardBackup = null; }).catch(() => {}); }
try {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: [...(packaged ? [] : [root]), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${speech}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  if (process.argv.includes('--slow-copy')) await application.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('project:directory');
    let delayed = false, active = 0;
    globalThis.directoryPeakRequests = 0;
    ipcMain.removeHandler('project:directory');
    ipcMain.handle('project:directory', async (event, ...args) => {
      active++; globalThis.directoryPeakRequests = Math.max(globalThis.directoryPeakRequests, active);
      try {
        if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 4200)); }
        return await handler(event, ...args);
      } finally { active--; }
    });
  });
  await application.evaluate(({ dialog, ipcMain, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    globalThis.voicePastes = [];
    ipcMain.on('terminal:write', (_event, id, data) => globalThis.voicePastes.push({ id, data }));
  });
  if (process.argv.includes('--slow-copy')) await application.evaluate((_, fixtureRoot) => {
    const filesystem = process.mainModule.require('node:fs/promises');
    const copy = filesystem.cp;
    filesystem.cp = async (source, ...rest) => {
      if (String(source).startsWith(fixtureRoot) && String(source).endsWith('外部文件夹')) await new Promise(resolve => setTimeout(resolve, 700));
      return copy(source, ...rest);
    };
  }, output);
  if (!assets) await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('voice:state'); ipcMain.handle('voice:state', () => ({ ok: true, value: { phase: 'ready', ready: true, percent: 100, model: 'test stub', error: null } }));
    ipcMain.removeHandler('voice:transcribe'); ipcMain.handle('voice:transcribe', (_event, audio) => { if (audio.byteLength < 16000) return { ok: false, error: 'Missing recorded microphone samples' }; return { ok: true, value: 'Please open the project folder and continue the task.' }; });
  });
  await page.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0].shellReady, 'terminal ready');
  await page.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click();
  await page.getByRole('treeitem', { name: 'source.txt', exact: true }).waitFor();
  if (process.argv.includes('--slow-copy')) {
    assert.equal(await application.evaluate(() => globalThis.directoryPeakRequests), 1, 'automatic refresh must not overlap or discard a slow directory read');
    console.log('PASS: a directory read slower than the refresh interval still renders, with one request in flight');
  }
  // The project name appears once, as the sidebar title, never again as a root row of the tree.
  assert.equal(await page.locator('.explorer-title h2').innerText(), project.name);
  assert.equal(await page.getByRole('treeitem', { name: project.name, exact: true }).count(), 0);
  assert.equal(await page.locator('.explorer-path').getAttribute('title'), project.path);
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByLabel('文件或文件夹名称', { exact: true }).fill('新文件.txt'); await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('treeitem', { name: '新文件.txt', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, '新文件.txt'), 'utf8'), '');
  await page.getByRole('treeitem', { name: '新文件.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^重命名/ }).click();
  const renameDialog = page.locator('dialog.file-edit-dialog[open]');
  await renameDialog.getByLabel('文件或文件夹名称', { exact: true }).fill('renamed.txt'); await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('treeitem', { name: 'renamed.txt', exact: true }).waitFor();
  await backupClipboard();
  await page.getByRole('treeitem', { name: 'source.txt', exact: true }).click(); await page.keyboard.press('Control+c');
  const copied = await fs.realpath(path.join(project.path, 'source.txt'));
  await waitFor(async () => { const entries = await fileClipboard(path.join(root, 'integration'), 'read'); return entries.length === 1 && entries[0] === copied; }, 'native Windows file clipboard');
  await ownClipboard();
  await exec(powershell, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/paste-files-fixture.ps1'), '-Destination', path.join(output, 'external'), '-Expected', copied], { windowsHide: true });
  await waitFor(async () => { try { return await fs.readFile(path.join(output, 'external/source.txt'), 'utf8') === 'FILE_CLIPBOARD_CONTENT'; } catch { return false; } }, 'Explorer pastes the copied file outside the project');
  await fileClipboard(path.join(root, 'integration'), 'copy', [path.join(output, 'external/external.txt')]); await ownClipboard();
  // Blank space below the files selects the project root, the destination for a root paste.
  const rootArea = page.getByRole('tree', { name: `${project.name} 的文件目录`, exact: true }), rootBox = await rootArea.boundingBox();
  await rootArea.click({ position: { x: 30, y: rootBox.height - 12 } }); await page.keyboard.press('Control+v');
  await page.getByRole('treeitem', { name: 'external.txt', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, 'external.txt'), 'utf8'), 'PASTE_IN_CONTENT');
  await fileClipboard(path.join(root, 'integration'), 'copy', [path.join(output, 'external/external.txt'), path.join(output, 'external/外部文件夹')]); await ownClipboard();
  const tree = page.getByRole('tree', { name: `${project.name} 的文件目录`, exact: true });
  const blank = { x: 35, y: (await tree.boundingBox()).height - 12 };
  await tree.click({ position: blank }); await page.keyboard.press('Control+v');
  await page.getByRole('treeitem', { name: '外部文件夹', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, '外部文件夹/nested.txt'), 'utf8'), 'NESTED_PASTE_CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, 'external - 副本.txt'), 'utf8'), 'PASTE_IN_CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, 'external.txt'), 'utf8'), 'PASTE_IN_CONTENT', 'paste preserves the existing file');
  await page.getByRole('treeitem', { name: '目标目录', exact: true }).click();
  await page.getByRole('button', { name: '粘贴文件', exact: true }).click();
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, '目标目录/外部文件夹/nested.txt'), 'utf8') === 'NESTED_PASTE_CONTENT'; } catch { return false; } }, 'toolbar pastes into the selected directory');
  await filesFinished();
  await tree.click({ position: blank, button: 'right' });
  await page.getByRole('menuitem', { name: /^粘贴/ }).click();
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, 'external - 副本 (2).txt'), 'utf8') === 'PASTE_IN_CONTENT'; } catch { return false; } }, 'blank-area menu pastes into project root');
  await filesFinished();
  await tree.click({ position: blank }); await page.keyboard.press('Shift+Insert');
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, 'external - 副本 (3).txt'), 'utf8') === 'PASTE_IN_CONTENT'; } catch { return false; } }, 'Shift+Insert pastes files into the focused explorer');
  await filesFinished();
  console.log('PASS: blank-area Ctrl+V and context menu, toolbar folder destination, multi-file/directory paste and safe duplicate names');
  await restoreClipboard();
  await page.getByRole('treeitem', { name: 'renamed.txt', exact: true }).click(); await page.keyboard.press('Delete');
  await waitFor(async () => { try { await fs.stat(path.join(project.path, 'renamed.txt')); return false; } catch { return true; } }, 'delete moves file out of project');
  await page.locator('[data-node-path="external.txt"]').click({ button: 'right' });
  await page.screenshot({ path: path.join(output, 'file-actions.png') });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: '文件操作', exact: true }).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await tree.evaluate(element => element === document.activeElement), true, 'Escape closes the menu even without tree focus, then returns keyboard focus');
  await page.getByRole('treeitem', { name: 'microphone-check.html', exact: true }).click();
  const isolated = page.frameLocator('iframe[title="HTML 页面预览"]');
  await isolated.getByRole('button', { name: 'Check microphone' }).click(); await isolated.getByText('BLOCKED', { exact: true }).waitFor();
  console.log('PASS: compact explorer, create/rename/delete, native Explorer copy-out and clipboard paste-in');
  if (await page.getByRole('button', { name: '返回终端', exact: true }).count()) await page.getByRole('button', { name: '返回终端', exact: true }).click();
  const microphone = page.getByRole('button', { name: `语音输入 ${project.name}`, exact: true });
  await waitFor(async () => /mic-connected/.test(await microphone.getAttribute('class')), 'connected microphone shows the blue state');
  assert.equal(await page.locator('dialog.voice-dialog').count(), 0);
  await microphone.click();
  await waitFor(async () => /is-recording/.test(await microphone.getAttribute('class')), 'first click starts recording in place');
  assert.equal(await microphone.getAttribute('aria-pressed'), 'true');
  await page.waitForTimeout(5500);
  await page.screenshot({ path: path.join(output, 'voice-recording.png') });
  await application.evaluate(() => { globalThis.voicePastes = []; });
  await microphone.click();
  await waitFor(async () => application.evaluate(() => globalThis.voicePastes.some(item => /project folder/i.test(item.data))), 'second click inserts the text into the same terminal', 60000);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.some(item => item.data === '\r')), false, 'dictation does not press Enter');
  await waitFor(async () => !/is-recording|is-busy/.test(await microphone.getAttribute('class')), 'button returns to idle');
  await page.screenshot({ path: path.join(output, 'voice-input.png') });
  await microphone.click(); await page.keyboard.press('Escape');
  await waitFor(async () => !/is-recording/.test(await microphone.getAttribute('class')), 'Escape cancels a recording without inserting');
  console.log(`PASS: blue connected microphone, click to talk and click again to insert ${assets ? 'real SenseVoice recognition' : 'stubbed recognition'} into the terminal without submitting; Escape cancels`);
  // Ctrl+T: a microphone appears in the middle of the window; Enter inserts the text and then sends it.
  await page.locator('.project-panel.is-focused .xterm-helper-textarea').first().focus();
  await application.evaluate(() => { globalThis.voicePastes = []; });
  await page.keyboard.press('Control+t');
  const overlay = page.locator('.voice-overlay');
  await overlay.waitFor();
  await waitFor(async () => /is-recording/.test(await microphone.getAttribute('class')), 'Ctrl+T records the focused terminal');
  await overlay.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const box = await overlay.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2 && Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2, `the microphone sits in the middle of the window ${JSON.stringify({ box, viewport })}`);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.some(item => item.data === '\x14')), false, 'Ctrl+T never reaches the terminal');
  await page.waitForTimeout(5500);
  await page.screenshot({ path: path.join(output, 'voice-shortcut.png') });
  await page.keyboard.press('Enter');
  await waitFor(async () => application.evaluate(() => { const pasted = globalThis.voicePastes.findIndex(item => /project folder/i.test(item.data)); return pasted >= 0 && globalThis.voicePastes.findIndex(item => item.data === '\r') > pasted; }), 'Enter inserts the text, then submits it', 60000);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.filter(item => item.data === '\r').length), 1, 'the Enter that stops recording is not also typed into the terminal');
  await overlay.waitFor({ state: 'detached' });
  await application.evaluate(() => { globalThis.voicePastes = []; });
  await page.keyboard.press('Control+t'); await overlay.waitFor(); await page.keyboard.press('Escape'); await overlay.waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.some(item => item.data === '\r' || item.data === '\x1b' || /project folder/i.test(item.data))), false, 'Escape cancels without inserting, submitting or reaching the terminal');
  console.log('PASS: Ctrl+T shows a centred microphone; Enter inserts and sends, Escape cancels');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) { console.error('UI error:', await page.locator('.form-error, .error-toast, .explorer-file-status').allTextContents().catch(() => [])); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
} finally { await restoreClipboard(); if (application) await application.close(); }
