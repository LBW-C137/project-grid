const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { summarizeRound, summaryPrompt, cleanSummary, commandFor, claudeReply, codexReply, SYSTEM } = require('../electron/round-summary.cjs');

// A child process that answers through standard output (Claude) or the file named by -o (Codex).
function fakeLaunch({ answer = '', code = 0, hang = false, calls = [] } = {}) {
  return (file, args, options) => {
    const child = new EventEmitter(); child.pid = 0; child.kill = () => child.emit('close', 1);
    child.stdout = new EventEmitter();
    let input = '';
    child.stdin = { on() {}, end(text) {
      input = text; calls.push({ file, args, options, input });
      if (hang) return;
      setImmediate(async () => {
        const output = args.indexOf('-o');
        if (output >= 0) await fs.writeFile(args[output + 1], answer); else child.stdout.emit('data', Buffer.from(answer));
        child.emit('close', code);
      });
    } };
    return child;
  };
}

test('the material goes to the CLI on standard input, never on its command line', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-summary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], secret = 'rm -rf / && echo "$(whoami)"';
  const summary = await summarizeRound({ agent: 'claude', language: 'zh', task: secret, reply: `做完了 ${secret}`, directory, find: () => 'C:\\tools\\claude.exe', launch: fakeLaunch({ answer: '“登录页加好了验证码，测试全过。”\n', calls }) });
  assert.equal(summary, '登录页加好了验证码，测试全过。');
  assert.equal(calls.length, 1); assert.equal(calls[0].file, 'C:\\tools\\claude.exe'); assert.equal(calls[0].options.cwd, directory, 'runs in its own folder, not the project');
  assert.ok(calls[0].args.includes('--no-session-persistence') && calls[0].args.includes(SYSTEM) && calls[0].args[calls[0].args.indexOf('--tools') + 1] === '', 'no session is left behind and no tools are offered');
  assert.ok(!calls[0].args.join(' ').includes('rm -rf') && calls[0].input.includes(secret), 'prompt and reply travel on standard input only');
});

test('Codex answers through its output file, in English when the interface is English', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-summary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const summary = await summarizeRound({ agent: 'codex', language: 'en', task: 'fix the test', reply: 'Fixed it.', directory, find: () => 'codex.exe', launch: fakeLaunch({ answer: '**Fixed the flaky upload test; all runs pass.**', calls }) });
  assert.equal(summary, 'Fixed the flaky upload test; all runs pass.');
  assert.deepEqual(calls[0].args.slice(0, 4), ['exec', '--skip-git-repo-check', '-s', 'read-only']); assert.equal(calls[0].args.at(-1), '-');
  assert.ok(calls[0].input.includes('<assistant_final_reply>') && calls[0].input.includes('one spoken English sentence'));
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('summary-')), [], 'the output file is removed');
});

test('a missing CLI, a failure, silence or an empty reply all fall back to the plain notice', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-summary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = { agent: 'claude', reply: 'done', directory, find: () => 'claude.exe' };
  assert.equal(await summarizeRound({ ...base, find: () => null, launch: () => { throw new Error('must not start'); } }), '');
  assert.equal(await summarizeRound({ ...base, launch: fakeLaunch({ answer: 'x', code: 1 }) }), '');
  assert.equal(await summarizeRound({ ...base, timeout: 30, launch: fakeLaunch({ hang: true }) }), '', 'a CLI that never answers is given up on');
  assert.equal(await summarizeRound({ ...base, reply: '   ', launch: () => { throw new Error('must not start'); } }), '');
  assert.equal(await summarizeRound({ ...base, agent: 'other', launch: () => { throw new Error('must not start'); } }), '');
  assert.equal(await summarizeRound({ ...base, launch: () => { throw new Error('spawn failed'); } }), '');
});

test('prompts bound their material, summaries become one clean line, and a .cmd shim is quoted', () => {
  const prompt = summaryPrompt({ language: 'zh', task: 't'.repeat(5000), reply: 'r'.repeat(20000) + 'END' });
  assert.ok(prompt.length < 7600 && prompt.includes('END') && prompt.includes('<助手最终回复>'), 'the end of a long reply is kept, where conclusions are');
  assert.equal(cleanSummary('\n```\n# `登录页` 已加上 **验证码**\n第二行', 'zh'), '登录页 已加上 验证码');
  assert.equal(cleanSummary('x'.repeat(500), 'zh').length, 60); assert.equal(cleanSummary('', 'en'), '');
  const shim = commandFor('claude', 'C:\\Program Files\\nodejs\\claude.cmd', 'out.txt');
  assert.ok(/cmd(\.exe)?$/i.test(shim.file) && shim.verbatim && shim.args[3].startsWith('""C:\\Program Files\\nodejs\\claude.cmd" "-p"') && shim.args[3].includes('""'), 'each argument is quoted for cmd.exe, the empty one too');
});

test('the final reply of a round is taken from each agent\'s own records', () => {
  assert.deepEqual(claudeReply({ type: 'user', message: { content: 'next task' } }), { reset: true });
  assert.deepEqual(claudeReply({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: ' 改好了。 ' }] } }), { text: '改好了。' });
  assert.equal(claudeReply({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }), null);
  assert.equal(claudeReply({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'child' }] } }), null);
  assert.equal(claudeReply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }), null);
  assert.deepEqual(codexReply({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }), { reset: true });
  assert.deepEqual(codexReply({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: 'All green.' } }), { text: 'All green.' });
  assert.equal(codexReply({ type: 'response_item', payload: { type: 'message' } }), null);
});
