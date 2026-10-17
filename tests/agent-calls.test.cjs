const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentCalls, codexCall } = require('../electron/features/agents/agent-calls.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');

const use = (id, name = 'Agent', input = {}) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, toolUseResult = {}, is_error = false) => ({ type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'placeholder', is_error }] } });
const notice = (id, status = 'completed', array = false) => {
  const body = `<task-notification><task-id>task</task-id><tool-use-id>${id}</tool-use-id><status>${status}</status><summary>Placeholder</summary></task-notification>`;
  return { type: 'user', message: { content: array ? [{ type: 'text', text: body }] : body } };
};
const command = `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -c service_tier='"fast"' - < '<home>/scratch/prompt.md'`;

test('Codex shell flags preserve model, effort, fast, custom provider and only the prompt filename', () => {
  assert.deepEqual(codexCall(command), { model: 'gpt-6.1-sol', effort: 'high', fast: true, provider: 'openai', task: 'prompt.md' });
  assert.deepEqual(codexCall(`cd '<home>/repo' && "C:\\tools\\codex.cmd" exec --model=gpt-6.1-sol --config 'model_reasoning_effort="medium"' -c 'model_provider="azure"' --config=service_tier=standard`),
    { model: 'gpt-6.1-sol', effort: 'medium', fast: false, provider: 'azure', task: '' });
  assert.deepEqual(codexCall('codex exec -c model=gpt-6.1-sol'), { model: 'gpt-6.1-sol', effort: null, fast: null, provider: 'openai', task: '' });
  assert.equal(codexCall('codex --version'), null);
  assert.equal(codexCall('git status'), null);
  assert.equal(codexCall('echo codex exec -m gpt-6.1-sol'), null);
  assert.equal(codexCall(`printf '%s' 'codex exec -m gpt-6.1-sol'`), null);
  assert.equal(codexCall('cd <home>/repo&&codex exec -m gpt-6.1-sol\necho done').model, 'gpt-6.1-sol');
});

test('foreground Agent and Codex runs finish on tool_result and replay never double counts or reopens them', () => {
  const meter = new UsageMeter('claude', { provider: 'Anthropic' });
  const agent = use('a', 'Agent', { model: 'sonnet', description: 'Polish the card' });
  assert.equal(meter.apply(agent), true);
  assert.equal(meter.apply(agent), false);
  meter.apply(use('b', 'Bash', { command, description: 'Implement parser' }));
  assert.deepEqual(meter.snapshot().calls, [
    { agent: 'Claude Code', provider: 'Anthropic', model: 'sonnet', effort: null, fast: null, runs: 1, running: 1, tasks: ['Polish the card'] },
    { agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'high', fast: true, runs: 1, running: 1, tasks: ['Implement parser'] },
  ]);
  meter.apply(result('a', { resolvedModel: 'claude-sonnet-5-5' }));
  meter.apply(result('b'));
  meter.apply(agent);
  assert.deepEqual(meter.snapshot().calls.map(call => [call.model, call.runs, call.running]), [['claude-sonnet-5-5', 1, 0], ['gpt-6.1-sol', 1, 0]]);
  meter.reset();
  assert.deepEqual(meter.snapshot().calls, []);
});

test('background launch receipts stay running until completed, failed or killed notifications', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const calls = new AgentCalls();
    calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: 'true' }));
    calls.apply(use('b', 'Bash', { command, run_in_background: true }));
    calls.apply(result('a', { isAsync: true, status: 'async_launched', resolvedModel: 'claude-sonnet-5-5', agentId: 'placeholder' }));
    calls.apply(result('b', { backgroundTaskId: 'placeholder' }));
    assert.deepEqual(calls.snapshot('Anthropic').map(call => call.running), [1, 1]);
    calls.apply(notice('a', 'running'));
    assert.equal(calls.snapshot('Anthropic')[0].running, 1);
    assert.equal(calls.apply(notice('a', status)), true);
    assert.equal(calls.apply(notice('b', status, true)), true);
    assert.equal(calls.apply(notice('b', status)), false);
    // A late or duplicate launch receipt must not resurrect a finished call.
    calls.apply(result('a', { isAsync: true }));
    assert.deepEqual(calls.snapshot('Anthropic').map(call => call.running), [0, 0]);
  }
});

