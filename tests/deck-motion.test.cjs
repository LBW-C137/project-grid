const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pose, rest, slideStart, poseStyle, DURATIONS } = require('../src/features/home/deck-motion.ts');

const EFFECTS = ['fade', 'sink', 'slide', 'depth'];
const near = (a, b, what) => { for (const key of ['x', 'y', 's', 'b', 'o', 'r', 'blur']) assert.ok(Math.abs(a[key] - b[key]) < 1e-6, `${what}: ${key} ${a[key]} vs ${b[key]}`); };

test('every motion starts where the stack rests and ends one card round, so nothing jumps', () => {
  for (const effect of EFFECTS) for (const count of [2, 3, 5]) for (let k = 0; k < count; k++) {
    near(pose(effect, k, count, 0), rest(k), `${effect} ${count} k${k} start`);
    near(pose(effect, k, count, 1), k === 0 ? rest(count - 1) : rest(k - 1), `${effect} ${count} k${k} end`);
  }
});

test('the card going to the back passes under the others; with fade the next one rises over it', () => {
  for (const effect of EFFECTS) {
    const late = pose(effect, 0, 3, .9), next = pose(effect, 1, 3, .9);
    assert.ok(late.z < next.z, `${effect}: at the end it lies under the next card`);
  }
  assert.ok(pose('fade', 1, 3, .2).z > pose('fade', 0, 3, .2).z, 'fade: the next card is already over the fading one');
  assert.ok(pose('sink', 0, 3, .2).z > pose('sink', 1, 3, .2).z, 'sink: it stays on top while it starts to sink');
});

test('each motion has its own character: sink dips, slide goes sideways either way, depth softens, fade fades', () => {
  assert.ok(pose('sink', 0, 3, .5).y > rest(2).y, 'sink dips below the stack');
  assert.ok(pose('slide', 0, 3, .5, 800, 1).x > 400 && pose('slide', 0, 3, .5, 800, -1).x < -400, 'slide follows the side it was dragged to');
  assert.ok(pose('depth', 0, 3, .5).blur > 2, 'depth blurs as it recedes');
  assert.ok(pose('fade', 0, 3, .45).o < .2, 'fade is nearly gone at the turn');
  const spring = [.6, .7, .8, .9].map(t => pose('depth', 1, 3, t).y);
  assert.ok(Math.min(...spring) < rest(0).y, 'depth: the card coming forward overshoots a little');
});

test('deeper cards are out of sight, a let-go slide resumes from where it is, and styles are plain CSS', () => {
  assert.equal(rest(3).o, 0); assert.equal(rest(2).o, 1);
  assert.equal(slideStart(0, 800), 0);
  assert.ok(slideStart(200, 800) > slideStart(100, 800));
  assert.equal(slideStart(5000, 800), .5);
  const style = poseStyle(pose('depth', 0, 3, .5));
  assert.match(style.transform, /^translate\([-\d.]+px, [-\d.]+px\) scale\([\d.]+\) rotate\([-\d.]+deg\)$/);
  assert.match(style.filter, /blur/);
  for (const effect of EFFECTS) assert.ok(DURATIONS[effect] >= 400 && DURATIONS[effect] <= 800);
});
