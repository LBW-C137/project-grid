const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { CodexAccountUsage, readCodexAccount, usageScope, accountResult } = require('../electron/features/agents/codex-account-usage.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
const options = { cwd: os.tmpdir(), codexHome: path.join(os.tmpdir(), 'fake-codex-home'), env: {}, provider: 'openai' };
const ready = left => accountResult({ rateLimitResetCredits: { availableCount: left }, rateLimits: {
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792149600 }, secondary: null,
} }, 1234);

// A real owned child with no account configuration or credentials. It only
// implements the two allowed reads, deliberately splitting JSON over chunks.
const FAKE = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = process.env.FAKE_MODE;
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') {
    process.stdout.write('{"id":1,"result":{}}\n'); return;
  }
  if (request.method !== 'account/rateLimits/read') process.exit(90);
  if (mode === 'hang') return;
  if (mode === 'exit') process.exit(1);
  if (mode === 'overflow') { process.stdout.write('x'.repeat(300000)); return; }
  if (mode === 'invalid') { process.stdout.write('not json\n'); return; }
  if (mode === 'null-message') { process.stdout.write('null\n'); return; }
  if (mode === 'error' || mode === 'old') {
    process.stdout.write(JSON.stringify({ id: 2, error: { code: mode === 'old' ? -32601 : -32000, message: 'private diagnostic' } }) + '\n'); return;
  }
  process.stdout.write('{"method":"account/rateLimits/updated","params":{}}\n{"id":99,"result":{}}\n');
  const response = JSON.stringify({ id: 2, result: { accountId: 'must-not-escape', rateLimits: {},
    rateLimitResetCredits: mode === 'null' ? null : { availableCount: Number(mode), credits: null } } }) + '\n';
  process.stdout.write(response.slice(0, 17));
  setTimeout(() => process.stdout.write(response.slice(17)), 5);
});
setInterval(() => {}, 1000);
`;

async function fakeRead(t, mode, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-child-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fake.cjs'); fs.writeFileSync(file, FAKE);
  const sent = []; let child, exited, stops = 0;
  const result = await readCodexAccount({ ...options, executable: 'fake-codex', timeout: 3000, ...extra,
    launch(executable, args, opts) {
      assert.equal(executable, 'fake-codex');
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.equal(opts.env.CODEX_HOME, options.codexHome);
      assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
      child = spawn(process.execPath, [file], { ...opts, env: { FAKE_MODE: mode, SystemRoot: process.env.SystemRoot || '' } });
      exited = once(child, 'exit');
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = data => {
        const request = JSON.parse(data); sent.push(request);
        if (request.method === 'account/rateLimits/read') extra.onUsage?.();
        return write(data);
      };
      return child;
    },
    stop: extra.defaultStop ? undefined : owned => { assert.equal(owned, child); ++stops; child?.kill('SIGKILL'); },
  });
  if (exited) await exited;
  assert.equal(stops, extra.defaultStop ? 0 : 1, 'every outcome disposes its child exactly once');
  assert.deepEqual(sent.map(value => value.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.deepEqual(sent.at(-1).params, { excludeResetCreditDetails: true });
  assert.equal(sent[0].params.capabilities.explicitGatewayOauth, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape|private diagnostic/);
  return result;
}

test('official background protocol: count 0 and 2, split JSON, notifications, sanitization and process cleanup', async t => {
  for (const left of [0, 2]) {
    const value = await fakeRead(t, String(left));
    assert.deepEqual(value.resets, { left, total: null });
    assert.equal(value.resetQuery.state, 'ready');
  }
});

test('null/old protocol is unsupported, never zero; errors, exits, malformed and oversized output are bounded', async t => {
  for (const mode of ['null', 'old']) {
    const value = await fakeRead(t, mode);
    assert.equal(value.resets, null); assert.equal(value.resetQuery.state, 'unavailable');
  }
  for (const mode of ['error', 'exit', 'invalid', 'null-message', 'overflow']) {
    const value = await fakeRead(t, mode);
    assert.equal(value.resets, null); assert.equal(value.resetQuery.state, 'error');
  }
  assert.throws(() => accountResult({ rateLimitResetCredits: { availableCount: Number.MAX_SAFE_INTEGER + 1 } }));
  assert.throws(() => accountResult({ rateLimitResetCredits: { availableCount: -1 } }));
});

test('hung read times out without blocking the event loop, kills its child, and abort/spawn errors settle', async t => {
  let responding = false;
  const timer = setTimeout(() => { responding = true; }, 20);
  const value = await fakeRead(t, 'hang', { timeout: 1000 }); clearTimeout(timer);
  assert.equal(responding, true);
  assert.equal(value.resetQuery.reason, 'timeout');
  const abort = new AbortController(); abort.abort();
  assert.equal((await readCodexAccount({ executable: 'fake', signal: abort.signal, launch: () => assert.fail('aborted') })).resetQuery.reason, 'cancelled');
  assert.equal((await readCodexAccount({ executable: 'fake', launch: () => { throw new Error('private'); } })).resetQuery.state, 'error');
  assert.equal((await readCodexAccount({ executable: path.join(os.tmpdir(), 'nonexistent-agentrix-codex-binary'), env: {} })).resetQuery.state, 'error');
  const running = new AbortController();
  const cancelled = await fakeRead(t, 'hang', { signal: running.signal, onUsage: () => setImmediate(() => running.abort()) });
  assert.equal(cancelled.resetQuery.reason, 'cancelled');
  assert.equal((await fakeRead(t, 'hang', { timeout: 1000, defaultStop: true })).resetQuery.reason, 'timeout', 'production cleanup also terminates the owned child');
});

test('cache deduplicates, isolates home/account environment and drops stale/disposed results', async () => {
  const pending = [], values = [], other = [];
  const service = new CodexAccountUsage({ read: opts => new Promise(resolve => pending.push({ opts, resolve })) });
  const first = service.watch(options, value => values.push(value));
  const second = service.watch(options, value => other.push(value));
  await flush(); assert.equal(pending.length, 1);
  assert.equal(other[0].resetQuery.state, 'loading');
  pending[0].resolve(ready(2)); await flush();
  assert.equal(values.at(-1).resets.left, 2); assert.equal(other.at(-1).resets.left, 2);
  service.watch({ ...options, codexHome: options.codexHome + '-other' }, () => {});
  service.watch({ ...options, env: { HOME: 'another-account-environment' } }, () => {});
  await flush(); assert.equal(pending.length, 3);
  first.refresh(); await flush(); const beforeReset = pending.at(-1);
  // Split terminal output of an actual reset cancels the read begun before it.
  first.output('\x1b[32mUsage re'); first.output('set. You have 0 resets left.\x1b[0m');
  await flush(); assert.equal(beforeReset.opts.signal.aborted, true);
  beforeReset.resolve(ready(2)); pending.at(-1).resolve(ready(0)); await flush();
  assert.equal(values.at(-1).resets.left, 0);
  second.dispose(); first.refresh(); await flush();
  const stale = pending.at(-1), previousLength = values.length;
  first.dispose(); assert.equal(stale.opts.signal.aborted, true);
  stale.resolve(ready(2)); await flush(); assert.equal(values.length, previousLength);
  service.dispose(); assert.equal(service.entries.size, 0);
});

test('remote, custom provider and ambiguous override scopes never query the local account', async () => {
  const service = new CodexAccountUsage({ read: () => assert.fail('must not query') });
  for (const [overrides, reason] of [[{ remote: true }, 'remote'], [{ provider: 'relay' }, 'provider'], [{ provider: null }, 'scope'], [{ command: '-c' }, 'scope']]) {
    let value;
    service.watch({ ...options, ...overrides }, result => { value = result; });
    assert.equal(value.resets, null); assert.equal(value.resetQuery.reason, reason);
  }
  assert.notEqual(usageScope(options).key, usageScope({ ...options, cwd: options.cwd + '-project' }).key);
  assert.notEqual(usageScope(options).key, usageScope({ ...options, env: {} }).key, 'independent account environments never share cached counts');
  assert.equal(usageScope({ ...options, codexHome: '.codex-local' }).home, path.join(options.cwd, '.codex-local'), 'relative homes follow the actual agent cwd');
  await flush(); service.dispose();
});

test('failed refreshes back off, retry automatically and recover without an endless loading status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; const values = [];
  const service = new CodexAccountUsage({ interval: 100, read: async () => ++calls < 3
    ? { resets: null, resetQuery: { state: 'error', reason: 'query' } } : ready(2) });
  service.watch(options, value => values.push(value)); await flush();
  assert.equal(values.at(-1).resetQuery.state, 'error');
  t.mock.timers.tick(199); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(399); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 3);
  assert.equal(values.at(-1).resets.left, 2);
  service.dispose();
});

test('main lifecycle follows recorded provider, replaces sessions safely and never uses local queries for SSH/Claude', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  // Exercise the real lifecycle functions without loading Electron or a PTY.
  const functions = main.slice(main.indexOf('function startUsage('), main.indexOf("// Claude's plan limits and resets, from Claude Code's own state file,"));
  const notes = main.slice(main.indexOf('function noteSettings('), main.indexOf('// A skill step names the skill;'));
  const pending = [], sessions = new Map();
  const service = new CodexAccountUsage({ read: opts => new Promise(resolve => pending.push({ opts, resolve })) });
  const { startUsage, stopUsageAccount, noteSettings } = vm.runInNewContext(`${functions}\n${notes}\n({ startUsage, stopUsageAccount, noteSettings })`, {
    UsageMeter, codexAccounts: service, sessions, process, scheduleState() {},
    codexProvider: async () => id => id, claudeProvider: async () => 'Anthropic', claudeConfigDir: () => '', refreshClaudeAccounts() {},
    agentSettings: previous => previous,
  });
  const s = { terminalId: 'test', codexActive: true, agent: 'codex', usageEnv: {} };
  sessions.set(s.terminalId, s);
  const project = { path: os.tmpdir(), kind: 'local' };
  const event = { codexHome: options.codexHome };
  const meta = model_provider => ({ type: 'session_meta', payload: { model_provider } });
  startUsage(project, s, event); await flush();
  assert.equal(pending.length, 0, 'wait for the actual recorded provider, without querying the wrong account');
  noteSettings(s, 'codex', meta('relay')); await flush();
  assert.equal(pending.length, 0); assert.equal(s.usage.snapshot().resetQuery.reason, 'provider');
  noteSettings(s, 'codex', meta('openai')); await flush();
  assert.equal(pending.length, 1);
  const previous = pending[0];
  startUsage(project, s, event); noteSettings(s, 'codex', meta('openai')); await flush();
  assert.equal(previous.opts.signal.aborted, true);
  previous.resolve(ready(2)); pending[1].resolve(ready(0)); await flush();
  assert.equal(s.usage.snapshot().resets.left, 0);
  s.usageAccount.refresh(); await flush(); const exiting = pending[2];
  stopUsageAccount(s); assert.equal(exiting.opts.signal.aborted, true);
  exiting.resolve(ready(2)); await flush(); assert.equal(s.usage.snapshot().resetQuery.state, 'loading');
  startUsage({ ...project, kind: 'ssh' }, s, event); noteSettings(s, 'codex', meta('openai')); await flush();
  assert.equal(s.usage.snapshot().resetQuery.reason, 'remote');
  s.agent = 'claude'; startUsage(project, s, event); await flush();
  assert.equal(pending.length, 3); assert.equal(s.usage.agent, 'claude');
  stopUsageAccount(s); service.dispose();
});