test('background Codex runs finish once on queue enqueue, matching either notification id', () => {
  for (const omit of ['', 'tool-use-id', 'task-id']) {
    const calls = new AgentCalls();
    const id = 'toolu_011S79Xo9hAEtCJPRLkByEb9';
    calls.apply(use(id, 'Bash', { command, run_in_background: true }));
    calls.apply(result(id, { backgroundTaskId: 'b1m86oomf' }));
    const queued = {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-10-17T00:47:36.711Z',
      sessionId: '<session>',
      content: '<task-notification>\n<task-id>b1m86oomf</task-id>\n<tool-use-id>toolu_011S79Xo9hAEtCJPRLkByEb9</tool-use-id>\n<output-file><home>\\tasks\\b1m86oomf.output</output-file>\n<status>completed</status>\n<summary>Background command "…" completed (exit code 0)</summary>\n</task-notification>',
    };
    if (omit) queued.content = queued.content.replace(new RegExp(`<${omit}>[^<]*</${omit}>\\n`), '');
    for (const operation of ['dequeue', 'remove']) assert.equal(calls.apply({ ...queued, operation }), false);
    assert.equal(calls.snapshot()[0].running, 1);
    assert.equal(calls.apply(queued), true);
    assert.deepEqual(calls.snapshot().map(call => [call.running, call.runs]), [[0, 1]]);
    assert.equal(calls.apply(queued), false);
    for (const operation of ['dequeue', 'remove']) assert.equal(calls.apply({ ...queued, operation }), false);
    for (const content of [queued.content, [{ type: 'text', text: queued.content }]]) {
      assert.equal(calls.apply({ type: 'user', message: { content } }), false);
    }
    calls.apply(result(id, { backgroundTaskId: 'b1m86oomf' }));
    assert.deepEqual(calls.snapshot().map(call => [call.running, call.runs]), [[0, 1]]);
  }
});

test('background Agent runs finish once on queue enqueue for each terminal status', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const calls = new AgentCalls();
    calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
    calls.apply(result('a', { isAsync: true, status: 'async_launched', agentId: 'child' }));
    const queued = {
      type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-17T00:47:36.711Z', sessionId: '<session>',
      content: notice('a', status).message.content,
    };
    assert.equal(calls.snapshot()[0].running, 1);
    assert.equal(calls.apply(queued), true);
    assert.deepEqual(calls.snapshot().map(call => [call.running, call.runs]), [[0, 1]]);
    assert.equal(calls.apply(queued), false);
    assert.equal(calls.apply(notice('a', status, true)), false);
    for (const operation of ['dequeue', 'remove']) assert.equal(calls.apply({ ...queued, operation }), false);
    assert.deepEqual(calls.snapshot().map(call => [call.running, call.runs]), [[0, 1]]);
  }
});

test('auto-backgrounded calls and failed launches follow the actual result', () => {
  const calls = new AgentCalls();
  calls.apply(use('a', 'Agent'));
  calls.apply(result('a', { isAsync: true }));
  calls.apply(use('b', 'Bash', { command }));
  calls.apply(result('b', { backgroundTaskId: 'placeholder' }));
  assert.deepEqual(calls.snapshot().map(call => call.running), [1, 1]);
  calls.apply(use('c', 'Agent', { run_in_background: true }));
  calls.apply(result('c', {}, true));
  assert.equal(calls.snapshot()[0].running, 1, 'the failed launch is no longer running in the inherited-model group');
  calls.apply(notice('a')); calls.apply(notice('b'));
  assert.ok(calls.snapshot().every(call => call.running === 0));
});

