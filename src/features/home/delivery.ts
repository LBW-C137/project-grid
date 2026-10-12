// The delivery summary an agent ends a finished task with (the startup note asks for it, electron/features/agents/
// handoff.cjs): for a fix, the problem, its cause and the result; for an optimization, what was optimized, what problem
// it solves and the comparison before and after. These three are what the homework card shows first.
export type Delivery = { kind: 'fix' | 'optimize'; parts: { label: string; text: string }[] };

const FIX = [['问题', 'problem'], ['原因', 'cause'], ['结果', 'result']] as const;
const OPTIMIZE = [['优化', 'optimization'], ['解决', 'solves'], ['对比', 'before and after']] as const;
const LABELS = { 问题: '要解决的问题', 原因: '具体原因', 结果: '结果', 优化: '做了什么优化', 解决: '解决了什么问题', 对比: '前后对比' } as const;
type Key = keyof typeof LABELS;
const ALIASES: Record<string, Key> = Object.fromEntries([...FIX, ...OPTIMIZE].flatMap(([key, english]) => [[key, key], [english, key]]));

// A line that starts one part: "问题：…", "- **原因**: …", "Result: …".
const START = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?\s*(问题|原因|结果|优化|解决|对比|problem|cause|result|optimization|solves|before and after)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/i;

// The last summary in the reply, or null when the agent wrote none (or only part of one).
export function parseDelivery(reply: string): Delivery | null {
  const lines = reply.replace(/\r\n?/g, '\n').split('\n');
  let from = -1;
  for (let index = lines.length - 1; index >= 0; index--) if (/^\s*(?:#+\s*)?(?:【交付】|\*\*交付\*\*|交付[:：]?\s*$|delivery[:：]?\s*$)/i.test(lines[index])) { from = index; break; }
  const found = new Map<Key, string[]>();
  let current: Key | null = null;
  for (const line of lines.slice(from + 1)) {
    const start = START.exec(line);
    if (start) { current = ALIASES[start[1].toLowerCase()] ?? ALIASES[start[1]]; found.set(current, [start[2].trim()]); continue; }
    if (current && line.trim() && !/^\s*#/.test(line)) found.get(current)!.push(line.trim());
    else if (!line.trim() && current && found.get(current)!.join('').trim()) current = null;
  }
  for (const [kind, keys] of [['fix', FIX], ['optimize', OPTIMIZE]] as const) {
    const parts = keys.map(([key]) => ({ key, text: (found.get(key) ?? []).join('\n').trim() }));
    if (parts.every(part => part.text)) return { kind, parts: parts.map(part => ({ label: LABELS[part.key], text: part.text })) };
  }
  return null;
}
