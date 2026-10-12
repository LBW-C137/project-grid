import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { CaretDown, CaretUp, X } from '@phosphor-icons/react';
import type { Decision } from './decisions';
import { DecisionCard, decisionKind, decisionTitle, trustedFolder, trustsFolder, waited } from './DecisionCard';
import { reviewHistory } from './review-history';
import { DURATIONS, pose, poseStyle, rest, slideStart, type DeckEffect } from './deck-motion';
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

// A move under way: the front card at its start (base) going to the back, at progress t; side is a slide's direction.
type Motion = { effect: DeckEffect; base: number; t: number; side: number };
const DRAG_START = 6;

// The decisions as a stack of cards: the one in front is read at a glance, the others wait behind it, and the stack
// goes round. Each way of moving it has its own motion (deck-motion.ts): the arrows and ↑↓ fade one card into the
// next, the wheel sinks the front card under the stack, dragging it sideways slides it off to the back, and clicking a
// card behind brings it forward. Clicking the front card (or Enter) draws it out and opens it in full over the page.
export function DecisionDeck({ decisions, now, onOpen, onDone, onError }: {
  decisions: readonly Decision[]; now: number; onOpen: (decision: Decision) => void; onDone: (message: string) => void; onError: (message: string) => void;
}) {
  const [front, setFront] = useState(0), [opened, setOpened] = useState<string | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null), [drag, setDrag] = useState<number | null>(null);
  const deck = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null), flipAt = useRef(0), origin = useRef<DOMRect | null>(null);
  const moving = useRef(false), frame = useRef(0), press = useRef<{ x: number; id: number; moved: boolean } | null>(null), pressed = useRef(false);
  const count = decisions.length;
  // The front card stays the same decision when others arrive or leave.
  const frontId = useRef<string | null>(null), frontNow = useRef(front);
  frontNow.current = front;
  useLayoutEffect(() => {
    const at = frontId.current ? decisions.findIndex(decision => decision.id === frontId.current) : -1;
    const next = at >= 0 ? at : Math.min(front, Math.max(0, count - 1));
    if (next !== front) setFront(next);
    frontId.current = decisions[next]?.id ?? null;
  }, [decisions, front, count]);
  // A card answered or arriving mid-move ends the move where the stack now is.
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => { cancelAnimationFrame(frame.current); moving.current = false; setMotion(null); setDrag(null); }, [count]);
  const settle = (index: number) => { frontId.current = decisions[index]?.id ?? null; setFront(index); };
  // One step round the stack: forward sends the front card to the back, backward brings the last one to the front.
  const step = (effect: DeckEffect, direction: 1 | -1, from = 0, side = 1) => new Promise<void>(done => {
    if (count < 2) { done(); return; }
    const base = direction > 0 ? frontNow.current : (frontNow.current - 1 + count) % count;
    const end = direction > 0 ? (base + 1) % count : base;
    if (motionReduced()) { settle(end); done(); return; }
    moving.current = true;
    const duration = DURATIONS[effect] * (1 - from), began = performance.now();
    const tick = (time: number) => {
      const progress = Math.min(1, (time - began) / duration), at = from + (1 - from) * progress;
      setMotion({ effect, base, t: direction > 0 ? at : 1 - at, side });
      if (progress < 1) { frame.current = requestAnimationFrame(tick); return; }
      moving.current = false; setMotion(null); setDrag(null); settle(end); done();
    };
    frame.current = requestAnimationFrame(tick);
  });
  const flip = (direction: 1 | -1, effect: DeckEffect = 'fade') => { if (!moving.current && !opened) void step(effect, direction); };
  const wheel = (event: WheelEvent) => {
    if (opened || moving.current || Math.abs(event.deltaY) < 8 || Date.now() - flipAt.current < 260) return;
    event.preventDefault(); flipAt.current = Date.now(); flip(event.deltaY > 0 ? 1 : -1, 'sink');
  };
  const keys = (event: KeyboardEvent) => {
    if (opened) return;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); flip(1); }
    else if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); flip(-1); }
    else if (event.key === 'Enter' && decisions[front] && !moving.current) { event.preventDefault(); draw(decisions[front].id); }
  };
  // A card behind, clicked: the stack comes round to it, a step at a time.
  const bringForward = async (depth: number) => {
    if (moving.current || opened) return;
    for (let index = 0; index < depth; index++) await step('depth', 1);
  };
  // Dragging the front card sideways: it follows the pointer; let go far enough and it slides off to the back,
  // otherwise it springs back into place.
  const width = () => deck.current?.clientWidth || 600;
  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || moving.current) return;
    press.current = { x: event.clientX, id: event.pointerId, moved: false };
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    tilt(event);
    const start = press.current;
    if (!start || start.id !== event.pointerId || count < 2) return;
    const dx = event.clientX - start.x;
    if (!start.moved && Math.abs(dx) < DRAG_START) return;
    if (!start.moved) { start.moved = true; event.currentTarget.setPointerCapture(event.pointerId); }
    setDrag(dx);
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => {
    const start = press.current; press.current = null;
    if (!start || !start.moved) return;
    pressed.current = true;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) > width() * .18) { void step('slide', 1, Math.min(.5, slideStart(dx, width())), Math.sign(dx) || 1); return; }
    // Not far enough: back into place.
    moving.current = true;
    const began = performance.now();
    const back = (time: number) => {
      const progress = Math.min(1, (time - began) / 200);
      setDrag(dx * (1 - (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame.current = requestAnimationFrame(back); else { setDrag(null); moving.current = false; }
    };
    frame.current = requestAnimationFrame(back);
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
  // The front card at rest leans toward the pointer.
  const tilt = (event: PointerEvent<HTMLButtonElement>) => {
    if (moving.current || press.current?.moved) return;
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--tilt-x', `${((event.clientY - box.top) / box.height - .5) * -6}deg`);
    event.currentTarget.style.setProperty('--tilt-y', `${((event.clientX - box.left) / box.width - .5) * 8}deg`);
    event.currentTarget.style.setProperty('--shine', `${((event.clientX - box.left) / box.width) * 100}%`);
  };
  const untilt = (event: PointerEvent<HTMLButtonElement>) => { event.currentTarget.style.removeProperty('--tilt-x'); event.currentTarget.style.removeProperty('--tilt-y'); };
  return <>
    <div className="decision-deck-wrap">
      <div ref={deck} className={`decision-deck${motion || drag !== null ? ' is-moving' : ''}`} style={{ '--behind': Math.min(count - 1, 2) } as CSSProperties} role="listbox" aria-label={t('待决定的事')} tabIndex={0} onWheel={wheel} onKeyDown={keys}
        aria-activedescendant={decisions[front] ? `deck-${decisions[front].id}` : undefined}>
        {decisions.map((decision, index) => {
          const depth = (index - (motion ? motion.base : front) + count) % count, { label, Icon } = decisionKind(decision.kind);
          if (depth > 3 && !(motion && depth === count - 1)) return null;
          // At rest the front card keeps no transform of its own, so its hover lift and lean apply.
          const style = motion ? poseStyle(pose(motion.effect, depth, count, motion.t, width(), motion.side))
            : depth === 0 && drag !== null ? poseStyle({ ...rest(0), x: drag, r: drag / 40, z: 11 })
            : depth === 0 ? { zIndex: 100 } : poseStyle(rest(depth));
          const atFront = !motion && depth === 0;
          return <button type="button" key={decision.id} id={`deck-${decision.id}`} role="option" aria-selected={atFront} data-deck-card={decision.id}
            className={`deck-card is-${decision.kind} ${atFront ? 'is-front' : 'is-behind'}${depth > 2 ? ' is-hidden' : ''}`} style={style} tabIndex={-1}
            onClick={() => {
              if (pressed.current) { pressed.current = false; return; }
              if (atFront) draw(decision.id); else if (!motion && depth <= 2) void bringForward(depth);
            }}
            onPointerDown={atFront ? down : undefined} onPointerMove={atFront ? move : undefined} onPointerUp={atFront ? up : undefined} onPointerCancel={atFront ? up : undefined}
            onPointerLeave={atFront ? untilt : undefined}>
            <span className="deck-card-head"><span className="deck-kind"><Icon size={14} weight="fill" />{t(label)}</span><span className="deck-source">{decision.projectName} · {waited(decision.since, now)}</span></span>
            <b className="deck-title">{decisionTitle(decision)}</b>
            <span className="deck-brief">{brief(decision)}</span>
            {atFront && <span className="deck-hint">{t('点开处理')}</span>}
          </button>;
        })}
      </div>
      {count > 1 && <div className="deck-controls">
        <button type="button" className="icon-button" aria-label={t('上一张')} onClick={() => flip(-1)}><CaretUp size={18} weight="bold" /></button>
        <span className="deck-position">{front + 1} / {count}</span>
        <button type="button" className="icon-button" aria-label={t('下一张')} onClick={() => flip(1)}><CaretDown size={18} weight="bold" /></button>
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
