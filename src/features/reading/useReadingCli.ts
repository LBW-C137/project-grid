import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { ScreenAgent } from '../agents/agent-screen-types';
import { codexDialog, parseAgentScreen } from '../agents/agent-screen';
import { readScreen, subscribeScreen, type Screen } from '../terminal/terminal-screen';
import { advanceCliCommand, cliDialogShown, cliHistory, cliInputDraft, commandInputText, cliResultRows, extractCliPanelRows, hasCliInput, isSideConversation, isCliIdle, type CliCommand } from './cli-panel';

// The command shown in the popup: while it runs (pending), and once it has finished (done) until the reader closes it.
type Panel = { command: string; rows: string[]; done?: boolean };
type Snapshot = { pending: CliCommand | null; panel: Panel | null; feedback?: 'waiting' | 'recovery'; interactive?: boolean };
// What the view shows (the popup, whether a command runs) changes far less often than the tracking behind it: the
// screen redraws many times a second while the agent works, and only a visible change re-renders the reading view.
type View = { panel: Panel | null; busy: boolean; commandId?: string; feedback?: 'waiting' | 'recovery'; interactive?: boolean };
type Session = { terminalId: string; snapshot: Snapshot; view: View; listeners: Set<() => void>; stop: (() => void) | null; confirmInput?: (id: string) => boolean; disposed?: boolean };
// Renderer-only state survives switching views; each PTY session owns its popup.
const sessions = new Map<string, Session>();
export function pruneReadingCli(liveKeys: ReadonlySet<string>) {
  for (const [key, session] of sessions) {
    if (liveKeys.has(key)) continue;
    session.disposed = true; session.stop?.(); sessions.delete(key);
  }
}
let sequence = 0;
function sessionFor(id: string, sessionId: string | null) {
  const key = JSON.stringify([id, sessionId]);
  for (const [otherKey, other] of sessions) {
    if (otherKey !== key && other.terminalId === id && other.stop) { other.disposed = true; other.stop(); other.stop = null; publish(other, { pending: null, panel: null }); sessions.delete(otherKey); }
  }
  let session = sessions.get(key);
  if (!session) { session = { terminalId: id, snapshot: { pending: null, panel: null }, view: { panel: null, busy: false }, listeners: new Set(), stop: null }; sessions.set(key, session); }
  return session;
}
const samePanel = (a: Panel | null, b: Panel | null) => a === b || (!!a && !!b && a.command === b.command && a.done === b.done
  && a.rows.length === b.rows.length && a.rows.every((row, index) => row === b.rows[index]));
