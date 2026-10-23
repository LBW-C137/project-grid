const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const audit = import('../scripts/design-audit-measure.mjs');
const box = (left = 0, top = 0, width = 100, height = 20) => ({ left, top, width, height });
const element = (selector, style = {}, extra = {}) => ({ selector, tag: 'div', pane: 'root', rect: box(), style, ...extra });
const pane = { id: 'root', rect: box(0, 0, 1000, 1000) };
async function measure(elements, panes = [pane]) {
  return (await audit).measureDesign({ elements, panes });
}
async function metric(id, elements, panes) {
  return (await measure(elements, panes)).metrics.find(entry => entry.id === id);
}

test('F1 requires one largest text owner and an inclusive 0.8 next-size ratio', async () => {
  const title = element('#title', { fontSize: '20px' }, { text: true });
  const subtitle = element('#subtitle', { fontSize: '16px' }, { text: true });
  assert.equal((await metric('F1', [title, subtitle])).pass, true);
  assert.equal((await metric('F1', [title, element('#other', { fontSize: 20 }, { text: true })])).pass, false);
  assert.equal((await metric('F1', [title, element('#other', { fontSize: '16.01px' }, { text: true })])).pass, false);
  assert.equal((await metric('F1', [])).pass, false);
  assert.equal((await metric('F1', [title, element('#container', { fontSize: 40 })])).value.largest, 20);
});

test('F2 counts solid buttons/select triggers at alpha >= 0.6, including effective opacity', async () => {
  const button = (name, color, extra = {}) => element(name, { backgroundColor: color }, { tag: 'button', ...extra });
  const solid = button('#solid', 'rgba(255, 255, 255, 0.6)');
  assert.equal((await metric('F2', [solid, button('#glass', 'rgba(255,255,255,.599)')])).pass, true);
  assert.equal((await metric('F2', [solid, button('#second', '#ffffff')])).pass, false);
  assert.equal((await metric('F2', [solid, button('#faded', '#fff', { opacity: 0.5 })])).value, 1);
  assert.equal((await metric('F2', [solid, element('#select', { backgroundColor: '#fff' }, { role: 'combobox' })])).value, 2);
});

test('visibility filters hidden, zero-area, transparent, clipped and ignored records without mutating input', async () => {
  const elements = [element('#visible', {}, { text: true }),
    element('#hidden', { visibility: 'hidden' }), element('#none', { display: 'none' }),
    element('#opacity', { opacity: '0' }), element('#ancestor', {}, { opacity: 0 }),
    element('#zero', {}, { rect: box(0, 0, 0, 20) }), element('#outside', {}, { clip: box(0, 0, 0, 0) }),
    element('#ignore', {}, { ignored: true }), element('#invisible', {}, { visible: false })];
  const before = JSON.stringify(elements);
  assert.equal((await measure(elements)).elementCount, 1);
  assert.equal(JSON.stringify(elements), before);
});

test('A1 counts row starts and column text blocks instead of inline row contents', async () => {
  const elements = [0, 8, 16, 24].map(x => element(`#x${x}`, {}, { text: true, rect: box(x + 0.1) }));
  assert.equal((await metric('A1', [...elements, element('#duplicate', {}, { text: true, rect: box(0.4) }), element('#layout', {}, { rect: box(900) })])).pass, true);
  assert.equal((await metric('A1', [...elements, element('#fifth', {}, { control: true, rect: box(32) })])).pass, false);
  assert.equal((await metric('A1', [...elements, element('#other', {}, { text: true, pane: 'other', rect: box(32) })])).pass, true);
  assert.deepEqual((await metric('A1', [element('#text', {}, { text: true, rect: box(20), textRect: box(24) })])).value, { root: 1 });
  const row = element('#row', { display: 'flex' }, { parent: 'root', rect: box(0, 40, 200, 20) });
  const contents = [element('#icon', {}, { tag: 'svg', parent: '#row', rect: box(0, 40, 16, 20) }),
    element('#label', {}, { text: true, parent: '#row', rect: box(32, 40, 80, 20) }),
    element('#tag', {}, { text: true, parent: '#row', rect: box(120, 40, 40, 20) })];
  assert.equal((await metric('A1', [...elements, row, ...contents])).pass, true);
  const columns = [element('#columns', { display: 'grid' }),
    ...[0, 200].flatMap(left => [element(`#column${left}`, { display: 'flex', flexDirection: 'column' }, { parent: '#columns', rect: box(left, 0, 100, 100) }),
      element(`#paragraph${left}`, { display: 'block' }, { parent: `#column${left}`, text: true, rect: box(left + 12) })])];
  assert.deepEqual((await metric('A1', columns)).value, { root: 2 });
});

