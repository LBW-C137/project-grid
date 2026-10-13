// A slash command's screen, read into blocks the reading view can lay out as a document: the CLI's box frames go,
// "Label:   value" rows and two-column listings become tables, block-character bars become meters, and key hints
// are set apart. Anything else stays text, in its own line order.
type CliBlock =
  | { kind: 'tabs'; items: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'pairs'; pairs: [string, string, number?][] }
  | { kind: 'meter'; percent: number; label: string }
  | { kind: 'hint'; text: string }
  // A slider (Claude Code's /effort): what its two ends mean, its levels in order, and the one its thumb is on.
  // aside: a setting beside it, with its key ("Ultracode off", "Tab to toggle").
  | { kind: 'slider'; ends: [string, string] | null; levels: string[]; current: number; aside: string[] }
  | { kind: 'text'; lines: string[] };

const FRAME = /^\s*[╭╰├┌└][─━═┬┴┼╌\s]*[╮╯┤┐┘]\s*$|^\s*[─━═╌▔▁]{3,}\s*$/;
const SIDES = (row: string) => row.replace(/^\s*[│┃]\s?/, '').replace(/\s?[│┃]\s*$/, '');
const METER = /^\s*([█▉▊▋▌▍▎▏▓▒░]+)\s+(\d{1,3})%\s*(.*)$/;
// A bar as a value (Codex's "Weekly limit:  [███████░] 96% left (resets …)"): drawn in its row of the table.
const VALUE_METER = /^\[([█▉▊▋▌▍▎▏▓▒░]+)\]\s+(\d{1,3})%\s*(.*)$/;
const PAIR = /^\s*([^\s:/][^:]{0,40}?):\s+(\S.*)$/;
const COLUMNS = /^\s*(\S(?:.*?\S)?)\s{3,}(\S(?:.*\S)?)\s*$/;
// A key as the hints name it: esc, enter, ctrl+o, an arrow or a pair of them (←/→), a letter.
const KEY = String.raw`(?:esc|enter|tab|space|ctrl\+\w+|shift\+\w+|[↑↓←→]+(?:\/[↑↓←→]+)*|\w)`;
const HINT = new RegExp(String.raw`^\s*(?:${KEY}\s+(?:to\s+)?[\w/ ]+?)(?:\s+·\s+${KEY}\s+(?:to\s+)?[\w/ ]+?)*\s*$`, 'i');
const TABS = /^\s*[A-Z][\w-]*(?:\s{2,}[A-Z][\w-]*){2,}\s*$/;

const columns = (row: string) => { const match = COLUMNS.exec(row); return match && !/\s{3,}/.test(match[2]) ? match : null; };

// A slider as Claude Code draws one (its /effort):
//    Faster                                         Smarter
//    ───────────────────────────────────────────▲─      Ultracode  off
//    low      medium      high      xhigh      max      Tab to toggle
// The level the thumb is on is the one whose label is centred nearest above or below it; the names of the ends, the
// row over the track, are optional. What stands beside the track, past its end (Claude Code 2.1.296's Ultracode
// switch and its key), is a setting of its own.
const THUMB = /[▲△▼▽◆●]/;
function track(row: string) {
  const run = /─*[▲△▼▽◆●]─*/.exec(row);
  if (!run || run[0].length < 8 || row.slice(0, run.index).trim()) return null;
  return { start: run.index, end: run.index + run[0].length, thumb: row.search(THUMB), aside: row.slice(run.index + run[0].length).trim().replace(/\s{2,}/g, ' ') };
}
function slider(rows: readonly string[], index: number): { block: CliBlock; last: number } | null {
  const ends = rows[index].trim().split(/\s{3,}/);
  const named = ends.length === 2 && !!track(rows[index + 1] ?? '');
  const at = named ? index + 1 : index, line = track(rows[at]);
  if (!line) return null;
  const labels = [...(rows[at + 1] ?? '').matchAll(/\S+(?: \S+)*/g)].map(match => ({ label: match[0], from: match.index!, centre: match.index! + match[0].length / 2 }));
  // Only when something stands beside the track is a label past its end beside it too.
  const past = (label: { from: number }) => !!line.aside && label.from >= line.end + 2;
  const levels = labels.filter(label => !past(label)), beside = labels.filter(past).map(label => label.label);
  if (levels.length < 2) return null;
  const current = levels.reduce((best, level, index) => Math.abs(level.centre - line.thumb) < Math.abs(levels[best].centre - line.thumb) ? index : best, 0);
  const aside = [line.aside, ...beside].filter(Boolean);
  return { block: { kind: 'slider', ends: named ? [ends[0], ends[1]] : null, levels: levels.map(level => level.label), current, aside }, last: at + 1 };
}

export function renderCliRows(raw: readonly string[]): CliBlock[] {
  const rows = raw.filter(row => !FRAME.test(row)).map(row => SIDES(row).trimEnd());
  const blocks: CliBlock[] = [];
  const push = (block: CliBlock) => {
    const last = blocks.at(-1);
    if (block.kind === 'pairs' && last?.kind === 'pairs') last.pairs.push(...block.pairs);
    else if (block.kind === 'text' && last?.kind === 'text') last.lines.push(...block.lines);
    else blocks.push(block);
  };
  const next = (index: number) => rows.slice(index + 1).find(row => row.trim()) ?? '';
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], text = row.trim();
    if (!text) { if (blocks.at(-1)?.kind === 'text') blocks.push({ kind: 'text', lines: [] }); continue; }
    const slid = slider(rows, index);
    if (slid) { push(slid.block); index = slid.last; continue; }
    const meter = METER.exec(row);
    if (meter) { push({ kind: 'meter', percent: Math.min(100, Number(meter[2])), label: meter[3].trim() }); continue; }
    if (!blocks.length && TABS.test(row)) { push({ kind: 'tabs', items: text.split(/\s{2,}/) }); continue; }
    if (text.length <= 100 && HINT.test(text) && /\b(?:esc|enter|tab|to)\b/i.test(text)) { push({ kind: 'hint', text }); continue; }
    const pair = PAIR.exec(row) ?? columns(row);
    if (pair && !/^https?$/i.test(pair[1])) {
      const value = (pair[2] ?? '').trim(), bar = VALUE_METER.exec(value);
      push({ kind: 'pairs', pairs: [bar ? [pair[1].trim(), `${bar[2]}% ${bar[3]}`.trim(), Math.min(100, Number(bar[2]))] : [pair[1].trim(), value]] }); continue;
    }
    // A short line that opens a group (after a blank, with something below it) names what follows.
    if (text.length <= 48 && !/[.。,，;；:：]$/.test(text) && !rows[index - 1]?.trim() && next(index)) { push({ kind: 'heading', text }); continue; }
    push({ kind: 'text', lines: [text] });
  }
  return blocks.filter(block => block.kind !== 'text' || block.lines.length);
}
