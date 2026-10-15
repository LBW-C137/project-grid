import { CaretRight, CircleNotch } from '@phosphor-icons/react';
import type { AgentTokens, AgentUsage, ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { modelName } from '../reading/model-name';
import './activity-pane.css';

// 1234 → "1.2k", 828400 → "828k", 23898406 → "23.9M": token counts the way a person reads them at a glance.
export function tokenCount(value: number) {
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(value / 1e6).toFixed(value < 1e7 ? 2 : 1).replace(/\.?0+$/, '')}M`;
}
// How full a meter is: calm, then amber from 70%, red from 90%.
const level = (percent: number) => percent >= 90 ? 'is-high' : percent >= 70 ? 'is-warm' : '';
const percentOf = (part: number, whole: number) => whole > 0 ? Math.min(100, Math.round(part / whole * 100)) : 0;

// Beside an expanded project's terminal: the prompts being worked on, then what the agent runs on and spends — the
// route its model is reached through, how full the context window is and the tokens and plan allowance used.
export function ActivityPane({ terminal }: { terminal: ProjectTerminal }) {
  return <aside className="activity-pane" aria-label={t('活动')}>
    <section className="activity-card activity-tasks" aria-label={t('正在处理的任务')}>
      <h4 className="activity-card-title">{t('正在处理的任务')}</h4>
      <PromptList terminal={terminal} />
    </section>
    {terminal.codexActive ? <>
      <RouteCard terminal={terminal} />
      <ContextCard usage={terminal.agentUsage} />
      <UsageCard usage={terminal.agentUsage} claude={terminal.agent === 'claude'} />
    </> : <section className="activity-card">
      <p className="activity-empty">{t('在终端里启动 Codex 或 Claude Code 后，这里显示它的模型路由、上下文长度和用量。')}</p>
    </section>}
  </aside>;
}

// Agent › service › model, and how the model runs: its effort and whether fast mode is on.
function RouteCard({ terminal }: { terminal: ProjectTerminal }) {
  const settings = terminal.agentSettings, provider = terminal.agentUsage?.provider;
  const steps = [
    { label: terminal.agent === 'claude' ? 'Claude Code' : 'Codex', title: t('代理') },
    ...(provider ? [{ label: provider, title: t('接口') }] : []),
    ...(settings?.model ? [{ label: modelName(settings.model), title: t('模型'), model: true }] : []),
  ];
  const how = [settings?.effort && t('思考 {effort}', { effort: settings.effort === 'default' ? t('默认') : settings.effort }),
    settings?.fast != null && (settings.fast ? t('快速模式') : t('普通模式'))].filter(Boolean).join(' · ');
  return <section className="activity-card activity-route" aria-label={t('模型路由')}>
    <h4 className="activity-card-title">{t('模型路由')}</h4>
    <ol className="activity-route-steps">
      {steps.map((step, index) => <li key={step.title} className={step.model ? 'is-model' : ''} title={t('{name}：{value}', { name: step.title, value: step.label })}>
        {index > 0 && <CaretRight size={12} weight="bold" aria-hidden="true" />}<span>{step.label}</span>
      </li>)}
    </ol>
    <p className="activity-note">{settings?.model ? how || t('按默认设置运行') : t('第一次回复后显示模型。')}</p>
  </section>;
}

// The context the conversation fills now, out of the model's window.
function ContextCard({ usage }: { usage: AgentUsage | null | undefined }) {
  const context = usage?.context;
  const percent = context ? percentOf(context.used, context.window) : 0;
  return <section className="activity-card activity-context" aria-label={t('上下文长度')}>
    <header className="activity-card-head"><h4 className="activity-card-title">{t('上下文长度')}</h4>{context && <b className={`activity-percent ${level(percent)}`}>{percent}%</b>}</header>
    {context ? <>
      <p className="activity-figure"><b>{tokenCount(context.used)}</b><span> / {tokenCount(context.window)} tokens</span></p>
      <Meter percent={percent} label={t('上下文已用 {percent}%', { percent })} />
      <p className="activity-note">{t('还可容纳 {count} tokens', { count: tokenCount(Math.max(0, context.window - context.used)) })}</p>
    </> : <p className="activity-note">{t('第一次回复后显示。')}</p>}
  </section>;
}

// The plan's allowance used (Codex reports it with every call), then the tokens of this round and this conversation.
function UsageCard({ usage, claude }: { usage: AgentUsage | null | undefined; claude: boolean }) {
  const limits = usage?.limits || [], rows = [[t('本轮'), usage?.round], [t('本次对话'), usage?.total]] as const;
  const known = rows.filter(([, tokens]) => tokens);
  return <section className="activity-card activity-usage" aria-label={t('用量')}>
    <h4 className="activity-card-title">{t('用量')}</h4>
    {!!limits.length && <div className="activity-limits">
      {limits.map(limit => <div key={limit.minutes ?? 0} className="activity-limit">
        <span>{limitName(limit.minutes)}</span><b className={level(limit.percent)}>{Math.round(limit.percent)}%</b>
        <Meter percent={limit.percent} label={t('{name}已用 {percent}%', { name: limitName(limit.minutes), percent: Math.round(limit.percent) })} />
        {limit.resetsAt && <small>{t('{time} 重置', { time: resetTime(limit.resetsAt) })}</small>}
      </div>)}
    </div>}
    {known.length ? <dl className="activity-tokens">
      {known.map(([label, tokens]) => <TokenRow key={label} label={label} tokens={tokens!} />)}
    </dl> : <p className="activity-note">{t('第一次回复后显示。')}</p>}
    {claude && <p className="activity-note">{t('Claude Code 的记录里没有账号额度；在终端输入 /usage 查看。')}</p>}
  </section>;
}

function TokenRow({ label, tokens }: { label: string; tokens: AgentTokens }) {
  const parts = [t('输入 {count}', { count: tokenCount(tokens.input) }), tokens.input > 0 && tokens.cached > 0 && t('缓存命中 {percent}%', { percent: percentOf(tokens.cached, tokens.input) }), t('输出 {count}', { count: tokenCount(tokens.output) })].filter(Boolean);
  return <div className="activity-token-row">
    <dt>{label}</dt><dd><b>{tokenCount(tokens.input + tokens.output)}</b> tokens</dd>
    <small>{parts.join(' · ')}</small>
  </div>;
}

function Meter({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return <span className={`activity-meter ${level(value)}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-label={label}><i style={{ width: `${value}%` }} /></span>;
}

