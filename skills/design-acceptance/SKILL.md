---
name: design-acceptance
description: The owner's five acceptance criteria for any UI design or restyle in Agentrix (clear focus, uniform alignment, regular spacing, restrained colour and material, one product), with measurable thresholds and the audit script that scores them. Use whenever a design mockup, concept page or UI change is handed in or reviewed.
---

# Accepting a design: five questions, measured

The owner accepts a design by five questions: 有没有明确的焦点？对齐是否统一？间距是否有规律？颜色与材质是否克制？每个组件是否像同一个产品的一部分？
Each is answered with numbers, not taste. Measure the app window's UI only: not the wallpaper, photos or brand marks
(mark those `data-audit-ignore`).

| # | Question | Metric | Pass |
| --- | --- | --- | --- |
| 1 | Clear focus | F1 elements at the largest font size; next size down | 1; ≤ 0.8× |
| | | F2 solid primary buttons in view | ≤ 1 |
| | | F3 12px-blurred grayscale screenshot | what stands out is the intended focus (a person checks) |
| 2 | Uniform alignment | A1 distinct left edges per pane | ≤ 4 |
| | | A2 near-misses (edges 1–3px apart) | 0 |
| | | A3 vertical centres within a row | differ ≤ 1px |
| 3 | Regular spacing | S1 padding/margin/gap off the scale {2,4,8,12,16,20,24,32,40,48,64} | 0 |
| | | S2 distinct spacing values | ≤ 8 |
| | | S3 repeated rows/cards | identical heights and gaps |
| 4 | Restrained colour and material | C1 chromatic hue families (30° buckets, saturation ≥ 25%) | ≤ 3: needs-you, working, danger |
| | | C2 chromatic background area of the pane | ≤ 5% |
| | | C3 backdrop-filters / box-shadows / surface alphas | ≤ 2 / ≤ 3 / ≤ 4 |
| 5 | One product | P1 border radii | ≤ 4, from one set |
| | | P2 font sizes / weights | ≤ 6 / ≤ 3 |
| | | P3 button variants, heights | ≤ 2 variants, one height (a compact one only inside rows) |
| | | P4 transition duration and easing | one of each |
| | | P5 icon family, icon sizes | one family, ≤ 3 sizes |
| | | P6 token sets across pages of the same product | identical |

## Definitions (so a hand count and the script agree)

- **Alignment line (A1, A2):** the left edge of a row's first visible box (a heading, row container, card, the first
  control of a toolbar) and of each column's text block. Icon, text and tag side by side in one row are one line.
- **Repeated components (S3):** adjacent siblings of the same class; a group label or divider between them starts a new
  run, so its gap is not compared.
- **Accent colour (C1, C2):** colours inside a pane (tags, badges, filled buttons, highlighted rows), as a share of
  that pane's area. The pane's own glass surface is material, not accent, and near-black or near-white colours
  (lightness < 12% or > 92%) are not accents.
- **Radius (P1):** 0 is no radius and is not counted; every pill (radius ≥ half the height) counts as one value.

## How

- `npm run audit:design -- <page.html> [more pages] --root <window selector> [--view name=query]` writes
  `audit.md` and `audit.json` with every metric, its value, PASS/FAIL and the offending selectors, plus the blurred
  screenshot for F3. Give two or more pages to check P6.
- Every brief for design work (Sonnet subagent or Codex concepts) carries this table, and the worker reports the
  measured numbers. The lead reruns the audit and opens the F3 picture before showing the owner.
- A deliberate exception (a fourth hue for an error state, say) is named in the report with its reason; it is not
  silently passed.
