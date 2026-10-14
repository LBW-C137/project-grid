const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gridColumns, gridNeighbor } = require('../src/features/workspace/grid-navigation.ts');

const ids = count => Array.from({ length: count }, (_, index) => `p${index}`);

test('the grid has as many columns as the overview draws, at most four', () => {
  assert.deepEqual([0, 1, 2, 4, 5, 6, 9, 10, 16, 30].map(gridColumns), [1, 1, 2, 2, 3, 3, 3, 4, 4, 4]);
});

test('Ctrl+Shift with an arrow goes to the project beside, above or below, as the cards sit', () => {
  // Six projects: p0 p1 p2 / p3 p4 p5.
  const six = ids(6);
  assert.equal(gridNeighbor(six, 'p1', 'right'), 'p2');
  assert.equal(gridNeighbor(six, 'p2', 'right'), 'p3', 'the end of a row goes on into the next');
  assert.equal(gridNeighbor(six, 'p5', 'right'), 'p0');
  assert.equal(gridNeighbor(six, 'p0', 'left'), 'p5');
  assert.equal(gridNeighbor(six, 'p1', 'down'), 'p4');
  assert.equal(gridNeighbor(six, 'p4', 'up'), 'p1');
  assert.equal(gridNeighbor(six, 'p4', 'down'), 'p1', 'from the last row round to the first');
  assert.equal(gridNeighbor(six, 'p0', 'up'), 'p3');
  // Five projects: p0 p1 p2 / p3 p4, the last row shorter.
  assert.equal(gridNeighbor(ids(5), 'p2', 'down'), 'p4', 'into a shorter row, its last project');
  // One row: up and down stay.
  assert.equal(gridNeighbor(ids(2), 'p0', 'down'), 'p0');
});

test('with no current project the arrows start at one end; with no projects there is nowhere to go', () => {
  assert.equal(gridNeighbor(ids(6), null, 'right'), 'p0');
  assert.equal(gridNeighbor(ids(6), undefined, 'down'), 'p0');
  assert.equal(gridNeighbor(ids(6), 'gone', 'left'), 'p5');
  assert.equal(gridNeighbor(ids(6), null, 'up'), 'p5');
  assert.equal(gridNeighbor([], null, 'right'), null);
});
