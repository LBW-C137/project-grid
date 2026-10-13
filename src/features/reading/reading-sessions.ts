import type { ProjectTerminal, Result } from '../../shared/types';

// /resume opens the reading view's own list for both agents on this computer, read from their records here. Over SSH
// the CLI's own list is used (Codex's shows in the reading view as a choice, agent-screen.ts): Codex lists there what
// it keeps on that computer, names and archives included, which its records alone do not always tell.
export const usesSessionPicker = (terminal: Pick<ProjectTerminal, 'agent' | 'codexActive'>, text: string, remote = false) =>
  terminal.codexActive && text === '/resume' && !remote;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const terminalNow = async (terminalId: string) => {
  const state = await window.agentrix.getState();
  return state.ok ? state.value.projects.flatMap(project => project.terminals).find(terminal => terminal.id === terminalId) : undefined;
};

// Codex changes conversation from its shell: it quits, and the same terminal resumes the chosen one with the command a
// project's restore uses, so the reading view follows that conversation from its start. A round at work is not cut off.
export async function resumeCodexSession(terminalId: string, id: string, active: () => boolean, busy: string, stuck: string) {
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)) throw new Error('Invalid session id');
  if ((await terminalNow(terminalId))?.codexActivity === 'working') throw new Error(busy);
  if (!active()) return false;
  window.agentrix.writeTerminal(terminalId, '\x15'); await pause(60);
  window.agentrix.writeTerminal(terminalId, '/quit'); await pause(150);
  if (!active()) return false;
  window.agentrix.writeTerminal(terminalId, '\r');
  for (const end = Date.now() + 10000; Date.now() < end; await pause(250)) {
    const terminal = await terminalNow(terminalId);
    if (terminal && !terminal.codexActive) { window.agentrix.writeTerminal(terminalId, `codex resume ${id}\r`); return true; }
  }
  throw new Error(stuck);
}

// Like other slash commands, send typed text, wait for the CLI redraw, then send Enter separately.
export async function resumeReadingSession(id: string, write: (text: string) => void,
  follow: (id: string) => Promise<Result<boolean>>, active: () => boolean) {
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Invalid session id');
  if (!active()) return false;
  // Whatever waits in Claude's input (a prompt it put back after an interrupt) would be sent with the command: cleared.
  write('\x15');
  await new Promise(resolve => setTimeout(resolve, 60));
  if (!active()) return false;
  write(`/resume ${id}`);
  await new Promise(resolve => setTimeout(resolve, 150));
  if (!active()) return false;
  write('\r');
  const result = await follow(id);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export function sessionAge(updatedAt: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60000));
  if (minutes < 1) return { unit: 'now', count: 0 } as const;
  if (minutes < 60) return { unit: 'minutes', count: minutes } as const;
  if (minutes < 1440) return { unit: 'hours', count: Math.floor(minutes / 60) } as const;
  return { unit: 'days', count: Math.floor(minutes / 1440) } as const;
}
