import type { Project, ProjectTerminal } from '../../shared/types';
import type { Decision } from './decisions';
import { relativeTime } from '../../shared/time';
import { t } from '../../shared/i18n';
import { actionText } from '../agents/ActivityPane';
import './home.css';

type State = { key: 'deciding' | 'working' | 'unread' | 'done' | 'idle' | 'stopped'; label: string };
// What a session is doing, in the words a person uses for work: never a percentage it cannot know.
function sessionState(project: Project, terminal: ProjectTerminal, decisions: number): State {
  if (!terminal.sessionId || terminal.status === 'exited') return { key: 'stopped', label: t('未启动') };
  if (!terminal.codexActive) return { key: 'idle', label: t('终端') };
  if (decisions) return { key: 'deciding', label: t('等你决定') };
  if (terminal.codexActivity === 'working') return { key: 'working', label: t('工作中') };
  if (project.unread > 0 && terminal.codexActivity === 'complete') return { key: 'unread', label: t('等你查看') };
  if (terminal.codexActivity === 'complete') return { key: 'done', label: t('本轮完成') };
  return { key: 'idle', label: t('等待指令') };
}

// Every session in every project, the way a teacher watches the class, beside the decisions on the home page: what
// it was asked to do, the step it is on right now, where it stands, what waits after it and how many decisions it
// waits on. A click opens it in the workbench.
export function SessionOverview({ projects, decisions, onOpenProject }: { projects: readonly Project[]; decisions: readonly Decision[]; onOpenProject: (projectId: string) => void }) {
  const rows = projects.flatMap(project => project.terminals.map(terminal => {
    const waiting = decisions.filter(decision => decision.terminalId === terminal.id).length;
    return { project, terminal, waiting, state: sessionState(project, terminal, waiting) };
  }));
  const order: State['key'][] = ['deciding', 'working', 'unread', 'done', 'idle', 'stopped'];
  rows.sort((a, b) => order.indexOf(a.state.key) - order.indexOf(b.state.key));
  const counts = order.map(key => [key, rows.filter(row => row.state.key === key).length] as const).filter(([, count]) => count);
  return <aside className="home-side session-overview" aria-label={t('所有会话')}>
    <h3>{t('所有会话')}</h3>
    {counts.length > 0 && <p className="session-counts">{counts.map(([key, count]) => <span key={key} className={`is-${key}`}>{t(LABELS[key], { count })}</span>)}</p>}
    {!rows.length ? <p className="task-empty">{t('还没有项目。添加项目后，每个会话的工作都会列在这里。')}</p>
      : <ul className="task-rows">{rows.map(({ project, terminal, waiting, state }) => {
        const prompts = terminal.prompts || [], doing = prompts.find(prompt => prompt.state === 'working')?.text || terminal.task;
        const queued = prompts.filter(prompt => prompt.state === 'queued').length;
        return <li key={terminal.id}><button type="button" onClick={() => onOpenProject(project.id)}>
          <span className={`task-state is-${state.key}`}>{state.label}</span>
          <span className="task-main">
            <b><span>{project.name}{project.terminals.length > 1 ? ` · ${terminal.title}` : ''}</span>{terminal.codexActive && <em>{terminal.agent === 'claude' ? 'Claude Code' : 'Codex'}</em>}</b>
            <span>{doing || (terminal.codexActive ? t('还没有交代任务') : t('没有运行中的助手'))}</span>
            {state.key === 'working' && terminal.action && <span className="task-step">{t('正在{step}', { step: actionText(terminal.action) })}</span>}
            {(waiting > 0 || queued > 0 || terminal.lastCompletedAt) && <span className="task-meta">
              {waiting > 0 && <span className="is-deciding">{t('{count} 件待决定', { count: waiting })}</span>}
              {queued > 0 && <span>{t('{count} 条排队', { count: queued })}</span>}
              {terminal.lastCompletedAt && <span>{t('上次完成 {time}', { time: relativeTime(terminal.lastCompletedAt, Date.now()) })}</span>}
            </span>}
          </span>
        </button></li>;
      })}</ul>}
  </aside>;
}
const LABELS: Record<State['key'], string> = { deciding: '{count} 个等你决定', working: '{count} 个工作中', unread: '{count} 个等你查看', done: '{count} 个本轮完成', idle: '{count} 个空闲', stopped: '{count} 个未启动' };
