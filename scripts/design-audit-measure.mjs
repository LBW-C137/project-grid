export const THRESHOLDS = {
  F1: { largestCount: 1, nextRatio: 0.8 },
  F2: { solidAlpha: 0.6, max: 1 },
  F3: { blur: 12 },
  A1: { max: 4 },
  A2: { minDistance: 1, maxDistance: 3, max: 0 },
  A3: { max: 1 },
  S1: { scale: [2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64], max: 0 },
  S2: { max: 8 },
  S3: { max: 0 },
  C1: { saturation: 0.25, minLightness: 0.12, maxLightness: 0.92, bucket: 30, max: 3 },
  C2: { max: 0.05 },
  C3: { backdropFilters: 2, boxShadows: 3, backgroundAlphas: 4 },
  P1: { max: 4 },
  P2: { fontSizes: 6, fontWeights: 3 },
  P3: { variants: 2, heights: 1, compactHeights: 1 },
  P4: { durations: 1, timingFunctions: 1 },
  P5: { max: 3 },
  P6: { max: 0 },
};

// Records contain CSS computed styles and viewport rectangles; no DOM or globals are read.
export function measureDesign({ elements, panes }, limits = THRESHOLDS) {
  const round = value => Math.round(value * 100) / 100;
  const sorted = values => [...new Set(values)].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a.localeCompare(b);
  });
  const number = value => typeof value === 'number' ? value : /^-?[\d.]+(?:px)?$/.test(value || '') ? Number.parseFloat(value) : value;
  const split = value => String(value).split(/,(?![^()]*\))/).map(part => part.trim());
  const style = (el, key, fallback = '') => el.style?.[key] ?? fallback;
  const right = box => box.left + box.width;
  const bottom = box => box.top + box.height;
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), width: Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left)), height: Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top)) });
  const classKey = el => sorted((el.className || '').split(/\s+/).filter(name => name && !/^(sel|sel-item|selected|is-.*|active|hover|focus)$/.test(name))).join(' ');
  const metrics = [];
  const hints = {
    F1: 'Keep one largest text block and reduce the next size to at most 80% of it.',
    F2: 'Keep one solid primary button; use translucent or unfilled secondary buttons.',
    A1: 'Align row starts and column text blocks to at most four left edges per pane.',
    A2: 'Snap the reported row or column edges to the same alignment line.',
    A3: 'Centre the reported boxes vertically within their row.',
    S1: `Use spacing from {${limits.S1.scale.join(', ')}}px; use 8 or 12 instead of 10.`,
    S2: 'Consolidate spacing tokens to at most eight non-zero values.',
    S3: 'Use equal heights and equal adjacent gaps within each same-class sibling run.',
    C1: 'Reuse at most three accent hue families for text, borders and fills.',
    C2: 'Reduce descendant accent fills to at most 5% of each pane.',
    C3: 'Reuse at most two backdrop filters, three shadows and four surface alphas.',
    P1: 'Reuse at most four non-zero radius tokens, counting every pill as one token.',
    P2: 'Reuse at most six text sizes and three font weights.',
    P3: 'Reuse two button recipes and one height, with one smaller height only inside rows.',
    P4: 'Use one transition duration and one easing on interactive elements.',
    P5: 'Resize SVG icons to at most three shared sizes.',
  };
  const add = (id, value, threshold, pass, offenders = []) => metrics.push({ id, value, threshold, pass, offenders: pass ? [] : offenders, hint: hints[id] });
  const offender = (el, value) => ({ selector: el.selector, value });
  const group = (items, key) => {
    const result = new Map();
    for (const item of items) {
      const name = key(item);
      if (!result.has(name)) result.set(name, []);
      result.get(name).push(item);
    }
    return result;
  };
  const entries = (items, key) => [...group(items, key)].map(([value, members]) => offender(members[0], value));

  function color(value) {
    if (!value || value === 'transparent' || value === 'none') return null;
    let rgba;
    if (Array.isArray(value)) rgba = [...value];
    else if (/^#[\da-f]{3,8}$/i.test(value)) {
      let hex = value.slice(1);
      if (hex.length < 5) hex = [...hex].map(c => c + c).join('');
      rgba = [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
      rgba.push(hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1);
    } else if (/^rgba?\(/.test(value)) {
      const parts = value.slice(value.indexOf('(') + 1, -1).trim().split(/[\s,/]+/);
      rgba = parts.map((part, i) => Number.parseFloat(part) * (part.endsWith('%') ? i === 3 ? 0.01 : 2.55 : 1));
    } else if (/^hsla?\(/.test(value)) {
      const parts = value.slice(value.indexOf('(') + 1, -1).trim().split(/[\s,/]+/);
      const h = ((Number.parseFloat(parts[0]) % 360) + 360) % 360 / 30;
      const s = Number.parseFloat(parts[1]) / 100, l = Number.parseFloat(parts[2]) / 100;
      const a = s * Math.min(l, 1 - l);
      rgba = [0, 8, 4].map(n => 255 * (l - a * Math.max(-1, Math.min((n + h) % 12 - 3, 9 - (n + h) % 12, 1))));
      rgba.push(parts[3] === undefined ? 1 : Number.parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1));
    } else return null;
    const [r, g, b] = rgba.map(c => c / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    const lightness = (max + min) / 2;
    let hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    return { rgba: [...rgba.slice(0, 3).map(round), rgba[3] ?? 1], hue, lightness, saturation: delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1)), alpha: rgba[3] ?? 1 };
  }

  const backgrounds = el => [style(el, 'backgroundColor'), ...(el.backgroundColors || [])].map(color).filter(Boolean);
  const chromatic = c => c && c.alpha > 0 && c.saturation + 1e-9 >= limits.C1.saturation && c.lightness + 1e-9 >= limits.C1.minLightness && c.lightness - 1e-9 <= limits.C1.maxLightness;
  const button = el => el.button || ['button', 'select'].includes(el.tag) || ['button', 'combobox'].includes(el.role);
  const interactive = el => el.interactive || button(el) || ['input', 'textarea', 'summary'].includes(el.tag) || el.role === 'switch';
  const visible = elements.filter(el => el.visible !== false && !el.ignored && el.rect?.width > 0 && el.rect.height > 0 && (!el.clip || el.clip.width > 0 && el.clip.height > 0) && (el.opacity ?? 1) > 0 && style(el, 'display') !== 'none' && !['hidden', 'collapse'].includes(style(el, 'visibility')) && Number(style(el, 'opacity', 1)) > 0);
  const text = visible.filter(el => el.text);
  const buttons = visible.filter(button);
  const paneGroups = group(visible, el => el.pane || 'root');
  const paneMap = new Map(panes.map(pane => [pane.id, pane.rect]));
  const bySelector = new Map(visible.map(el => [el.selector, el]));
  const children = group(visible.filter(el => el.parent), el => el.parent);

  const fontSizes = sorted(text.map(el => number(style(el, 'fontSize', 16))));
  const largest = fontSizes.at(-1) || 0, next = fontSizes.at(-2) || 0;
  const leaders = text.filter(el => number(style(el, 'fontSize', 16)) === largest);
  add('F1', { largest, count: leaders.length, next, ratio: largest ? round(next / largest) : 0 }, `one largest text block; next <= ${limits.F1.nextRatio}x`, leaders.length === limits.F1.largestCount && next <= largest * limits.F1.nextRatio, [...leaders, ...text.filter(el => number(style(el, 'fontSize', 16)) === next)].map(el => offender(el, style(el, 'fontSize', 16))));
  const solid = buttons.filter(el => backgrounds(el).some(c => c.alpha * (el.opacity ?? 1) >= limits.F2.solidAlpha));
  add('F2', solid.length, `<= ${limits.F2.max} button with background alpha >= ${limits.F2.solidAlpha}`, solid.length <= limits.F2.max, solid.map(el => offender(el, { backgrounds: backgrounds(el).map(c => c.rgba), effectiveAlpha: Math.max(...backgrounds(el).map(c => c.alpha * (el.opacity ?? 1))) })));

  const edgesByPane = new Map();
  const alignment = [];
  const content = new Set();
  for (const el of visible.filter(el => el.text || el.control || interactive(el) || el.tag === 'svg')) {
    for (let current = el; current && !content.has(current.selector); current = bySelector.get(current.parent)) content.add(current.selector);
  }
  const inFlow = el => content.has(el.selector) && !['absolute', 'fixed'].includes(style(el, 'position'));
  const rowLayout = el => ['flex', 'inline-flex'].includes(style(el, 'display')) ? !style(el, 'flexDirection', 'row').startsWith('column') : ['grid', 'inline-grid'].includes(style(el, 'display'));
  const column = el => !rowLayout(el) && (children.get(el.selector) || []).some(child => inFlow(child) && child.tag !== 'svg' && /^(block|flex|grid|flow-root|list-item)$/.test(style(child, 'display')));
  const rows = new Map();
  for (const [parent, members] of children) {
    const owner = bySelector.get(parent), flow = members.filter(inFlow);
    if (!owner || !flow.length) continue;
    const inline = flow.every(el => style(el, 'display').startsWith('inline'));
    if (!rowLayout(owner) && !owner.row && !inline && !flow.some(el => el.rowParent === parent)) continue;
    // A row's inline contents share an edge; independent text columns keep their own.
    if (!owner.row && !interactive(owner) && flow.filter(column).length > 1) continue;
    rows.set(parent, owner);
  }
  const inRow = el => {
    for (let parent = bySelector.get(el.parent); parent && parent.pane === el.pane; parent = bySelector.get(parent.parent)) {
      if (rows.has(parent.selector)) return true;
    }
    return false;
  };
  const lineBoxes = visible.filter(el => content.has(el.selector) && !paneMap.has(el.selector) && !inRow(el) && (el.text || el.control || interactive(el) || rows.has(el.selector) || el.tag === 'svg' || backgrounds(el).some(c => c.alpha > 0)));
  for (const [id, owner] of rows) {
    if (inRow(owner)) continue;
    const members = (children.get(id) || []).filter(el => inFlow(el) && el.pane === owner.pane);
    const wrapped = style(owner, 'flexWrap', 'nowrap') !== 'nowrap' || !rowLayout(owner);
    const rowLines = wrapped || !style(owner, 'display').includes('flex') ? lines(members) : [{ items: members }];
    if (!paneMap.has(id) && rowLines.length < 2) continue;
    for (const line of rowLines) {
      if (line.items.length) lineBoxes.push([...line.items].sort((a, b) => a.rect.left - b.rect.left)[0]);
    }
  }
  for (const [pane, members] of paneGroups) {
    const edges = group(lineBoxes.filter(el => members.includes(el)), el => Math.round(el.rect.left));
    edgesByPane.set(pane, edges);
    if (edges.size > limits.A1.max) alignment.push(...[...edges].flatMap(([x, els]) => els.map(el => offender(el, { pane, leftPx: el.rect.left, linePx: x }))));
  }
  add('A1', Object.fromEntries([...edgesByPane].map(([pane, edges]) => [pane, edges.size])), `<= ${limits.A1.max} left edges per pane (rounded px)`, !alignment.length, alignment);
  const nearMisses = [];
  for (const [pane, edges] of edgesByPane) {
    const lefts = sorted([...edges.keys()]);
    for (let i = 0; i < lefts.length; i++) {
      for (let j = i + 1; j < lefts.length && lefts[j] - lefts[i] <= limits.A2.maxDistance; j++) {
        if (lefts[j] - lefts[i] >= limits.A2.minDistance) nearMisses.push({ selector: [...edges.get(lefts[i]), ...edges.get(lefts[j])].map(el => el.selector).join(', '), value: { pane, linesPx: [lefts[i], lefts[j]], distancePx: lefts[j] - lefts[i] } });
      }
    }
  }
  add('A2', nearMisses.length, `${limits.A2.max} pairs ${limits.A2.minDistance}-${limits.A2.maxDistance}px apart`, nearMisses.length <= limits.A2.max, nearMisses);

  function lines(items) {
    const rows = [];
    for (const item of [...items].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
      const box = item.rect;
      const line = rows.find(row => box.top < row.bottom && bottom(box) > row.top);
      if (!line) { rows.push({ top: box.top, bottom: bottom(box), items: [item] }); continue; }
      line.top = Math.max(line.top, box.top);
      line.bottom = Math.min(line.bottom, bottom(box));
      line.items.push(item);
    }
    return rows;
  }

  const rowItems = visible.filter(el => el.rowParent);
  for (const el of text.filter(el => el.textRect && el.textRow)) rowItems.push({ selector: `${el.selector}::text`, rect: el.textRect, rowParent: el.selector, rowNoWrap: el.textNoWrap });
  const centres = [];
  let maxCentreDifference = 0;
  for (const members of group(rowItems, el => el.rowParent).values()) {
    const rows = members.some(el => el.rowNoWrap) ? [{ items: members }] : lines(members);
    for (const line of rows.filter(line => line.items.length > 1)) {
      const ys = line.items.map(el => el.rect.top + el.rect.height / 2);
      const delta = round(Math.max(...ys) - Math.min(...ys));
      maxCentreDifference = Math.max(delta, maxCentreDifference);
      if (delta > limits.A3.max) centres.push(...line.items.map(el => offender(el, `centre ${round(el.rect.top + el.rect.height / 2)}px; spread ${delta}px`)));
    }
  }
  add('A3', maxCentreDifference, `centre spread <= ${limits.A3.max}px per flex/grid line`, maxCentreDifference <= limits.A3.max, centres);

  const spacing = [], offScale = [];
  for (const el of visible) {
    for (const property of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap', 'rowGap', 'columnGap']) {
      for (const part of String(style(el, property, 0)).split(/\s+/)) {
        if (part === 'normal' || part === 'auto') continue;
        const value = number(part);
        if (value === 0) continue;
        spacing.push({ selector: el.selector, value, property });
        if (!limits.S1.scale.includes(value)) offScale.push(offender(el, `${property}: ${part}`));
      }
    }
  }
  const spacingValues = sorted(spacing.map(entry => entry.value));
  add('S1', offScale.length, `non-zero spacing in {${limits.S1.scale.join(', ')}}px`, offScale.length <= limits.S1.max, offScale);
  add('S2', spacingValues, `<= ${limits.S2.max} distinct non-zero spacing values`, spacingValues.length <= limits.S2.max, spacing.map(el => offender(el, `${el.property}: ${el.value}`)));
  const repeated = [], variance = [];
  for (const siblings of children.values()) {
    let run;
    for (let i = 0; i < siblings.length; i++) {
      const el = siblings[i], previous = siblings[i - 1], className = classKey(el);
      if (!className) { run = null; continue; }
      const adjacent = previous && (el.previousSibling === undefined || el.previousSibling === previous.selector);
      if (!adjacent || run?.className !== className) {
        run = { className, members: [] };
        repeated.push(run);
      }
      run.members.push(el);
    }
  }
  for (const { className, members } of repeated) {
    if (members.length < 2) continue;
    const heights = sorted(members.map(el => round(el.rect.height)));
    const xGaps = [], yGaps = [], pairs = [];
    for (let i = 1; i < members.length; i++) {
      const previous = members[i - 1], el = members[i];
      const horizontal = el.rect.top < bottom(previous.rect) && bottom(el.rect) > previous.rect.top;
      const gap = horizontal ? Math.max(el.rect.left, previous.rect.left) - Math.min(right(el.rect), right(previous.rect)) : Math.max(el.rect.top, previous.rect.top) - Math.min(bottom(el.rect), bottom(previous.rect));
      (horizontal ? xGaps : yGaps).push(round(gap));
      pairs.push({ selector: `${previous.selector}, ${el.selector}`, value: { axis: horizontal ? 'x' : 'y', gapPx: gap } });
    }
    const gaps = { x: sorted(xGaps), y: sorted(yGaps) };
    if (heights.length > 1 || gaps.x.length > 1 || gaps.y.length > 1) variance.push({ selector: members.map(el => el.selector).join(', '), value: { className, heights, gaps, members: members.map(el => offender(el, { heightPx: el.rect.height })), pairs } });
  }
  add('S3', variance.length, `${limits.S3.max} adjacent same-class sibling runs with unequal heights or gaps (0.01px precision)`, variance.length <= limits.S3.max, variance);

  const hueEntries = [], bgEntries = [], filters = [], shadows = [], alphas = [];
  for (const el of visible) {
    const bg = el.wallpaper ? [] : backgrounds(el);
    const surface = paneMap.has(el.selector) || !['', 'none'].includes(style(el, 'backdropFilter', 'none'));
    const colors = surface ? [] : [...bg];
    if (el.text || el.tag === 'svg') colors.push(color(style(el, 'color')));
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (!surface && Number.parseFloat(style(el, `border${side}Width`, 0)) > 0 && !['none', 'hidden'].includes(style(el, `border${side}Style`, 'solid'))) colors.push(color(style(el, `border${side}Color`)));
    }
    for (const c of colors.filter(chromatic)) hueEntries.push({ ...offender(el, Math.floor(((c.hue + 1e-7) % 360) / limits.C1.bucket) * limits.C1.bucket), color: c.rgba, hueDegrees: c.hue, saturation: c.saturation, lightness: c.lightness });
    if (!surface && bg.some(chromatic)) bgEntries.push(el);
    if (!surface) for (const c of bg.filter(c => c.alpha > 0)) alphas.push(offender(el, c.alpha));
    const filter = style(el, 'backdropFilter', 'none'), shadow = style(el, 'boxShadow', 'none');
    if (!el.wallpaper && filter && filter !== 'none') filters.push(offender(el, filter));
    if (!el.wallpaper && shadow && shadow !== 'none') shadows.push(offender(el, shadow));
  }
  const hues = sorted(hueEntries.map(entry => entry.value));
  add('C1', hues, `<= ${limits.C1.max} hue families (${limits.C1.bucket}deg buckets, saturation >= ${limits.C1.saturation * 100}%, lightness ${limits.C1.minLightness * 100}-${limits.C1.maxLightness * 100}%; pane surfaces excluded)`, hues.length <= limits.C1.max, hueEntries.map(el => offender(el, { familyDegrees: el.value, color: el.color, hueDegrees: el.hueDegrees, saturation: el.saturation, lightness: el.lightness })));

  function unionArea(boxes) {
    const xs = sorted(boxes.flatMap(box => [box.left, right(box)]));
    let area = 0;
    for (let i = 1; i < xs.length; i++) {
      const intervals = boxes.filter(box => box.left < xs[i] && right(box) > xs[i - 1]).map(box => [box.top, bottom(box)]).sort((a, b) => a[0] - b[0]);
      let end = -Infinity, height = 0;
      for (const [top, base] of intervals) {
        height += Math.max(0, base - Math.max(top, end));
        end = Math.max(end, base);
      }
      area += (xs[i] - xs[i - 1]) * height;
    }
    return area;
  }

  const coverage = {}, colored = [];
  for (const [id, box] of paneMap) {
    const members = bgEntries.filter(el => (el.pane || 'root') === id);
    const boxes = members.map(el => intersect(el.clip || el.rect, box)).filter(box => box.width > 0 && box.height > 0);
    const area = unionArea(boxes), paneArea = box.width * box.height;
    const ratio = paneArea ? area / paneArea : 0;
    coverage[id] = round(ratio * 100);
    if (ratio > limits.C2.max + 1e-9) colored.push(...members.map(el => {
      const clip = intersect(el.clip || el.rect, box), areaPx = clip.width * clip.height;
      return offender(el, { pane: id, areaPx, coveragePercent: areaPx / paneArea * 100, paneUnionAreaPx: area, paneCoveragePercent: ratio * 100 });
    }));
  }
  add('C2', coverage, `chromatic background union <= ${limits.C2.max * 100}% of each pane`, !colored.length, colored);
  const material = { backdropFilters: sorted(filters.map(el => el.value)), boxShadows: sorted(shadows.map(el => el.value)), backgroundAlphas: sorted(alphas.map(el => el.value)) };
  add('C3', material, `<= ${limits.C3.backdropFilters} backdrop filters / ${limits.C3.boxShadows} shadows / ${limits.C3.backgroundAlphas} surface alphas`, Object.keys(material).every(key => material[key].length <= limits.C3[key]), [...filters.map(el => offender(el, { backdropFilter: el.value })), ...shadows.map(el => offender(el, { boxShadow: el.value })), ...alphas.map(el => offender(el, { backgroundAlpha: el.value }))]);

  const radius = el => ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(corner => String(style(el, `border${corner}Radius`, 0)).split(/\s+/).map(number));
  const radiusEntries = visible.flatMap(el => radius(el).flat().filter(value => Number.parseFloat(value) > 0).map(value => ({ ...offender(el, (typeof value === 'number' ? value : Number.parseFloat(value) * el.rect.height / 100) >= el.rect.height / 2 ? 'pill' : value), radius: value, heightPx: el.rect.height })));
  const radii = sorted(radiusEntries.map(entry => entry.value));
  add('P1', radii, `<= ${limits.P1.max} non-zero radii (radius >= half height is pill)`, radii.length <= limits.P1.max, radiusEntries.map(el => offender(el, { token: el.value, radius: el.radius, heightPx: el.heightPx })));
  const weight = el => ({ normal: 400, bold: 700 }[style(el, 'fontWeight')] ?? number(style(el, 'fontWeight', 400)));
  const weights = sorted(text.map(weight));
  add('P2', { fontSizes, weights }, `<= ${limits.P2.fontSizes} font sizes / ${limits.P2.fontWeights} font weights on text`, fontSizes.length <= limits.P2.fontSizes && weights.length <= limits.P2.fontWeights, text.map(el => offender(el, { fontSize: number(style(el, 'fontSize', 16)), fontWeight: weight(el) })));
  const colorKey = value => {
    const parsed = color(value);
    return parsed ? parsed.alpha > 0 ? parsed.rgba : 'transparent' : value || 'transparent';
  };
  const variant = el => JSON.stringify({ background: [colorKey(style(el, 'backgroundColor', 'transparent')), style(el, 'backgroundImage', 'none')], border: ['Top', 'Right', 'Bottom', 'Left'].map(side => Number.parseFloat(style(el, `border${side}Width`, 0)) > 0 && !['none', 'hidden'].includes(style(el, `border${side}Style`, 'solid')) ? [number(style(el, `border${side}Width`)), style(el, `border${side}Style`, 'solid'), colorKey(style(el, `border${side}Color`))] : 0), radius: radius(el) });
  const variants = entries(buttons, variant);
  const heights = sorted(buttons.map(el => round(el.rect.height)));
  const compact = heights.length > limits.P3.heights && heights.length <= limits.P3.heights + limits.P3.compactHeights && buttons.filter(el => round(el.rect.height) === heights[0]).every(el => el.inRow);
  add('P3', { variants: variants.length, heights, compactHeights: compact ? [heights[0]] : [] }, `<= ${limits.P3.variants} background/border/radius variants; ${limits.P3.heights} height + ${limits.P3.compactHeights} smaller height inside rows`, variants.length <= limits.P3.variants && (heights.length <= limits.P3.heights || compact), buttons.map(el => offender(el, { variant: JSON.parse(variant(el)), heightPx: el.rect.height, inRow: Boolean(el.inRow) })));

  const durations = [], timings = [];
  for (const el of visible.filter(interactive)) {
    const properties = split(style(el, 'transitionProperty', 'all'));
    const times = split(style(el, 'transitionDuration', '0s')).map(time => round(Number.parseFloat(time) * (time.endsWith('ms') ? 1 : 1000)));
    const functions = split(style(el, 'transitionTimingFunction', 'ease'));
    if (!times.some(time => time > 0)) continue;
    properties.forEach((property, i) => {
      if (property === 'none') return;
      durations.push(offender(el, times[i % times.length]));
      timings.push(offender(el, functions[i % functions.length]));
    });
  }
  const transitionDurations = sorted(durations.map(el => el.value)), transitionTimingFunctions = sorted(timings.map(el => el.value));
  add('P4', { durationsMs: transitionDurations, timingFunctions: transitionTimingFunctions }, `<= ${limits.P4.durations} duration / ${limits.P4.timingFunctions} timing function on transitioning interactive elements`, transitionDurations.length <= limits.P4.durations && transitionTimingFunctions.length <= limits.P4.timingFunctions, [...durations.map(el => offender(el, { durationMs: el.value })), ...timings.map(el => offender(el, { easing: el.value }))]);
  const icons = visible.filter(el => el.tag === 'svg');
  const iconSizes = entries(icons, el => `${round(el.rect.width)}x${round(el.rect.height)}`);
  add('P5', iconSizes.map(el => el.value), `<= ${limits.P5.max} SVG sizes`, iconSizes.length <= limits.P5.max, icons.map(el => offender(el, { widthPx: el.rect.width, heightPx: el.rect.height })));

  return { metrics, tokens: { radii, fontSizes, fontWeights: weights, spacing: spacingValues, buttonHeights: heights, transitionDurations, transitionTimingFunctions }, tokenSources: { radii: radiusEntries, fontSizes: text.map(el => offender(el, number(style(el, 'fontSize', 16)))), fontWeights: text.map(el => offender(el, weight(el))), spacing, buttonHeights: buttons.map(el => offender(el, round(el.rect.height))), transitionDurations: durations, transitionTimingFunctions: timings }, elementCount: visible.length };
}

export function compareTokens(pages, limits = THRESHOLDS) {
  const differences = [], offenders = [];
  const baseline = pages[0];
  for (const page of pages.slice(1)) {
    for (const key of new Set([...Object.keys(baseline.tokens), ...Object.keys(page.tokens)])) {
      const expected = new Set(baseline.tokens[key] || []), actual = new Set(page.tokens[key] || []);
      const missing = [...expected].filter(value => !actual.has(value));
      const added = [...actual].filter(value => !expected.has(value));
      if (!missing.length && !added.length) continue;
      differences.push({ page: page.name, baseline: baseline.name, token: key, missing, added });
      for (const [source, values, change] of [[baseline, missing, 'missing'], [page, added, 'added']]) {
        for (const entry of source.tokenSources?.[key] || []) {
          if (values.includes(entry.value)) offenders.push({ selector: entry.selector, value: { page: source.name, token: key, change, measured: entry.value } });
        }
      }
    }
  }
  return { id: 'P6', value: differences.length, threshold: 'identical token sets across pages/views', pass: differences.length <= limits.P6.max, compared: pages.length, differences, offenders, hint: 'Use the same radius, typography, spacing, button-height and motion tokens across pages/views.' };
}
