import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { CaretDown, CaretUp, X } from '@phosphor-icons/react';
import type { Decision } from './decisions';
import { DecisionCard, decisionKind, decisionTitle, trustedFolder, trustsFolder, waited } from './DecisionCard';
import { reviewHistory } from './review-history';
import { motionReduced } from '../../shared/motion';
import { t } from '../../shared/i18n';
import './deck.css';

// One line under a card's title saying what it is about, so the deck can be read without opening anything.
function brief(decision: Decision) {
  if (decision.kind === 'approval') return decision.context.map(line => line.trim()).filter(Boolean).at(-1) ?? t('它要先得到你的批准才能继续');
  if (decision.kind === 'question') return t('{count} 个选项，等你回答', { count: decision.choice?.options.length ?? 0 });
  if (trustsFolder(decision)) return trustedFolder(decision) ?? (decision.choice?.options ?? []).map(option => option.label).join(' / ');
  if (decision.kind === 'choice') return (decision.choice?.options ?? []).map(option => option.label).join(' / ');
  if (decision.kind === 'signin') return t('登录之后它才能开始工作');
  if (decision.kind === 'attention') return t('打开它的终端看看它在问什么');
  const { submission, notes } = reviewHistory(decision.projectId);
  return submission > 1 ? t('第 {count} 次提交 · 上次批语：{note}', { count: submission, note: notes.at(-1)?.text ?? '' }) : t('做完了，等你批改');
}

// The decisions as a stack of cards: the one in front is read at a glance, the others wait behind it. Scroll, ↑↓ or
// the arrows flip through the stack; clicking the front card (or Enter) draws it out and opens it in full over the
// page. A card that is answered leaves the stack; one that arrives is dealt onto it.
export function DecisionDeck({ decisions, now, onOpen, onDone, onError }: {
  decisions: readonly Decision[]; now: number; onOpen: (decision: Decision) => void; onDone: (message: string) => void; onError: (message: string) => void;
}) {
  const [front, setFront] = useState(0), [opened, setOpened] = useState<string | null>(null);
  const deck = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null), flipAt = useRef(0), origin = useRef<DOMRect | null>(null);
  // The front card stays the same decision when others arrive or leave.
  const frontId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const at = frontId.current ? decisions.findIndex(decision => decision.id === frontId.current) : -1;
    const next = at >= 0 ? at : Math.min(front, Math.max(0, decisions.length - 1));
    if (next !== front) setFront(next);
    frontId.current = decisions[next]?.id ?? null;
  }, [decisions, front]);
  const flip = (step: number) => {
    const next = Math.max(0, Math.min(decisions.length - 1, front + step));
    if (next === front) return;
    frontId.current = decisions[next].id; setFront(next);
  };
  const wheel = (event: WheelEvent) => {
    if (opened || Math.abs(event.deltaY) < 8 || Date.now() - flipAt.current < 260) return;
    event.preventDefault(); flipAt.current = Date.now(); flip(event.deltaY > 0 ? 1 : -1);
  };
  const keys = (event: KeyboardEvent) => {
    if (opened) return;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); flip(1); }
    else if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); flip(-1); }
    else if (event.key === 'Enter' && decisions[front]) { event.preventDefault(); draw(decisions[front].id); }
  };
  // Drawing a card out: the full card grows from where the small one was.
  const draw = (id: string) => {
    origin.current = deck.current?.querySelector<HTMLElement>(`[data-deck-card="${CSS.escape(id)}"]`)?.getBoundingClientRect() ?? null;
    setOpened(id);
  };
  useLayoutEffect(() => {
    const node = sheet.current, from = origin.current;
    if (!opened || !node || !from || motionReduced()) return;
    const to = node.getBoundingClientRect();
    node.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: .6, borderRadius: '20px' },
      { transform: 'none', opacity: 1 },
    ], { duration: 380, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }, [opened]);
  const close = () => {
    const node = sheet.current, to = origin.current;
    if (!node || !to || motionReduced()) { setOpened(null); return; }
    const from = node.getBoundingClientRect();
    node.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`, opacity: 0 }],
      { duration: 260, easing: 'cubic-bezier(.4, 0, .6, 1)' }).onfinish = () => setOpened(null);
  };
  useEffect(() => {
    if (!opened) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  });
  // An opened decision that was answered elsewhere (or whose question changed) closes with it.
  const open = decisions.find(decision => decision.id === opened);
  useEffect(() => { if (opened && !open) setOpened(null); }, [opened, open]);
  // The front card leans toward the pointer.
  const tilt = (event: PointerEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--tilt-x', `${((event.clientY - box.top) / box.height - .5) * -6}deg`);
    event.currentTarget.style.setProperty('--tilt-y', `${((event.clientX - box.left) / box.width - .5) * 8}deg`);
    event.currentTarget.style.setProperty('--shine', `${((event.clientX - box.left) / box.width) * 100}%`);
  };
  const untilt = (event: PointerEvent<HTMLButtonElement>) => { event.currentTarget.style.removeProperty('--tilt-x'); event.currentTarget.style.removeProperty('--tilt-y'); };
  return <>
    <div className="decision-deck-wrap">
      <div ref={deck} className="decision-deck" role="listbox" aria-label={t('待决定的事')} tabIndex={0} onWheel={wheel} onKeyDown={keys}
        aria-activedescendant={decisions[front] ? `deck-${decisions[front].id}` : undefined}>
        {decisions.map((decision, index) => {
          const offset = index - front, { label, Icon } = decisionKind(decision.kind);
          if (offset < -1 || offset > 4) return null;
          return <button type="button" key={decision.id} id={`deck-${decision.id}`} role="option" aria-selected={offset === 0} data-deck-card={decision.id}
            className={`deck-card is-${decision.kind} ${offset === 0 ? 'is-front' : offset < 0 ? 'is-past' : 'is-behind'}`}
            style={{ '--offset': offset, zIndex: 20 - Math.abs(offset) } as CSSProperties} tabIndex={-1}
            onClick={() => offset === 0 ? draw(decision.id) : (frontId.current = decision.id, setFront(index))}
            onPointerMove={offset === 0 ? tilt : undefined} onPointerLeave={offset === 0 ? untilt : undefined}>
            <span className="deck-card-head"><span className="deck-kind"><Icon size={14} weight="fill" />{t(label)}</span><span className="deck-source">{decision.projectName} · {waited(decision.since, now)}</span></span>
            <b className="deck-title">{decisionTitle(decision)}</b>
            <span className="deck-brief">{brief(decision)}</span>
            {offset === 0 && <span className="deck-hint">{t('点开处理')}</span>}
          </button>;
        })}
      </div>
      {decisions.length > 1 && <div className="deck-controls">
        <button type="button" className="icon-button" aria-label={t('上一张')} disabled={front === 0} onClick={() => flip(-1)}><CaretUp size={18} weight="bold" /></button>
        <span className="deck-position">{front + 1} / {decisions.length}</span>
        <button type="button" className="icon-button" aria-label={t('下一张')} disabled={front >= decisions.length - 1} onClick={() => flip(1)}><CaretDown size={18} weight="bold" /></button>
      </div>}
    </div>
    {open && <div className="decision-sheet-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={sheet} className="decision-sheet" role="dialog" aria-modal="true" aria-label={decisionTitle(open)}>
        <button type="button" className="icon-button decision-sheet-close" aria-label={t('放回去')} title={t('放回去 (Esc)')} onClick={close}><X size={17} /></button>
        <DecisionCard decision={open} now={now} onOpen={onOpen} onDone={message => { setOpened(null); onDone(message); }} onError={onError} />
      </div>
    </div>}
  </>;
}
