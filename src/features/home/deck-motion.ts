// How the decision deck moves its cards. The deck is a loop: the front card goes to the back as the next one comes up.
// Each way of moving it has its own motion (chosen from the candidates the user compared):
//   fade  — the arrows and ↑↓: the front card fades out as the next one rises over it, and fades in again at the back;
//   sink  — the wheel: the front card sinks under the stack and the others move up;
//   slide — dragging the front card sideways: it follows the pointer, slides off and tucks in at the back;
//   depth — clicking a card behind: the front card recedes into the stack and that one comes forward with a little spring.
export type DeckEffect = 'fade' | 'sink' | 'slide' | 'depth';
export type Pose = { x: number; y: number; s: number; b: number; o: number; r: number; blur: number; z: number };

export const DURATIONS: Record<DeckEffect, number> = { fade: 600, sink: 620, slide: 560, depth: 600 };
const clamp = (value: number, from = 0, to = 1) => Math.min(to, Math.max(from, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const inOut = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const out = (t: number) => 1 - Math.pow(1 - t, 3);
const spring = (t: number) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
const span = (t: number, from: number, to: number) => clamp((t - from) / (to - from));

// A card at depth k (0 is the front): the two behind it step down and back; deeper ones are out of sight.
export function rest(k: number): Pose {
  const shown = Math.min(k, 3);
  return { x: 0, y: shown * 20, s: 1 - shown * .05, b: 1 - shown * .14, o: k <= 2 ? 1 : 0, r: 0, blur: 0, z: 10 - Math.min(k, 9) };
}
const mix = (a: Pose, b: Pose, t: number): Pose => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), s: lerp(a.s, b.s, t), b: lerp(a.b, b.b, t),
  o: lerp(a.o, b.o, t), r: lerp(a.r, b.r, t), blur: lerp(a.blur, b.blur, t), z: t < .5 ? a.z : b.z });

// Where the card at depth k is while the stack of `count` moves its front card to the back, at progress t (0 to 1).
// width: how far a slide goes; side: which way (1 right, -1 left).
export function pose(effect: DeckEffect, k: number, count: number, t: number, width = 600, side = 1): Pose {
  t = clamp(t);
  const last = rest(count - 1), from = rest(k);
  if (k > 0) {
    const to = rest(k - 1);
    if (effect === 'fade') return { ...mix(from, to, inOut(span(t, .05, .85))), z: to.z + (k === 1 ? 2 : 0) };
    if (effect === 'sink') return mix(from, to, inOut(span(t, .18, 1)));
    if (effect === 'slide') return mix(from, to, inOut(span(t, .25, 1)));
    return mix(from, to, spring(span(t, .12, 1)));
  }
  const p = inOut(t), arc = Math.sin(Math.PI * t);
  if (effect === 'fade') return t < .5 ? { ...from, o: 1 - out(t / .5), s: lerp(1, .97, t / .5), y: lerp(0, -10, t / .5), z: 11 }
    : { ...last, o: out((t - .5) / .5) * last.o, z: 0 };
  if (effect === 'sink') return { ...mix(from, last, p), y: lerp(0, last.y, p) + arc * 46, b: lerp(1, last.b, p), z: t < .42 ? 11 : 0 };
  if (effect === 'slide') return { ...mix(from, last, p), x: arc * width * .62 * side, r: arc * 5 * side, z: t < .5 ? 11 : 0 };
  return { ...mix(from, last, p), s: lerp(1, last.s, p) - arc * .04, blur: arc * 3, b: lerp(1, last.b, p) - arc * .1, z: t < .22 ? 11 : 0 };
}

// Where a slide that the pointer let go of at dx pixels goes on from: the point of the slide that far out.
export function slideStart(dx: number, width: number) {
  return Math.asin(clamp(Math.abs(dx) / (width * .62))) / Math.PI;
}

export const poseStyle = (p: Pose) => ({
  transform: `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${p.s.toFixed(4)}) rotate(${p.r.toFixed(2)}deg)`,
  filter: `brightness(${p.b.toFixed(3)})${p.blur > .05 ? ` blur(${p.blur.toFixed(2)}px)` : ''}`,
  opacity: p.o, zIndex: Math.round(p.z * 10),
});
