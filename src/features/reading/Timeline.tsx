import type { ReactNode } from 'react';

// The conversation as a timeline: each message of yours, each answer and each group of steps is a node on a line down
// the left, with the time it came beside it; what it is sits to the right of its node. kind: user, agent, tools,
// working. A time the step before already showed is set quiet, so a burst of steps in one minute reads at a glance.
export const stepTime = (at: number | null | undefined) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

export function TimelineStep({ at, kind, mark, quiet = false, state, agent, children }: {
  at: number | null | undefined; kind: 'user' | 'agent' | 'tools' | 'working'; mark: ReactNode; quiet?: boolean;
  // A node whose steps still run turns; one that failed is marked. agent: whose answer it is, which tints its node.
  state?: 'running' | 'failed' | null; agent?: 'claude' | 'codex' | null; children: ReactNode;
}) {
  const time = stepTime(at);
  return <div className={`reading-step is-${kind}${agent ? ` is-${agent}` : ''}${state ? ` is-${state}` : ''}`}>
    <time className={quiet ? 'is-quiet' : undefined} dateTime={at ? new Date(at).toISOString() : undefined}>{time}</time>
    <span className="reading-node" aria-hidden="true">{mark}</span>
    <div className="reading-step-body">{children}</div>
  </div>;
}

// Claude Code's ✻ drawn as an icon rather than a font's glyph: eight rounded rays from one hub on a 24-unit grid, the stroke of the
// icons beside it, so it stays sharp and centred at any size. Each ray sits in a group turned to its angle, so the ray
// itself can grow from the hub and shrink back while Claude works.
const RAYS = Array.from({ length: 8 }, (_, ray) => ray * 45);
export const ClaudeSpark = ({ size = 16 }: { size?: number }) => <svg className="reading-spark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
  {RAYS.map(angle => <g key={angle} transform={`rotate(${angle} 12 12)`}><line x1="12" y1="12" x2="12" y2="3.2" /></g>)}
</svg>;
