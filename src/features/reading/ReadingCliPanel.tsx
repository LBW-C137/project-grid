import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { CheckCircle, CircleNotch } from '@phosphor-icons/react';
import { cliPanelKey } from './cli-panel';
import { renderCliRows } from './cli-render';
import { t } from '../../shared/i18n';
import { isTyping } from './typing';
import './reading-cli.css';

// A slash command's screen laid out for reading: tabs, headings, label/value tables, meters, sliders, hints, text. Key
// hints only mean something while the command still listens; a finished result leaves them out. While it listens, a
// level of a slider picked here moves the CLI's own slider there (onKeys: its arrow keys), for Enter to confirm.
function CliBlocks({ rows, live = false, onKeys }: { rows: readonly string[]; live?: boolean; onKeys?: (keys: string[]) => void }) {
  const blocks = useMemo(() => renderCliRows(rows).filter(block => live || block.kind !== 'hint'), [rows, live]);
  return <div className="cli-blocks">{blocks.map((block, index) => {
    if (block.kind === 'tabs') return <div key={index} className="cli-tabs">{block.items.map(item => <span key={item}>{item}</span>)}</div>;
    if (block.kind === 'slider') return <div key={index} className="cli-slider" style={{ '--levels': block.levels.length, '--current': block.current } as CSSProperties}>
      {block.ends && <div className="cli-slider-ends" aria-hidden="true"><span>{block.ends[0]}</span><span>{block.ends[1]}</span></div>}
      <div className="cli-slider-levels" role="radiogroup" aria-label={block.ends?.join(' – ')}>
        <i className="cli-slider-fill" aria-hidden="true" />
        {block.levels.map((level, at) => <button type="button" key={level} role="radio" aria-checked={at === block.current} className={at === block.current ? 'is-current' : ''}
          disabled={!live || !onKeys} onClick={() => { const distance = at - block.current; if (distance) onKeys?.(Array(Math.abs(distance)).fill(distance > 0 ? '\x1b[C' : '\x1b[D')); }}>
          <span className="cli-slider-dot" aria-hidden="true" />{level}</button>)}
      </div>
      {block.aside.length > 0 && (() => {
        // A setting beside the slider and the key that turns it ("Ultracode off" · "Tab to toggle"): a click presses it.
        const key = block.aside.find(item => /^tab to toggle$/i.test(item)), setting = block.aside.filter(item => item !== key).join(' · ');
        return key && setting ? <button type="button" className="cli-slider-aside" disabled={!live || !onKeys} onClick={() => onKeys?.(['\t'])}>{setting}<kbd>Tab</kbd></button>
          : <small className="cli-slider-aside">{block.aside.join(' · ')}</small>;
      })()}
    </div>;
    if (block.kind === 'heading') return <h5 key={index}>{block.text}</h5>;
    if (block.kind === 'pairs') return <dl key={index} className="cli-pairs">{block.pairs.map(([label, value, percent], at) => <div key={at}><dt>{label}</dt>
      <dd>{percent === undefined ? value : <span className="cli-meter" role="meter" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span><i style={{ width: `${percent}%` }} /></span><small>{value}</small></span>}</dd></div>)}</dl>;
    if (block.kind === 'meter') return <div key={index} className="cli-meter" role="meter" aria-valuenow={block.percent} aria-valuemin={0} aria-valuemax={100}><span><i style={{ width: `${block.percent}%` }} /></span><b>{block.percent}%</b>{block.label && <small>{block.label}</small>}</div>;
    if (block.kind === 'hint') return <p key={index} className="cli-hint">{block.text}</p>;
    return <p key={index} className="cli-text">{block.lines.join('\n')}</p>;
  })}</div>;
}

