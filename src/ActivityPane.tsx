import { useEffect, useMemo, useState } from 'react';
import { CircleNotch, FileText, Globe, MagnifyingGlass, PencilSimple, Plugs, Robot, Sparkle, Terminal, Wrench } from '@phosphor-icons/react';
import type { AgentAction, AgentActionBrief, Project, ProjectTerminal } from './types';
import { t } from './i18n';

// What each kind of step is called, in the card's one-line status and in the activity pane.
const KIND_LABELS: Record<AgentActionBrief['kind'], string> = { edit: '修改', command: '运行', read: '读取', search: '搜索', web: '访问', skill: '技能', mcp: 'MCP', agent: '子代理', other: '调用' };
const ICONS = { edit: PencilSimple, command: Terminal, read: FileText, search: MagnifyingGlass, web: Globe, skill: Sparkle, mcp: Plugs, agent: Robot, other: Wrench };

// "修改 src/App.tsx": the step in a few words. An edit made through a shell script names no file.
export function actionText(action: AgentActionBrief) {
  if (action.kind === 'edit' && !action.target) return t('通过命令修改文件');
  return `${t(KIND_LABELS[action.kind])} ${action.target}`.trim();
}

function explanation(action: AgentAction) {
  if (action.kind === 'skill') return action.description || t('没有找到这个技能的说明（SKILL.md）');
  if (action.kind === 'mcp') return t('由 MCP 服务 {server} 提供的工具', { server: action.server || action.target.split(' · ')[0] });
  if (action.kind === 'edit' && !action.target) return action.detail;
  return action.detail;
}

// The steps of the current round for one terminal, newest first: which files the agent edits, which commands
// it runs, which skills and MCP tools it calls and what those are for. The main process reads them from the
// agent's own transcript and sends changes as they happen.
export function ActivityPane({ project, terminal }: { project: Project; terminal: ProjectTerminal }) {
  const [actions, setActions] = useState<AgentAction[]>([]);
  useEffect(() => {
    let active = true; setActions([]);
    void window.projectGrid.terminalActions(terminal.id).then(result => { if (active && result.ok) setActions(result.value); });
    const off = window.projectGrid.onTerminalAction(packet => {
      if (packet.id !== terminal.id) return;
      if (packet.list) { setActions(packet.list); return; }
      setActions(current => {
        const next = [...current];
        for (const action of packet.changes || []) { const at = next.findIndex(item => item.id === action.id); if (at < 0) next.push(action); else next[at] = action; }
        return next.slice(-200);
      });
    });
    return () => { active = false; off(); };
  }, [terminal.id, terminal.sessionId]);
  const working = terminal.codexActive && terminal.codexActivity === 'working';
  const running = working ? [...actions].reverse().find(action => !action.done) : undefined;
  const agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const status = !terminal.codexActive ? t('没有运行中的 Codex 或 Claude Code')
    : running ? actionText(running)
    : working ? t('{agent} 正在思考', { agent })
    : terminal.codexActivity === 'complete' ? t('本轮已完成') : t('等待指令');
  return <aside className="activity-pane" aria-label={t('活动')}>
    <header className="activity-header"><b>{t('活动')}</b><span>{terminal.codexActive ? agent : ''}{actions.length ? ` · ${t('{count} 步', { count: actions.length })}` : ''}</span></header>
    <div className={`activity-now ${running?.kind === 'edit' ? 'is-editing' : ''} ${working ? 'is-working' : ''}`} role="status" title={status}>
      {working && <CircleNotch size={14} className="loading-spinner" />}<span>{status}</span>
    </div>
    <div className="activity-split">
    <section className="activity-live" aria-label={t('实时动态')}>
    <h4 className="activity-section-title">{t('实时动态')}</h4>
    <div className="activity-list" role="list">
      {!actions.length && <p className="activity-empty">{!terminal.codexActive
        ? project.kind === 'ssh' ? t('远程项目暂不显示活动。') : t('在终端里启动 Codex 或 Claude Code 后，这里显示它每一步在做什么：改了哪些文件、运行了什么命令、调用了哪些技能和 MCP 工具。')
        : t('这一轮还没有调用工具。')}</p>}
      {[...actions].reverse().map(action => {
        const Icon = ICONS[action.kind], note = explanation(action);
        return <div key={action.id} role="listitem" className={`activity-item activity-${action.kind} ${action.done ? '' : 'is-running'} ${action.failed ? 'is-failed' : ''}`}>
          <span className="activity-icon" aria-hidden="true">{action.done ? <Icon size={14} /> : <CircleNotch size={14} className="loading-spinner" />}</span>
          <div>
            <div className="activity-title"><b>{t(KIND_LABELS[action.kind])}</b><time>{new Date(action.at).toLocaleTimeString([], { hour12: false })}</time>{action.failed && <em>{t('失败')}</em>}</div>
            {(action.target || action.kind === 'edit') && <code title={action.target}>{action.target || t('通过命令修改文件')}</code>}
            {note && <p title={note}>{note}</p>}
          </div>
        </div>;
      })}
    </div>
    </section>
    <RoundOverview terminal={terminal} actions={actions} working={working} />
    </div>
  </aside>;
}