test('A1 coalesces a pane toolbar containing nested icon/text rows and control groups', async () => {
  const elements = [element('root', { display: 'flex' }, { rect: box(0, 0, 800, 40) }),
    element('#logo', { display: 'flex' }, { parent: 'root', rect: box(16, 0) }),
    element('#icon', { display: 'block' }, { tag: 'svg', parent: '#logo', rect: box(16, 0, 16, 20) }),
    element('#brand', {}, { parent: '#logo', text: true, rect: box(40) }),
    element('#tabs', { display: 'flex' }, { parent: 'root', rect: box(160) }),
    ...[160, 240, 320, 400].map(left => element(`#tab${left}`, { display: 'flex' }, { parent: '#tabs', text: true, interactive: true, rect: box(left) }))];
  assert.deepEqual((await metric('A1', elements)).value, { root: 1 });
  assert.equal((await metric('A2', elements)).pass, true);
});

test('A1/A2 coalesce block inline contents and retain the first box on each wrapped line', async () => {
  const block = [element('#row', { display: 'block' }, { text: true }),
    ...[1, 3].map(left => element(`#inline${left}`, { display: 'inline' }, { parent: '#row', text: true, rect: box(left) }))];
  assert.deepEqual((await metric('A1', block)).value, { root: 1 });
  assert.equal((await metric('A2', block)).pass, true);
  const wrapped = [element('root', { display: 'flex', flexWrap: 'wrap' }),
    ...[box(0, 0), box(100, 0), box(2, 40)].map((rect, i) => element(`#control${i}`, {}, { parent: 'root', control: true, rect }))];
  assert.deepEqual((await metric('A1', wrapped)).value, { root: 2 });
  assert.equal((await metric('A2', wrapped)).pass, false);
});

test('A1 retains each text column in a grid of interactive cards', async () => {
  const columns = [element('#columns', { display: 'grid' }),
    ...[0, 200, 400, 600, 800].flatMap(left => [element(`#card${left}`, { display: 'flex', flexDirection: 'column' }, { parent: '#columns', interactive: true, rect: box(left, 0, 100, 100) }),
      element(`#title${left}`, { display: 'block' }, { parent: `#card${left}`, text: true, rect: box(left) })])];
  assert.equal((await metric('A1', columns.slice(0, -2))).pass, true);
  const result = await metric('A1', columns);
  assert.equal(result.pass, false);
  assert.deepEqual(result.value, { root: 5 });
  assert.ok(result.offenders.some(entry => entry.selector === '#title800' && entry.value.leftPx === 800));
});

test('A2 detects all 1-3px near-miss pairs, excludes equality/4px and separates panes', async () => {
  const elements = [0, 1, 3, 7].map(x => element(`#x${x}`, {}, { text: true, rect: box(x) }));
  const result = await metric('A2', elements);
  assert.equal(result.value, 3);
  assert.equal(result.pass, false);
  assert.deepEqual(result.offenders[0].value, { pane: 'root', linesPx: [0, 1], distancePx: 1 });
  assert.equal((await metric('A2', [elements[0], elements[3], element('#different', {}, { text: true, pane: 'other', rect: box(1) })])).pass, true);
  const row = element('#row', { display: 'flex' }, { rect: box(0, 0, 200, 20) });
  const contents = [0, 1, 3].map(x => element(`#inline${x}`, {}, { parent: '#row', text: true, rect: box(x) }));
  assert.equal((await metric('A2', [row, ...contents])).pass, true);
  assert.equal((await metric('A2', [row, ...contents, element('#next-row', {}, { text: true, rect: box(2, 40) })])).pass, false);
});

