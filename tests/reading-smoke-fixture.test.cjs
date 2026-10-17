const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { cliInputDraft, isCliIdle, hasCliInput, cliHistory, extractCliOutputRows, advanceCliCommand } = require('../src/features/reading/cli-panel.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');

// Read the actual fixture literals without importing its Electron smoke runner.
const filename = path.resolve(__dirname, '../scripts/reading-smoke.mjs');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const literals = {};
const functions = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'idle') {
    assert.ok(ts.isStringLiteral(node.initializer)); literals[node.name.getText(source)] = node.initializer.text;
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'fixturePrompt') literals.fixturePrompt = new Function('path', 'root', `return (${node.initializer.getText(source)});`)(path, path.resolve(__dirname, '..'));
  if (ts.isVariableDeclaration(node) && ['fixtureIdle', 'waitForFixtureIdle'].includes(node.name.getText(source))) functions[node.name.getText(source)] = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
const fixtureIdle = new Function('parseAgentScreen', 'hasCliInput', 'isCliIdle', 'cliInputDraft', `return (${functions.fixtureIdle});`)(parseAgentScreen, hasCliInput, isCliIdle, cliInputDraft);

test('fixture readiness rejects partial frames, helper input and an ordinary shell prompt', () => {
  const frame = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ manual mode on'];
  assert.equal(fixtureIdle(frame), true);
  assert.equal(fixtureIdle(frame.slice(0, 3)), false, 'a drawn box without its footer is not idle');
  assert.equal(fixtureIdle(frame.map(row => row === '❯ ' ? '❯ Clear-Host; Write-Host pending' : row)), false, 'the idle-rendering script itself is not an empty input');
  assert.equal(fixtureIdle(['reading-fixture> ']), false);
  assert.equal(fixtureIdle([]), false);
});