const COUNTED: AgentActionBrief['kind'][] = ['edit', 'command', 'read', 'search', 'web', 'agent', 'skill', 'mcp', 'other'];
const seconds = (ms: number) => { const total = Math.max(0, Math.round(ms / 1000)), m = Math.floor(total / 60); return m ? t('{m} 分 {s} 秒', { m, s: total % 60 }) : t('{s} 秒', { s: total }); };

// The round at a glance: what it was asked to do, how far it has got, how many tools of each kind it called,
// which files it touched, and the skills and MCP tools it used with what they are for.
function RoundOverview({ terminal, actions, working }: { terminal: ProjectTerminal; actions: AgentAction[]; working: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!working) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [working]);
  const summary = useMemo(() => {
    const counts = new Map<AgentActionBrief['kind'], number>(), files = new Set<string>(), skills = new Map<string, string>(), servers = new Map<string, Set<string>>();
    for (const action of actions) {
      counts.set(action.kind, (counts.get(action.kind) || 0) + 1);
      if (action.kind === 'edit' && action.target) for (const file of action.target.replace(/\s\+\d+$/, '').split('、')) if (file.trim()) files.add(file.trim());
      if (action.kind === 'skill' && action.target) skills.set(action.target, action.description || skills.get(action.target) || '');
      if (action.kind === 'mcp') { const [server, tool] = action.target.split(' · '); if (!servers.has(server)) servers.set(server, new Set()); if (tool) servers.get(server)!.add(tool); }
    }
    return { counts, files: [...files], skills: [...skills], servers: [...servers], done: actions.filter(a => a.done).length, failed: actions.filter(a => a.failed).length };
  }, [actions]);
  const started = actions[0]?.at, ended = working ? now : actions.at(-1)?.at;
  const most = Math.max(1, ...summary.counts.values());
  return <section className="activity-overview" aria-label={t('本轮概览')}>
    <h4 className="activity-section-title">{t('本轮概览')}</h4>
    <div className="overview-body">
      {(terminal.task || !terminal.codexActive) && <p className="overview-task" title={terminal.task}>{terminal.task || t('还没有开始任务')}</p>}
      <div className="overview-stats">
        <div><b>{actions.length}</b><span>{t('工具调用')}</span></div>
        <div><b>{summary.done}</b><span>{t('已完成')}</span></div>
        <div className={summary.failed ? 'is-failed' : ''}><b>{summary.failed}</b><span>{t('失败')}</span></div>
        <div><b>{started && ended ? seconds(ended - started) : '—'}</b><span>{working ? t('已进行') : t('用时')}</span></div>
      </div>
      {actions.length > 0 && <div className="overview-progress" role="progressbar" aria-label={t('已完成的步骤')} aria-valuemin={0} aria-valuemax={actions.length} aria-valuenow={summary.done}><i style={{ width: `${(summary.done / actions.length) * 100}%` }} className={working ? 'is-working' : ''} /></div>}
      {summary.counts.size > 0 && <div className="overview-kinds">{COUNTED.filter(kind => summary.counts.get(kind)).map(kind => { const Icon = ICONS[kind], count = summary.counts.get(kind)!; return <div key={kind} className={`overview-kind activity-${kind}`}><span className="activity-icon" aria-hidden="true"><Icon size={13} /></span><span>{t(KIND_LABELS[kind])}</span><i><em style={{ width: `${(count / most) * 100}%` }} /></i><b>{count}</b></div>; })}</div>}
      {summary.files.length > 0 && <div className="overview-group"><h5>{t('修改的文件')}<span>{summary.files.length}</span></h5>{summary.files.slice(-6).reverse().map(file => <code key={file} title={file}>{file}</code>)}{summary.files.length > 6 && <small>{t('还有 {count} 个', { count: summary.files.length - 6 })}</small>}</div>}
      {summary.skills.length > 0 && <div className="overview-group"><h5>{t('技能')}<span>{summary.skills.length}</span></h5>{summary.skills.map(([name, description]) => <div key={name} className="overview-named"><b>{name}</b>{description && <p title={description}>{description}</p>}</div>)}</div>}
      {summary.servers.length > 0 && <div className="overview-group"><h5>MCP<span>{summary.servers.length}</span></h5>{summary.servers.map(([server, tools]) => <div key={server} className="overview-named"><b>{server}</b><p>{[...tools].join('、') || t('工具')}</p></div>)}</div>}
    </div>
  </section>;
}