test('A3 compares centres within each line and includes direct text beside an icon', async () => {
  const icon = element('#icon', {}, { tag: 'svg', rect: box(0, 0, 16, 16), rowParent: '#row' });
  const text = element('#text', {}, { text: true, rect: box(24, 1, 40, 16), rowParent: '#row' });
  assert.equal((await metric('A3', [icon, text])).pass, true);
  assert.equal((await metric('A3', [icon, { ...text, rect: box(24, 1.01, 40, 16) }])).pass, false);
  assert.equal((await metric('A3', [icon, { ...text, rect: box(24, 30, 40, 16), rowNoWrap: true }])).value, 30);
  assert.equal((await metric('A3', [icon, { ...text, rect: box(24, 30, 40, 16) }])).pass, true);
  const parent = element('#row', {}, { text: true, textRow: true, textRect: box(24, 2, 40, 16) });
  assert.equal((await metric('A3', [icon, parent])).value, 2);
});

test('S1 reports every off-scale property with its selector and preserves unit/negative violations', async () => {
  const result = await metric('S1', [element('#ok', { paddingTop: '2px', gap: '4px 8px', marginTop: '0px', marginLeft: 'auto', rowGap: 'normal' }), element('#bad', { marginTop: '3px', columnGap: '10%', paddingBottom: '-4px' })]);
  assert.equal(result.value, 3);
  assert.equal(result.pass, false);
  assert.deepEqual(result.offenders, [
    { selector: '#bad', value: 'paddingBottom: -4px' }, { selector: '#bad', value: 'marginTop: 3px' }, { selector: '#bad', value: 'columnGap: 10%' },
  ]);
  assert.equal((await metric('S1', [element('#ok', { paddingTop: '64px', marginTop: 0 })])).pass, true);
});

test('S2 permits eight distinct non-zero values, deduplicates gap aliases and rejects nine', async () => {
  const values = (await audit).THRESHOLDS.S1.scale;
  const elements = values.slice(0, 8).map((value, i) => element(`#s${i}`, { paddingTop: `${value}px`, rowGap: `${value}px` }));
  assert.equal((await metric('S2', elements)).pass, true);
  assert.equal((await metric('S2', [...elements, element('#ninth', { gap: `${values[8]}px` })])).pass, false);
});

test('S3 checks full class lists regardless of order or state, heights, vertical and grid gaps', async () => {
  const classNames = ['row compact sel sel-item', 'compact row is-ready active', 'row compact hover focus selected'];
  const rows = [0, 28, 56].map((top, i) => element(`#row${i}`, {}, { parent: '#list', className: classNames[i], rect: box(0, top, 100, 20) }));
  assert.equal((await metric('S3', rows)).pass, true);
  assert.equal((await metric('S3', [...rows.slice(0, 2), { ...rows[2], rect: box(0, 57, 100, 20) }])).pass, false);
  const result = await metric('S3', [{ ...rows[0], rect: box(0, 0, 100, 21) }, ...rows.slice(1)]);
  assert.equal(result.pass, false);
  assert.equal(result.value, 1);
  assert.equal(result.offenders[0].value.className, 'compact row');
  assert.deepEqual(result.offenders[0].value.heights, [20, 21]);
  assert.equal((await metric('S3', [rows[0], { ...rows[1], parent: '#different', rect: box(0, 28, 100, 40) }])).pass, true);
  const cards = [0, 28, 57].map((left, i) => element(`#card${i}`, {}, { parent: '#grid', className: 'card', rect: box(left, 0, 20, 20) }));
  assert.equal((await metric('S3', cards)).offenders[0].value.gaps.x.length, 2);
});

test('S3 separates adjacent pane recipes and breaks runs when only a base class matches', async () => {
  const panes = [element('#detail', {}, { parent: '#column', className: 'pane detail', rect: box(0, 0, 500, 400) }),
    element('#prompt', {}, { parent: '#column', className: 'pane prompt', rect: box(0, 424, 500, 100) })];
  const result = await metric('S3', panes);
  assert.equal(result.pass, true);
  assert.equal(result.value, 0);
  assert.deepEqual(result.offenders, []);
  const rows = ['row compact', 'row roomy', 'compact row'].map((className, i) => element(`#row${i}`, {}, { parent: '#list', className, rect: box(0, i * 48, 100, 20 + i * 4) }));
  assert.equal((await metric('S3', rows)).pass, true);
});

