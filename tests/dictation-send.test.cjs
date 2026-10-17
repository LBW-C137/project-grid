const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDictationSend } = require('../src/features/reading/dictation-send.ts');

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = [], callbacks = [];
  let sent = 0;
  const controller = createDictationSend(() => { sent++; }, pending => states.push(pending), (run, delay) => {
    callbacks.push(run);
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  });
  return { ...controller, states, callbacks, sent: () => sent, tick: ms => t.mock.timers.tick(ms) };
}

test('dictation waits half a second, clears its pending state and sends exactly once', t => {
  const h = harness(t);
  h.start();
  assert.deepEqual(h.states, [true]);
  h.tick(499); assert.equal(h.sent(), 0);
  h.tick(1); assert.equal(h.sent(), 1);
  assert.deepEqual(h.states, [true, false]);
  h.tick(2000); h.callbacks[0]();
  assert.equal(h.sent(), 1);
  assert.equal(h.cancel(), false);
});

test('cancelling dictation disarms even an already queued callback', t => {
  const h = harness(t);
  assert.equal(h.cancel(), false);
  h.start(); h.tick(250);
  assert.equal(h.cancel(), true);
  assert.equal(h.cancel(), false);
  h.tick(1000); h.callbacks[0]();
  assert.equal(h.sent(), 0);
  assert.deepEqual(h.states, [true, false]);
});

test('new dictation replaces the previous deadline and ignores its stale callback', t => {
  const h = harness(t);
  h.start(); h.tick(300); h.start(); h.callbacks[0]();
  h.tick(499); assert.equal(h.sent(), 0);
  h.tick(1); assert.equal(h.sent(), 1);
  assert.deepEqual(h.states, [true, false, true, false]);
});

