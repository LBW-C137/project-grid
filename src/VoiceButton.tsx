import type { CSSProperties } from 'react';
import { Microphone, SpinnerGap } from '@phosphor-icons/react';
import { toggleDictation, useVoice } from './voice-input';

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
  const status = recording ? '正在录音，再次点击插入文字（Esc 取消）'
    : busy ? '正在识别…'
    : voice.microphone === false ? '未检测到麦克风'
    : model?.phase === 'downloading' ? `麦克风已连接 · 语音模型下载中 ${model.percent}%`
    : model && !model.ready ? '麦克风已连接 · 点击下载语音模型'
    : '麦克风已连接 · 点击说话';
  const tone = recording ? 'is-recording' : busy ? 'is-busy' : voice.microphone === false ? 'mic-missing' : voice.microphone ? 'mic-connected' : '';
  return <button type="button" className={`icon-button voice-button ${tone}`} title={status} aria-label={`语音输入 ${name}`} aria-pressed={recording}
    style={{ '--voice-level': voice.level.toFixed(2) } as CSSProperties}
    onClick={event => { event.stopPropagation(); void toggleDictation(terminalId, sessionId, onError); }}>
    {busy ? <SpinnerGap className="loading-spinner" size={size} /> : <Microphone size={size} weight={recording ? 'fill' : 'regular'} />}
  </button>;
}