test('S3 starts a new run at a label, divider or an uncollected intervening sibling', async () => {
  const rows = [0, 28, 56, 120, 156, 192].map((top, i) => element(`#row${i}`, {}, { parent: '#list', className: 'row', rect: box(0, top, 100, i < 3 ? 20 : 24) }));
  const separator = element('#label', {}, { parent: '#list', text: true, rect: box(0, 88) });
  const separated = [...rows.slice(0, 3), separator, ...rows.slice(3)];
  assert.equal((await metric('S3', separated)).pass, true);
  assert.equal((await metric('S3', [...rows.slice(0, 3), { ...separator, className: 'sel is-label' }, ...rows.slice(3)])).pass, true);
  assert.equal((await metric('S3', [...rows.slice(0, 3), { ...separator, tag: 'hr', text: false }, ...rows.slice(3)])).pass, true);
  assert.equal((await metric('S3', rows.map((el, i) => i === 3 ? { ...el, previousSibling: '#ignored-divider' } : el))).pass, true);
  const result = await metric('S3', [...separated.slice(0, -1), { ...rows.at(-1), rect: box(0, 193, 100, 24) }]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.offenders[0].value.gaps.y, [12, 13]);
  assert.ok(result.offenders[0].value.pairs.some(pair => pair.value.gapPx === 13));
});

test('C1 buckets hues in 30deg families at saturation >= 25%, across text, borders and gradients', async () => {
  const colors = ['hsl(0 25% 50%)', 'hsl(29 80% 50%)', 'hsl(30 80% 50%)', 'hsl(60 80% 50%)'];
  const elements = colors.map((color, i) => element(`#color${i}`, { color }, { text: true }));
  assert.deepEqual((await metric('C1', elements)).value, [0, 30, 60]);
  assert.equal((await metric('C1', elements)).pass, true);
  const border = element('#border', { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'hsl(90 80% 50%)' });
  assert.equal((await metric('C1', [...elements, border])).pass, false);
  assert.deepEqual((await metric('C1', [element('#muted', { color: 'hsl(240 24.9% 50%)' }, { text: true }), element('#clear', { backgroundColor: '#ff000000' }), element('#wallpaper', { backgroundColor: '#f00' }, { wallpaper: true })])).value, []);
  assert.deepEqual((await metric('C1', [element('#gradient', {}, { backgroundColors: ['#f00', [0, 255, 0, 1]] }), element('#rgb', { backgroundColor: 'rgb(0% 0% 100% / 50%)' })])).value, [0, 120, 240]);
});

test('C1 ignores material surfaces and saturated near-black/white colours, retaining accent failures', async () => {
  const accents = [0, 30, 60].map(hue => element(`#accent${hue}`, { backgroundColor: `hsl(${hue} 80% 50%)` }));
  const material = [element('root', { backgroundColor: 'hsl(90 80% 50%)' }, { rect: pane.rect }),
    element('#glass', { backdropFilter: 'blur(32px)', borderTopWidth: '1px', borderTopColor: '#00f' }, { backgroundColors: ['#f0f'] }),
    element('#black', { color: 'hsl(150 100% 11.99%)' }, { text: true }),
    element('#white', { backgroundColor: 'hsl(210 100% 92.01%)' })];
  assert.deepEqual((await metric('C1', [...accents, ...material])).value, [0, 30, 60]);
  assert.equal((await metric('C1', [...accents, ...material])).pass, true);
  assert.equal((await metric('C1', [...accents, ...material, element('#fourth', { backgroundColor: 'hsl(90 80% 50%)' })])).pass, false);
  assert.deepEqual((await metric('C1', [element('#dark-boundary', { backgroundColor: 'hsl(120 100% 12%)' }), element('#light-boundary', { backgroundColor: 'hsl(240 100% 92%)' })])).value, [120, 240]);
});