test('routes group by every route field, keep the latest five tasks and inherit the current Claude provider', () => {
  const meter = new UsageMeter('claude', { provider: 'relay.example' });
  for (let i = 0; i < 7; i++) {
    meter.apply(use(`a${i}`, 'Agent', { model: 'claude-sonnet-5-5', description: `Task ${i}` }));
    if (i < 6) meter.apply(result(`a${i}`));
  }
  assert.deepEqual(meter.snapshot().calls[0], { agent: 'Claude Code', provider: 'relay.example', model: 'claude-sonnet-5-5', effort: null, fast: null, runs: 7, running: 1, tasks: ['Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6'] });
  for (const [id, suffix] of [['b', ''], ['c', ''], ['d', ' -c model_reasoning_effort=low'], ['e', ' -c service_tier=standard'], ['f', ' -c model_provider=azure'], ['g', ' -m gpt-6-astra']]) {
    meter.apply(use(id, 'Bash', { command: command.replace(/ - < .*$/, '') + suffix }));
  }
  meter.apply(result('b'));
  const groups = meter.snapshot().calls;
  assert.equal(groups.length, 6);
  assert.equal(groups[1].runs, 2); assert.equal(groups[1].running, 1);
  assert.equal(groups[4].provider, 'Azure OpenAI');
  meter.provider = 'Anthropic';
  assert.equal(meter.snapshot().calls[0].provider, 'Anthropic');
});

test('sidechains, request blobs, unrelated tools and orphan results do not create calls', () => {
  const calls = new AgentCalls();
  for (const record of [{ ...use('a'), isSidechain: true }, { ...use('b'), type: 'api-request-blob' }, use('c', 'Read'), result('unknown'), notice('unknown')]) assert.equal(calls.apply(record), false);
  assert.deepEqual(calls.snapshot(), []);
  calls.apply(use('a', 'Bash', { command }));
  assert.deepEqual(calls.snapshot()[0].tasks, ['prompt.md']);
});

test('small meta matches toolUseId and bounded subagent tail resolves the real model without polling', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let changes = 0;
  const meter = new UsageMeter('claude', { provider: 'Anthropic', changed: () => changes++ });
  meter.calls.setFolder(folder);
  await fs.writeFile(path.join(folder, 'agent-child.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Placeholder', toolUseId: 'a', model: 'sonnet' }));
  const reply = model => JSON.stringify({ type: 'assistant', isSidechain: true, message: { model } }) + '\n';
  const file = path.join(folder, 'agent-child.jsonl');
  // A huge first line straddles the tail boundary; only complete tail records can be considered.
  await fs.writeFile(file, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } }) + '\n' + reply('claude-sonnet-5-5') + reply('<synthetic>'));
  meter.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
  await meter.calls.work;
  assert.equal(meter.snapshot().calls[0].model, 'claude-sonnet-5-5');
  assert.equal(changes, 1);
  await fs.appendFile(file, reply('claude-haiku-5-5'));
  assert.equal(meter.snapshot().calls[0].model, 'claude-sonnet-5-5', 'no read until another related record arrives');
  meter.apply(notice('a'));
  await meter.calls.work;
  assert.equal(meter.snapshot().calls[0].model, 'claude-haiku-5-5');
  assert.equal(meter.snapshot().calls[0].running, 0);
  assert.equal(changes, 2);
});

test('late metadata, missing tails, result agentId fallback, and reset during a read are safe', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const calls = new AgentCalls(); calls.setFolder(folder);
  calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
  await calls.work;
  await fs.writeFile(path.join(folder, 'agent-late.meta.json'), JSON.stringify({ toolUseId: 'a', model: 'claude-sonnet-5-5' }));
  calls.apply(result('a', { isAsync: true })); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'claude-sonnet-5-5');
  await fs.writeFile(path.join(folder, 'agent-fallback.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } }) + '\n');
  calls.apply(use('b', 'Agent', { model: 'haiku' }));
  calls.apply(result('b', { agentId: 'fallback' })); await calls.work;
  assert.equal(calls.snapshot()[1].model, 'claude-haiku-5-5');
  await fs.writeFile(path.join(folder, 'agent-inherited.meta.json'), JSON.stringify({ toolUseId: 'inherited', model: 'sonnet' }));
  calls.apply(use('inherited')); await calls.work;
  assert.equal(calls.snapshot()[2].model, 'sonnet', 'an inherited parent model yields to the subagent metadata');
  calls.apply(result('inherited', { resolvedModel: 'claude-sonnet-5-5' })); await calls.work;
  assert.equal(calls.snapshot()[0].runs, 2, 'the resolved model merges into its route instead of reverting to the alias');
  assert.equal(calls.snapshot().length, 2);
  calls.apply(use('c')); const pending = calls.work; calls.reset(); await pending;
  assert.deepEqual(calls.snapshot(), []);
});
