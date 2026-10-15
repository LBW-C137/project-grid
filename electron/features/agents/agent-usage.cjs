const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { claudePrompt } = require('../../agent-actions.cjs');

// What an agent spends, as its own records tell it, for the activity pane: the service its model is reached through,
// how full the context window is, the tokens this round and this conversation took and, for Codex, how much of the
// plan's 5-hour and weekly allowance is used.
//
// Codex writes a token_count event after each model call: the conversation's running totals, the last call's size (the
// context it filled), the window and the plan's rate limits. Claude Code writes each reply's usage with the reply, and
// every piece of one reply repeats it, so a reply counts once. Claude's records hold no plan limits, and its
// conversation total is known only when the part read reaches back to the conversation's first prompt.
//
// Tokens are { input, cached, output }: input counts the cached part too; output counts the reasoning too.
const ZERO = { input: 0, cached: 0, output: 0 };
const count = value => Number.isFinite(value) && value > 0 ? value : 0;
const plus = (a, b, sign = 1) => ({ input: a.input + sign * b.input, cached: a.cached + sign * b.cached, output: a.output + sign * b.output });

// Claude models from Opus 4.7 on (and Sonnet 5, Haiku 5.5, Fable, Mythos) have a 1M-token window; older ones 200k
// unless named with [1m]. A context larger than 200k shows the window is the large one, whatever the name says.
const LARGE_WINDOW = /\[1m\]|claude-(?:opus-4-[7-9]|(?:opus|sonnet|haiku)-(?:[5-9]|\d{2,})|fable|mythos)/i;
const claudeWindow = (model, used) => LARGE_WINDOW.test(model || '') || used > 200000 ? 1000000 : 200000;

// provider: Claude's, known when it starts. Codex names its own in each conversation's first record; names turns that
// id into what the pane shows.
class UsageMeter {
  constructor(agent, { provider = null, names = codexProviderName } = {}) {
    this.agent = agent; this.provider = provider; this.names = names; this.providerId = null; this.limits = [];
    this.reset();
  }
  // Another conversation starts over; the provider and the plan's limits stay.
  reset() { this.context = null; this.round = null; this.total = null; this.roundStart = null; this.replies = new Map(); }
  // What the pane shows.
  snapshot() { return { provider: this.providerId ? this.names(this.providerId) : this.provider, context: this.context, round: this.round, total: this.total, limits: this.limits }; }
  // Whether this record changed what the pane shows.
  apply(record) {
    if (!record || typeof record !== 'object') return false;
    return this.agent === 'claude' ? this.claude(record) : this.codex(record);
  }
  claude(record) {
    if (record.isSidechain) return false;
    // A prompt starts a round, told by time: Claude Code writes a session's first prompt after the reply to it, so the
    // replies stamped after the prompt stay in its round. A round whose prompt lies before the part read stays unknown.
    if (claudePrompt(record)) {
      const at = Date.parse(record.timestamp);
      for (const [id, reply] of this.replies) if (!(reply.at > at)) this.replies.delete(id);
      this.round = [...this.replies.values()].reduce((sum, reply) => plus(sum, reply.tokens), { ...ZERO });
      // The conversation's first prompt answers nothing before it: from here its total is known.
      if (record.parentUuid === null) this.total = { ...this.round };
      return true;
    }
    const message = record.message, usage = message?.usage;
    if (record.type !== 'assistant' || !usage || typeof usage !== 'object' || message.model === '<synthetic>') return false;
    const prompt = count(usage.input_tokens), written = count(usage.cache_creation_input_tokens), read = count(usage.cache_read_input_tokens);
    const tokens = { input: prompt + written + read, cached: read, output: count(usage.output_tokens) };
    if (!tokens.input && !tokens.output) return false;
    // The replies since the last prompt, by id: a later piece of a reply replaces what an earlier one counted.
    const id = message.id || record.uuid, earlier = this.replies.get(id)?.tokens;
    const add = sum => plus(earlier ? plus(sum, earlier, -1) : sum, tokens);
    this.replies.set(id, { at: Date.parse(record.timestamp), tokens });
    if (this.round) this.round = add(this.round);
    if (this.total) this.total = add(this.total);
    const used = tokens.input + tokens.output;
    this.context = { used, window: claudeWindow(message.model, used) };
    return true;
  }
  codex(record) {
    const payload = record.payload || {};
    if (record.type === 'session_meta') {
      this.reset();
      if (typeof payload.model_provider === 'string' && payload.model_provider) this.providerId = payload.model_provider;
      return true;
    }
    if (record.type !== 'event_msg') return false;
    if (['task_started', 'turn_started'].includes(payload.type)) { this.roundStart = this.total || { ...ZERO }; this.round = { ...ZERO }; return true; }
    if (payload.type !== 'token_count') return false;
    const info = payload.info && typeof payload.info === 'object' ? payload.info : null;
    const total = tokensOf(info?.total_token_usage), last = info?.last_token_usage;
    if (total) {
      this.total = total;
      if (this.roundStart) this.round = plus(total, this.roundStart, -1);
    }
    if (last && Number.isFinite(last.total_tokens) && count(info.model_context_window)) this.context = { used: count(last.total_tokens), window: info.model_context_window };
    const limits = payload.rate_limits && typeof payload.rate_limits === 'object' ? [payload.rate_limits.primary, payload.rate_limits.secondary]
      .filter(window => window && Number.isFinite(window.used_percent))
      .map(window => ({ minutes: count(window.window_minutes) || null, percent: window.used_percent, resetsAt: count(window.resets_at) ? window.resets_at * 1000 : null })) : null;
    if (limits) this.limits = limits;
    return !!(total || limits);
  }
}
function tokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return { input: count(usage.input_tokens), cached: count(usage.cached_input_tokens), output: count(usage.output_tokens) };
}

