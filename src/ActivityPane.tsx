import { useEffect, useState } from 'react';
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
  </aside>;
}
