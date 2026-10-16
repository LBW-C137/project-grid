const { claudeAction, claudeOwnRecord, codexActions, codexFailed, resolvePath } = require('./agent-actions.cjs');
const { IMAGE_LIMIT } = require('./oversized-record.cjs');

// The conversation of a terminal's agent, for the reading view: what the user asked, what the agent
// answered (Markdown), and the tools it called in between. It is read from the records each agent already
// writes (Claude Code's transcript, Codex's rollout), the same ones the activity pane follows, so it shows
// exactly what was said, laid out properly, instead of the terminal's character grid.
//
// An entry is { id, at, role: 'user' | 'assistant' | 'tool', text?, tool? }.
const TEXT_LIMIT = 20000;
// Wrappers the agents put around a prompt that are not what the user typed.
const WRAPPERS = /<(system-reminder|environment_context|user_instructions|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;
// Claude marks where a pasted image went ("[Image #2]"); the image itself is shown, so the mark goes.
// Only the start of a huge record is cleaned: the wrapper pattern scans to the end for each unclosed tag, and what is
// shown is cut to TEXT_LIMIT anyway.
const CLEAN_LIMIT = 60000;
// Claude Code wraps pasted text in <pasted_content id=…> tags: the text is what was said, the tags are not.
const PASTED = /<\/?pasted_content\b[^>]*>\n?/g;
const clean = text => String(text || '').slice(0, CLEAN_LIMIT).replace(WRAPPERS, '').replace(PASTED, '').replace(/\[Image #\d+\]\s?/g, '').trim();
// Images the user attached to a message, as data URLs the reading view shows: at most four, none over about 2 MB,
// each made small by the main process (setThumbnailer) so a conversation full of screenshots stays light to send.
let shrink = url => url;
function images(parts) {
  return pictures(parts).map(url => { try { return shrink(url) || url; } catch { return url; } });
}
function pictures(parts) {
  const found = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (found.length >= 4) break;
    if (part?.type === 'image' && part.source?.type === 'base64' && /^image\/[\w.+-]+$/.test(part.source.media_type || '') && typeof part.source.data === 'string' && part.source.data.length <= IMAGE_LIMIT) found.push(`data:${part.source.media_type};base64,${part.source.data}`);
    else {
      const url = part?.image_url?.url ?? part?.image_url ?? part?.url;
      if (['image', 'input_image'].includes(part?.type) && typeof url === 'string' && /^data:image\/[\w.+-]+;base64,/.test(url) && url.length <= IMAGE_LIMIT) found.push(url);
    }
  }
  return found;
}
const withImages = (entry, parts) => { const attached = images(parts); return attached.length ? { ...entry, images: attached } : entry; };
// A picture Codex generated (its image_gen tool) and saved under generated_images. The reading view shows a small copy
// made from the saved file (the main process sets how, see setThumbnailer), never the full image inline, and opens
// the file itself on a click.
const GENERATED = /[\\/]generated_images[\\/][^\\/]+[\\/][^\\/]+\.(?:png|jpe?g|webp)$/i;
// Codex records the path on the system it runs on; either form of an absolute path is read the same way everywhere.
const isGeneratedImage = file => typeof file === 'string' && (require('node:path').win32.isAbsolute(file) || require('node:path').posix.isAbsolute(file)) && GENERATED.test(file);
let thumbnail = () => null;
// fromFile(path) and fromDataUrl(url) return a small data URL, or null to keep what there is.
function setThumbnailer(fromFile, fromDataUrl = url => url) { thumbnail = fromFile; shrink = fromDataUrl; }
function generatedImage(item, at) {
  const kind = item?.type === 'Extension' ? item.kind : item?.type;
  if (!['image_gen.generation', 'imageGeneration'].includes(kind) || item.status !== 'completed' || !isGeneratedImage(item.savedPath)) return null;
  let src = null;
  try { src = thumbnail(item.savedPath); } catch { }
  if (!src && typeof item.result === 'string' && item.result.length <= IMAGE_LIMIT) src = `data:image/png;base64,${item.result}`;
  if (!src) return null;
  return { id: `g:${item.id}`, at, role: 'assistant', text: '', images: [src], generated: { path: item.savedPath, prompt: bounded(String(item.revisedPrompt || '')) } };
}
const bounded = text => text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n…` : text;
// A step as the reading view shows it; an edit names the files it left (not deleted ones), so the documents, pages and
// videos among them can be previewed. Keep their cwd here; the project folder may be a parent of it.
const brief = (action, cwd = action.cwd) => ({ kind: action.kind, tool: action.tool, target: action.target, detail: action.detail, done: action.done, failed: action.failed, phrase: action.phrase, object: action.object,
  ...(action.kind === 'edit' && action.files?.length ? { written: action.files.filter(file => file.change !== 'delete').map(file => cwd ? resolvePath(cwd, file.path.replace(/\\/g, '/')) : file.path).slice(0, 8) } : {}) });

// Entries keep their order; a later record about the same entry (a tool that finished) replaces it.
class ConversationLog {
  // cwd: the folder Codex works in (its session's and each turn's), which relative file paths in its steps start from.
  constructor(changed = () => {}, limit = 400) { this.changed = changed; this.limit = limit; this.list = []; this.cwd = null; }
  // Records still feed activity tracking during replay, but reading snapshots wait for the file tail.
  beginHistory() { this.loading = true; }
  endHistory() { if (!this.loading) return; this.loading = false; this.changed({ reset: true }); }
  snapshot() { return this.loading ? [] : this.list; }
  reset() { if (!this.list.length) return; this.list = []; this.changed({ reset: true }); }
  // inOrder: a new entry goes before those stamped after it, and the window gets the whole list again.
  put(entry, inOrder = false) {
    const index = this.list.findIndex(item => item.id === entry.id);
    if (index >= 0) { this.list[index] = entry; this.changed({ entry }); return; }
    let at = this.list.length;
    if (inOrder) while (at > 0 && this.list[at - 1].at > entry.at) at--;
    this.list.splice(at, 0, entry);
    if (this.list.length > this.limit) this.list.shift();
    this.changed(at < this.list.length - 1 ? { reset: true, entry } : { entry });
  }
  // An entry gone (a queued message taken up): the window gets the whole list again.
  drop(id) {
    const index = this.list.findIndex(item => item.id === id);
    if (index < 0) return;
    this.list.splice(index, 1); this.changed({ reset: true });
  }
  // A tool whose result arrived. prefix: a Codex call id covers every step its script made.
  finish(id, failed = false, prefix = false) {
    for (let index = 0; index < this.list.length; index++) {
      const entry = this.list[index];
      if (entry.role !== 'tool' || entry.tool.done || !(prefix ? entry.id.startsWith(`${id}:`) : entry.id === id)) continue;
      const next = { ...entry, tool: { ...entry.tool, done: true, failed } };
      this.list[index] = next; this.changed({ entry: next });
    }
  }
  // A round that ended leaves nothing running.
  settle() {
    for (let index = 0; index < this.list.length; index++) {
      const entry = this.list[index];
      if (entry.role !== 'tool' || entry.tool.done) continue;
      const next = { ...entry, tool: { ...entry.tool, done: true } };
      this.list[index] = next; this.changed({ entry: next });
    }
  }
}

// Claude Code queues a message sent while it works (a queue-operation "enqueue" naming it) and writes it into the
// conversation only when it takes it up: within the turn ("remove", absorbed_mid_turn) or as the next one ("dequeue",
// the oldest). Until then it stands in the list marked queued, which the reading view shows on the message it sent and
// is never shown as a message itself.
function claudeQueue(log, record) {
  const queued = log.list.filter(entry => entry.queued), text = typeof record.content === 'string' ? clean(record.content) : '';
  if (record.operation === 'enqueue') {
    // A slash command or shell line sent while it works is not a message (the reading view's isTypedCommand).
    const command = (/^\/[^\s/]+(?:\s|$)/.test(text) || text.startsWith('!')) && !/[\r\n]/.test(text);
    if (text && !command) log.put({ id: `q:${record.timestamp}:${log.list.length}`, at: Date.parse(record.timestamp) || Date.now(), role: 'user', text: bounded(text), queued: true });
    return;
  }
  if (record.operation !== 'remove' && record.operation !== 'dequeue') return;
  const entry = (text && queued.find(item => item.text === bounded(text))) || (record.operation === 'dequeue' || !text ? queued[0] : null);
  if (entry) log.drop(entry.id);
}

function claudeConversation(log, record, cwd) {
  if (record?.type === 'queue-operation') { if (!record.isSidechain) claudeQueue(log, record); return; }
  if (claudeOwnRecord(record)) return;
  const queued = record?.type === 'attachment' && record.attachment?.type === 'queued_command' && record.attachment.commandMode !== 'bash' ? record.attachment : null;
  if (queued && !record.isSidechain) {
    const text = clean(typeof queued.prompt === 'string' ? queued.prompt : Array.isArray(queued.prompt) ? queued.prompt.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '');
    const entry = withImages({ id: `u:${record.uuid || record.timestamp}`, at: Date.parse(record.timestamp) || Date.now(), role: 'user', text: bounded(text) }, queued.prompt);
    if (text || entry.images) log.put(entry);
    return;
  }
  if (!record || record.isSidechain || !record.message || record.isMeta) return;
  const content = record.message.content, at = Date.parse(record.timestamp) || Date.now(), base = String(record.uuid || at);
  if (record.type === 'user') {
    if (Array.isArray(content) && content.some(block => block.type === 'tool_result')) {
      for (const block of content) if (block.type === 'tool_result') log.finish(String(block.tool_use_id || ''), block.is_error === true);
      return;
    }
    const text = clean(typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '');
    const entry = withImages({ id: `u:${base}`, at, role: 'user', text: bounded(text) }, content);
    // A conversation's first prompt, which Claude Code writes after the reply to it, goes before that reply.
    if (text || entry.images) log.put(entry, record.parentUuid === null);
    return;
  }
  if (record.type !== 'assistant' || !Array.isArray(content)) return;
  content.forEach((block, index) => {
    const text = block.type === 'text' ? clean(block.text) : '';
    if (text) log.put({ id: `a:${base}:${index}`, at, role: 'assistant', text: bounded(text) });
    else if (block.type === 'tool_use') { const action = claudeAction(block, at, record.cwd || cwd); log.put({ id: action.id, at, role: 'tool', tool: brief(action, record.cwd || cwd) }); }
  });
}

// Codex records the answers to its own questions (request_user_input) as a user message: the questions and the chosen
// answers as JSON inside <send_user_message_question_reply>. They answer it; they are not something the user asked.
// Gives the readable "question → answer" lines, '' for a reply that cannot be read, or null for any other message.
const QUESTION_REPLY = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/;
function questionReply(text) {
  const match = QUESTION_REPLY.exec(String(text || ''));
  if (!match) return null;
  let answers; try { answers = JSON.parse(match[1]); } catch { return ''; }
  if (!Array.isArray(answers)) return '';
  const said = value => typeof value === 'string' && value.trim() ? value.trim() : '';
  return answers.map(item => [said(item?.question), said(item?.answer)]).filter(([question, answer]) => question || answer)
    .map(([question, answer]) => question && answer ? `${question}\n→ ${answer}` : question || `→ ${answer}`).join('\n\n');
}
// Newer Codex reports each message once as a completed item; older versions as event messages.
function codexMessage(item) {
  const parts = Array.isArray(item?.content) ? item.content : [];
  return clean(parts.map(part => typeof part?.text === 'string' ? part.text : '').join('\n'));
}
function codexConversation(log, record, cwd) {
  if (!record?.payload) return;
  const payload = record.payload, at = Date.parse(record.timestamp) || Date.now();
  if (record.type === 'session_meta') { log.reset(); log.cwd = payload.cwd || cwd; return; }
  if (record.type === 'turn_context') { log.cwd = payload.cwd || log.cwd; return; }
  if (record.type === 'event_msg') {
    const picture = payload.type === 'item_completed' ? generatedImage(payload.item, at) : null;
    if (picture) log.put(picture);
    else if (payload.type === 'item_completed' && ['UserMessage', 'AgentMessage'].includes(payload.item?.type)) {
      const raw = codexMessage(payload.item), user = payload.item.type === 'UserMessage', reply = user ? questionReply(raw) : null, text = reply ?? raw;
      const entry = { id: `${user ? 'u' : 'a'}:${payload.item.id || at}`, at, role: user ? 'user' : 'assistant', text: bounded(text), ...(reply !== null ? { answer: true } : {}) };
      const shown = user ? withImages(entry, payload.item.content) : entry;
      if (text || shown.images) log.put(shown);
    } else if (['user_message', 'agent_message'].includes(payload.type) && typeof payload.message === 'string' && clean(payload.message)) {
      const user = payload.type === 'user_message', reply = user ? questionReply(clean(payload.message)) : null, text = reply ?? clean(payload.message);
      if (text) log.put({ id: `${payload.type[0]}:${at}:${payload.message.length}`, at, role: user ? 'user' : 'assistant', text: bounded(text), ...(reply !== null ? { answer: true } : {}) });
    } else if (['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(payload.type)) log.settle();
    return;
  }
  if (record.type !== 'response_item') return;
  if (['custom_tool_call_output', 'function_call_output', 'local_shell_call_output'].includes(payload.type)) { log.finish(String(payload.call_id || ''), codexFailed(payload), true); return; }
  for (const action of codexActions(payload, at, log.cwd || cwd)) log.put({ id: action.id, at, role: 'tool', tool: brief(action) });
}

module.exports = { ConversationLog, claudeConversation, codexConversation, clean, brief, generatedImage, isGeneratedImage, setThumbnailer, questionReply };
