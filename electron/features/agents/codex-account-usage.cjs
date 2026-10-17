const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

// Codex 0.163's generated GetAccountRateLimitsResponse/Params contract. This is an
// owned stdio client, never the person's PTY. No threads, turns, login or reset RPCs.
const MAX_OUTPUT = 256 * 1024;
const unavailable = reason => ({ resets: null, resetQuery: { state: 'unavailable', reason } });
const environments = new WeakMap();
let nextEnvironment = 0;

function accountResult(result, at = Date.now()) {
  const left = result?.rateLimitResetCredits?.availableCount;
  if (left == null) return unavailable('unsupported');
  // JSON's integer representation must be safe before crossing Electron IPC.
  if (!Number.isSafeInteger(left) || left < 0) throw new Error('invalid-count');
  const limits = [result.rateLimits?.primary, result.rateLimits?.secondary]
    .filter(value => value && Number.isFinite(value.usedPercent))
    .map(value => ({ minutes: value.windowDurationMins ?? null, percent: value.usedPercent,
      resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt * 1000 : null }));
  return { resets: { left, total: null }, limits, at, source: 'Codex', resetQuery: { state: 'ready', at } };
}

// Use a native executable, avoiding a shell and unowned npm shim descendants.
// Standard Windows npm installations can expose the vendor binary here too.
async function codexExecutable(env = process.env, platform = process.platform, cancelled = () => false) {
  const folders = String(Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '').split(path.delimiter);
  for (const folder of folders.filter(Boolean)) {
    const root = folder.replace(/"/g, '');
    const candidates = platform === 'win32' ? [path.join(root, 'codex.exe'),
      ...['node_modules/@openai/codex/vendor', 'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor',
        'node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor']
        .flatMap(base => ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].map(target => path.join(root, base, target, 'codex/codex.exe')))]
      : [path.join(root, 'codex')];
    for (const candidate of candidates) {
      if (cancelled()) return null;
      try { if ((await fs.promises.stat(candidate)).isFile()) return candidate; } catch { }
    }
  }
  return null;
}

function stopChild(child) {
  if (!child || child.exitCode != null) return;
  // Only our own pid/tree. Never enumerate or signal any running Codex sessions.
  if (process.platform === 'win32' && child.pid) {
    const killer = execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 2000 }, () => {
      try { if (child.exitCode == null) child.kill('SIGKILL'); } catch { }
    });
    killer.unref?.();
    return;
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { }
  }
  try { child.kill('SIGKILL'); } catch { }
}

