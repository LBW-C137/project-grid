import { useSyncExternalStore } from 'react';

// Which terminals show the reading view instead of the raw terminal. Remembered in this browser profile,
// so a terminal opens the way it was last seen; nothing breaks when storage is unavailable.
const KEY = 'project-grid.reading';
let reading = new Set<string>();
try { reading = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { }
const listeners = new Set<() => void>();
let snapshot = [...reading];

export function setReading(id: string, on: boolean) {
  if (reading.has(id) === on) return;
  if (on) reading.add(id); else reading.delete(id);
  snapshot = [...reading];
  try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch { }
  listeners.forEach(listener => listener());
}
export function useReading() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
