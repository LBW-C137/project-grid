import { useEffect, useMemo, useState, type ClipboardEvent } from 'react';
import { ArrowRight, CheckCircle, CircleNotch, PaperPlaneRight, Sparkle, X } from '@phosphor-icons/react';
import type { Project, Result } from '../../shared/types';
import type { Decision } from './decisions';
import { DecisionDeck } from './DecisionDeck';
import { acceptedToday } from './ReviewCard';
import { sendToAgent, untilAtPrompt } from './send-to-agent';
import { dataUrl, thumbnail } from '../reading/image-thumbnail';
import { t } from '../../shared/i18n';
import './home.css';

// The home page, for grading the work like a teacher: what needs you, as a stack of cards to flip through and draw
// from (permissions, questions, work handed in); what is being worked on; and where to say what comes next. Nothing
// here is solved by looking at it.
export function DecisionHome({ projects, decisions, snoozed, onOpenProject, onOpenDecision, onAction, onError }: {
  projects: readonly Project[]; decisions: readonly Decision[]; snoozed: number;
  onOpenProject: (projectId: string) => void; onOpenDecision: (decision: Decision) => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>; onError: (message: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const [notice, setNotice] = useState('');
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const terminals = projects.flatMap(project => project.terminals.map(terminal => ({ project, terminal })));
  const working = terminals.filter(({ terminal }) => terminal.codexActive && terminal.codexActivity === 'working');
  // What the decisions are, by kind: "1 次审批 · 2 项交付审查".
  const breakdown = (Object.entries(BREAKDOWN) as [Decision['kind'], string][]).map(([kind, label]) => [label, decisions.filter(decision => decision.kind === kind).length] as const).filter(([, count]) => count > 0);
  const accepted = useMemo(() => acceptedToday(), [decisions]);
  const headline = decisions.length ? t('{count} 件事需要你决定', { count: decisions.length })
    : working.length ? t('现在没有需要你处理的事') : t('接下来想创造什么？');
  return <div className="home-page decision-home">
    <header className="home-head">
      <h1>{headline}</h1>
      <p className="home-counts">
        {working.length > 0 && <span><CircleNotch size={13} className="loading-spinner" />{t('{count} 个会话正在工作', { count: working.length })}</span>}
        {breakdown.map(([label, count]) => <span key={label} className="home-count-kind">{t(label, { count })}</span>)}
        {accepted > 0 && <span><CheckCircle size={13} weight="fill" />{t('今天已接受 {count} 项交付', { count: accepted })}</span>}
        {snoozed > 0 && <span>{t('{count} 件已暂缓', { count: snoozed })}</span>}
        {!decisions.length && !working.length && <span>{t('描述一个目标，选择项目后开始。')}</span>}
      </p>
    </header>
    {notice && <p className="home-notice" role="status"><CheckCircle size={15} weight="fill" />{notice}</p>}
    {decisions.length > 0 && <DecisionDeck decisions={decisions} now={now} onOpen={onOpenDecision} onDone={setNotice} onError={onError} />}
    {working.length > 0 && <section className="home-section" aria-label={t('工作进展')}>
      <h3>{t('工作进展')}</h3>
      <ul className="progress-rows">
        {working.map(({ project, terminal }) => <li key={terminal.id} className="is-working"><CircleNotch size={13} className="loading-spinner" /><b>{project.name}</b>
          <span>{terminal.prompts.find(prompt => prompt.state === 'working')?.text || terminal.task || t('正在工作')}</span>
          <button type="button" className="text-button" onClick={() => onOpenProject(project.id)}>{t('打开')}<ArrowRight size={13} /></button></li>)}
      </ul>
    </section>}
    <NewWork projects={projects} onAction={onAction} onDone={setNotice} onError={onError} />
  </div>;
}

const BREAKDOWN: Partial<Record<Decision['kind'], string>> = { approval: '{count} 次审批', question: '{count} 个问题', choice: '{count} 个选择', signin: '{count} 个登录', attention: '{count} 件要你处理', review: '{count} 项交付审查' };

// "What next": a goal sent to a project's agent from here, without leaving the page. One that runs gets it at once (it
// queues it while it works); otherwise the chosen agent is started first and gets it when its input is ready. Its
// progress then shows under "工作进展" and its work comes back as a card.
function NewWork({ projects, onAction, onDone, onError }: {
  projects: readonly Project[];
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>; onDone: (message: string) => void; onError: (message: string) => void;
}) {
  const local = useMemo(() => projects.filter(project => project.kind !== 'ssh' || project.terminals[0]?.codexActive), [projects]);
  const [text, setText] = useState(''), [projectId, setProjectId] = useState(''), [agent, setAgent] = useState<'claude' | 'codex'>('claude'), [busy, setBusy] = useState(false);
  const project = local.find(item => item.id === projectId) ?? local[0], terminal = project?.terminals[0];
  // Pictures pasted here go as files: the agent may not run yet to take them from the clipboard, so each is saved and
  // its path sent with the goal for the agent to look at.
  const [images, setImages] = useState<{ blob: Blob; preview: string }[]>([]);
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (!files.length || event.clipboardData.getData('text/plain')) return;
    event.preventDefault();
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { onError(t('图片太大（超过 25 MB），请压缩后再粘贴。')); continue; }
      void thumbnail(file).catch(() => dataUrl(file)).then(preview => setImages(list => [...list, { blob: file, preview }].slice(-6))).catch(() => onError(t('无法读取这张图片。')));
    }
  };
  const start = async () => {
    let goal = text.trim();
    if ((!goal && !images.length) || !project || !terminal || busy) return;
    const kind = terminal.codexActive ? (terminal.agent === 'codex' ? 'codex' : 'claude') : agent, name = kind === 'codex' ? 'Codex' : 'Claude Code';
    setBusy(true);
    try {
      if (!terminal.codexActive) {
        if (terminal.sessionId && terminal.shellReady) window.agentrix.writeTerminal(terminal.id, `${agent}\r`);
        else if (!terminal.sessionId && await onAction(window.agentrix.agentLaunch(terminal.id, agent, 'new')) === undefined) return;
        onDone(t('正在启动 {agent}，准备好就把任务发给它…', { agent: name }));
        if (!await untilAtPrompt(terminal.id, kind)) { onError(t('{agent} 还没准备好接收任务，任务留在这里，稍后再点开始。', { agent: name })); return; }
      }
      // A just-started terminal has its session only now.
      const state = await window.agentrix.getState();
      const sessionId = state.ok ? state.value.projects.flatMap(item => item.terminals).find(item => item.id === terminal.id)?.sessionId : null;
      if (!sessionId) { onError(t('它的终端还没有准备好，请稍后再试。')); return; }
      if (images.length) {
        const paths: string[] = [];
        for (const image of images) {
          const saved = await window.agentrix.saveImage(terminal.id, await image.blob.arrayBuffer(), image.blob.type);
          if (!saved.ok) { onError(saved.error); return; }
          paths.push(saved.value);
        }
        goal = [goal, t('附图（请先打开看看）：'), ...paths].filter(Boolean).join('\n');
      }
      const failed = await sendToAgent(terminal.id, sessionId, kind, goal);
      if (failed) { onError(failed); return; }
      setText(''); setImages([]); onDone(t('已交给「{project}」的 {agent}，它的进展会出现在下面。', { project: project.name, agent: name }));
    } catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  if (!local.length) return null;
  return <section className="home-section new-work" aria-label={t('新任务')}>
    <h3><Sparkle size={15} weight="fill" />{t('告诉 Agentrix 接下来要做什么')}</h3>
    <textarea value={text} rows={text || images.length ? 3 : 1} placeholder={t('描述要做的事，比如“给登录页加上验证码”；可以直接粘贴截图')} onChange={event => setText(event.target.value)} onPaste={paste}
      onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void start(); } }} />
    {images.length > 0 && <div className="new-work-images" role="list" aria-label={t('附图')}>{images.map((image, index) => <span key={index} role="listitem">
      <img src={image.preview} alt={t('附加的图片 {n}', { n: index + 1 })} />
      <button type="button" aria-label={t('移除这张图片')} onClick={() => setImages(list => list.filter((_, at) => at !== index))}><X size={12} weight="bold" /></button>
    </span>)}</div>}
    {(text.trim() || images.length > 0) && <div className="new-work-options">
      <label>{t('项目')}<select value={project?.id} onChange={event => setProjectId(event.target.value)}>{local.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {terminal && !terminal.codexActive && <label>{t('助手')}<select value={agent} onChange={event => setAgent(event.target.value as 'claude' | 'codex')}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>}
      <span className="new-work-note">{terminal?.codexActive ? t('直接发给它，不离开这一页') : t('先启动助手，准备好就发给它')}</span>
      <button type="button" className="button primary" disabled={busy} onClick={() => void start()}>{busy ? <CircleNotch size={15} className="loading-spinner" /> : <PaperPlaneRight size={15} />}{busy ? t('发送中…') : t('开始')}</button>
    </div>}
  </section>;
}