test('C2 uses clipped union area per pane, with an inclusive 5% boundary', async () => {
  const surface = element('#surface', { backgroundColor: '#f00' }, { rect: box(0, 0, 100, 500) });
  assert.deepEqual((await metric('C2', [surface, { ...surface, selector: '#overlap' }])).value, { root: 5 });
  assert.equal((await metric('C2', [surface])).pass, true);
  assert.equal((await metric('C2', [{ ...surface, rect: box(0, 0, 101, 500) }])).pass, false);
  assert.equal((await metric('C2', [{ ...surface, rect: box(0, 0, 1000, 1000), clip: box(0, 0, 10, 10) }])).value.root, 0.01);
  const other = { id: 'other', rect: box(0, 0, 100, 100) };
  assert.equal((await metric('C2', [{ ...surface, pane: 'other', rect: box(0, 0, 10, 100) }], [pane, other])).value.other, 10);
});

test('C2 counts descendant accents while excluding pane roots, glass recipes and near-black/white fills', async () => {
  const surfaces = [element('root', { backgroundColor: '#f00' }, { rect: pane.rect }),
    element('#glass', { backgroundColor: '#0f0', backdropFilter: 'blur(32px)' }, { rect: pane.rect }),
    element('#black', { backgroundColor: 'hsl(240 100% 11%)' }, { rect: pane.rect }),
    element('#white', {}, { rect: pane.rect, backgroundColors: ['hsl(180 100% 93%)'] })];
  const badge = element('#badge', { backgroundColor: '#f00' }, { parent: '#glass', rect: box(0, 0, 100, 500) });
  assert.equal((await metric('C2', [...surfaces, badge])).pass, true);
  assert.equal((await metric('C2', [...surfaces, badge])).value.root, 5);
  const result = await metric('C2', [...surfaces, { ...badge, rect: box(0, 0, 101, 500) }]);
  assert.equal(result.pass, false);
  assert.deepEqual(result.offenders, [{ selector: '#badge', value: { pane: 'root', areaPx: 50500, coveragePercent: 5.050000000000001, paneUnionAreaPx: 50500, paneCoveragePercent: 5.050000000000001 } }]);
});

test('C3 independently caps non-empty filters, shadow declarations and positive surface alphas', async () => {
  const surfaces = [...[0.055, 0.06, 0.2, 1].map((alpha, i) => element(`#surface${i}`, { backgroundColor: `rgba(0,0,0,${alpha})`, boxShadow: `0 0 ${i % 3 + 1}px #000` })),
    ...[1, 2].map(blur => element(`#glass${blur}`, { backdropFilter: `blur(${blur}px)` }))];
  assert.equal((await metric('C3', surfaces)).pass, true);
  assert.deepEqual((await metric('C3', surfaces)).value.backgroundAlphas, [0.055, 0.06, 0.2, 1]);
  for (const style of [{ backdropFilter: 'blur(3px)' }, { boxShadow: '0 0 4px #000' }, { backgroundColor: 'rgba(0,0,0,.3)' }]) assert.equal((await metric('C3', [...surfaces, element('#extra', style)])).pass, false);
});

test('C3 excludes pane recipe colours and gradient alphas while retaining inner surface excess', async () => {
  const material = [element('root', { backgroundColor: 'rgba(20,40,80,.50)' }, { rect: pane.rect, backgroundColors: ['rgba(20,40,80,.58)'] }),
    element('#glass', { backgroundColor: 'rgba(20,40,80,.62)', backdropFilter: 'blur(32px)' }, { rect: pane.rect, backgroundColors: ['rgba(20,40,80,.70)'] })];
  const surfaces = [0.055, 0.06, 0.2, 1].map((alpha, i) => element(`#surface${i}`, { backgroundColor: `rgba(0,0,0,${alpha})` }, { parent: '#glass' }));
  const result = await metric('C3', [...material, ...surfaces]);
  assert.equal(result.pass, true);
  assert.deepEqual(result.value.backgroundAlphas, [0.055, 0.06, 0.2, 1]);
  assert.deepEqual(result.value.backdropFilters, ['blur(32px)']);
  const excess = await metric('C3', [...material, ...surfaces, element('#menu', {}, { parent: '#glass', backgroundColors: ['rgba(0,0,0,.3)'] })]);
  assert.equal(excess.pass, false);
  assert.deepEqual(excess.value.backgroundAlphas, [0.055, 0.06, 0.2, 0.3, 1]);
  assert.ok(excess.offenders.some(entry => entry.selector === '#menu' && entry.value.backgroundAlpha === 0.3));
  assert.equal(excess.offenders.some(entry => ['root', '#glass'].includes(entry.selector) && 'backgroundAlpha' in entry.value), false);
});

