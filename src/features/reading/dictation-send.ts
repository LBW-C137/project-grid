// One cancellable grace period per composer: dictated words show in the box for half a second before they are sent.
// The callback reads the current composer, including its pictures.
export const DICTATION_PAUSE = 500;
export function createDictationSend(send: () => void, changed: (pending: boolean) => void,
  schedule: (run: () => void, delay: number) => () => void = (run, delay) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  }) {
  let stop: (() => void) | undefined, generation = 0;
  const cancel = () => {
    if (!stop) return false;
    const cancelTimer = stop; stop = undefined; generation++;
    cancelTimer(); changed(false);
    return true;
  };
  return {
    cancel,
    start() {
      cancel();
      const current = ++generation;
      stop = schedule(() => {
        // A callback already queued before cancellation must not send a later draft.
        if (current !== generation) return;
        cancel(); send();
      }, DICTATION_PAUSE);
      changed(true);
    },
  };
}
