import { useSyncExternalStore } from 'react';
import { MicrophoneCapture } from './voice-audio';
import type { VoiceState } from './types';

// One shared dictation controller: a single microphone, one recording at a time,
// and every terminal's microphone button reflecting the same device and model state.
export type VoiceSnapshot = { microphone: boolean | null; model: VoiceState | null; recording: string | null; busy: string | null; level: number };
let snapshot: VoiceSnapshot = { microphone: null, model: null, recording: null, busy: null, level: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<VoiceSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };

const capture = new MicrophoneCapture();
let target: { id: string; sessionId: string; onError: (message: string) => void } | null = null;
let started = false;

async function refreshMicrophone() {
  try { set({ microphone: (await navigator.mediaDevices.enumerateDevices()).some(device => device.kind === 'audioinput') }); }
  catch { set({ microphone: false }); }
}

function start() {
  if (started) return; started = true;
  navigator.mediaDevices?.addEventListener('devicechange', () => void refreshMicrophone());
  void refreshMicrophone();
  window.projectGrid.onVoiceState(model => set({ model }));
  void window.projectGrid.getVoiceState().then(result => { if (result.ok) set({ model: result.value }); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && snapshot.recording) void cancelDictation(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && snapshot.recording) { event.preventDefault(); void cancelDictation(); } }, true);
}

function subscribe(listener: () => void) { start(); listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useVoice() { return useSyncExternalStore(subscribe, () => snapshot); }

export function microphoneMessage(error: unknown) {
  const name = (error as DOMException)?.name;
  if (name === 'NotAllowedError') return '麦克风访问被拒绝，请在 Windows 设置中允许桌面应用使用麦克风。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '未检测到麦克风，请连接后重试。';
  if (name === 'NotReadableError') return '麦克风无法使用，可能正被其他程序占用。';
  return String((error as Error)?.message || error);
}

function modelMessage(model: VoiceState | null) {
  if (model?.phase === 'downloading') return `语音模型正在下载（${model.percent}%），完成后即可使用。`;
  return '语音模型开始下载，完成后即可使用。';
}

function focusTerminal(id: string) {
  document.querySelector<HTMLTextAreaElement>(`[data-terminal-id="${CSS.escape(id)}"] .xterm-helper-textarea`)?.focus();
}

export async function cancelDictation() {
  target = null; await capture.close(); set({ recording: null, level: 0 });
}

async function finish() {
  const current = target; if (!current) return;
  target = null; set({ recording: null, busy: current.id, level: 0 });
  try {
    const wav = await capture.stopRecording(); await capture.close();
    const text = await window.projectGrid.transcribe(wav);
    if (!text.ok) throw new Error(text.error);
    const pasted = await window.projectGrid.pasteTerminal(current.id, text.value, current.sessionId);
    if (!pasted.ok) throw new Error(pasted.error);
    focusTerminal(current.id);
  } catch (error) { current.onError(microphoneMessage(error)); }
  finally { await capture.close(); set({ busy: null }); }
}

// Click once to start talking, click again to insert the recognised text into this terminal's input.
// Nothing is submitted: the user reviews the text and presses Enter.
export async function toggleDictation(id: string, sessionId: string | null, onError: (message: string) => void) {
  if (snapshot.busy) return onError('正在识别上一段语音，请稍候。');
  if (snapshot.recording) return snapshot.recording === id ? finish() : onError('另一个终端正在录音，请先结束那一段。');
  if (!sessionId) return onError('请先启动终端，再使用语音输入。');
  if (snapshot.microphone === false) { void refreshMicrophone(); return onError('未检测到麦克风，请连接后重试。'); }
  if (!snapshot.model?.ready) {
    if (snapshot.model?.phase !== 'downloading') void window.projectGrid.prepareVoice();
    return onError(modelMessage(snapshot.model));
  }
  try {
    await capture.open('', level => set({ level: Math.min(1, level * 5) }));
    capture.onLimit = () => void finish();
    capture.startRecording();
    target = { id, sessionId, onError };
    set({ recording: id, microphone: true });
  } catch (error) { await capture.close(); onError(microphoneMessage(error)); void refreshMicrophone(); }
}