test('P1 ignores zero and normalizes pixel/percentage pills to one token', async () => {
  const elements = [4, 8, 12].map(r => element(`#r${r}`, { borderTopLeftRadius: `${r}px` }, { rect: box(0, 0, 100, 100) }));
  const pills = [element('#circle', { borderTopLeftRadius: '50%' }), element('#pill', { borderTopLeftRadius: '999px' }), element('#half-height', { borderTopLeftRadius: '10px' })];
  assert.equal((await metric('P1', elements)).pass, true);
  assert.deepEqual((await metric('P1', [...elements, ...pills, element('#square', { borderTopLeftRadius: '0%' })])).value, [4, 8, 12, 'pill']);
  assert.equal((await metric('P1', [...elements, ...pills])).pass, true);
  const result = await metric('P1', [...elements, ...pills, element('#fifth', { borderTopLeftRadius: '2px' })]);
  assert.equal(result.pass, false);
  assert.ok(result.offenders.some(entry => entry.selector === '#pill' && entry.value.radius === 999 && entry.value.token === 'pill'));
  assert.deepEqual((await metric('P1', [element('#ellipse', { borderTopLeftRadius: '8px 12px' }, { rect: box(0, 0, 100, 40) })])).value, [8, 12]);
  assert.deepEqual((await metric('P1', [element('#square')])).value, []);
});

test('P2 caps six font sizes and three normalized weights on text blocks', async () => {
  const elements = [12, 14, 16, 20, 24, 32].map((size, i) => element(`#text${i}`, { fontSize: `${size}px`, fontWeight: ['normal', 600, 'bold'][i % 3] }, { text: true }));
  assert.equal((await metric('P2', elements)).pass, true);
  assert.equal((await metric('P2', [...elements, element('#seventh', { fontSize: 40 }, { text: true })])).pass, false);
  assert.equal((await metric('P2', [...elements, element('#fourth', { fontSize: 12, fontWeight: 500 }, { text: true })])).pass, false);
});

test('P3 groups backgrounds/borders/radii, ignores text colour, permits one compact height only in rows', async () => {
  const base = element('#button', { backgroundColor: '#fff', color: '#000' }, { tag: 'button', rect: box(0, 0, 100, 32) });
  const ghost = element('#ghost', { backgroundColor: 'transparent' }, { role: 'button', rect: base.rect });
  assert.equal((await metric('P3', [base, ghost, { ...base, selector: '#same', style: { ...base.style, color: '#f00' } }])).value.variants, 2);
  assert.equal((await metric('P3', [base, ghost])).pass, true);
  assert.equal((await metric('P3', [base, { ...base, style: { backgroundColor: 'rgb(255, 255, 255)' } }])).value.variants, 1);
  assert.equal((await metric('P3', [ghost, { ...ghost, style: { backgroundColor: 'rgba(255, 0, 0, 0)' } }])).value.variants, 1);
  assert.equal((await metric('P3', [base, ghost, { ...base, style: { ...base.style, borderTopLeftRadius: 8 } }])).pass, false);
  assert.equal((await metric('P3', [base, ghost, { ...base, style: { ...base.style, borderTopWidth: '1px', borderTopColor: '#000' } }])).value.variants, 3);
  const compact = { ...base, selector: '#compact', rect: box(0, 0, 100, 24), inRow: true };
  assert.equal((await metric('P3', [base, compact])).pass, true);
  assert.deepEqual((await metric('P3', [base, compact])).value.compactHeights, [24]);
  assert.equal((await metric('P3', [base, { ...compact, inRow: false }])).pass, false);
  assert.equal((await metric('P3', [base, compact, { ...base, rect: box(0, 0, 100, 40), inRow: true }])).pass, false);
});

