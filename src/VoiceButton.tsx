import { useEffect, type CSSProperties } from 'react';
import { Microphone, SpinnerGap } from '@phosphor-icons/react';
import { quickDictation, toggleDictation, useVoice } from './voice-input';

// Settings summary of the offline model. It downloads by itself after installation; this only reports it.
export function VoiceModelStatus() {
  const { model } = useVoice();
  if (!model) return null;
  if (model.ready) return <span className="voice-model-status is-ready" role="status">已就绪</span>;
  if (model.phase === 'downloading') return <span className="voice-model-status" role="status">下载中 {model.percent}%</span>;
  return <button className="button secondary small" title={model.error || undefined} onClick={() => void window.projectGrid.prepareVoice()}>{model.phase === 'error' ? '重试下载' : '下载模型'}</button>;
}

// Blue: a microphone is connected. Red: none is connected. Pulsing: recording this terminal.
export function VoiceButton({ terminalId, sessionId, name, size = 14, onError }: { terminalId: string; sessionId: string | null; name: string; size?: number; onError: (message: string) => void }) {
  const voice = useVoice();
  const recording = voice.recording === terminalId, busy = voice.busy === terminalId;
  const model = voice.model;
  const status = recording ? '正在录音 · Enter 识别并发送，再次点击只插入不发送（Esc 取消）'
    : busy ? '正在识别…'
    : voice.microphone === false ? '未检测到麦克风'
    : model?.phase === 'downloading' ? `麦克风已连接 · 语音模型下载中 ${model.percent}%`
    : model && !model.ready ? '麦克风已连接 · 点击下载语音模型'
    : '麦克风已连接 · 点击或按 Ctrl+T 说话';
  const tone = recording ? 'is-recording' : busy ? 'is-busy' : voice.microphone === false ? 'mic-missing' : voice.microphone ? 'mic-connected' : '';
  return <button type="button" className={`icon-button voice-button ${tone}`} title={status} aria-label={`语音输入 ${name}`} aria-pressed={recording}
    style={{ '--voice-level': voice.level.toFixed(2) } as CSSProperties}
    onClick={event => { event.stopPropagation(); void toggleDictation(terminalId, sessionId, onError, name); }}>
    {busy ? <SpinnerGap className="loading-spinner" size={size} /> : <Microphone size={size} weight={recording ? 'fill' : 'regular'} />}
  </button>;
}

// Ctrl+T anywhere in the window starts dictation into the current terminal. While it records, a microphone
// sits in the middle of the window; Enter (or Ctrl+T again) inserts the text and sends it, Esc cancels.
export function VoiceOverlay({ onError }: { onError: (message: string) => void }) {
  const voice = useVoice();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.code !== 'KeyT') return;
      // xterm would otherwise send Ctrl+T (^T) to the shell or agent.
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat && !document.querySelector('dialog[open]')) void quickDictation(onError);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onError]);
  const recording = !!voice.recording;
  if (!recording && !voice.busy) return null;
  return <div className="voice-overlay" role="status" aria-live="polite" aria-label="语音输入">
    <div className={`voice-orb ${recording ? 'is-recording' : 'is-busy'}`} style={{ '--voice-level': voice.level.toFixed(2) } as CSSProperties}>
      {recording ? <Microphone size={34} weight="fill" /> : <SpinnerGap className="loading-spinner" size={34} />}
    </div>
    <b>{recording ? '正在听…' : voice.sending ? '正在识别并发送…' : '正在识别…'}</b>
    {voice.label && <span className="voice-overlay-target">{voice.label}</span>}
    {recording && <span className="voice-overlay-keys"><kbd>Enter</kbd>发送<kbd>Esc</kbd>取消</span>}
  </div>;
}
