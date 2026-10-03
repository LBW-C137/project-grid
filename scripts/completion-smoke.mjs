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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output', `completion-${Date.now()}`), dataDir = path.join(output, 'profile');
const home = path.join(output, 'codex-home'), bin = path.join(output, 'bin');
const project = { id: randomUUID(), name: 'Parent task status', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
for (const directory of [dataDir, project.path, bin, path.join(home, 'sessions')]) await fs.mkdir(directory, { recursive: true });
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/restore-codex.cs')], { windowsHide: true });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { notifications: true, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.PROJECT_GRID_DEV_URL;
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
const packaged = process.argv.includes('--packaged');
let application, page, bootstrap;
const state = async () => (await page.evaluate(() => window.projectGrid.getState())).value.projects[0];
const notices = () => application.evaluate(() => globalThis.completionNotices);
const input = data => page.evaluate(({ id, data }) => window.projectGrid.writeTerminal(id, data), { id: project.id, data });
const thread = randomUUID(), child = randomUUID();
const transcript = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
const record = (type, turn) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } }) + '\n';
async function notify(id, turn) {
  await exec(bootstrap.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap.notifyPath, '-PipeName', bootstrap.pipeName, '-ProjectId', bootstrap.projectId, '-SessionKey', bootstrap.sessionKey, '-Payload', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': id, 'turn-id': turn })], { windowsHide: true, timeout: 10000 });
}
async function launch() {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Project Grid.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  await application.evaluate(({ Notification, dialog }) => {
    globalThis.completionNotices = 0; Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.completionNotices++; };
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.waitForSelector('.project-panel');
  // Record spoken completion notices instead of playing them aloud during the test.
  await page.evaluate(() => { window.spokenNotices = []; window.speechSynthesis.speak = utterance => { window.spokenNotices.push({ text: utterance.text, lang: utterance.lang, voice: utterance.voice?.name || null }); setTimeout(() => utterance.onend?.(), 0); }; });
  await page.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'shell ready');
  const runtime = (await fs.readdir(dataDir)).find(name => name.startsWith('runtime-'));
  bootstrap = JSON.parse(await fs.readFile(path.join(dataDir, runtime, `${(await state()).sessionId}.json`), 'utf8'));
  // Codex is started by typing it at the prompt, as a user does; there is no launch button.
  await input('codex\r');
  await waitFor(async () => (await state()).codexActive, 'offline Codex fixture');
}
try {
  await launch();
  await notify(child, 'before-input'); assert.equal(await notices(), 0);
  await input('first instruction\r');
  await fs.writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: project.path, source: 'cli' } }) + '\n' + record('task_started', 'first'));
  await fs.writeFile(path.join(home, 'sessions', `rollout-${child}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: child, cwd: project.path, source: { subagent: thread } } }) + '\n' + record('task_started', 'child-turn') + record('task_complete', 'child-turn'));
  await notify(child, 'child-turn');
  await waitFor(async () => (await state()).codexActivity === 'working', 'parent stays running');
  assert.equal(await notices(), 0); assert.equal((await state()).unread, 0);
  await waitFor(async () => page.locator('.status-badge').innerText().then(text => text.includes('正在处理')), 'visible running badge');
  // The step the agent is on shows in the card header: a command it runs, then a file it patches.
  const step = (id, cmd) => JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input: 'text(await tools.exec_command({cmd:' + JSON.stringify(cmd) + '}))' } }) + '\n';
  await fs.appendFile(transcript, step('call-1', 'npm test'));
  await waitFor(async () => (await state()).action?.kind === 'command' && (await state()).action.target === 'npm test', 'running command is reported');
  await fs.appendFile(transcript, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [] } }) + '\n' + step('call-2', 'apply_patch\n*** Begin Patch\n*** Update File: src/login.ts\n*** End Patch'));
  await waitFor(async () => (await state()).action?.kind === 'edit' && (await state()).action.target === 'src/login.ts', 'file edit is reported');
  assert.equal((await page.evaluate(id => window.projectGrid.terminalActions(id), project.id)).value.length, 2, 'both steps are listed for the activity pane');
  // Expanded, the pane beside the terminal lists the steps, newest first, and the running edit is marked.
  await page.getByRole('button', { name: '全屏查看 Parent task status', exact: true }).click();
  const pane = page.locator('.activity-pane'); await pane.waitFor();
  await waitFor(async () => await pane.locator('.activity-item').count() === 2, 'activity pane lists the steps');
  assert.equal(await pane.locator('.activity-item').first().locator('code').innerText(), 'src/login.ts');
  assert.ok((await pane.locator('.activity-now').getAttribute('class')).includes('is-editing'));
  await page.waitForFunction(() => !document.querySelector('[data-focus-motion]')); await page.screenshot({ path: path.join(output, 'activity-pane.png') });
  await page.getByRole('button', { name: '隐藏活动栏', exact: true }).click(); await waitFor(async () => !await pane.count(), 'activity pane can be hidden');
  await page.getByRole('button', { name: '显示活动栏：它正在做什么', exact: true }).click(); await pane.waitFor();
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.screenshot({ path: path.join(output, 'parent-running.png') });
  // The round's prompt, as Codex records it; the spoken notice names this work.
  await fs.appendFile(transcript, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: '给登录页加上验证码。然后跑一下测试' } }) + '\n');
  await fs.appendFile(transcript, record('task_complete', 'first')); await notify(thread, 'first');
  await waitFor(async () => (await state()).unread === 1, 'parent completes');
  assert.equal(await notices(), 1);
  // The finished round is also announced once, in Mandarin, naming the project.
  await waitFor(async () => (await page.evaluate(() => window.spokenNotices.length)) === 1, 'completion is announced');
  const spoken = (await page.evaluate(() => window.spokenNotices))[0];
  assert.ok(spoken.text.includes(project.name) && spoken.text.includes('给登录页加上验证码') && !spoken.text.includes('跑一下测试') && spoken.lang === 'zh-CN', `the notice says which project finished what: ${JSON.stringify(spoken)}`);
  console.log(`Spoken notice: ${JSON.stringify(spoken)}`);
  await page.evaluate(id => window.projectGrid.acknowledge(id), project.id);
  await waitFor(async () => page.locator('.project-panel').evaluate(node => node.classList.contains('round-complete')), 'viewed automatic completion is steady green');
  assert.equal(await page.locator('.status-badge').innerText(), '本轮已完成');
  assert.equal(await page.locator('.project-panel').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.animationName === 'signal-breathe')), false);
  await input('draft'); await notify(child, 'new-id'); await notify(thread, 'first');
  assert.equal(await notices(), 1); assert.equal((await state()).codexActivity, 'complete');
  await input('\x15'); await input('second instruction\r');
  await fs.appendFile(transcript, record('task_started', 'second'));
  await notify(thread, 'first');
  assert.equal((await state()).codexActivity, 'working'); assert.equal(await notices(), 1);
  await fs.appendFile(transcript, record('task_complete', 'first'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await state()).codexActivity, 'working');
  await fs.appendFile(transcript, record('task_complete', 'second')); await notify(thread, 'second');
  await waitFor(async () => (await state()).unread === 1, 'second parent turn completes');
  assert.equal(await notices(), 2);
  await notify(child, 'yet-another-turn'); await notify(thread, 'second');
  assert.equal(await notices(), 2);
  await fs.appendFile(transcript, record('task_started', 'interrupted') + record('turn_aborted', 'interrupted'));
  await waitFor(async () => (await state()).codexActivity === 'interrupted', 'interruption is distinct from completion');
  assert.equal(await notices(), 2);
  assert.equal(await page.evaluate(() => window.spokenNotices.length), 2, 'only real completions are spoken; child, stale and interrupted turns stay silent');
  console.log('PASS: real parent lifecycle owns working/completed/interrupted status; child and stale callbacks never finish the current task');
  await application.close(); application = null;
  await launch(); await notify(child, 'after-restart');
  assert.equal(await notices(), 0);
  assert.notEqual((await state()).codexActivity, 'complete', 'old lastCompletedAt is not the current running state');
  console.log('PASS: completed history and restarting never generate a new completion notice');
  console.log(`Fixture: ${output}`);
} finally { if (application) await application.close(); }