// The service behind a Codex model_provider id: its own names for the built-in ones, else the host of the base_url
// that config.toml gives the provider, else the id.
const CODEX_PROVIDERS = { openai: 'OpenAI', azure: 'Azure OpenAI', ollama: 'Ollama', oss: 'Ollama', lmstudio: 'LM Studio' };
function codexProviderName(id, config = '') {
  if (CODEX_PROVIDERS[id]) return CODEX_PROVIDERS[id];
  const header = new RegExp(`^\\s*\\[model_providers\\.(?:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|"${id.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}")\\]\\s*$`, 'm').exec(config);
  const section = header ? config.slice(header.index + header[0].length).split(/^\s*\[/m)[0] : '';
  return hostOf(/^\s*base_url\s*=\s*["']([^"']+)["']/m.exec(section)?.[1]) || id;
}
async function codexProvider(codexHome) {
  const config = await fs.readFile(path.join(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8').catch(() => '');
  return id => codexProviderName(id, config);
}

// Where Claude Code sends its requests: Bedrock, Vertex or Foundry when switched on, else ANTHROPIC_BASE_URL's host when
// it points elsewhere than Anthropic. Its settings files set environment variables over the inherited ones, the
// project's local file over the project's over the user's.
const on = value => /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
function hostOf(url) { try { return new URL(String(url)).host || null; } catch { return null; } }
function claudeProviderName(env) {
  if (on(env.CLAUDE_CODE_USE_BEDROCK)) return 'Amazon Bedrock';
  if (on(env.CLAUDE_CODE_USE_VERTEX)) return 'Google Vertex AI';
  if (on(env.CLAUDE_CODE_USE_FOUNDRY)) return 'Microsoft Foundry';
  const host = hostOf(env.ANTHROPIC_BASE_URL);
  return host && host !== 'api.anthropic.com' ? host : 'Anthropic';
}
async function claudeProvider(cwd, configDir, env = process.env) {
  const files = [path.join(configDir, 'settings.json'), ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : [])];
  const merged = { ...env };
  for (const file of files) {
    try { const settings = JSON.parse(await fs.readFile(file, 'utf8')); if (settings?.env && typeof settings.env === 'object') Object.assign(merged, settings.env); } catch { }
  }
  return claudeProviderName(merged);
}

module.exports = { UsageMeter, claudeWindow, claudeProvider, claudeProviderName, codexProvider, codexProviderName };