function readCodexAccount({ env = process.env, cwd, codexHome, signal, timeout = 8000,
  executable, launch = spawn, stop = stopChild } = {}) {
  return new Promise(resolve => {
    let child, timer, done = false, pending = '', bytes = 0, stage = 1;
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child?.stdout?.removeListener('data', read);
      try { child?.stdin?.end(); } catch { }
      stop(child);
      resolve(value);
    };
    const fail = reason => finish({ resets: null, resetQuery: { state: 'error', reason } });
    const abort = () => fail('cancelled');
    const write = value => { try { child.stdin.write(JSON.stringify(value) + '\n'); } catch { fail('query'); } };
    const read = data => {
      bytes += Buffer.byteLength(data);
      if (bytes > MAX_OUTPUT) { fail('query'); return; }
      pending += data;
      let end;
      while (!done && (end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('query'); return; }
        if (!message || typeof message !== 'object') { fail('query'); return; }
        // Notifications may be interleaved. Never answer a server request that
        // could ask for auth or an action; this connection only reads usage.
        if (message.id !== stage || message.method) continue;
        if (message.error) { if (message.error.code === -32601) finish(unavailable('unsupported')); else fail('query'); return; }
        if (!Object.hasOwn(message, 'result')) continue;
        if (stage === 1) {
          stage = 2;
          write({ method: 'initialized' });
          write({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else {
          try { finish(accountResult(message.result)); } catch { fail('query'); }
        }
      }
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail('timeout'), timeout);
    const start = file => {
      if (done) return;
      if (!file) { finish(unavailable('unsupported')); return; }
      try {
        child = launch(file, ['app-server', '--listen', 'stdio://'], {
          cwd, env: { ...env, CODEX_HOME: codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex') },
          windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8'); child.stdout.on('data', read);
        // Drain but never retain/log diagnostics (they may contain account data).
        child.stderr?.on('data', data => { bytes += data.length; if (bytes > MAX_OUTPUT) fail('query'); });
        child.stdin.on('error', () => fail('query'));
        child.once('error', () => fail('query'));
        child.once('exit', () => { if (!done) fail('query'); });
        child.once('close', () => { if (!done) fail('query'); });
        write({ id: 1, method: 'initialize', params: {
          clientInfo: { name: 'agentrix_usage', title: 'Agentrix usage', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true },
        } });
      } catch { fail('query'); }
    };
    if (executable) start(executable);
    else void codexExecutable(env, process.platform, () => done).then(start, () => fail('query'));
  });
}

// Scope only to the actual reported home + inherited account environment + cwd
// (Codex resolves project config there). No credential files or account IDs read.
function usageScope({ codexHome, cwd, env = process.env, provider, remote, command } = {}) {
  if (remote) return { reason: 'remote' };
  if (!provider) return { reason: 'scope' };
  if (provider !== 'openai') return { reason: 'provider' };
  if (command?.startsWith('-')) return { reason: 'scope' };
  const home = path.resolve(cwd || process.cwd(), codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  // Object identity keeps distinct account environments separate without ever
  // inspecting, comparing, hashing or retaining credential values as cache keys.
  if (!environments.has(env)) environments.set(env, ++nextEnvironment);
  return { home, key: JSON.stringify([home, cwd, environments.get(env), provider]) };
}

class CodexAccountUsage {
  constructor({ read = readCodexAccount, interval = 30000 } = {}) {
    this.read = read; this.interval = interval; this.entries = new Map();
  }
  watch(options, changed) {
    const scope = usageScope(options);
    if (scope.reason) { changed(unavailable(scope.reason)); return { dispose() {}, refresh() {}, output() {} }; }
    let entry = this.entries.get(scope.key);
    if (!entry) {
      entry = { options: { ...options, codexHome: scope.home }, listeners: new Set(), failures: 0, generation: 0 };
      this.entries.set(scope.key, entry);
    }
    entry.listeners.add(changed);
    if (entry.value) changed(entry.value);
    if (!entry.pending && !entry.timer) this.refresh(entry);
    let tail = '';
    return {
      refresh: () => this.refresh(entry, true),
      // A success printed by the actual CLI invalidates any pre-reset read. No
      // query ever writes into its PTY, submits a prompt or initiates a reset.
      output: data => {
        tail = (tail + data).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-4096);
        const success = /Usage reset\.\s+You have \d+\b[^.]*?\bleft\.?/i.exec(tail);
        if (success) { tail = tail.slice(success.index + success[0].length); this.refresh(entry, true); }
      },
      dispose: () => {
        entry.listeners.delete(changed);
        if (entry.listeners.size) return;
        ++entry.generation; clearTimeout(entry.timer); entry.abort?.abort(); this.entries.delete(scope.key);
      },
    };
  }
  refresh(entry, force = false) {
    if (!entry.listeners.size || (entry.pending && !force)) return;
    clearTimeout(entry.timer); entry.timer = null;
    const generation = ++entry.generation;
    entry.abort?.abort(); const abort = entry.abort = new AbortController();
    const publish = value => { entry.value = value; for (const changed of entry.listeners) changed(value); };
    publish({ resets: null, resetQuery: { state: 'loading' } });
    entry.pending = true;
    Promise.resolve().then(() => abort.signal.aborted ? null : this.read({ ...entry.options, signal: abort.signal })).catch(() => ({ resets: null, resetQuery: { state: 'error', reason: 'query' } })).then(value => {
      if (entry.generation !== generation || !entry.listeners.size) return;
      entry.pending = false; publish(value);
      const failed = value.resetQuery.state !== 'ready';
      entry.failures = failed ? entry.failures + 1 : 0;
      const delay = failed ? Math.min(300000, this.interval * 2 ** Math.min(entry.failures, 4)) : this.interval;
      entry.timer = setTimeout(() => this.refresh(entry), delay); entry.timer.unref?.();
    });
  }
  dispose() {
    for (const entry of this.entries.values()) { entry.listeners.clear(); ++entry.generation; clearTimeout(entry.timer); entry.abort?.abort(); }
    this.entries.clear();
  }
}

module.exports = { CodexAccountUsage, readCodexAccount, accountResult, usageScope, codexExecutable };
