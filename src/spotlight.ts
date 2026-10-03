import { motionReduced } from './motion';

// In the overview the card under the pointer lights up where the pointer is. The light is a gradient
// placed by two CSS variables on that card, written at most once a frame and never through React.
let frame = 0, latest: { panel: HTMLElement; x: number; y: number } | null = null;
export function trackSpotlight(event: { target: EventTarget | null; clientX: number; clientY: number }) {
  const panel = (event.target as Element | null)?.closest?.<HTMLElement>('.project-panel');
  if (!panel || motionReduced()) return;
  latest = { panel, x: event.clientX, y: event.clientY };
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    if (!latest) return;
    const box = latest.panel.getBoundingClientRect();
    latest.panel.style.setProperty('--spot-x', `${Math.round(latest.x - box.left)}px`);
    latest.panel.style.setProperty('--spot-y', `${Math.round(latest.y - box.top)}px`);
    latest = null;
  });
}