test('reading smoke positions delayed real PTY input inside its frame and preserves later choices', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const { Terminal } = require('@xterm/xterm');
  const pty = require('node-pty');
  assert.ok(literals.fixturePrompt); assert.ok(literals.idle);
  const terminal = new Terminal({ cols: 120, rows: 30 });
  // Unopened xterm parses PTY output and answers cursor queries; no DOM, window or Electron is started.
  // Exercise the fixture's isolation from newer PSReadLine history predictions, including /fix-issue after /fix-issue 42.
  const prediction = "if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('PredictionSource')) { Set-PSReadLineOption -PredictionSource History }; ";
  const shell = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', 'Set-PSReadLineOption -HistorySaveStyle SaveNothing; ' + prediction + literals.fixturePrompt], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: path.dirname(filename), env: process.env,
  });
  let disposed = false;
  const output = shell.onData(data => { if (!disposed) terminal.write(data); });
  const replies = terminal.onData(data => { if (!disposed) shell.write(data); });
  t.after(() => { disposed = true; output.dispose(); replies.dispose(); shell.kill(); terminal.dispose(); });
  const rows = () => Array.from({ length: terminal.rows }, (_, index) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true) ?? '');
  const wait = async (check, label) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(label + '\n' + rows().join('\n'));
  };
  const idleReady = new Function('waitFor', 'fixtureIdle', `return (${functions.waitForFixtureIdle});`)(wait, fixtureIdle);
  shell.write("Write-Output 'FIXTURE_READY'\r");
  await wait(() => rows().some(row => row.trim() === 'FIXTURE_READY'), 'isolated PowerShell starts');
  shell.write(literals.idle);
  await idleReady(rows, 'initial idle');
  assert.equal(terminal.buffer.active.cursorX, 2); assert.equal(terminal.buffer.active.cursorY, 1);
  const typedAt = Date.now(); shell.write('/status');
  await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === '/status', 'actual typed echo recognized by production receipt parser');
  const echoDelay = Date.now() - typedAt;
  assert.ok(echoDelay >= 140, 'preserve the smoke timing assertion through actual delayed input handling');
  t.diagnostic('Exact input echo appeared after ' + echoDelay + ' ms');
  assert.equal(rows()[0], '─'.repeat(40)); assert.equal(rows()[1], '❯ /status');
  assert.equal(rows()[2], '─'.repeat(40)); assert.equal(rows()[3], '  ⏸ manual mode on');
  shell.write('\b'.repeat('/status'.length));
  await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === '', 'clear only the unsubmitted draft');
  // Reproduce settled()'s fire-and-forget idle helper: the composer could be enabled while this script is still
  // physically in PowerShell's input. The next project command must wait for the real frame and its empty draft.
  shell.write('Start-Sleep -Milliseconds 180; ' + literals.idle);
  let redrawReady = false;
  const redraw = idleReady(rows, 'post-status redraw').then(() => { redrawReady = true; });
  await wait(() => !fixtureIdle(rows()), 'idle helper is still executing or in the real input');
  assert.equal(redrawReady, false, 'a partial/helper frame cannot release the next command');
  await redraw;
  assert.ok(fixtureIdle(rows()));
  assert.equal(terminal.buffer.active.cursorX, 2); assert.equal(terminal.buffer.active.cursorY, 1);
  shell.write('/fix-issue 42');
  await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === '/fix-issue 42', 'next project command echoes in the newly empty actual input');
  assert.equal(fixtureIdle(rows()), false, 'a nonempty input cannot satisfy readiness');
  shell.write('\b'.repeat('/fix-issue 42'.length));
  await wait(() => fixtureIdle(rows()), 'clear unsubmitted project draft before helper execution');
  shell.write("Write-Output 'HOOK_EXECUTED'\r");
  await wait(() => rows().some(row => row.startsWith('HOOK_EXECUTED')), 'PowerShell still executes fixture hook commands');
  shell.write(literals.idle); await idleReady(rows, 'before shell commands');
  // Execute the smoke's full slash sequence, including the exact command after Shift+Tab. Observe only the final
  // frame after Enter, as a slow/coalesced renderer can: no tracker gets to depend on transient PowerShell errors.
  for (const command of ['/status', '/fix-issue 42', '/fix-issue', '/unknown-reading-command']) {
    if (command === '/fix-issue') {
      shell.write('\x1b[Z');
      await idleReady(rows, 'Shift+Tab preserves physical input');
    }
    const before = cliHistory('claude', rows(), parseAgentScreen('claude', rows()));
    shell.write(command);
    await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === command, 'physical slash receipt: ' + command);
    shell.write('\r'); // Exactly one Enter, after receipt. Native PowerShell executes the unmodified command.
    await idleReady(rows, 'executed slash result: ' + command);
    const resultRows = rows(), screen = parseAgentScreen('claude', resultRows);
    assert.equal(resultRows[terminal.buffer.active.cursorY].trim(), '❯', 'scrolling keeps the physical cursor in the new box');
    assert.equal(terminal.buffer.active.cursorX, 2);
    const result = extractCliOutputRows('claude', resultRows, screen, command, before);
    assert.ok(result.some(row => row.includes('CommandNotFoundException')), 'retain the real execution error: ' + command);
    assert.ok(result.some(row => row.trim() === '+ ' + command), 'the error belongs to this exact command');
    const started = { id: command, command, at: 0, observed: false, idleSince: null, output: [], dialog: [], before, inputConfirmed: true, submitted: true };
    const next = advanceCliCommand(started, 'claude', resultRows, screen, 100, true);
    assert.equal(advanceCliCommand(next.command, 'claude', resultRows, screen, 500, false).done, true, 'coalesced final frame proves completion');
    // The previous settled() cleared the only result before a publication. Keep the runtime's refusal to invent
    // completion from that empty redraw, even with an exact receipt and one acknowledged Enter.
    const empty = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ manual mode on'];
    const lost = advanceCliCommand(started, 'claude', empty, parseAgentScreen('claude', empty), 100, true);
    assert.equal(advanceCliCommand(lost.command, 'claude', empty, parseAgentScreen('claude', empty), 500, false).done, false);
  }
  for (const [command, expected] of [['!echo reading-fixture', ['reading-fixture']], ['!true', []]]) {
    const before = cliHistory('claude', rows(), parseAgentScreen('claude', rows()));
    shell.write(command);
    await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === command, 'physical bang receipt');
    shell.write('\r'); // One submission only, after actual input receipt; the fixture program executes the payload.
    await idleReady(rows, 'executed shell result');
    const resultRows = rows(), screen = parseAgentScreen('claude', resultRows);
    assert.deepEqual(extractCliOutputRows('claude', resultRows, screen, command, before), expected);
    const started = { id: command, command, at: 0, observed: false, idleSince: null, output: [], dialog: [], before, inputConfirmed: true, submitted: true };
    const next = advanceCliCommand(started, 'claude', resultRows, screen, 100, true);
    assert.equal(advanceCliCommand(next.command, 'claude', resultRows, screen, 500, false).done, true, 'actual accepted Bash result proves completion');
  }
  shell.write("Clear-Host; Write-Host 'Would you like to run the following command?'; Write-Host ''; Write-Host '  $ npm test'; Write-Host ''; Write-Host ([string][char]0x203A + ' 1. Yes, proceed (y)'); Write-Host '  2. No, and tell Codex what to do differently (esc)'; Write-Host ''; Write-Host 'Press enter to confirm or esc to cancel'\r");
  await wait(() => parseAgentScreen('codex', rows()).choice?.title === 'Would you like to run the following command?', 'permission frame renders');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(parseAgentScreen('codex', rows()).choice?.options.length, 2, 'returning to PowerShell does not clear or redraw the choice frame');
  assert.ok(rows().every(row => !/^\s*(?:PS .*?>|reading-fixture>)/.test(row)), 'no extra prompt below fixture states');
});
