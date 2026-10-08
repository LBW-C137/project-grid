import { useSyncExternalStore } from 'react';
import type { ProjectTerminal } from './types';

// While Codex or Claude Code runs in a terminal, its conversation shows in the reading view by default. The toggle
// in the card header shows the raw terminal instead; that choice lasts until the agent exits, and the next agent
// started there opens in the reading view again.
let terminals = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: string[] = [];
const inputSeen = new Set<string>(), automatic = new Set<string>();

export function setReading(id: string, on: boolean, auto = false) {
  if (!auto) automatic.delete(id);
  if (terminals.has(id) === !on) return;
  terminals = new Set(terminals);
  if (on) terminals.delete(id); else terminals.add(id);
  snapshot = [...terminals];
  listeners.forEach(listener => listener());
}
// The terminals switched to the raw terminal while their agent runs.
export function useTerminalChoice() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
export const readingShown = (terminal: ProjectTerminal, raw: string[]) => !!terminal.sessionId && terminal.codexActive && !raw.includes(terminal.id);
// Forget a terminal's choice once its agent has exited.
export function agentExited(terminal: ProjectTerminal) { if (!terminal.codexActive && terminals.has(terminal.id)) setReading(terminal.id, true); }
// One handoff per permission notice; a manual toggle cancels its return trip.
export function syncReading(terminal: ProjectTerminal) {
  agentExited(terminal);
  if (terminal.needsInput !== null && terminal.codexActive) {
    if (inputSeen.has(terminal.id)) return;
    inputSeen.add(terminal.id);
    if (readingShown(terminal, snapshot)) { automatic.add(terminal.id); setReading(terminal.id, false, true); }
  } else {
    inputSeen.delete(terminal.id);
    if (automatic.delete(terminal.id) && terminals.has(terminal.id)) setReading(terminal.id, true, true);
  }
}
