// Temporary, offline diagnostic. Observations never replace the wrapper gate.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const GLOBAL_MS = 110000, CHILD_MS = 6000, EXTRA_PROBES = 12;
const PRIVATE_KEY = /token|secret|password|passwd|auth|credential|key|account|cookie|session|^(?:OPENAI|CODEX|CLAUDE|AGENTRIX|GITHUB|ACTIONS)/i;
const OS_KEYS = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'OS',
  'ProgramData', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PUBLIC',
  'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'COMPUTERNAME', 'LOGONSERVER',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
];
// Unknown/custom names are counted, never printed (even when they survived the filter).
const LOGGABLE = new Set([...OS_KEYS, 'PATH', 'PATHEXT', 'PSModulePath', 'PSModuleAnalysisCachePath',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SESSIONNAME', 'PSExecutionPolicyPreference',
  '__COMPAT_LAYER', '__PSLockdownPolicy', 'PROCESSOR_ARCHITEW6432', 'PSDisableModuleAnalysisCacheCleanup']
  .map(key => key.toUpperCase()));
const normalize = env => Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
const describe = keys => ({ keyCount: keys.length, osKeys: keys.filter(key => LOGGABLE.has(key)),
  otherKeyCount: keys.filter(key => !LOGGABLE.has(key)).length });
const emit = record => console.log(JSON.stringify({ diagnostic: 'windows-env-bisect', ...record }));
const passed = result => result.status === 'pass';

function environments(home, inherited = process.env) {
  const system = inherited.SystemRoot || 'C:\\Windows';
  const modules = path.join(system, 'System32/WindowsPowerShell/v1.0/Modules');
  const profile = path.resolve(inherited.USERPROFILE || os.homedir());
  const drive = path.parse(profile).root.replace(/[\\/]+$/, '');
  const cache = path.join(home, 'ModuleAnalysisCache');
  // Exact safeEnv(home, true) snapshot from codex-scope-wrappers.test.cjs.
  // No bootstrap/session facts are needed for the first Join-Path.
  const minimal = normalize({ SystemRoot: inherited.SystemRoot || '',
    ...Object.fromEntries(OS_KEYS.flatMap(key => inherited[key] === undefined ? [] : [[key, inherited[key]]])),
    PATH: [path.dirname(home), path.join(system, 'System32'), path.dirname(process.execPath), path.dirname(modules)].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', PSModulePath: modules, PSModuleAnalysisCachePath: cache,
    USERPROFILE: profile, HOMEDRIVE: drive, HOMEPATH: profile.slice(drive.length), CODEX_HOME: path.join(home, '.codex') });
  // Preserve inherited OS values, including native home/temp/console/module facts.
  // Only the module-analysis cache is redirected; never touch the real user's cache.
  const native = normalize(Object.fromEntries(Object.entries(inherited)
    .filter(([key]) => key.toUpperCase() === 'SESSIONNAME' || !PRIVATE_KEY.test(key))));
  native.PSMODULEANALYSISCACHEPATH = cache;
  return { minimal, native, system, modules, cache };
}

function changedKeys(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => left[key] !== right[key]).sort();
}

function patched(base, source, keys) {
  const env = { ...base };
  for (const key of keys) {
    if (Object.hasOwn(source, key)) env[key] = source[key];
    else delete env[key];
  }
  return env;
}

function ownedRoot(root) {
  const resolved = fs.realpathSync.native(root), temp = fs.realpathSync.native(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('quota-scope-wrapper-') ||
      path.basename(root) !== path.basename(resolved) || fs.lstatSync(root).isSymbolicLink()) throw new Error('root-ownership');
  return resolved;
}

// Deterministic ddmin over replacements AND deletions, with a passing endpoint.
// Reserve two observations for a final matched candidate/minimal confirmation.
async function bisect(keys, test, available) {
  let candidate = keys, partitions = 2, complete = false;
  while (candidate.length > 1 && available() > 2) {
    const chunks = [];
    for (let i = 0; i < partitions; i++) {
      chunks.push(candidate.slice(Math.floor(i * candidate.length / partitions), Math.floor((i + 1) * candidate.length / partitions)));
    }
    const trials = [...chunks, ...(partitions > 2 ? chunks.map(chunk => candidate.filter(key => !chunk.includes(key))) : [])];
    let reduced = false, exhausted = false;
    for (const trial of trials) {
      if (available() <= 2) { exhausted = true; break; }
      if (passed(await test(trial))) {
        candidate = trial; partitions = Math.max(2, partitions - 1); reduced = true; break;
      }
    }
    if (reduced) continue;
    if (exhausted) break;
    if (partitions >= candidate.length) { complete = true; break; }
    partitions = Math.min(candidate.length, partitions * 2);
  }
  return { keys: candidate, complete: complete || candidate.length <= 1 };
}

