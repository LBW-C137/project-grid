const fs = require('node:fs/promises');
const path = require('node:path');

const text = value => typeof value === 'string' ? value : '';
const short = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 240);
const enabled = value => value === true || value === 'true';
const unquote = value => value.replace(/["']/g, '');
const basename = value => value.split(/[\\/]/).at(-1);

// Only inspect the command; never run a shell or follow its prompt/output paths. Keep quoted config values together.
function codexCall(command) {
  const words = text(command).match(/(?:[^\s"';&|]+|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;&|\n]/g)?.map(unquote) || [];
  const separator = word => /^(?:&&|\|\||[;&|\n])$/.test(word);
  const start = words.findIndex((word, i) => {
    if (!/(?:^|[\\/])codex(?:\.exe|\.cmd)?$/i.test(word) || words[i + 1] !== 'exec') return false;
    const before = words.slice(0, i), boundary = before.findLastIndex(separator);
    return before.slice(boundary + 1).every(prefix => /^(?:env|nohup|exec)$|^\w+=/.test(prefix));
  });
  if (start < 0) return null;
  let model = 'default', effort = null, fast = null, provider = 'openai', task = '';
  for (let i = start + 2; i < words.length; i++) {
    const word = words[i];
    if (separator(word)) break;
    if (word === '-m' || word === '--model') model = words[++i] || model;
    else if (/^(?:-m|--model)=/.test(word)) model = word.slice(word.indexOf('=') + 1) || model;
    else if (word === '-c' || word === '--config' || /^(?:-c|--config)=/.test(word)) {
      const config = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++i] || '';
      const match = /^(model|model_provider|model_reasoning_effort|service_tier)=(.+)$/.exec(config);
      if (!match) continue;
      if (match[1] === 'model') model = match[2];
      if (match[1] === 'model_provider') provider = match[2];
      if (match[1] === 'model_reasoning_effort') effort = match[2];
      if (match[1] === 'service_tier') fast = /fast|priority/i.test(match[2]);
    } else if (word === '<' && words[i + 1]) task = basename(words[++i]);
  }
  return { model, effort, fast, provider, task };
}

// A strict byte bound, including for a subagent whose transcript is itself very large. Drop a cut first record.
async function tailRecords(filename, limit = 256 * 1024) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const { size } = await file.stat(), offset = Math.max(0, size - limit), buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(offset ? 1 : 0).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; } finally { await file?.close(); }
}

class AgentCalls {
  constructor({ changed = () => {}, names = id => id === 'openai' ? 'OpenAI' : id } = {}) {
    this.changed = changed; this.names = names; this.folder = null; this.reset();
  }
  reset() { this.calls = new Map(); this.meta = new Map(); this.pending = new Set(); this.work = null; }
  setFolder(folder) { this.folder = folder; }
  snapshot(provider) {
    const groups = new Map();
    for (const call of this.calls.values()) {
      const route = { agent: call.agent, provider: call.agent === 'Claude Code' ? provider ?? null : this.names(call.provider), model: call.model, effort: call.effort, fast: call.fast };
      const key = JSON.stringify(route);
      if (!groups.has(key)) groups.set(key, { ...route, runs: 0, running: 0, tasks: [] });
      const group = groups.get(key);
      group.runs++; group.running += call.done ? 0 : 1;
      if (call.task) { group.tasks = group.tasks.filter(task => task !== call.task); group.tasks.push(call.task); group.tasks = group.tasks.slice(-5); }
    }
    return [...groups.values()];
  }
  apply(record) {
    if (record.isSidechain) return false;
    const content = record.message?.content;
    let changed = false;
    for (const block of Array.isArray(content) ? content : []) {
      if (record.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && !this.calls.has(block.id)) {
        const input = block.input || {}, codex = block.name === 'Bash' ? codexCall(input.command) : null;
        if (block.name !== 'Agent' && !codex) continue;
        this.calls.set(block.id, {
          agent: codex ? 'Codex' : 'Claude Code', provider: codex?.provider ?? null,
          model: codex?.model || text(input.model) || text(record.message?.model) || 'default',
          resolved: text(input.model).startsWith('claude-'),
          effort: codex?.effort ?? null, fast: codex?.fast ?? null,
          task: short(input.description || block.description || codex?.task || input.subagent_type || block.name),
          background: enabled(input.run_in_background), done: false,
        });
        if (!codex) this.refresh(block.id);
        changed = true;
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const call = this.calls.get(block.tool_use_id);
        if (!call) continue;
        const result = record.toolUseResult || {};
        call.background ||= enabled(result.isAsync) || !!result.backgroundTaskId;
        if (call.agent === 'Codex' && typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) call.backgroundTaskId = result.backgroundTaskId;
        if (block.is_error || !call.background) { if (!call.done) changed = true; call.done = true; }
        if (call.agent === 'Claude Code') {
          if (typeof result.resolvedModel === 'string' && result.resolvedModel) { changed ||= call.model !== result.resolvedModel; call.model = result.resolvedModel; call.resolved = true; }
          if (typeof result.agentId === 'string' && /^[\w-]+$/.test(result.agentId)) call.agentId = result.agentId;
          this.refresh(block.tool_use_id);
        }
      }
    }
    // Background tool_result is only a launch receipt. A queued or user-delivered notification ends it once.
    if (record.type === 'user' || (record.type === 'queue-operation' && record.operation === 'enqueue')) {
      const notificationContent = record.type === 'queue-operation' ? text(record.content) : content;
      const body = typeof notificationContent === 'string' ? notificationContent : (Array.isArray(notificationContent) ? notificationContent.filter(block => block.type === 'text').map(block => text(block.text)).join('\n') : '');
      for (const [notification] of body.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        let id = /<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/.exec(notification)?.[1];
        const taskId = /<task-id>\s*([^<]+?)\s*<\/task-id>/.exec(notification)?.[1];
        if (!/<status>\s*(?:completed|failed|killed)\s*<\/status>/.test(notification)) continue;
        if (!this.calls.has(id) && taskId) id = [...this.calls].find(([, call]) => call.backgroundTaskId === taskId)?.[0];
        const call = this.calls.get(id);
        if (call && !call.done) { call.done = true; changed = true; if (call.agent === 'Claude Code') this.refresh(id); }
      }
    }
    return changed;
  }
  // Batch history records into one small directory scan. No timer, watcher or polling of subagent transcripts.
  refresh(id) {
    if (!this.folder) return;
    this.pending.add(id);
    if (!this.work) {
      const calls = this.calls, pending = this.pending, folder = this.folder;
      this.work = Promise.resolve().then(async () => {
        while (pending.size && this.calls === calls) {
          const ids = new Set(pending); pending.clear();
          await this.readModels(folder, ids, calls);
        }
      }).catch(() => {}).finally(() => { if (this.calls === calls) this.work = null; });
    }
  }
  async readModels(folder, ids, calls) {
    const files = await fs.readdir(folder).catch(() => []);
    const matches = new Map();
    for (const name of files) {
      if (!/^agent-[\w-]+\.meta\.json$/.test(name)) continue;
      const filename = path.join(folder, name), stat = await fs.stat(filename).catch(() => null);
      if (!stat || stat.size > 64 * 1024) continue;
      let entry = this.meta.get(filename);
      if (!entry || entry.at !== stat.mtimeMs || entry.size !== stat.size) {
        try { entry = { at: stat.mtimeMs, size: stat.size, value: JSON.parse(await fs.readFile(filename, 'utf8')) }; } catch { continue; }
        if (this.calls !== calls) return;
        this.meta.set(filename, entry);
      }
      if (ids.has(entry.value?.toolUseId)) matches.set(entry.value.toolUseId, { ...entry.value, filename: filename.replace(/\.meta\.json$/, '.jsonl') });
    }
    for (const id of ids) {
      const call = calls.get(id), meta = matches.get(id);
      const filename = meta?.filename || (call?.agentId && path.join(folder, `agent-${call.agentId}.jsonl`));
      if (!call || !filename) continue;
      const records = await tailRecords(filename);
      if (this.calls !== calls || this.folder !== folder) return;
      const model = records.findLast(record => record.type === 'assistant' && record.message?.model && record.message.model !== '<synthetic>')?.message.model;
      // A full id from the transcript outranks the alias in meta. Don't replace a resolved id with an alias.
      const next = model || (typeof meta?.model === 'string' && (!call.resolved || meta.model.startsWith('claude-')) ? meta.model : null);
      if (model || (typeof next === 'string' && next.startsWith('claude-'))) call.resolved = true;
      if (typeof next === 'string' && next && next !== call.model) { call.model = next; this.changed(); }
    }
  }
}

module.exports = { AgentCalls, codexCall };
