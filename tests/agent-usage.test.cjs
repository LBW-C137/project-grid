const { test } = require('node:test');

test('official Codex counts/status integrate without changing conversation tokens or Claude account semantics', () => {
  const { accountResult } = require('../electron/features/agents/codex-account-usage.cjs');
  const meter = new UsageMeter('codex');
  const account = left => accountResult({ rateLimitResetCredits: { availableCount: left }, rateLimits: {
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 123 },
  } }, 1000);
  for (const left of [2, 0]) {
    assert.equal(meter.codexAccount(account(left)), true);
    assert.equal(meter.snapshot().resets.left, left);
    assert.equal(meter.snapshot().limits[0].percent, 25);
    assert.equal(meter.snapshot().limitsAt, 1000);
  }
  meter.reset(); assert.equal(meter.snapshot().resets.left, 0, 'conversation reset keeps the same account');
  meter.codexAccount({ resets: null, resetQuery: { state: 'error', reason: 'timeout' } });
  assert.equal(meter.snapshot().resets, null);
  assert.equal(meter.snapshot().resetQuery.state, 'error');
  assert.equal(new UsageMeter('claude').codexAccount(account(2)), false);
});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageMeter, claudeWindow, claudeProvider, claudeProviderName, codexProviderName } = require('../electron/features/agents/agent-usage.cjs');

const replay = (meter, records) => { for (const record of records) meter.apply(record); return meter.snapshot(); };
const event = payload => ({ type: 'event_msg', payload });
const usage = (input, cached, output, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
const tokenCount = (total, last, window = 828400, rateLimits) => event({ type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: window }, ...(rateLimits ? { rate_limits: rateLimits } : {}) });

test("Codex's route, context, round, conversation and plan limits come from its token counts", () => {
  const meter = new UsageMeter('codex');
  const limits = { limit_id: 'codex', primary: { used_percent: 34, window_minutes: 300, resets_at: 1792000000 }, secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1792472784 }, credits: { balance: '1' } };
  const first = replay(meter, [
    { type: 'session_meta', payload: { id: 'a', model_provider: 'openai' } },
    event({ type: 'task_started', turn_id: '1' }),
    tokenCount(usage(18562, 13056, 242), usage(18562, 13056, 242), 828400, limits),
  ]);
  assert.deepEqual(first, {
    provider: 'OpenAI', context: { used: 18804, window: 828400 },
    round: { input: 18562, cached: 13056, output: 242 }, total: { input: 18562, cached: 13056, output: 242 },
    limits: [{ minutes: 300, percent: 34, resetsAt: 1792000000000 }, { minutes: 10080, percent: 18, resetsAt: 1792472784000 }], limitsAt: null, limitsFrom: null, resets: null, calls: [],
  });
  // The next round counts from where the conversation stood; the context is the last call's size.
  const second = replay(meter, [event({ type: 'task_started', turn_id: '2' }), tokenCount(usage(60000, 50000, 1000), usage(40000, 36000, 700))]);
  assert.deepEqual(second.round, { input: 41438, cached: 36944, output: 758 });
  assert.deepEqual(second.total, { input: 60000, cached: 50000, output: 1000 });
  assert.deepEqual(second.context, { used: 40700, window: 828400 });
  assert.equal(second.limits.length, 2, 'a count without limits keeps the last ones');
  // A count that only brings limits (Codex sends one before the first call) still updates them.
  assert.equal(meter.apply(event({ type: 'token_count', info: null, rate_limits: { primary: { used_percent: 40, window_minutes: 300 }, secondary: null } })), true);
  assert.deepEqual(meter.snapshot().limits, [{ minutes: 300, percent: 40, resetsAt: null }]);
  // Another conversation cannot borrow a provider from the preceding conversation.
  meter.apply({ type: 'session_meta', payload: { id: 'b' } });
  assert.deepEqual(meter.snapshot(), { provider: null, context: null, round: null, total: null, limits: [{ minutes: 300, percent: 40, resetsAt: null }], limitsAt: null, limitsFrom: null, resets: null, calls: [] });
  // Records that say nothing about usage change nothing.
  assert.equal(meter.apply({ type: 'response_item', payload: { type: 'message' } }), false);
  assert.equal(meter.apply(event({ type: 'agent_message', message: 'hi' })), false);
});

