// How many of its plan's limit resets Codex last said are left, as its screen shows it: when a limit is reached ("You
// have 2 resets available. Run /usage to use one."), in /usage, and after a reset ("Usage reset. You have 1 reset
// left."). The official background account read now supplies this number too. null: it has not said.
const SAID = [
  /You have (\d+) [^.]*?resets? available/gi,
  /Usage reset\. You have (\d+)\b[^.]*?\bleft/gi,
  /\b(\d+) (?:usage limit )?resets? (?:available|left|remaining)\b/gi,
  /You don't have any usage limit resets available()/gi,
];
export function codexResetsSaid(rows: readonly string[]): number | null {
  const text = rows.map(row => row.trim()).join(' ');
  let latest: { at: number; left: number } | null = null;
  for (const pattern of SAID) {
    for (const match of text.matchAll(pattern)) {
      if (!latest || match.index >= latest.at) latest = { at: match.index, left: match[1] ? Number(match[1]) : 0 };
    }
  }
  return latest?.left ?? null;
}

// A background account read is scoped to the current account environment. Once
// present, its unknown/error state must not revive an older screen's count.
export function codexResetCount(usage: { resets?: { left: number | null } | null; resetQuery?: { state: string } } | null | undefined, said: number | null): number | null {
  if (usage?.resetQuery) return usage.resetQuery.state === 'ready' ? usage.resets?.left ?? null : null;
  return usage?.resets?.left ?? said;
}
