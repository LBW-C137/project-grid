// The prompts a user has sent an agent and it has not finished yet, for the activity overview: the ones it is
// working on, then the ones waiting their turn. Kept in memory only, never written to disk.
//
// A prompt enters when it is submitted in the terminal (queued), is taken up when the agent's own record shows
// the message (working), and leaves when the round that worked on it ends. The record is what counts: typed
// text can differ from what was sent (a line recalled from history, edited with the arrow keys), so a message
// the record shows takes the oldest waiting prompt and replaces its text.
//
// An item is { id, text, state: 'queued' | 'working', at }.
const TEXT_LIMIT = 400;
// Slash commands, shell mode and memory notes are not prompts.
const NOT_A_PROMPT = /^[/!#]/;
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
const clip = text => text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
const key = text => clean(text).slice(0, 80);

class PromptQueue {
  // grace: how long a submission may wait to be taken up when nothing else is running (a line that was
  // an answer to a question, not a prompt, never is).
  constructor(changed = () => {}, { now = Date.now, grace = 20000 } = {}) {
    this.changed = changed; this.now = now; this.grace = grace;
    this.items = []; this.seen = new Set(); this.count = 0; this.timer = null; this.finishedAt = -Infinity;
  }
  list() { this.prune(); return this.items.map(({ id, text, state, at }) => ({ id, text, state, at })); }
  reset() { clearTimeout(this.timer); this.timer = null; this.seen.clear(); this.finishedAt = -Infinity; if (!this.items.length) return; this.items = []; this.changed(); }
  // Typed in the terminal. While the agent works it waits for its turn; otherwise it should start at once.
  submit(text, working, at = this.now()) {
    const value = clean(text);
    if (!value || NOT_A_PROMPT.test(value)) return;
    this.items.push({ id: `p${++this.count}`, text: clip(value), state: 'queued', at, expires: working ? Infinity : at + this.grace });
    this.schedule(); this.changed();
  }
  // The agent's record shows a message it received; id makes a record read twice count once.
  start(text, at = this.now(), id = '') {
    const value = clean(text);
    if (!value || (id && this.seen.has(id))) return;
    if (id) { this.seen.add(id); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value); }
    if (this.items.some(item => item.state === 'working' && key(item.text) === key(value))) return;
    const waiting = this.items.filter(item => item.state === 'queued');
    const item = waiting.find(candidate => key(candidate.text) === key(value)) || waiting[0];
    // A message from a round that has already ended (its record was read after the round's end was reported).
    if (at <= this.finishedAt) { if (item) { this.items.splice(this.items.indexOf(item), 1); this.schedule(); this.changed(); } return; }
    if (item) Object.assign(item, { text: clip(value), state: 'working', started: at, expires: Infinity });
    else this.items.push({ id: `p${++this.count}`, text: clip(value), state: 'working', at, started: at, expires: Infinity });
    // Working prompts come first, in the order the agent took them up.
    this.items.sort((a, b) => (a.state === 'working' ? 0 : 1) - (b.state === 'working' ? 0 : 1) || (a.started ?? a.at) - (b.started ?? b.at));
    this.changed();
  }
  // A round ended at this time: the prompts it took up are done. A prompt taken up later belongs to the next
  // round. Waiting ones are sent next by the agent, so they get a short while to be taken up.
  finish(at = this.now()) {
    const before = this.items.length;
    this.finishedAt = Math.max(this.finishedAt, at);
    this.items = this.items.filter(item => item.state !== 'working' || item.started > at);
    for (const item of this.items) if (item.state === 'queued') item.expires = Math.min(item.expires, this.now() + this.grace);
    this.schedule();
    if (this.items.length !== before) this.changed();
  }
  prune() {
    const now = this.now(), before = this.items.length;
    this.items = this.items.filter(item => item.expires > now);
    return this.items.length !== before;
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    const next = Math.min(...this.items.map(item => item.expires));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => { this.timer = null; if (this.prune()) this.changed(); this.schedule(); }, Math.max(50, next - this.now() + 10));
    this.timer.unref?.();
  }
}

module.exports = { PromptQueue };
