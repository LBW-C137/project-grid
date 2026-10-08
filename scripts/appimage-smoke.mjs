// Linux AppImage check: the AppImage starts with an isolated profile and its own HOME, restores a Bash terminal,
// and that terminal's environment has none of the AppImage's folders or variables (AppRun adds them to the app's
// own). The terminal's ~/.bashrc writes the environment out. Usage: node scripts/appimage-smoke.mjs <file.AppImage>
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { waitFor } from './wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appImage = path.resolve(process.argv[2] || '');
await fs.access(appImage);
const output = path.join(root, '.test-output', `appimage-${Date.now()}`);
const dataDir = path.join(output, 'user-data'), home = path.join(output, 'home'), project = path.join(output, 'projects', '中文 项目');
for (const folder of [dataDir, home, project]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(home, '.bashrc'), 'env > "$HOME/terminal-env.txt"\n');
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 1,
  projects: [{ id: randomUUID(), name: '中文 项目', path: project, unread: 0, seenEvents: [], lastCompletedAt: null }],
  settings: { shell: 'bash', restoreSessions: true, terminalRenderer: 'dom', notifications: false, sound: false, announce: false, closeToTray: false } }));

const env = { ...process.env, HOME: home, PROJECT_GRID_DATA_DIR: dataDir, PROJECT_GRID_TEST_RESTORE: '1' };
for (const name of ['ELECTRON_RUN_AS_NODE', 'APPDIR', 'APPIMAGE', 'LD_LIBRARY_PATH']) delete env[name];
// Its own process group, so the AppImage runtime and the app inside it stop together.
const child = spawn(appImage, [], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
child.stderr.on('data', data => { log = (log + data).slice(-20000); });
try {
  const file = path.join(home, 'terminal-env.txt');
  let text = '';
  await waitFor(async () => { try { text = await fs.readFile(file, 'utf8'); return /^PATH=/m.test(text); } catch { return false; } },
    'the restored terminal writes its environment', 90000);
  const vars = Object.fromEntries(text.split('\n').filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'PROJECT_GRID_DATA_DIR', 'PROJECT_GRID_SOCKET', 'PROJECT_GRID_SESSION_KEY', 'ELECTRON_RUN_AS_NODE']) assert.equal(vars[name], undefined, `${name} stays out of the terminal`);
  assert.doesNotMatch(text, /\/tmp\/\.mount_/, 'no folder of the mounted AppImage reaches the terminal');
  assert.equal(vars.TERM_PROGRAM, 'project-grid');
  assert.ok(vars.PATH && vars.PATH.split(':').includes('/usr/bin'), 'the system PATH remains');
  console.log(`PASS: the AppImage starts and its terminals leave out the AppImage environment; output: ${output}`);
} catch (error) {
  console.error(`--- AppImage stderr ---\n${log}`);
  throw error;
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { }
  await new Promise(resolve => setTimeout(resolve, 2000));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { }
}