function probe(executable, script, env, cwd, options, children) {
  return new Promise(resolve => {
    const started = Date.now();
    let child, hard, done = false, output = '', stderrBytes = 0, timedOut = false;
    const finish = error => {
      if (done) return;
      done = true; clearTimeout(hard);
      const begin = /^ENTRY\r?$/m.test(output), end = /^END\r?$/m.test(output);
      resolve({ status: timedOut || error?.killed ? 'timeout' : error ? 'process-error' : stderrBytes ? 'powershell-error' : begin && end ? 'pass' : 'missing-marker',
        ms: Date.now() - started, begin, end, stderrBytes, exit: error ? Number.isInteger(error.code) ? error.code : null : 0 });
    };
    const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'];
    if (options.nonInteractive) args.push('-NonInteractive');
    args.push(...(options.command ? ['-Command', ". '" + script.replace(/'/g, "''") + "'"] : ['-File', script]));
    try {
      child = execFile(executable, args, { env, cwd, windowsHide: options.windowsHide !== false,
        timeout: CHILD_MS - 250, maxBuffer: 4096 }, finish);
      children.add(child);
      child.once('close', () => children.delete(child));
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => { output = (output + data).slice(0, 4096); });
      child.stderr.on('data', data => { stderrBytes += data.length; });
      // Match execFile fixture stdin (open pipe); never print stdout/stderr or error text.
      hard = setTimeout(() => {
        timedOut = true;
        if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish({ killed: true });
      }, CHILD_MS);
    } catch (error) { finish(error); }
  });
}

async function main() {
  if (process.platform !== 'win32') { emit({ status: 'skip-non-windows' }); return; }
  const started = Date.now(), deadline = started + GLOBAL_MS, children = new Set();
  let root, watchdog, probes = 0, extra = 0, expired = false;
  // Read test configuration separately; never forward AGENTRIX or account variables.
  const testTimeoutScale = Math.max(1, Number(process.env.AGENTRIX_TEST_TIMEOUT_SCALE) || 1);
  const stopOwn = () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    }
  };
  try {
    // Raw TEMP (including CI's short alias) intentionally matches the wrapper fixture.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-scope-wrapper-'));
    ownedRoot(root);
    const home = path.join(root, 'home'), integration = path.join(root, 'integration');
    fs.mkdirSync(home); fs.mkdirSync(integration);
    fs.writeFileSync(path.join(integration, 'bootstrap.ps1'), '');
    const { minimal, native, system, modules, cache } = environments(home);
    minimal.QUOTA_INTEGRATION = integration; native.QUOTA_INTEGRATION = integration;
    if (path.dirname(cache) !== home || path.dirname(path.resolve(home)) !== root) throw new Error('cache-ownership');
    const executable = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    if (!fs.statSync(modules).isDirectory() || !fs.statSync(executable).isFile()) throw new Error('setup');
    const script = path.join(root, 'probe.ps1'), ioScript = path.join(root, 'io.ps1'), systemScript = path.join(root, 'system.ps1');
    fs.writeFileSync(script, "[Console]::WriteLine('ENTRY')\n$p=Join-Path $env:QUOTA_INTEGRATION 'bootstrap.ps1'\n[Console]::WriteLine('END')\n");
    fs.writeFileSync(ioScript, "[Console]::WriteLine('ENTRY')\n$p=[System.IO.Path]::Combine($env:QUOTA_INTEGRATION, 'bootstrap.ps1')\n[Console]::WriteLine('END')\n");
    fs.writeFileSync(systemScript, "[Console]::WriteLine('ENTRY')\n$p=Join-Path $env:SystemRoot 'System32'\n[Console]::WriteLine('END')\n");
    watchdog = setTimeout(() => { expired = true; stopOwn(); }, Math.max(0, deadline - Date.now()));
    const differences = changedKeys(minimal, native);
    emit({ status: 'start', childDeadlineMs: CHILD_MS, globalDeadlineMs: GLOBAL_MS, maxProbes: 2 + EXTRA_PROBES,
      testTimeoutScale, cache: 'owned-cold-each-probe', ...describe(differences) });
    const available = () => expired || children.size || Date.now() + CHILD_MS + 1500 >= deadline ? 0 : EXTRA_PROBES - extra;
    const run = async (label, env, keys = [], options = {}, initial = false) => {
      if ((!initial && available() <= 0) || expired || children.size) return { status: 'budget-exhausted' };
      if (!initial) extra++;
      probes++;
      // Same cache path, cold contents: no cross-probe cache warming confound.
      const canonicalRoot = ownedRoot(root);
      if (path.dirname(path.resolve(home)) !== root || fs.realpathSync.native(home) !== path.join(canonicalRoot, 'home') ||
          fs.lstatSync(home).isSymbolicLink()) throw new Error('home-ownership');
      fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home);
      let childScript = options.io ? ioScript : options.systemRoot ? systemScript : script, cwd = root;
      if (options.canonical) {
        // Only these three aliases change; HOME/PATH/module-cache values stay identical.
        childScript = path.join(canonicalRoot, 'probe.ps1'); cwd = canonicalRoot;
        env = { ...env, QUOTA_INTEGRATION: path.join(canonicalRoot, 'integration') };
      }
      const result = await probe(executable, childScript, env, cwd, options, children);
      emit({ probe: probes, label, ...describe(keys), ...result });
      return result;
    };
    const small = await run('minimal-file', minimal, [], {}, true);
    const inherited = await run('inherited-file', native, differences, {}, true);
    if (!passed(small) && passed(inherited)) {
      const reduced = await bisect(differences, keys => run('env-delta', patched(minimal, native, keys), keys), available);
      const candidate = await run('confirm-candidate-file', patched(minimal, native, reduced.keys), reduced.keys);
      const baseline = await run('confirm-minimal-file', minimal);
      const confirmed = passed(candidate) && baseline.status !== 'budget-exhausted' && !passed(baseline);
      emit({ status: confirmed ? 'matched-environment-group' : 'environment-group-unconfirmed',
        reductionComplete: reduced.complete, ...describe(reduced.keys),
        firstJoinHangReproduced: small.status === 'timeout' && small.begin && !small.end &&
          baseline.status === 'timeout' && baseline.begin && !baseline.end,
        candidatePass: passed(candidate), minimalPass: passed(baseline) });
    } else if (!passed(small) && !passed(inherited)) {
      // Change exactly one startup dimension at a time, always against the initial -File pair.
      for (const [label, options] of [
        ['file-system-root-join', { systemRoot: true }],
        ['file-canonical-root', { canonical: true }],
        ['command-dot-source', { command: true }],
        ['file-windowsHide-false', { windowsHide: false }],
        ['file-io-combine', { io: true }],
        ['file-cache-nul', { nulCache: true }],
      ]) {
        for (const [name, env] of [['minimal', minimal], ['inherited', native]]) {
          if (!available()) break;
          await run(name + '-' + label, options.nulCache ? { ...env, PSMODULEANALYSISCACHEPATH: 'NUL' } : env,
            options.nulCache ? ['PSMODULEANALYSISCACHEPATH'] : [], options);
        }
      }
      emit({ status: 'no-passing-inherited-file-control-no-environment-cause-established' });
    } else {
      emit({ status: passed(inherited) ? 'both-file-controls-pass-not-reproduced' : 'minimal-passes-inherited-fails' });
    }
    emit({ status: 'complete', probes, ms: Date.now() - started });
  } catch {
    emit({ status: 'setup-or-probe-error', probes });
  } finally {
    clearTimeout(watchdog); stopOwn();
    // Allow only our captured child handles to close; no process enumeration or tree-kill.
    if (children.size) await Promise.race([
      Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve)))),
      new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - Date.now())))),
    ]);
    for (const child of children) child.unref();
    try {
      if (root) {
        ownedRoot(root);
        fs.rmSync(root, { recursive: true, force: true });
      }
      emit({ status: children.size ? 'owned-child-cleanup-unconfirmed' : 'cleanup-complete' });
    } catch { emit({ status: 'owned-fixture-cleanup-error' }); }
  }
}

if (require.main === module) main().catch(() => emit({ status: 'diagnostic-error' }));
module.exports = { environments, changedKeys, patched, bisect, probe, ownedRoot, main };
