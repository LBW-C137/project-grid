import { useEffect, useState, type CSSProperties } from 'react';
import { Microphone, SpinnerGap } from '@phosphor-icons/react';
import { toggleDictation, useVoice } from './voice-input';
import { t } from './i18n';
import { shortcut } from './shortcuts';

// Settings summary of the offline model. It downloads by itself after installation; this only reports it.
export function VoiceModelStatus() {
  const { model } = useVoice();
  if (!model) return null;
  if (model.ready) return <span className="voice-model-status is-ready" role="status">{t('已就绪')}</span>;
  if (model.phase === 'downloading') return <span className="voice-model-status" role="status">{t('下载中 {percent}%', { percent: model.percent })}</span>;
  return <button className="button secondary small" title={model.error ? t(model.error) : undefined} onClick={() => void window.projectGrid.prepareVoice()}>{model.phase === 'error' ? t('重试下载') : t('下载模型')}</button>;
}

// Blue: a microphone is connected. Red: none is connected. Pulsing: recording this terminal.
export function VoiceButton({ terminalId, sessionId, name, size = 14, onError }: { terminalId: string; sessionId: string | null; name: string; size?: number; onError: (message: string) => void }) {
  const voice = useVoice();
  const recording = voice.recording === terminalId, busy = voice.busy === terminalId;
  const model = voice.model;
  const status = recording ? t('正在录音 · Enter 识别并发送，再次点击只插入不发送（Esc 取消）')
    : busy ? t('正在识别…')
    : voice.microphone === false ? t('未检测到麦克风')
    : model?.phase === 'downloading' ? t('麦克风已连接 · 语音模型下载中 {percent}%', { percent: model.percent })
    : model && !model.ready ? t('麦克风已连接 · 点击下载语音模型')
    : t('麦克风已连接 · 点击或按 {key} 说话', { key: shortcut('voice') });
  const tone = recording ? 'is-recording' : busy ? 'is-busy' : voice.microphone === false ? 'mic-missing' : voice.microphone ? 'mic-connected' : '';
  return <button type="button" className={`icon-button voice-button ${tone}`} title={status} aria-label={t('语音输入 {name}', { name })} aria-pressed={recording}
    style={{ '--voice-level': voice.level.toFixed(2) } as CSSProperties}
    onClick={event => { event.stopPropagation(); void toggleDictation(terminalId, sessionId, onError, name); }}>
    {busy ? <SpinnerGap className="loading-spinner" size={size} /> : <Microphone size={size} weight={recording ? 'fill' : 'regular'} />}
  </button>;
}

type Box = { left: number; top: number; width: number; height: number };

// The project card holding this terminal, tracked every frame while shown so the microphone stays
// centred on it through focus animations, window resizes and grid changes.
function useCardBox(terminalId: string | null) {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!terminalId) { setBox(null); return; }
    let frame = 0;
    const track = () => {
      const card = document.querySelector(`[data-terminal-id="${CSS.escape(terminalId)}"]`)?.closest('.project-panel');
      const rect = card?.getBoundingClientRect();
      const next = rect?.width ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      setBox(current => current && next && Object.keys(next).every(key => current[key as keyof Box] === next[key as keyof Box]) ? current : next);
      frame = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(frame);
  }, [terminalId]);
  return box;
}

// Ctrl+T anywhere in the window starts dictation into the current terminal. While it records, a microphone
// sits in the middle of that terminal's project card; Enter (or Ctrl+T again) inserts the text and sends it, Esc cancels.
// The voice shortcut itself is handled with the other app shortcuts in App.
export function VoiceOverlay() {
  const voice = useVoice();
  const box = useCardBox(voice.recording || voice.busy);
  const recording = !!voice.recording;
  if (!recording && !voice.busy) return null;
  // Without a visible card (for example, while a file preview covers it) the window centre is used.
  return <div className="voice-overlay-anchor" style={box || undefined}><div className="voice-overlay" role="status" aria-live="polite" aria-label={t('语音输入')}>
    <div className={`voice-orb ${recording ? 'is-recording' : 'is-busy'}`} style={{ '--voice-level': voice.level.toFixed(2) } as CSSProperties}>
      {recording ? <Microphone size={34} weight="fill" /> : <SpinnerGap className="loading-spinner" size={34} />}
    </div>
    <b>{recording ? t('正在听…') : voice.sending ? t('正在识别并发送…') : t('正在识别…')}</b>
    {voice.label && <span className="voice-overlay-target">{voice.label}</span>}
    {recording && <span className="voice-overlay-keys"><kbd>Enter</kbd>{t('发送')}<kbd>Esc</kbd>{t('取消')}</span>}
  </div></div>;
}