test('P4 normalizes milliseconds and respects CSS transition lists and interaction scope', async () => {
  const style = { transitionProperty: 'color, opacity', transitionDuration: '0.14s, 140ms', transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
  const base = element('#button', style, { tag: 'button' });
  assert.equal((await metric('P4', [base, element('#layout', { transitionDuration: '1s' })])).pass, true);
  assert.deepEqual((await metric('P4', [base])).value.durationsMs, [140]);
  assert.equal((await metric('P4', [base, element('#other', { ...style, transitionDuration: '150ms' }, { interactive: true })])).pass, false);
  assert.equal((await metric('P4', [base, element('#other', { ...style, transitionTimingFunction: 'ease' }, { interactive: true })])).pass, false);
  assert.equal((await metric('P4', [base, element('#none', { transitionProperty: 'none', transitionDuration: '1s' }, { tag: 'button' })])).pass, true);
  assert.equal((await metric('P4', [])).pass, true);
});

test('P5 permits three SVG sizes and excludes ignored brand marks', async () => {
  const icons = [12, 16, 20].map(size => element(`#icon${size}`, {}, { tag: 'svg', rect: box(0, 0, size, size) }));
  assert.equal((await metric('P5', icons)).pass, true);
  const logo = element('#logo', {}, { tag: 'svg', rect: box(0, 0, 100, 50) });
  assert.equal((await metric('P5', [...icons, logo])).pass, false);
  assert.equal((await metric('P5', [...icons, { ...logo, ignored: true }])).pass, true);
});

test('P6 compares every token set against the first page and lists missing/added values', async () => {
  const { compareTokens, THRESHOLDS } = await audit;
  const { tokens } = await measure([element('#button', { fontSize: 20, borderTopLeftRadius: 8 }, { tag: 'button', text: true })]);
  const first = { name: 'first', tokens };
  assert.equal(compareTokens([first, { name: 'same', tokens: { ...tokens, radii: [...tokens.radii].reverse() } }]).pass, true);
  const changed = { name: 'second', tokens: Object.fromEntries(Object.entries(tokens).map(([key, values]) => [key, [...values, key.startsWith('transitionTiming') ? 'linear' : 99]])) };
  const result = compareTokens([first, changed]);
  assert.equal(result.pass, false);
  assert.equal(result.differences.length, Object.keys(tokens).length);
  assert.deepEqual(result.differences[0], { page: 'second', baseline: 'first', token: 'radii', missing: [], added: [99] });
  assert.deepEqual(compareTokens([first, { name: 'removed', tokens: { ...tokens, radii: [] } }]).differences[0].missing, [8]);
  assert.equal(compareTokens([first]).compared, 1);
  assert.equal(compareTokens([]).value, THRESHOLDS.P6.max);
});

test('P6 reports selectors and measured values for every differing token source', async () => {
  const { compareTokens } = await audit;
  const first = { name: 'first', ...await measure([element('#first', { borderTopLeftRadius: 4 })]) };
  const second = { name: 'second', ...await measure([element('#second', { borderTopLeftRadius: 8 })]) };
  const result = compareTokens([first, second]);
  assert.deepEqual(result.offenders, [
    { selector: '#first', value: { page: 'first', token: 'radii', change: 'missing', measured: 4 } },
    { selector: '#second', value: { page: 'second', token: 'radii', change: 'added', measured: 8 } },
  ]);
  assert.ok(result.hint);
});

test('all automated acceptance metrics are present and thresholds are exported once', async () => {
  const { THRESHOLDS } = await audit;
  const { metrics } = await measure([element('#title', { fontSize: 20 }, { text: true })]);
  assert.deepEqual(metrics.map(entry => entry.id), Object.keys(THRESHOLDS).filter(key => !['F3', 'P6'].includes(key)));
  assert.equal(metrics.every(entry => entry.pass === true), true);
  assert.equal(metrics.every(entry => typeof entry.hint === 'string' && entry.hint.length > 0 && !entry.hint.includes('\n')), true);
  assert.equal(THRESHOLDS.F3.blur, 12);
});

test('CLI help and invalid arguments work without starting Electron', () => {
  const cli = path.join(__dirname, '../scripts/design-audit.mjs');
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /--view <name>=<url-query>/);
  for (const args of [[], ['page.html', '--width', '0'], ['page.html', '--height', '1.5'], ['page.html', '--view', 'invalid'], ['page.html', '--unknown'], ['javascript:alert(1)']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.ok(result.stderr.trim());
  }
});