test('a Codex round whose start was not read stays unknown, while the conversation total is known', () => {
  const snapshot = replay(new UsageMeter('codex'), [tokenCount(usage(1000, 0, 10), usage(1000, 0, 10))]);
  assert.equal(snapshot.round, null);
  assert.deepEqual(snapshot.total, { input: 1000, cached: 0, output: 10 });
});

test("Claude's replies count once each, however many pieces they are written in", () => {
  const meter = new UsageMeter('claude', { provider: 'Anthropic' });
  const reply = (id, model, input, written, read, output, extra = {}) => ({ type: 'assistant', ...extra, message: { id, model, usage: { input_tokens: input, cache_creation_input_tokens: written, cache_read_input_tokens: read, output_tokens: output, service_tier: 'standard' } } });
  // Before any prompt is read, the round is unknown but the context is not.
  meter.apply(reply('m0', 'claude-opus-5-5', 5, 100, 1000, 20));
  assert.deepEqual(meter.snapshot(), { provider: 'Anthropic', context: { used: 1125, window: 1000000 }, round: null, total: null, limits: [], limitsAt: null, limitsFrom: null, resets: null, calls: [] });
  const snapshot = replay(meter, [
    { type: 'user', message: { content: 'fix the login page' } },
    reply('m1', 'claude-opus-5-5', 10, 2000, 30000, 4),
    reply('m1', 'claude-opus-5-5', 10, 2000, 30000, 300),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
    reply('m2', 'claude-opus-5-5', 20, 500, 32000, 80),
  ]);
  assert.deepEqual(snapshot.round, { input: 64530, cached: 62000, output: 380 }, 'the tool result is no new round; m1 counts once');
  assert.deepEqual(snapshot.context, { used: 32600, window: 1000000 });
  // A subagent's reply, Claude's own synthetic message and its bookkeeping change nothing.
  assert.equal(meter.apply(reply('s1', 'claude-haiku-5-5', 1, 1, 1, 1, { isSidechain: true })), false);
  assert.equal(meter.apply(reply('x', '<synthetic>', 0, 0, 0, 0)), false);
  assert.equal(meter.apply({ type: 'user', isMeta: true, message: { content: 'Caveat' } }), false);
  // The next prompt starts a new round.
  meter.apply({ type: 'user', message: { content: [{ type: 'text', text: 'and the tests' }] } });
  assert.deepEqual(meter.snapshot().round, { input: 0, cached: 0, output: 0 });
});

test("Claude's first prompt, written after its reply, keeps the reply in its round and starts the conversation's total", () => {
  const meter = new UsageMeter('claude');
  const reply = (id, at, input, output) => ({ type: 'assistant', timestamp: at, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } } });
  const prompt = (at, parentUuid, text) => ({ type: 'user', timestamp: at, parentUuid, message: { role: 'user', content: text } });
  // As Claude Code 2.1.300 writes a new session: the reply first, then the prompt stamped before it.
  meter.apply(reply('m1', '2026-10-15T13:12:06.934Z', 100, 10));
  meter.apply(prompt('2026-10-15T13:12:06.230Z', null, 'hi 1'));
  assert.deepEqual(meter.snapshot().round, { input: 100, cached: 0, output: 10 });
  assert.deepEqual(meter.snapshot().total, { input: 100, cached: 0, output: 10 });
  // The next prompt leaves the earlier reply to the conversation's total.
  meter.apply(prompt('2026-10-15T13:12:10.892Z', 'x', 'hi 2'));
  meter.apply(reply('m2', '2026-10-15T13:12:11.364Z', 200, 5));
  meter.apply(reply('m2', '2026-10-15T13:12:11.400Z', 200, 20));
  assert.deepEqual(meter.snapshot().round, { input: 200, cached: 0, output: 20 });
  assert.deepEqual(meter.snapshot().total, { input: 300, cached: 0, output: 30 });
  // A conversation read from its middle has a round but no total.
  const middle = new UsageMeter('claude');
  middle.apply(prompt('2026-10-15T13:12:10.892Z', 'x', 'more'));
  middle.apply(reply('m3', '2026-10-15T13:12:11.364Z', 50, 5));
  assert.deepEqual(middle.snapshot().round, { input: 50, cached: 0, output: 5 });
  assert.equal(middle.snapshot().total, null);
});