function publish(session: Session, snapshot: Snapshot) {
  session.snapshot = snapshot;
  const busy = snapshot.pending !== null;
  const commandId = snapshot.pending?.id ?? (snapshot.panel ? session.view.commandId : undefined);
  if (busy === session.view.busy && samePanel(snapshot.panel, session.view.panel) && commandId === session.view.commandId && snapshot.feedback === session.view.feedback && snapshot.interactive === session.view.interactive) return;
  session.view = { panel: snapshot.panel, busy, commandId, feedback: snapshot.feedback, interactive: snapshot.interactive };
  session.listeners.forEach(listener => listener());
}
function begin(session: Session, terminalId: string, agent: ScreenAgent, command: string, history?: string[], footer?: string) {
  if (session.disposed) return;
  session.stop?.();
  let latest = readScreen(terminalId), subscribing = true;
  const before = history ?? (latest ? cliHistory(agent, latest.rows, parseAgentScreen(agent, latest.rows)) : undefined);
  const pending: CliCommand = { id: `cli-output-${++sequence}`, command, at: Date.now(), observed: false, idleSince: null, output: [], dialog: [], before, footer };
  publish(session, { pending, panel: { command, rows: [] }, feedback: 'waiting', interactive: false });
  let active = true, progressAt = Date.now(), parsed = latest ? parseAgentScreen(agent, latest.rows) : null;
  let parsedRows = latest?.rows, interval: ReturnType<typeof setInterval> | undefined;
  const recover = () => {
    clearInterval(interval); interval = undefined;
    publish(session, { ...session.snapshot, panel: session.snapshot.panel ?? { command, rows: [] }, feedback: 'recovery', interactive: false });
  };
  const watch = () => { if (interval === undefined) interval = setInterval(() => update(false), 100); };
  const update = (observation: boolean) => {
    const current = session.snapshot.pending;
    if (!active || current?.id !== pending.id) return;
    if (!observation && session.snapshot.feedback === 'recovery') { clearInterval(interval); interval = undefined; return; }
    if (Date.now() - progressAt >= 10000) {
      // An unchanged interactive dialog is waiting for the reader, not a hung command. Stop polling it.
      if (session.snapshot.interactive || parsed?.choice) { clearInterval(interval); interval = undefined; return; }
      recover(); return;
    }
    if (!latest) return;
    if (parsedRows !== latest.rows) { parsed = parseAgentScreen(agent, latest.rows); parsedRows = latest.rows; }
    const screen = parsed!;
    // A first late input screen has no pre-command history to compare against. Establish a baseline rather than
    // attributing its earlier conversation to this command. Dialogs/choices can still show their own captured UI.
    if (observation && current.before === undefined && !current.observed && !screen.choice && !cliDialogShown(agent, latest.rows, screen) && hasCliInput(agent, latest.rows, screen)) {
      publish(session, { ...session.snapshot, pending: { ...current, before: cliHistory(agent, latest.rows, screen) } });
      return;
    }
    // A Codex side conversation idles at its own input between messages; it lasts until its popup is closed.
    const side = isSideConversation(agent, command, [...session.snapshot.panel?.rows ?? [], ...latest.rows]);
    if (!observation && (current.idleSince === null || Date.now() - current.idleSince < 400)) return;
    const next = advanceCliCommand(current, agent, latest.rows, screen, Date.now(), observation);
    if (side) next.done = false;
    if (next.done) {
      session.stop?.(); session.stop = null;
      const rows = cliResultRows(next.command);
      // Finished with nothing printed, it says so and stays until closed: a spinner would mean it still runs. A command
      // that asked something was answered in the reading view's own card, and leaves nothing more.
      publish(session, { pending: null, panel: rows.length || !next.command.chose ? { command, rows, done: true } : null });
    } else if (observation || next.command.idleSince !== current.idleSince) {
      const dialog = cliDialogShown(agent, latest.rows, screen);
      const panel = screen.choice ? null : isCliIdle(agent, latest.rows, screen) && !side
        ? next.command.observed && !next.command.chose ? { command, rows: next.command.output } : session.snapshot.panel
        : hasCliInput(agent, latest.rows, screen) && !side && !dialog ? { command, rows: [] }
        : next.command.observed ? { command, rows: extractCliPanelRows(agent, latest.rows, screen, command, next.command.before) } : session.snapshot.panel;
      // A dialog the CLI is still redrawing (or just closed) leaves nothing for a moment: keep showing it.
      const shown = panel && !panel.rows.length && session.snapshot.panel?.rows.length ? session.snapshot.panel : panel;
      if (panel?.rows.length && (side || !hasCliInput(agent, latest.rows, screen) || (agent === 'codex' && codexDialog(latest.rows)))) next.command.dialog = panel.rows;
      publish(session, { pending: next.command, panel: screen.choice ? null : shown ?? { command, rows: [] }, feedback: shown?.rows.length ? undefined : 'waiting', interactive: dialog });
    } else session.snapshot = { ...session.snapshot, pending: next.command };
  };
  const observe = (screen: Screen) => {
    if (!active || session.snapshot.pending?.id !== pending.id) return;
    const changed = !latest || latest.rows.length !== screen.rows.length || latest.rows.some((row, index) => row !== screen.rows[index]);
    if (changed) { latest = screen; progressAt = Date.now(); }
    if (!subscribing && (changed || !session.snapshot.pending.observed)) { watch(); update(true); }
  };
  const unsubscribe = subscribeScreen(terminalId, observe);
  subscribing = false;
  session.confirmInput = id => {
    if (!active || id !== session.snapshot.pending?.id) return false;
    const current = readScreen(terminalId);
    if (!current || cliInputDraft(agent, current.rows, parseAgentScreen(agent, current.rows)) !== commandInputText(command)) return false;
    // Read the live xterm input directly before Enter: the 100 ms publisher may coalesce typed input and its result.
    observe(current);
    const tracked = session.snapshot.pending;
    if (tracked?.id !== id) return false;
    publish(session, { ...session.snapshot, pending: { ...tracked, inputConfirmed: true } });
    return true;
  };
  watch();
  session.stop = () => { active = false; session.confirmInput = undefined; unsubscribe(); clearInterval(interval); interval = undefined; };
  return pending.id;
}

// Stop following the command and close its popup.
function close(session: Session) {
  if (!session.snapshot.pending && !session.snapshot.panel) return;
  session.stop?.(); session.stop = null;
  publish(session, { pending: null, panel: null });
}

export function useReadingCli(terminalId: string, sessionId: string | null, agent: ScreenAgent, input: RefObject<HTMLTextAreaElement | null>, autoFocus: boolean) {
  const session = useMemo(() => sessionFor(terminalId, sessionId), [terminalId, sessionId]);
  const snapshot = useSyncExternalStore(listener => { session.listeners.add(listener); return () => { session.listeners.delete(listener); }; }, () => session.view);
  const previous = useRef(snapshot.panel);
  useLayoutEffect(() => {
    if (previous.current && !snapshot.panel && autoFocus) input.current?.focus();
    previous.current = snapshot.panel;
  }, [snapshot.panel, autoFocus, input]);
  return {
    panel: snapshot.panel,
    busy: snapshot.busy,
    commandId: snapshot.commandId,
    feedback: snapshot.feedback,
    interactive: snapshot.interactive,
    begin: (command: string, history?: string[], footer?: string) => begin(session, terminalId, agent, command, history, footer),
    confirmInput: (id: string) => session.confirmInput?.(id) ?? false,
    submitted: (id: string) => {
      const pending = session.snapshot.pending;
      if (!session.disposed && pending?.id === id && pending.inputConfirmed) publish(session, { ...session.snapshot, pending: { ...pending, submitted: true } });
    },
    close: () => close(session),
    recover: () => { if (!session.disposed) publish(session, { ...session.snapshot, feedback: 'recovery', interactive: false }); },
  };
}
