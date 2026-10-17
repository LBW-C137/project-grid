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

// What Claude Code last said of its weekly session reset (/limit-reset): offered when the 5-hour limit is reached ("/limit-
// reset to reset your session limit now · … · 1/week"), used ("Session limit reset · next reset available Oct 23 · …"),
// or already used this week ("Weekly reset used · available again Oct 23"). again: when it comes back, as Claude wrote
// it. null: it has not said.
export function claudeResetsSaid(rows: readonly string[]): { left: number; again: string | null } | null {
  // Rows apart, so a date ends with its row; the words before it may wrap.
  const text = rows.map(row => row.trim()).join('\n');
  const said = [
    ...[...text.matchAll(/\/limit-reset\s+to\s+reset\s+your\s+session\s+limit\s+now/gi)].map(match => ({ at: match.index, left: 1, again: null as string | null })),
    ...[...text.matchAll(/(?:Weekly\s+reset\s+used\s+·\s+available\s+again|Session\s+limit\s+reset\s+·\s+next\s+reset\s+available)\s+([^·\n]+)/gi)].map(match => ({ at: match.index, left: 0, again: match[1].trim() })),
  ].sort((a, b) => a.at - b.at).at(-1);
  return said ? { left: said.left, again: said.again } : null;
}
