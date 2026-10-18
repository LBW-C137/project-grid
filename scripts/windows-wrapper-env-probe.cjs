const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const context = Object.hasOwn(process.env, 'NODE_TEST_CONTEXT') ? 'node-test' : 'plain-node';

// Disposable CI comparison; the following wrapper test remains the failing gate.
async function main() {
  if (process.platform !== 'win32' || process.env.CI !== 'true') return;
  const started = Date.now(), deadline = started + 90000;
  const timeout = 2000 * Math.max(1, Number(process.env.AGENTRIX_TEST_TIMEOUT_SCALE) || 1);
  const system = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const powershellModules = path.join(system, 'System32/WindowsPowerShell/v1.0/Modules');
  const safeEnv = home => ({ SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || process.env.Path || '',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ...(powershellModules ? { PSModulePath: powershellModules } : {}),
    HOME: home, USERPROFILE: home, HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\fixture', CODEX_HOME: path.join(home, '.codex') });
  const base = fs.realpathSync(os.tmpdir());
  let root;
  try {
    if (!fs.statSync(powershellModules).isDirectory()) throw new Error('setup');
    root = fs.mkdtempSync(path.join(base, 'agentrix-env-probe-'));
    const home = path.join(root, 'home'), integration = path.join(root, 'integration');
    const roaming = path.join(root, 'appdata/roaming'), local = path.join(root, 'appdata/local'), temp = path.join(root, 'temp');
    for (const folder of [home, integration, roaming, local, temp]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(integration, 'bootstrap.ps1'), '');
    const script = path.join(root, 'probe.ps1');
    fs.writeFileSync(script, "[Console]::WriteLine('ENTRY')\n$env:AGENTRIX_AGENT_ONLY = '1'\n$quotaBootstrapPath = (Join-Path $env:QUOTA_INTEGRATION 'bootstrap.ps1')\n[Console]::WriteLine('JOIN_OK')\n");
    const baseline = { ...safeEnv(home), QUOTA_INTEGRATION: integration };
    const drive = path.parse(home).root.replace(/[\\/]+$/, '');
    const homeFields = { HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) };
    const appData = { APPDATA: roaming, LOCALAPPDATA: local };
    const boot = { WINDIR: system, COMSPEC: path.join(system, 'System32/cmd.exe'), OS: 'Windows_NT', TEMP: temp, TMP: temp };
    const variants = [
      { name: 'baseline' },
      { name: 'stdin-eof', eof: true },
      { name: 'noninteractive', noninteractive: true },
      { name: 'consistent-home', env: homeFields },
      { name: 'owned-appdata', env: appData },
      { name: 'windows-boot-temp', env: boot },
      { name: 'combined-os', env: { ...homeFields, ...appData, ...boot } },
      { name: 'omit-module-path', omit: 'PSModulePath' },
      { name: 'baseline-after-controls' },
    ];
    for (const variant of variants) {
      const env = { ...baseline, ...variant.env };
      if (variant.omit) delete env[variant.omit];
      const modifiedKeys = [...new Set([...Object.keys(baseline), ...Object.keys(env)])].filter(key => baseline[key] !== env[key]);
      const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
      if (variant.noninteractive) args.splice(4, 0, '-NonInteractive');
      const remaining = deadline - Date.now() - 1000;
      if (remaining <= 0) {
        console.log(JSON.stringify({ context, variant: variant.name, modifiedKeys, ms: 0, exit: null, killed: false, signal: null, ENTRY: false, JOIN_OK: false, error: 'budget-exhausted' }));
        continue;
      }
      console.log(JSON.stringify(await probe(variant, modifiedKeys, powershell, args, env, root, Math.min(timeout, remaining))));
    }
  } finally {
    // Only this exact mkdtemp child of the resolved temporary directory is removable.
    if (root) {
      if (path.dirname(path.resolve(root)) !== base || !path.basename(root).startsWith('agentrix-env-probe-') || fs.realpathSync(root) !== root) throw new Error('cleanup');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function probe(variant, modifiedKeys, powershell, args, env, cwd, timeout) {
  const started = Date.now();
  return new Promise(resolve => {
    let child, timer, done = false, out = '', err = '';
    const stop = () => {
      if (!child) return;
      try { child.kill('SIGKILL'); } catch {}
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    };
    const finish = (error, stdout = out, stderr = err, forced = false) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const signal = ['SIGTERM', 'SIGKILL'].includes(error?.signal) ? error.signal : null;
      resolve({ context, variant: variant.name, modifiedKeys, ms: Date.now() - started,
        exit: Number.isInteger(error?.code) ? error.code : error ? null : 0,
        killed: Boolean(child?.killed || error?.killed), signal,
        ENTRY: /^ENTRY\r?$/m.test(stdout), JOIN_OK: /^JOIN_OK\r?$/m.test(stdout),
        error: forced ? 'cleanup-deadline' : category(error, stderr) });
    };
    try {
      child = execFile(powershell, args, { env, cwd, windowsHide: true, timeout, maxBuffer: 4096 }, finish);
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => { out = (out + data).slice(0, 4096); });
      child.stderr.on('data', data => { err = (err + data).slice(0, 4096); });
      timer = setTimeout(() => {
        stop();
        finish({ killed: child.killed, signal: child.signalCode || (child.killed ? 'SIGKILL' : null) }, out, err, true);
      }, timeout + 1000);
      if (variant.eof) child.stdin.end();
    } catch (error) {
      stop();
      finish(error);
    }
  });
}

function category(error, stderr = '') {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-limit';
  if (error?.code === 'ENOENT') return 'spawn-not-found';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'access-denied';
  if (/CommandNotFoundException|commandnotfound|not recognized/i.test(stderr)) return 'command-not-found';
  if (/DriveNotFound|ItemNotFound|PathNotFound|ParameterBinding|Cannot find (path|drive)/i.test(stderr)) return 'configuration-error';
  if (/ParserError|ParseException/i.test(stderr)) return 'parse-error';
  if (error?.killed) return stderr ? 'timeout-with-stderr' : 'timeout';
  return stderr ? 'powershell-stderr' : error ? 'process-error' : null;
}

main().catch(() => console.log(JSON.stringify({ context, variant: 'setup-or-cleanup', modifiedKeys: [], ms: 0, exit: null, killed: false, signal: null, ENTRY: false, JOIN_OK: false, error: 'setup-or-cleanup-error' })));
