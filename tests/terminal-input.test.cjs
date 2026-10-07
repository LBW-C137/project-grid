const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTerminalResponse, acceptShellEvent, SubmissionTracker } = require('../electron/terminal-input.cjs');

test('terminal protocol responses do not dirty an empty shell prompt', () => {
  for (const response of [
    '', '\x1b[1;1R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n',
    '\x1b[8;24;80t', '\x1b[I', '\x1b[O', '\x1b[1;1R\x1b[?1;2c',
    '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b]11;rgb:0000/0000/0000\x1b\\',
    '\x1bP1+r544e=787465726d\x1b\\',
  ]) assert.equal(isTerminalResponse(response), true, JSON.stringify(response));
});

test('real typing, paste, Enter and mixed user input are still treated as input', () => {
  for (const input of ['codex', 'r', 'c', ' ', '\r', '\n', '中文', '\x7f', '\x1b[A', '\x1b[C', '\x1b[1;5C', '\x1b[200~echo hi\x1b[201~', '\x1b[1;1Rwhoami']) {
    assert.equal(isTerminalResponse(input), false, JSON.stringify(input));
  }
});

test('late startup events cannot overwrite prompt-ready or newer Codex events', () => {
  const session = {};
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-ready', sequence: 1 }), false);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), false);
  assert.equal(acceptShellEvent(session, { type: 'codex-started', sequence: 3 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), false);
  assert.equal(acceptShellEvent(session, { type: 'codex-exited', sequence: 4 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 5 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-ready' }), false);
  assert.equal(acceptShellEvent({}, { type: 'shell-ready', sequence: 1 }), true);
});

test('completion is rearmed by submitted input, not typing, empty Enter or terminal reports', () => {
  const tracker = new SubmissionTracker();
  for (const input of ['', '\r', '   \r', '\x1b[I', '\x1b[O', '\x1b[8;24;80t', '\x1b[?1;2c', '\x1b[1;1R', '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b[<0;14;9M', '\x1b[Mabc', '\x1bOP', '\r']) assert.equal(tracker.write(input), false, JSON.stringify(input));
  assert.equal(tracker.write('继续'), false);
  assert.equal(tracker.write('\x1b[D\x1b[C'), false);
  assert.equal(tracker.write('\r'), true);
  assert.equal(tracker.write('\r'), false);
  assert.equal(tracker.write('draft\x15\r'), false, 'cleared input does not submit work');
  assert.equal(tracker.write('修改\x7f\x7f\r'), false);
  assert.equal(tracker.write('cancel\x03\r'), false);
});

test('split multiline paste and editing newlines wait for an explicit submission', () => {
  const tracker = new SubmissionTracker();
  for (const character of '\x1b[200~第一行\r\n第二行\x1b[201~') assert.equal(tracker.write(character), false);
  assert.equal(tracker.write('\n'), false, 'Ctrl+J inserts a newline');
  assert.equal(tracker.write('\x1b\r'), false, 'Alt+Enter inserts a newline');
  assert.equal(tracker.write('\x1b[13;2u'), false, 'modified Enter does not submit');
  assert.equal(tracker.write('\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_'), false, 'native Windows Shift+Enter does not rearm completion');
  assert.equal(tracker.write('\x1b[13u'), true);
  assert.equal(tracker.write('\r'), false);
  assert.equal(tracker.write('\x1b['), false);
  assert.equal(tracker.write('A'), false, 'history selection alone is not a submission');
  assert.equal(tracker.write('\r'), true, 'submitting a recalled prompt is new input');
});

test('Command Prompt prompt markers report the directory, even when split across output chunks', () => {
  const { PromptMarkers, PROMPT_MARKER } = require('../electron/terminal-input.cjs');
  const markers = new PromptMarkers();
  const prompt = directory => `${PROMPT_MARKER}${directory}\x1b\\${directory}>`;
  assert.deepEqual(markers.write(`hello\r\n${prompt('C:\\项目 a')}`), ['C:\\项目 a']);
  const split = prompt('D:\\work\\(x) & y');
  assert.deepEqual(markers.write(split.slice(0, 3)), []);
  assert.deepEqual(markers.write(split.slice(3, 20)), []);
  assert.deepEqual(markers.write(split.slice(20) + 'dir\r\n' + prompt('E:\\')), ['D:\\work\\(x) & y', 'E:\\']);
  assert.deepEqual(markers.write('\x1b]0;title\x07plain output'), [], 'other OSC sequences are ignored');
});

test('input waits while PowerShell asks where the cursor is, then goes in order', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 0; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now, wait: 1500 });
  gate.input('a'); assert.deepEqual(written, ['a'], 'nothing asked: input goes at once');
  gate.output('PS> \x1b[6n');
  gate.input('c'); gate.input('odex\r');
  assert.deepEqual(written, ['a'], 'keys wait for the answer');
  gate.input('\x1b[4;86R');
  assert.deepEqual(written, ['a', '\x1b[4;86R', 'c', 'odex\r'], 'the answer first, then the keys in order');
  gate.output('\x1b[6n'); now = 100; gate.input('x');
  now = 1700; gate.input('y');
  assert.deepEqual(written.slice(4), [], 'still held in order behind x');
  gate.release();
  assert.deepEqual(written.slice(4), ['x', 'y']);
  gate.output('\x1b[6n'); now = 5000; gate.input('z');
  assert.deepEqual(written.slice(6), ['z'], 'an old unanswered question no longer holds input');
  gate.dispose();
});

test('a command restored at a prompt waits for that prompt\'s question and answer, not only an open one', t => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const written = [];
  const gate = new InputGate(data => written.push(data), { wait: 1500, settle: 150 });
  // The prompt event comes before the prompt is drawn: nothing is asked yet, and still the command waits.
  gate.afterPrompt('claude --continue\r');
  assert.deepEqual(written, [], 'held before the question is asked');
  gate.output('PS C:\\p> \x1b[6n'); gate.input('\x1b[5;12R');
  assert.deepEqual(written, ['\x1b[5;12R'], 'after the answer, a moment more');
  // A second question in that moment holds the command until its own answer.
  t.mock.timers.tick(100); gate.output('\x1b[6n');
  t.mock.timers.tick(200); assert.deepEqual(written, ['\x1b[5;12R']);
  gate.input('\x1b[5;12R');
  assert.deepEqual(written, ['\x1b[5;12R', '\x1b[5;12R', 'claude --continue\r'], 'whole, with its first letter');
  // Keys typed while a restored command waits go after it.
  gate.afterPrompt('codex resume abc\r'); gate.input('x');
  gate.output('\x1b[6n'); gate.input('\x1b[1;1R'); t.mock.timers.tick(150);
  assert.deepEqual(written.slice(3), ['\x1b[1;1R', 'codex resume abc\r', 'x']);
  // A shell that never asks (or a window not showing the terminal) holds it no longer than wait.
  gate.afterPrompt('codex\r'); t.mock.timers.tick(1499);
  assert.equal(written.length, 6); t.mock.timers.tick(1);
  assert.deepEqual(written.slice(6), ['codex\r']);
  // A busy window (many terminals starting at once) may answer late: a restored command waits up to patience
  // for an open question, though typed keys would have gone after wait.
  gate.afterPrompt('claude --continue\r'); gate.output('\x1b[6n'); t.mock.timers.tick(5000);
  assert.equal(written.length, 7, 'still waiting for the late answer');
  gate.input('\x1b[2;1R'); t.mock.timers.tick(150);
  assert.deepEqual(written.slice(7), ['\x1b[2;1R', 'claude --continue\r']);
  gate.afterPrompt('codex\r'); gate.output('\x1b[6n'); t.mock.timers.tick(7999);
  assert.equal(written.length, 9); t.mock.timers.tick(1);
  assert.deepEqual(written.slice(9), ['codex\r'], 'an answer that never comes holds it no longer than patience');
  gate.dispose();
});
