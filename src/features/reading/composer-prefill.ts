// Text written elsewhere (the home page's "what next") for a terminal's message box: its reading view takes it once,
// when it is showing, and the reader sends it after a look. Nothing is typed into the agent from here.
const waiting = new Map<string, string>();
const listeners = new Set<(terminalId: string) => void>();

export function prefillComposer(terminalId: string, text: string) {
  waiting.set(terminalId, text);
  listeners.forEach(listener => listener(terminalId));
}

// Calls take(text) now if text waits for this terminal, and whenever some arrives later.
export function onComposerPrefill(terminalId: string, take: (text: string) => void) {
  const give = (id: string) => {
    const text = waiting.get(id);
    if (id !== terminalId || text === undefined) return;
    waiting.delete(id); take(text);
  };
  listeners.add(give); give(terminalId);
  return () => { listeners.delete(give); };
}
