const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { interactiveSession } = require('./session-restore.cjs');
const { rolloutFiles, sessionMeta } = require('./session-files.cjs');

// Only interactive rollout files can own a project card. A child agent can
// inherit notify, but its completion does not end the interactive parent turn.
class CodexActivityReader {
  constructor(cwd, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), since = Date.now(), options = {}) {
    this.cwd = cwd; this.directory = path.join(home, 'sessions'); this.since = since;
    this.options = options; this.boundThread = null;
    this.offset = 0; this.buffer = Buffer.alloc(0); this.skipping = false;
    this.snapshot = null; this.nextDiscovery = 0;
  }
  async discover() {
    if (Date.now() < this.nextDiscovery) return;
    this.nextDiscovery = Date.now() + 2000;
    // The listing is shared with the other terminals and kept current by a watcher (session-files.cjs).
    const candidates = (await rolloutFiles(this.directory)).filter(item => this.boundThread ? item.name.includes(this.boundThread) : item.modified >= this.since - 2000);
    candidates.sort((a, b) => b.modified - a.modified);
    for (const item of candidates) {
      if (item.filename === this.filename) return;
      try {
        const meta = await sessionMeta(item.filename);
        if (interactiveSession(meta, this.cwd) && (!this.boundThread || meta.id === this.boundThread)) {
          this.filename = item.filename;
          this.offset = 0; this.buffer = Buffer.alloc(0); this.skipping = false;
          this.snapshot = { threadId: meta.id, turnId: null, state: 'unknown', updatedAt: 0 };
          return;
        }
      } catch {}
    }
  }
  record(record) {
    if (record.type !== 'event_msg') return;
    const item = record.payload || {}, turn = item.turn_id;
    // The prompt of the round, so its completion can be announced by what it worked on.
    if (item.type === 'user_message' && typeof item.message === 'string') { this.snapshot = { ...this.snapshot, prompt: item.message.slice(0, 2000) }; return; }
    if (['task_started', 'turn_started'].includes(item.type)) {
      if (typeof turn !== 'string' || !turn) return;
      this.snapshot = { ...this.snapshot, turnId: turn, state: 'working', updatedAt: Date.parse(record.timestamp) || 0 };
    } else if (['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(item.type)) {
      if (!this.snapshot.turnId || turn && turn !== this.snapshot.turnId) return;
      this.snapshot = { ...this.snapshot, state: ['task_complete', 'turn_completed'].includes(item.type) ? 'complete' : 'interrupted', updatedAt: Date.parse(record.timestamp) || 0 };
    }
  }
  async read() {
    const threadId = this.options.threadId?.() || null;
    if (threadId !== this.boundThread) { this.boundThread = threadId; this.filename = null; this.snapshot = null; this.offset = 0; this.buffer = Buffer.alloc(0); this.skipping = false; this.nextDiscovery = 0; }
    if (this.options.requireBinding?.() && !threadId) return null;
    if (!this.filename || this.snapshot.state !== 'working') await this.discover();
    if (!this.filename) return null;
    const file = await fs.open(this.filename, 'r');
    try {
      const stat = await file.stat();
      if (stat.size < this.offset) { this.offset = 0; this.buffer = Buffer.alloc(0); this.skipping = false; this.snapshot = { ...this.snapshot, turnId: null, state: 'unknown', updatedAt: 0 }; }
      // Bound each poll; never rescan a growing transcript from its beginning.
      const end = Math.min(stat.size, this.offset + 4 * 1024 * 1024);
      while (this.offset < end) {
        const chunk = Buffer.alloc(Math.min(65536, end - this.offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(0, bytesRead)]);
        let newline;
        while ((newline = this.buffer.indexOf(10)) !== -1) {
          const line = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
          if (!this.skipping && line.length <= 1024 * 1024) { try { this.record(JSON.parse(line.toString('utf8'))); } catch {} }
          this.skipping = false;
        }
        if (this.buffer.length > 1024 * 1024) { this.buffer = Buffer.alloc(0); this.skipping = true; }
      }
      return this.offset >= stat.size ? { ...this.snapshot } : null;
    } finally { await file.close(); }
  }
}

// One asynchronous read at a time, with cancellation even when a remote read
// finishes after the terminal has exited or been replaced.
function monitorActivity(read, onChange, { interval = 1000 } = {}) {
  let stopped = false, timer = null, pending = null, last = '';
  const poll = () => {
    if (stopped) return Promise.resolve(null);
    if (pending) return pending;
    clearTimeout(timer);
    pending = Promise.resolve().then(read).then(snapshot => {
      if (stopped || !snapshot) return null;
      const signature = JSON.stringify(snapshot);
      if (signature !== last) { last = signature; onChange(snapshot); }
      return snapshot;
    }).catch(() => null).finally(() => {
      pending = null;
      if (!stopped) { timer = setTimeout(poll, interval); timer.unref?.(); }
    });
    return pending;
  };
  void poll();
  return { poll, stop() { stopped = true; clearTimeout(timer); } };
}

module.exports = { CodexActivityReader, monitorActivity };
