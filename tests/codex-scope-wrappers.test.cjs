const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { timeoutScale } = require('../scripts/wait.mjs');
const { accountEnvironment } = require('../integration/codex-account-scope.cjs');
const { createEventServer } = require('../electron/events.cjs');
const exec = promisify(execFile), integration = path.resolve(__dirname, '../integration');
const scopeHelper = path.join(integration, 'codex-account-scope.cjs');
const cases = [
  { args: [], safe: true },
  { args: ['-m', 'gpt-test'], safe: true },
  { args: ['--model=gpt-test', '-c', 'model_reasoning_effort=high', '-c', 'service_tier="fast"', 'opaque 中文 prompt'], safe: true },
  { args: ['resume', '--last'], safe: true },
  { args: ['-m', 'gpt-test', '--profile', 'work'], safe: false },
  { args: ['-m', 'gpt-test', '-c', 'model_provider="relay"'], safe: false },
  { args: ['-c', 'model_reasoning_effort=high', '-c', 'cli_auth_credentials_store="keyring"'], safe: false },
  { args: ['-m'], safe: false },
  { args: ['-m', 'gpt-test'], change: 'profile', safe: false },
  { args: ['-m', 'gpt-test'], change: 'home', safe: false },
];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-scope-wrapper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  return { root, home };
}
const powershellModules = process.platform === 'win32' &&
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules');
if (powershellModules) assert.ok(fs.statSync(powershellModules).isDirectory(), 'system Windows PowerShell modules directory must exist');
const nativeProfile = process.platform === 'win32' && path.resolve(process.env.USERPROFILE || os.homedir());
const nativeDrive = nativeProfile && path.parse(nativeProfile).root.replace(/[\\/]+$/, '');
// Windows process.env resolves these explicit OS names case-insensitively.
const nativeWindowsOS = powershellModules ? Object.fromEntries([
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'OS',
  'ProgramData', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PUBLIC',
  'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'COMPUTERNAME', 'LOGONSERVER',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) : {};
const safeEnv = (home, nativeShell = false) => ({ SystemRoot: process.env.SystemRoot || '', ...nativeWindowsOS,
  PATH: powershellModules ? [path.dirname(home), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    path.dirname(process.execPath), path.dirname(powershellModules)].join(path.delimiter) : process.env.PATH || process.env.Path || '',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ...(powershellModules ? { PSModulePath: powershellModules } : {}),
  ...(powershellModules ? { PSModuleAnalysisCachePath: path.join(home, 'ModuleAnalysisCache') } : {}),
  ...(powershellModules && nativeShell ? {} : { HOME: home }), USERPROFILE: nativeProfile || home, HOMEDRIVE: nativeDrive || 'C:',
  HOMEPATH: nativeProfile ? nativeProfile.slice(nativeDrive.length) : '\\Users\\fixture', CODEX_HOME: path.join(home, '.codex') });

test('PowerShell and the cmd agent shim classify complete argv and forward it unchanged to an offline executable',
  { skip: process.platform !== 'win32', timeout: 60000 * timeoutScale }, async t => {
    const { root, home } = fixture(t), exe = path.join(root, 'codex.exe');
    const ciTrace = process.env.CI === 'true';
    const phase = stage => ciTrace ? `[Console]::WriteLine('TRACE=${stage}')` : '';
    const probeIntegration = ciTrace ? path.join(root, 'integration') : integration;
    if (ciTrace) {
      fs.mkdirSync(probeIntegration);
      fs.copyFileSync(path.join(integration, 'refresh-path.ps1'), path.join(probeIntegration, 'refresh-path.ps1'));
      let subject = fs.readFileSync(path.join(integration, 'bootstrap.ps1'), 'utf8');
      const eol = subject.includes('\r\n') ? '\r\n' : '\n';
      for (const [anchor, stages] of [
        ["[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)", ['input-encoding-before']],
        ["[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)", ['input-encoding-after', 'output-encoding-before']],
        ["$OutputEncoding = [Console]::OutputEncoding", ['output-encoding-after', 'pipeline-encoding-before']],
        [". (Join-Path $PSScriptRoot 'refresh-path.ps1')", ['pipeline-encoding-after', 'refresh-path-before']],
        ["$global:AgentrixSession = Get-Content -LiteralPath $env:AGENTRIX_BOOTSTRAP -Raw -Encoding UTF8 | ConvertFrom-Json", ['refresh-path-after', 'session-json-before']],
        ["$global:AgentrixEventSequence = 0", ['session-json-after']],
        ["$global:AgentrixCodexCommand = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source", ['codex-discovery-before']],
        ["$global:AgentrixCodexExecutable = $global:AgentrixCodexCommand", ['codex-discovery-after', 'codex-resolver-before']],
        ["$global:AgentrixClaudeCommand = Get-Command claude -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source", ['codex-resolver-after', 'claude-discovery-before']],
        ["# Windows PowerShell 5 strips embedded quotes when forwarding native arguments.", ['claude-discovery-after']],
        ["if ($global:AgentrixAgentOnly) { return }", ['agent-only-before']],
      ]) {
        assert.equal(subject.split(eol).filter(line => line === anchor).length, 1, 'unique bootstrap trace anchor');
        subject = subject.replace(anchor, [...stages.map(stage => phase('bootstrap-' + stage)), anchor].join(eol));
      }
      fs.writeFileSync(path.join(probeIntegration, 'bootstrap.ps1'), subject);
    }
    const source = path.join(root, 'fixture.cs');
    fs.writeFileSync(source, `using System; using System.Linq; using System.Web.Script.Serialization;
class Fixture { static int Main(string[] args) {
${ciTrace ? 'Console.WriteLine("TRACE=executable-entry");' : ''}
var expected = new JavaScriptSerializer().Deserialize<string[]>(Environment.GetEnvironmentVariable("QUOTA_EXPECTED"));
bool ok = args.Length == expected.Length + 4 && args[0] == "-c" && args[2] == "-c"
 && args[3] == "tui.terminal_title=[\\\"session-id\\\"]" && args.Skip(4).SequenceEqual(expected);
Console.WriteLine(ok ? "FORWARD_OK" : "FORWARD_FAILED"); return ok ? 3 : 7;
}}`);
    const system = process.env.SystemRoot || 'C:\\Windows';
    await exec(path.join(system, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${exe}`, source], { windowsHide: true, timeout: 10000 * timeoutScale });
    fs.copyFileSync(exe, path.join(root, 'claude.exe'));
    const bootstrap = path.join(root, 'bootstrap.json');
    const events = [], server = await createEventServer(event => events.push(event));
    t.after(() => server.close());
    fs.writeFileSync(bootstrap, JSON.stringify({ projectPath: root, projectId: 'quota-fixture', sessionKey: 'fixture-key',
      pipeName: server.name, nodePath: process.execPath, accountScopeHelper: scopeHelper }));
    const script = path.join(root, 'probe.ps1');
    fs.writeFileSync(script, `
${phase('script-entry')}
$env:AGENTRIX_AGENT_ONLY = '1'
${phase('bootstrap-path-before')}
$quotaBootstrapPath = (Join-Path $env:QUOTA_INTEGRATION 'bootstrap.ps1')
${phase('bootstrap-path-after')}
${phase('bootstrap-source-before')}
. $quotaBootstrapPath
${phase('bootstrap-agent-only-after')}
${phase('bootstrap-return')}
${ciTrace ? `
$global:QuotaOriginalAccountLaunch = (Get-Item Function:Get-AgentrixAccountLaunch).ScriptBlock
function global:Get-AgentrixAccountLaunch($arguments) {
  ${phase('account-proof-before')}
  & $global:QuotaOriginalAccountLaunch $arguments
  ${phase('account-proof-after')}
}
` : ''}
$global:AgentrixCodexCommand = $env:QUOTA_EXE
$global:AgentrixCodexExecutable = $env:QUOTA_EXE
$global:AgentrixCodexPrefix = @()
function global:Send-AgentrixEvent {
  param($Type, $ExitCode = 0, $Agent = 'codex', $Command = '', $AccountLaunch = '')
  if ($Type -eq 'codex-started') { Write-Output ('SCOPE=' + $AccountLaunch); Write-Output ('COMMAND=' + $Command) }
}
if ($env:QUOTA_CHANGE -eq 'profile') { $env:CODEX_PROFILE = 'fixture' }
if ($env:QUOTA_CHANGE -eq 'home') { $env:CODEX_HOME = Join-Path ([IO.Path]::GetDirectoryName($env:CODEX_HOME)) 'other' }
$caseArgs = ConvertFrom-Json $env:QUOTA_EXPECTED
${phase('codex-before')}
codex @caseArgs
${phase('codex-after')}
if ($global:LASTEXITCODE -ne 3) { exit 9 }
`);
    for (const [i, item] of cases.entries()) {
      const env = { ...safeEnv(home, true), AGENTRIX_BOOTSTRAP: bootstrap, QUOTA_INTEGRATION: probeIntegration,
        QUOTA_EXE: exe, QUOTA_EXPECTED: JSON.stringify(item.args), QUOTA_CHANGE: item.change || '' };
      env.AGENTRIX_ACCOUNT_BASELINE = JSON.stringify(accountEnvironment(env));
      const result = await exec(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { env, cwd: root, windowsHide: true, timeout: 7000 * timeoutScale, maxBuffer: 4096 });
      assert.equal(result.stderr, '', `PowerShell case ${i} must be silent`);
      assert.ok(result.stdout.includes('FORWARD_OK'), `PowerShell forwarding case ${i}`);
      assert.ok(result.stdout.includes(`SCOPE=${item.safe ? 'model-only-v1' : 'unavailable'}`), `PowerShell proof case ${i}`);
      const command = i === 2 ? '' : item.args[0] || '';
      assert.ok(result.stdout.includes(`COMMAND=${command}`), `first-word detection case ${i}`);
    }
    // Execute cmd's actual shim and real event serialization, using only the fixture executable/pipe.
    const env = { ...safeEnv(home, true), PATH: root + path.delimiter + safeEnv(home, true).PATH,
      AGENTRIX_BOOTSTRAP: bootstrap, QUOTA_EXPECTED: JSON.stringify(['-m', 'gpt-test']) };
    env.AGENTRIX_ACCOUNT_BASELINE = JSON.stringify(accountEnvironment(env));
    const result = await exec(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(integration, 'agent.ps1'), 'codex', '-m', 'gpt-test'],
      { env, cwd: root, windowsHide: true, timeout: 7000 * timeoutScale, maxBuffer: 4096 }).catch(error => {
      assert.equal(error.code, 3, 'offline fixture exit status passes through cmd shim'); return error;
    });
    assert.equal(result.stderr, '');
    for (let attempt = 0; attempt < 20 * timeoutScale && !events.some(event => event.type === 'codex-exited'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    const started = events.find(event => event.type === 'codex-started');
    assert.equal(started?.accountLaunch, 'model-only-v1'); assert.equal(started.command, '-m');
    assert.equal(events.find(event => event.type === 'codex-exited')?.exitCode, 3, 'fixture returns 3 only when argv was forwarded intact');
    assert.equal(Object.hasOwn(started, 'args'), false); assert.equal(Object.hasOwn(started, 'prompt'), false);
  });

// CI may select a supported Bash without changing the product's shell selection.
const bash = process.env.AGENTRIX_TEST_BASH;
if (bash) assert.ok(fs.existsSync(bash), 'AGENTRIX_TEST_BASH must name an installed Bash');
for (const kind of ['bash', 'zsh']) {
  const shell = (kind === 'bash' && bash) || (process.platform === 'win32' ? kind === 'bash' && 'C:/Program Files/Git/bin/bash.exe' : `/bin/${kind}`);
  test(`${kind} wrapper proves alias and user flags together, emits only scope, and preserves forwarding`,
    { skip: !shell || !fs.existsSync(shell), timeout: 60000 * timeoutScale }, async t => {
      const { root, home } = fixture(t), probe = path.join(root, 'probe.sh');
      // LF copy makes the same Bash source executable by Git Bash on a CRLF checkout.
      const copy = path.join(root, `integration.${kind}`);
      fs.writeFileSync(copy, fs.readFileSync(path.join(integration, `${kind === 'bash' ? 'bash-integration.bash' : 'zsh-integration.zsh'}`), 'utf8').replace(/\r\n/g, '\n'));
      const recorder = path.join(root, 'forward.cjs');
      fs.writeFileSync(recorder, `const a=process.argv.slice(2),e=JSON.parse(process.env.QUOTA_EXPECTED),prefix=process.env.QUOTA_ALIAS?['--profile','work']:[],n=prefix.length;
const ok=a.length===e.length+4+n&&prefix.every((v,i)=>a[i]===v)&&a[n]==='-c'&&a[n+2]==='-c'&&a[n+3]==='tui.terminal_title=["session-id"]'&&a.slice(n+4).every((v,i)=>v===e[i]);
process.stdout.write(ok?'FORWARD_OK\\n':'FORWARD_FAILED\\n');process.exitCode=ok?3:7;`);
      const program = path.join(root, 'codex-fixture');
      fs.writeFileSync(program, '#!/bin/sh\nexec "$QUOTA_NODE" "$QUOTA_RECORDER" "$@"\n', { mode: 0o755 });
      fs.writeFileSync(probe, `
export AGENTRIX_ACCOUNT_BASELINE=$("$QUOTA_NODE" -e 'process.stdout.write(JSON.stringify(require(process.env.QUOTA_SCOPE).accountEnvironment(process.env)))')
builtin source "$QUOTA_COPY" ${kind === 'zsh' ? 'zshrc' : ''}
__pg_send() { if [[ $1 == codex-started ]]; then printf 'SCOPE=%s\\nCOMMAND=%s\\n' "$5" "$4"; fi; }
__pg_program() { ${kind === 'bash' ? '__pg_words' : 'reply'}=("$QUOTA_PROGRAM"); if [[ $QUOTA_ALIAS == profile ]]; then ${kind === 'bash' ? '__pg_words' : 'reply'}+=(--profile work); fi; }
if [[ $QUOTA_CHANGE == profile ]]; then export CODEX_PROFILE=fixture; fi
if [[ $QUOTA_CHANGE == home ]]; then export CODEX_HOME="$HOME/other"; fi
codex "$@"
[[ $? == 3 ]]
`);
      for (const [i, item] of [...cases, { args: ['-m', 'gpt-test'], alias: 'profile', safe: false }].entries()) {
        const env = { ...safeEnv(home), AGENTRIX_NODE: process.execPath, AGENTRIX_EVENT_HELPER: path.join(integration, 'agent-event.cjs').replace(/\\/g, '/'),
          AGENTRIX_START_DIR: root, QUOTA_NODE: process.execPath, QUOTA_SCOPE: scopeHelper, QUOTA_COPY: copy,
          QUOTA_PROGRAM: program, QUOTA_RECORDER: recorder, QUOTA_EXPECTED: JSON.stringify(item.args),
          QUOTA_CHANGE: item.change || '', QUOTA_ALIAS: item.alias || '' };
        const result = await exec(shell, kind === 'bash' ? ['--noprofile', '--norc', probe, ...item.args] : ['-f', probe, ...item.args],
          { env, cwd: root, windowsHide: true, timeout: 7000 * timeoutScale, maxBuffer: 4096 });
        assert.equal(result.stderr, '', `${kind} case ${i} must be silent`);
        assert.ok(result.stdout.includes('FORWARD_OK'), `${kind} forwarding case ${i}`);
        assert.ok(result.stdout.includes(`SCOPE=${item.safe ? 'model-only-v1' : 'unavailable'}`), `${kind} proof case ${i}`);
      }
    });
}