// A rate-limit window by its length: 5 hours, a week.
function limitName(minutes: number | null) {
  if (minutes === 10080) return t('每周额度');
  if (minutes === 1440) return t('每日额度');
  if (minutes && minutes % 60 === 0) return t('{n} 小时额度', { n: minutes / 60 });
  return minutes ? t('{n} 分钟额度', { n: minutes }) : t('额度');
}
// When a window starts over: the time today, else the date and time.
function resetTime(at: number) {
  const date = new Date(at), today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// The prompts sent and not finished: the one being worked on first, then those waiting their turn. A prompt
// leaves the list when the round that worked on it ends.
function PromptList({ terminal }: { terminal: ProjectTerminal }) {
  const prompts = terminal.prompts || [];
  if (!prompts.length) {
    const text = !terminal.codexActive ? t('还没有开始任务') : terminal.codexActivity === 'complete' && terminal.task ? t('已完成：{task}', { task: terminal.task }) : t('没有待处理的提示');
    return <p className="activity-task-quiet" title={text}>{text}</p>;
  }
  return <ol className="activity-prompts" aria-label={t('提示')}>
    {prompts.map(prompt => prompt.state === 'working'
      ? <li key={prompt.id} className="is-working" title={prompt.text}>
        <span className="activity-prompt-state"><CircleNotch size={20} weight="bold" className="loading-spinner" aria-hidden="true" />{t('正在处理')}</span>
        <p>{prompt.text}</p>
        <span className="activity-progress" aria-hidden="true"><i /></span>
      </li>
      : <li key={prompt.id} title={prompt.text}><span className="activity-prompt-state">{t('排队中')}</span><p>{prompt.text}</p></li>)}
  </ol>;
}
