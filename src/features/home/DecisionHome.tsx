import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle, Circle, CircleNotch, PaperPlaneRight, Sparkle } from '@phosphor-icons/react';
import type { Project, Result } from '../../shared/types';
import type { Decision } from './decisions';
import { DecisionCard, decisionKind, decisionTitle, waited } from './DecisionCard';
import { prefillComposer } from '../reading/composer-prefill';
import { t } from '../../shared/i18n';
import './home.css';

// The home page: what needs you, one decision open in full and the others under it; what is being worked on and what
// finished for you to look at; and where to say what comes next. Nothing here is solved by looking at it.
export function DecisionHome({ projects, decisions, snoozed, onOpenProject, onOpenDecision, onAction, onError }: {
  projects: readonly Project[]; decisions: readonly Decision[]; snoozed: number;
  onOpenProject: (projectId: string) => void; onOpenDecision: (decision: Decision) => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>; onError: (message: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  // The decision open in full stays the one the reader chose while it lasts; a new arrival never replaces it.
  const [chosen, setChosen] = useState<string | null>(null), [all, setAll] = useState(false), [notice, setNotice] = useState('');
  const current = decisions.find(decision => decision.id === chosen) ?? decisions[0] ?? null;
  useEffect(() => { if (current && current.id !== chosen) setChosen(current.id); }, [current, chosen]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const others = decisions.filter(decision => decision !== current), listed = all ? others : others.slice(0, 3);
  const terminals = projects.flatMap(project => project.terminals.map(terminal => ({ project, terminal })));
  const working = terminals.filter(({ terminal }) => terminal.codexActive && terminal.codexActivity === 'working');
  const unread = projects.filter(project => project.unread > 0);
  const headline = decisions.length ? t('{count} 件事需要你决定', { count: decisions.length })
    : working.length ? t('现在没有需要你处理的事') : t('接下来想创造什么？');
  return <div className="home-page decision-home">
    <header className="home-head">
      <h1>{headline}</h1>
      <p className="home-counts">
        {working.length > 0 && <span><CircleNotch size={13} className="loading-spinner" />{t('{count} 个会话正在工作', { count: working.length })}</span>}
        {unread.length > 0 && <span className="is-unread"><Circle size={9} weight="fill" />{t('{count} 个本轮完成，等你查看', { count: unread.length })}</span>}
        {snoozed > 0 && <span>{t('{count} 件已暂缓', { count: snoozed })}</span>}
        {!decisions.length && !working.length && !unread.length && <span>{t('描述一个目标，选择项目后开始。')}</span>}
      </p>
    </header>
    {notice && <p className="home-notice" role="status"><CheckCircle size={15} weight="fill" />{notice}</p>}
    {current && <DecisionCard key={current.id} decision={current} now={now} onOpen={onOpenDecision} onDone={setNotice} onError={onError} />}
    {others.length > 0 && <section className="home-section" aria-label={t('其他事项')}>
      <h3>{t('其他事项')}</h3>
      <ul className="decision-rows">{listed.map(decision => { const { label, Icon } = decisionKind(decision.kind); return <li key={decision.id}>
        <button type="button" onClick={() => setChosen(decision.id)}>
          <Icon size={16} weight="fill" className={`decision-row-icon is-${decision.kind}`} aria-label={t(label)} />
          <b>{decisionTitle(decision)}</b><span>{decision.projectName}</span><small>{waited(decision.since, now)}</small>
        </button></li>; })}</ul>
      {others.length > 3 && <button type="button" className="text-button" onClick={() => setAll(!all)}>{all ? t('收起') : t('查看全部（{count}）', { count: others.length })}</button>}
    </section>}
    {(working.length > 0 || unread.length > 0) && <section className="home-section" aria-label={t('工作进展')}>
      <h3>{t('工作进展')}</h3>
      <ul className="progress-rows">
        {unread.map(project => <li key={project.id} className="is-unread"><Circle size={9} weight="fill" /><b>{project.name}</b>
          <span>{t('本轮完成，等你查看')}{project.terminals[0]?.task ? ` · ${project.terminals[0].task}` : ''}</span>
          <button type="button" className="text-button" onClick={() => onOpenProject(project.id)}>{t('查看')}<ArrowRight size={13} /></button></li>)}
        {working.map(({ project, terminal }) => <li key={terminal.id} className="is-working"><CircleNotch size={13} className="loading-spinner" /><b>{project.name}</b>
          <span>{terminal.prompts.find(prompt => prompt.state === 'working')?.text || terminal.task || t('正在工作')}</span>
          <button type="button" className="text-button" onClick={() => onOpenProject(project.id)}>{t('打开')}<ArrowRight size={13} /></button></li>)}
      </ul>
    </section>}
    <NewWork projects={projects} onOpenProject={onOpenProject} onAction={onAction} onError={onError} />
  </div>;
}

// "What next": a goal for a project. It waits in that project's message box to be sent after a look; an agent is started
// first when none runs there.
function NewWork({ projects, onOpenProject, onAction, onError }: {
  projects: readonly Project[]; onOpenProject: (projectId: string) => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>; onError: (message: string) => void;
}) {
  const local = useMemo(() => projects.filter(project => project.kind !== 'ssh' || project.terminals[0]?.codexActive), [projects]);
  const [text, setText] = useState(''), [projectId, setProjectId] = useState(''), [agent, setAgent] = useState<'claude' | 'codex'>('claude'), [busy, setBusy] = useState(false);
  const project = local.find(item => item.id === projectId) ?? local[0], terminal = project?.terminals[0];
  const start = async () => {
    if (!text.trim() || !project || !terminal || busy) return;
    setBusy(true);
    try {
      prefillComposer(terminal.id, text.trim());
      if (!terminal.codexActive) {
        if (terminal.sessionId && terminal.shellReady) window.agentrix.writeTerminal(terminal.id, `${agent}\r`);
        else if (!terminal.sessionId && await onAction(window.agentrix.agentLaunch(terminal.id, agent, 'new')) === undefined) return;
      }
      setText(''); onOpenProject(project.id);
    } catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  if (!local.length) return null;
  return <section className="home-section new-work" aria-label={t('新任务')}>
    <h3><Sparkle size={15} weight="fill" />{t('告诉 Agentrix 接下来要做什么')}</h3>
    <textarea value={text} rows={text ? 3 : 1} placeholder={t('描述要做的事，比如“给登录页加上验证码”')} onChange={event => setText(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void start(); } }} />
    {text.trim() && <div className="new-work-options">
      <label>{t('项目')}<select value={project?.id} onChange={event => setProjectId(event.target.value)}>{local.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {terminal && !terminal.codexActive && <label>{t('助手')}<select value={agent} onChange={event => setAgent(event.target.value as 'claude' | 'codex')}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>}
      <span className="new-work-note">{terminal?.codexActive ? t('放进它的消息框，看一眼再发送') : t('先启动助手，再放进它的消息框')}</span>
      <button type="button" className="button primary" disabled={busy} onClick={() => void start()}><PaperPlaneRight size={15} />{t('开始')}</button>
    </div>}
  </section>;
}
