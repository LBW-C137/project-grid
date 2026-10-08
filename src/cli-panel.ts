import type { AgentScreen, ScreenAgent } from './agent-screen-types.ts';
import type { ConversationEntry } from './types.ts';

const rule = (row: string) => /^[─╌]{2,}$/.test(row.trim());
const trimRows = (rows: string[]) => {
  const result = rows.map(row => row.replace(/\r$/, ''));
  while (result.length && !result[0].trim()) result.shift();
  while (result.length && !result.at(-1)!.trim()) result.pop();
  return result;
};
const prompt = (agent: ScreenAgent, row: string) => {
  const match = (agent === 'claude' ? /^\s*❯(?:\s+(.*))?$/ : /^\s*›(?:\s+(.*))?$/).exec(row.replace(/\r$/, ''));
  if (!match || /^\d+\.\s/.test(match[1] ?? '') || /\S\s{2,}\S/.test(match[1] ?? '')) return null;
  return (match[1] ?? '').trim();
};

// A historical prompt is not an input area. Claude needs both surrounding rules;
// Codex needs the footer that parseAgentScreen found below its last composer.
export function cliInputArea(agent: ScreenAgent, rows: string[], screen: AgentScreen) {
  const status = screen.status;
  const hasFooter = !!(status.model || status.mode || status.context || status.effort || status.notes.length);
  for (let index = rows.length - 1; index >= 0; index--) {
    const text = prompt(agent, rows[index]);
    if (text === null) continue;
    if (agent === 'claude') {
      if (!rule(rows[index - 1] ?? '') || !rule(rows[index + 1] ?? '')) continue;
      return { row: index, start: index - 1, footer: index + 2, text, hasFooter };
    }
    if (hasFooter) return { row: index, start: index, footer: index + 1, text, hasFooter };
  }
  return null;
}

export function isCliIdle(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  if (screen.choice || screen.overlay !== 'none') return false;
  const input = cliInputArea(agent, rows, screen);
  if (!input?.hasFooter) return false;
  return input.text === '' || (agent === 'claude'
    ? /^Try ["“].+["”]$/.test(input.text)
    : input.text === 'Ask Codex to do anything');
}

function echoRow(agent: ScreenAgent, rows: string[], command: string, end: number) {
  for (let index = end - 1; index >= 0; index--) {
    const text = rows[index].trim();
    if (text.startsWith(agent === 'claude' ? '❯' : '›') && text.slice(1).trim() === command.trim()) return index;
  }
  return -1;
}

export function extractCliPanelRows(agent: ScreenAgent, rows: string[], screen: AgentScreen, command: string): string[] {
  const input = cliInputArea(agent, rows, screen);
  // A panel can replace the entire input area. Only recognizable status rows are
  // cut in that case; keyboard hints belong to the panel and must remain visible.
  let end = input?.hasFooter ? input.footer : rows.length;
  if (!input) {
    const statusRow = (row: string) => agent === 'claude'
      ? /^\s*[⏺⏸⏵]+\s+.*(?:·|mode on|permissions on)/.test(row)
      : /^\s*(?:GPT|gpt|o\d|codex)[^·]*\s+·\s+[^·]+\s+·\s+.+$/.test(row);
    for (let index = rows.length - 1; index >= 0; index--) {
      if (!statusRow(rows[index])) continue;
      if (rows.slice(index + 1).some(row => row.trim() && !statusRow(row) && !/^\s*(?:\? for shortcuts|⚠)/.test(row))) continue;
      end = index;
      while (end > 0 && (!rows[end - 1].trim() || statusRow(rows[end - 1]))) end--;
      break;
    }
  }
  const echo = echoRow(agent, rows, command, input?.row ?? end);
  let start = echo + 1;
  if (echo < 0) {
    // The composer rules are below the panel, not its upper boundary.
    const boundary = input?.start ?? end;
    for (let index = boundary - 1; index >= 0; index--) {
      if (rule(rows[index])) { start = index + 1; break; }
    }
  }
  // If the command is still in the live composer, do not mirror its echo.
  if (input?.text === command.trim()) {
    if (agent === 'claude' && screen.overlay !== 'none') start = input.row + 1;
    else end = input.start;
  }
  return trimRows(rows.slice(start, end));
}

export function extractCliOutputRows(agent: ScreenAgent, rows: string[], screen: AgentScreen, command: string): string[] {
  const input = cliInputArea(agent, rows, screen);
  if (!input) return [];
  const echo = echoRow(agent, rows, command, input.start);
  // Without the echo, using old conversation text would fabricate command output.
  return echo < 0 ? [] : trimRows(rows.slice(echo + 1, input.start));
}

export type CliCommand = {
  id: string; command: string; at: number; anchor: string | null;
  observed: boolean; idleSince: number | null; output: string[];
};
export type CliResult = Pick<CliCommand, 'id' | 'command' | 'at' | 'anchor'> & { rows: string[] };
export type CliOutputEntry = ConversationEntry & { cliOutput?: string[] };

// Stream observations start the idle clock; timer ticks only advance it. The
// pre-submit snapshot must never complete a command before the CLI receives it.
export function advanceCliCommand(command: CliCommand, agent: ScreenAgent, rows: string[], screen: AgentScreen, now: number, observation: boolean) {
  const next = { ...command, observed: command.observed || observation };
  const idle = isCliIdle(agent, rows, screen);
  if (!next.observed || !idle) next.idleSince = null;
  else {
    next.idleSince ??= now;
    next.output = extractCliOutputRows(agent, rows, screen, command.command);
  }
  return { command: next, done: next.idleSince !== null && now - next.idleSince >= 400 };
}

// Insert immediately after the transcript's command when available. Otherwise a
// local command row provides its anchor. Repeated commands match only after the
// entry that preceded this submission, and each transcript row is used once.
export function mergeCliResults(entries: ConversationEntry[], results: CliResult[]): CliOutputEntry[] {
  const merged: CliOutputEntry[] = [...entries];
  const used = new Set<string>();
  for (const result of results) {
    const anchor = result.anchor ? merged.findIndex(entry => entry.id === result.anchor) : -1;
    let index = merged.findIndex((entry, at) => at > anchor && entry.role === 'user' && entry.text?.trim() === result.command && !used.has(entry.id));
    if (index >= 0) used.add(merged[index].id);
    else {
      index = merged.findIndex((entry, at) => at > anchor && entry.at > result.at);
      if (index < 0) index = merged.length;
      merged.splice(index, 0, { id: result.id + '-command', at: result.at, role: 'user', text: result.command });
    }
    used.add(merged[index].id);
    merged.splice(index + 1, 0, { id: result.id, at: result.at, role: 'assistant', cliOutput: result.rows });
  }
  return merged;
}

export function cliPanelKey(event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): string | null {
  const keys: Record<string, string> = { ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Enter: '\r', Escape: '\x1b', Backspace: '\x7f', Delete: '\x1b[3~', Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~' };
  if (event.metaKey) return null;
  if (event.ctrlKey && /^[a-z]$/i.test(event.key)) return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
  const key = event.key === 'Tab' ? event.shiftKey ? '\x1b[Z' : '\t' : keys[event.key] ?? ([...event.key].length === 1 ? event.key : null);
  return key !== null && event.altKey ? '\x1b' + key : key;
}