test("Claude's window is 1M for models that have it natively or by name, 200k for older ones unless the context shows more", () => {
  assert.equal(claudeWindow('claude-opus-5-5', 1000), 1000000);
  assert.equal(claudeWindow('claude-fable-5-1', 1000), 1000000);
  assert.equal(claudeWindow('claude-sonnet-5', 1000), 1000000);
  assert.equal(claudeWindow('claude-opus-4-7', 1000), 1000000);
  assert.equal(claudeWindow('us.anthropic.claude-haiku-5-5', 1000), 1000000);
  assert.equal(claudeWindow('claude-sonnet-4-6', 1000), 200000);
  assert.equal(claudeWindow('claude-sonnet-4-6[1m]', 1000), 1000000);
  assert.equal(claudeWindow('claude-haiku-4-5-20251001', 1000), 200000);
  assert.equal(claudeWindow('deepseek-chat', 250000), 1000000);
});

test("the service names: Codex's providers by their own names or their base_url's host, Claude's by its switches", () => {
  assert.equal(codexProviderName('openai'), 'OpenAI');
  assert.equal(codexProviderName('ollama'), 'Ollama');
  const config = 'model = "x"\n[model_providers.relay]\nname = "Relay"\nbase_url = "https://api.relay.example/v1"\n\n[model_providers."my.box"]\nbase_url = \'http://10.0.0.5:8000/v1\'\n[tui]\n';
  assert.equal(codexProviderName('relay', config), 'api.relay.example');
  assert.equal(codexProviderName('my.box', config), '10.0.0.5:8000');
  assert.equal(codexProviderName('unknown', config), 'unknown');
  const relay = new UsageMeter('codex', { names: id => codexProviderName(id, config) });
  relay.apply({ type: 'session_meta', payload: { model_provider: 'relay' } });
  assert.equal(relay.snapshot().provider, 'api.relay.example');
  assert.equal(claudeProviderName({}), 'Anthropic');
  assert.equal(claudeProviderName({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), 'Anthropic');
  assert.equal(claudeProviderName({ ANTHROPIC_BASE_URL: 'https://gw.example.com/anthropic' }), 'gw.example.com');
  assert.equal(claudeProviderName({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gw.example.com' }), 'Amazon Bedrock');
  assert.equal(claudeProviderName({ CLAUDE_CODE_USE_VERTEX: 'true' }), 'Google Vertex AI');
  assert.equal(claudeProviderName({ CLAUDE_CODE_USE_BEDROCK: '0' }), 'Anthropic');
});

test("Claude's settings files set its environment: the project's local file over the project's over the user's", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-usage-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'), project = path.join(root, 'project');
  fs.mkdirSync(config); fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  assert.equal(await claudeProvider(project, config, { ANTHROPIC_BASE_URL: 'https://inherited.example' }), 'inherited.example');
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://user.example' } }));
  assert.equal(await claudeProvider(project, config, {}), 'user.example');
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://project.example' } }));
  assert.equal(await claudeProvider(project, config, {}), 'project.example');
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{ not json');
  assert.equal(await claudeProvider(project, config, {}), 'project.example', 'a broken file is skipped');
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }));
  assert.equal(await claudeProvider(project, config, {}), 'Google Vertex AI');
});

test("Claude's plan limits and limit resets come from what Claude Code last fetched for its own /usage", () => {
  const { claudeAccountFrom } = require('../electron/features/agents/agent-usage.cjs');
  const state = (utilization, fetchedAtMs = 1792133696288) => ({ cachedUsageUtilization: { fetchedAtMs, utilization } });
  const windows = { five_hour: { utilization: 9, resets_at: '2026-10-16T11:19:59.818281+00:00' }, seven_day: { utilization: 84, resets_at: '2026-10-19T13:59:59.818302+00:00' } };
  const grant = (left, total, paused = false) => ({ id: 'g', resets_left: left, resets_total: total, paused });
  assert.deepEqual(claudeAccountFrom(state({ ...windows, cedar_ember: { eligible: true, grants: [grant(2, 3), grant(1, 1, true)] } })), {
    limits: [{ minutes: 300, percent: 9, resetsAt: Date.parse('2026-10-16T11:19:59.818281+00:00') }, { minutes: 10080, percent: 84, resetsAt: Date.parse('2026-10-19T13:59:59.818302+00:00') }],
    resets: { kind: 'grants', left: 2, total: 3 }, at: 1792133696288, source: 'Claude Code',
  }, 'a paused grant gives none');
  // cedar_ember: null is "not fetched yet" (Claude Code asks only at the limit), never "none left".
  assert.equal(claudeAccountFrom(state({ ...windows, cedar_ember: null })).resets, null, 'no word on grants');
  assert.equal(claudeAccountFrom(state(windows)).resets, null, 'no word on resets');
  // The weekly session reset (/limit-reset) is offered by a flag Claude Code caches; whether this week's is used it says
  // only on screen.
  const flags = features => ({ ...state({ ...windows, cedar_ember: null }), cachedGrowthBookFeatures: features });
  assert.deepEqual(claudeAccountFrom(flags({ tengu_nifty_lemur: { enabled: true, label: 'Reset your session limit now' } })).resets, { kind: 'session', left: null, total: 1 });
  assert.deepEqual(claudeAccountFrom(flags({ tengu_cedar_ember: { enabled: true } })).resets, { kind: 'grants', left: null, total: null });
  assert.equal(claudeAccountFrom(flags({ tengu_nifty_lemur: { enabled: false } })).resets, null, 'an unoffered reset is no word, so the button stays usable');
  assert.deepEqual(claudeAccountFrom({ cachedGrowthBookFeatures: { tengu_nifty_lemur: { enabled: true } } }), { limits: [], resets: { kind: 'session', left: null, total: 1 }, at: null, source: 'Claude Code' }, 'before any /usage');
  assert.equal(claudeAccountFrom({}), null);
  assert.equal(claudeAccountFrom(null), null);
  const meter = new UsageMeter('claude'), account = claudeAccountFrom(state({ ...windows, cedar_ember: { grants: [grant(2, 2)] } }));
  assert.equal(meter.account(account), true);
  assert.equal(meter.account(account), false, 'the same fetch changes nothing');
  assert.deepEqual([meter.snapshot().limits.length, meter.snapshot().resets, meter.snapshot().limitsAt], [2, { kind: 'grants', left: 2, total: 2 }, 1792133696288]);
  assert.equal(new UsageMeter('codex').account(account), false, "Codex's limits come from its own records");
});

test("Claude's limits come from the fresher of Claude Code's own cache and CodePulse's status line record; resets only from the cache", async t => {
  const { claudeAccount, codePulseLimits } = require('../electron/features/agents/agent-usage.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-usage-pulse-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, '.claude.json'), pulse = path.join(root, 'claude-quota.json');
  const own = at => ({ cachedUsageUtilization: { fetchedAtMs: at, utilization: { five_hour: { utilization: 9, resets_at: '2026-10-16T11:20:00Z' }, seven_day: { utilization: 84, resets_at: '2026-10-19T14:00:00Z' }, cedar_ember: { grants: [{ resets_left: 1, resets_total: 2 }] } } } });
  const quota = at => ({ updatedAt: at, rate_limits: { five_hour: { used_percent: 12, resets_at: 1792149600 }, seven_day: { used_percent: 85, resets_at: 1792418400 } }, source: 'statusline' });
  assert.deepEqual(codePulseLimits(quota(2000)), { limits: [{ minutes: 300, percent: 12, resetsAt: 1792149600000 }, { minutes: 10080, percent: 85, resetsAt: 1792418400000 }], at: 2000, source: 'CodePulse' });
  assert.equal(codePulseLimits({ rate_limits: {} }), null);
  fs.writeFileSync(state, JSON.stringify(own(1000))); fs.writeFileSync(pulse, JSON.stringify(quota(2000)));
  const fresher = await claudeAccount(state, pulse);
  assert.deepEqual([fresher.source, fresher.limits[0].percent, fresher.resets], ['CodePulse', 12, { kind: 'grants', left: 1, total: 2 }]);
  fs.writeFileSync(state, JSON.stringify(own(3000)));
  assert.deepEqual([(await claudeAccount(state, pulse)).source, (await claudeAccount(state, pulse)).limits[0].percent], ['Claude Code', 9]);
  assert.equal((await claudeAccount(state, null)).source, 'Claude Code', 'without CodePulse');
  assert.equal(await claudeAccount(path.join(root, 'none.json'), path.join(root, 'none-either.json')), null);
});