// A slash command in a popup over the conversation, never in it. While the command runs, keys typed here go to the
// CLI, so its dialogs (tabs, lists) work as in the terminal; once it has finished the popup shows what it showed.
// Escape or a click outside closes it (onClose closes what the command opened in the CLI as well).
export function ReadingCliPanel({ command, rows, done, terminalId, feedback, interactive = false, onWrite, onClose, onShowTerminal }: { command: string; rows: string[]; done: boolean; terminalId: string; feedback?: 'waiting' | 'recovery'; interactive?: boolean; onWrite?: (key: string) => boolean; onClose: () => void; onShowTerminal: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const waits = useRef(new Map<ReturnType<typeof setTimeout>, (ready: boolean) => void>());
  useEffect(() => { alive.current = true; return () => {
    alive.current = false;
    for (const [timer, resolve] of waits.current) { clearTimeout(timer); resolve(false); }
    waits.current.clear();
  }; }, [terminalId]);
  const live = !done && interactive && feedback !== 'recovery';
  // A live dialog takes the keys when the reader is here (in this reading view, or nowhere in particular); a result
  // that is done never takes focus from what is being typed, and another card's typing stays where it is.
  useLayoutEffect(() => {
    const active = document.activeElement, view = card.current?.closest('.reading-view');
    if (!done && !isTyping(active) && (!active || active === document.body || (view && view.contains(active)))) card.current?.focus({ preventScroll: true });
  }, []);
  const write = (key: string) => {
    if (!alive.current || !live) return false;
    if (onWrite) return onWrite(key);
    window.agentrix.writeTerminal(terminalId, key); return true;
  };
  // Keys one after another, as typed: a burst of arrows can arrive as one paste.
  const writeKeys = async (keys: string[]) => {
    for (const [at, key] of keys.entries()) {
      if (at && !await new Promise<boolean>(resolve => { const timer = setTimeout(() => { waits.current.delete(timer); resolve(true); }, 30); waits.current.set(timer, resolve); })) return;
      if (!write(key)) return;
    }
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (!live) return;
    // Ctrl+C with text selected copies it (twice to the CLI would quit it); Ctrl+V pastes the text through onPaste.
    const control = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (control && event.key.toLowerCase() === 'c' && window.getSelection()?.toString()) return;
    if (control && event.key.toLowerCase() === 'v') return;
    const key = cliPanelKey(event);
    if (key === null) return;
    event.preventDefault(); write(key);
  };
  const outside = (event: MouseEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onClose(); };
  return <div className="reading-cli-overlay" onMouseDown={outside}>
    <div className="reading-cli-panel" data-terminal-id={terminalId} ref={card} tabIndex={-1} role="dialog" aria-modal="true" aria-label={command} onKeyDown={keys}
      onCompositionEnd={event => { if (event.data && live) write(event.data); }}
      onPaste={event => { const text = event.clipboardData.getData('text/plain'); if (text && live) { event.preventDefault(); write(text); } }}
      onFocus={() => window.agentrix.terminalFocus(terminalId, false)}>
      <div className="reading-cli-head"><strong>{command}</strong><small>{t('Esc 关闭')}</small></div>
      <div className="reading-cli-body">{feedback === 'recovery' && <p className="cli-waiting" role="status">{t('尚未确认命令完成。请切换到终端检查，避免重复执行。')}</p>}
        {!rows.length && done && feedback !== 'recovery' ? <p className="cli-waiting"><CheckCircle size={14} weight="fill" className="cli-done" />{t('{command} 已完成，没有输出。', { command })}</p>
        : !rows.length ? feedback !== 'recovery' && <p className="cli-waiting" role="status"><CircleNotch size={13} className="loading-spinner" />{t('正在等待 {command} 的结果…', { command })}
        </p>
        : <CliBlocks rows={rows} live={!done} onKeys={live ? keys => void writeKeys(keys) : undefined} />}
        {(!done || feedback === 'recovery') && <button type="button" className="text-button" onClick={onShowTerminal}>{t('切换到终端')}</button>}</div>
    </div>
  </div>;
}
