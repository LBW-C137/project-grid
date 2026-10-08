import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitFor, timeoutScale } from './wait.mjs';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'the portable build is Windows-only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const executable = process.argv.includes('--executable') ? process.argv[process.argv.indexOf('--executable') + 1] : path.join(root, 'release', `Project-Grid-${version}-win-x64.exe`);
await fs.access(executable);
await fs.mkdir(path.join(root, '.test-output'), { recursive: true });
const output = await fs.mkdtemp(path.join(root, '.test-output', 'portable-'));
// Keep extracted app binaries outside the source tree so subsequent builds cannot include them.
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-grid-portable-'));
const dataDir = path.join(testDir, 'profile'), temp = path.join(testDir, 'temp');
const firstProject = path.join(testDir, 'Existing project'), nextProject = path.join(testDir, 'New project');
for (const folder of [dataDir, temp, firstProject, nextProject]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({
  version: 2,
  projects: [{ id: 'existing', name: 'Existing project', path: firstProject, kind: 'local', restore: { terminal: false, codex: false } }],
  history: [{ name: 'New project', path: nextProject, lastOpenedAt: Date.now() }],
  settings: { restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false, terminalRenderer: 'dom' },
}));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const env = { ...process.env, PROJECT_GRID_DATA_DIR: dataDir, TEMP: temp, TMP: temp };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PROJECT_GRID_DEV_URL;
const launchers = [], logs = [], errors = [];
function launch() {
  const child = spawn(executable, [`--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => logs.push(data.toString()));
  child.stderr.on('data', data => logs.push(data.toString()));
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  exited.catch(() => {});
  const launcher = { child, exited };
  launchers.push(launcher);
  return launcher;
}
async function files(folder) {
  const result = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else result.push(filename);
  }
  return result;
}
let browser, page, appDir;
const results = { executable, checks: [] };
let passed = false;
try {
  const first = launch();
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 'portable debugging endpoint', 30000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await waitFor(() => browser.contexts()[0].pages().length > 0, 'portable app window');
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.projectGrid);
  const extracted = (await files(temp)).find(filename => path.basename(filename) === 'Project Grid.exe');
  assert.ok(extracted, 'portable app must extract within the isolated TEMP');
  appDir = path.dirname(extracted);
  assert.ok(appDir.startsWith(temp + path.sep));
  results.appDir = appDir;
  const baseline = (await files(appDir)).map(filename => path.relative(appDir, filename));
  async function state(id) {
    const result = await page.evaluate(() => window.projectGrid.getState());
    assert.ok(result.ok, JSON.stringify(result));
    return result.value.projects.find(project => project.id === id);
  }
  async function ready(id) {
    await waitFor(async () => {
      const project = await state(id);
      assert.notEqual(project?.status, 'exited', project?.error || 'terminal exited');
      return project?.status === 'shell' && project.shellReady;
    }, `terminal ready: ${id}`);
  }
  const started = await page.evaluate(() => window.projectGrid.startTerminal('existing'));
  assert.ok(started.ok, JSON.stringify(started));
  await ready('existing');
  const original = await state('existing');
  const second = launch();
  let timeout;
  try {
    const code = await Promise.race([second.exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('second portable launcher did not exit')), 30000 * timeoutScale); })]);
    assert.equal(code, 0, 'second launch hands off to the running instance');
  } finally { clearTimeout(timeout); }
  assert.equal(first.child.exitCode, null, 'first launcher is still running');
  const remaining = (await files(appDir)).map(filename => path.relative(appDir, filename));
  results.missing = baseline.filter(filename => !remaining.includes(filename));
  assert.deepEqual(results.missing, [], 'second launcher must not clean the first instance resources');
  assert.equal((await state('existing')).sessionId, original.sessionId, 'original terminal session survives');
  results.checks.push('second launch preserves the original app resources and terminal');
  console.log('PASS: repeated portable launch preserves the running instance and all extracted files');

  async function command(id, folder, name) {
    const proof = path.join(folder, `${name}.txt`);
    const code = `[IO.File]::WriteAllText('${proof.replaceAll("'", "''")}', (Get-Location).Path)\r`;
    await page.evaluate(({ id, code }) => window.projectGrid.writeTerminal(id, code), { id, code });
    await waitFor(async () => { try { return (await fs.readFile(proof, 'utf8')) === folder; } catch { return false; } }, `terminal command: ${name}`);
    await ready(id);
  }
  await command('existing', firstProject, 'existing-after-second-launch');
  const added = await page.evaluate(folder => window.projectGrid.addRecentProject(folder), nextProject);
  assert.ok(added.ok, JSON.stringify(added));
  await ready(added.value);
  await command(added.value, nextProject, 'new-terminal');
  results.checks.push('existing terminal accepts commands and a newly added project starts');
  // An exited terminal does not open the native confirmation dialog on restart.
  await page.evaluate(id => window.projectGrid.writeTerminal(id, 'exit\r'), added.value);
  await waitFor(async () => (await state(added.value))?.status === 'exited', 'new terminal exits');
  const restarted = await page.evaluate(id => window.projectGrid.restartTerminal(id), added.value);
  assert.ok(restarted.ok && restarted.value, JSON.stringify(restarted));
  await ready(added.value);
  await command(added.value, nextProject, 'restarted-terminal');
  assert.equal((await state('existing')).sessionId, original.sessionId);
  assert.deepEqual(errors, [], 'renderer errors');
  results.checks.push('new terminal restarts without disturbing the original session');
  await page.screenshot({ path: path.join(output, 'after-second-launch.png') });
  passed = true;
  console.log('PASS: existing terminal input, new project startup and terminal restart after a second portable launch');
} catch (error) {
  results.error = error.stack;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  // Only terminate processes whose executable lives in this test's own TEMP.
  // The user's real Project Grid window and terminals cannot match this prefix.
  const cleanupEnv = { ...process.env, PROJECT_GRID_TEST_TEMP: temp + path.sep };
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'Project Grid.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:PROJECT_GRID_TEST_TEMP, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"], { env: cleanupEnv, windowsHide: true });
  if (browser) await browser.close().catch(() => {});
  for (const { child, exited } of launchers) {
    if (child.exitCode === null) child.kill();
    let timeout;
    try { await Promise.race([exited.catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timeout); }
  }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  await fs.writeFile(path.join(output, 'launcher.log'), logs.join(''));
  console.log(`Portable regression artifacts: ${output}`);
  if (passed) {
    assert.ok(testDir.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(testDir).startsWith('project-grid-portable-'));
    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
