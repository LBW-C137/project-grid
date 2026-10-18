import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, CaretRight, CircleNotch } from '@phosphor-icons/react';
import type { AgentTokens, AgentUsage, ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { modelName } from '../reading/model-name';
import { readScreen, subscribeScreen } from '../terminal/terminal-screen';
import { sendToAgent } from '../home/send-to-agent';
import { claudeResetsSaid, codexResetCount, codexResetsSaid } from './reset-count';
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

// Beside an expanded project's terminal: the model route, context and usage, followed by the running tasks.
export function ActivityPane({ terminal }: { terminal: ProjectTerminal }) {
  return <aside className="activity-pane" aria-label={t('活动')}>
    {terminal.codexActive ? <>
      <RouteCard terminal={terminal} />
      <ContextCard usage={terminal.agentUsage} />
      <UsageCard usage={terminal.agentUsage} terminal={terminal} />
    </> : <section className="activity-card">
      <p className="activity-empty">{t('在终端里启动 Codex 或 Claude Code 后，这里显示它的模型路由、上下文长度和用量。')}</p>
    </section>}
    {/* The task card stays fixed at the bottom; prompts piling up scroll inside it. */}
    <section className="activity-card activity-tasks" aria-label={t('正在处理的任务')}>
      <h4 className="activity-card-title">{t('正在处理的任务')}{(terminal.prompts?.length ?? 0) > 1 && <span className="activity-task-count">{terminal.prompts.length}</span>}</h4>
      <PromptList terminal={terminal} />
    </section>
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
    {!!terminal.agentUsage?.calls?.length && <div className="activity-route-calls">
      <h5>{t('调用的模型')}</h5>
      {terminal.agentUsage.calls.map(call => <div className="activity-route-call" key={JSON.stringify([call.agent, call.provider, call.model, call.effort, call.fast])} title={call.tasks.join('\n')}>
        <ol className="activity-route-steps">
          {[call.agent, ...(call.provider ? [call.provider] : []), modelName(call.model)].map((label, index, route) => <li key={index} className={index === route.length - 1 ? 'is-model' : ''}>
            {index > 0 && <CaretRight size={10} weight="bold" aria-hidden="true" />}<span>{label}</span>
          </li>)}
        </ol>
        <p className="activity-note">
          {call.running > 0 && <i className="activity-call-running" aria-hidden="true" />}
          {[call.agent === 'Codex' ? t('Codex 子任务 ×{count}', { count: call.runs }) : t('子代理 ×{count}', { count: call.runs }),
            call.running > 0 && t('{count} 个运行中', { count: call.running }),
            call.effort && t('思考 {effort}', { effort: call.effort }), call.fast != null && (call.fast ? t('快速') : t('普通模式'))].filter(Boolean).join(' · ')}
        </p>
      </div>)}
    </div>}
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
function UsageCard({ usage, terminal }: { usage: AgentUsage | null | undefined; terminal: ProjectTerminal }) {
  const claude = terminal.agent === 'claude';
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
    <ResetQuota key={`${terminal.id}:${terminal.sessionId}:${terminal.agentStartedAt}`} terminal={terminal} resets={usage?.resets ?? null} />
    {claude && <p className="activity-note">{usage?.limitsAt ? t('额度来自 {source}，{time} 更新', { source: usage.limitsFrom || 'Claude Code', time: resetTime(usage.limitsAt) }) : t('Claude Code 还没有获取账号额度；在终端输入 /usage 查看。')}</p>}
  </section>;
}

// What the agent last said on its screen of the resets left (Claude says whether its
// weekly reset is still there only when offered it or after using it), per terminal.
type Said = { left: number; again: string | null };
const resetsSaid = new Map<string, Said>();
function useResetsSaid(terminal: ProjectTerminal) {
  const key = `${terminal.agent}:${terminal.id}:${terminal.sessionId}:${terminal.agentStartedAt}`;
  const [said, setSaid] = useState(() => resetsSaid.get(key) ?? null);
  useEffect(() => {
    setSaid(resetsSaid.get(key) ?? null);
    const read = (rows: readonly string[]) => {
      const now = terminal.agent === 'claude' ? claudeResetsSaid(rows) : (left => left === null ? null : { left, again: null })(codexResetsSaid(rows));
      const known = resetsSaid.get(key);
      if (now && (now.left !== known?.left || now.again !== known?.again)) { resetsSaid.set(key, now); setSaid(now); }
    };
    const current = readScreen(terminal.id); if (current) read(current.rows);
    const unsubscribe = subscribeScreen(terminal.id, screen => read(screen.rows));
    return () => { unsubscribe(); resetsSaid.delete(key); };
  }, [key]);
  return said;
}

// Using one of the plan's limit resets is costly and never happens at once: a click starts a ten-second countdown that
// the reader can cancel at any moment, and only then does the agent get its own command for it, sent as a typed one
// (Claude Code's /limit-reset; Codex's /usage, where Codex asks which reset to use and to confirm). Agentrix itself never
// calls a reset. Closing the pane or switching terminals cancels the countdown.
const COUNTDOWN = 10;
function ResetQuota({ terminal, resets }: { terminal: ProjectTerminal; resets: AgentUsage['resets'] }) {
  const claude = terminal.agent === 'claude', said = useResetsSaid(terminal);
  const left = claude ? said?.left ?? resets?.left ?? null : codexResetCount(terminal.agentUsage, said?.left ?? null);
  const weekly = claude && resets?.kind === 'session', query = terminal.agentUsage?.resetQuery;
  const queryNote = query?.state === 'loading' ? t('正在查询剩余次数…')
    : query?.reason === 'remote' ? t('远程账号暂不支持后台查询')
    : query?.reason === 'provider' ? t('当前接口不提供重置次数')
    : query?.reason === 'scope' ? t('无法确认账号环境，暂不能查询')
    : query?.state === 'error' ? t('查询失败，将自动重试') : t('当前账号或 Codex 版本未提供次数，将自动重试');
  const sessionPercent = terminal.agentUsage?.limits.find(limit => limit.minutes === 300)?.percent;
  const afterLimit = weekly && left !== 0 && sessionPercent != null && sessionPercent < 100;
  const [count, setCount] = useState<number | null>(null), [note, setNote] = useState<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null), fired = useRef(false);
  const command = claude ? '/limit-reset' : '/usage';
  useEffect(() => {
    if (count === null) return;
    // Once per countdown, whatever renders again meanwhile.
    if (count === 0) { setCount(null); if (!fired.current) { fired.current = true; void run(); } return; }
    const timer = window.setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(timer);
  }, [count]);
  useEffect(() => { if (count === COUNTDOWN) cancelButton.current?.focus(); }, [count]);
  useEffect(() => { if (!note) return; const timer = window.setTimeout(() => setNote(null), 8000); return () => clearTimeout(timer); }, [note]);
  const run = async () => {
    // A reading view of this terminal takes it as its own composer would (its popup shows what the agent answers);
    // otherwise it goes into the agent's input as typed.
    const event = new CustomEvent('agentrix:command', { detail: { terminalId: terminal.id, text: command }, cancelable: true });
    const failed = window.dispatchEvent(event) && terminal.sessionId ? await sendToAgent(terminal.id, terminal.sessionId, claude ? 'claude' : 'codex', command) : null;
    setNote(failed ?? (claude ? t('已向 Claude Code 发送 /limit-reset，由它完成重置。') : t('已打开 Codex 的 /usage，在那里选择要用的重置并确认。')));
  };
  // An emergency stop: a red dome in a metal bezel ringed with hazard stripes. Counting down, the seconds take the
  // dome, a red ring runs out around it and the way out sits beside it.
  const counting = count !== null, none = left === 0;
  const start = () => { fired.current = false; setNote(null); setCount(COUNTDOWN); };
  return <div className={`activity-reset${counting ? ' is-counting' : ''}`} role={counting ? 'timer' : undefined} aria-live={counting ? 'polite' : undefined}
    onKeyDown={event => { if (counting && event.key === 'Escape') { event.stopPropagation(); setCount(null); } }}>
    <div className="activity-estop-wrap">
      <button type="button" className="activity-estop" disabled={!counting && (none || !terminal.codexActive)} aria-disabled={counting || undefined}
        aria-label={counting ? t('{seconds} 秒后重置额度', { seconds: count }) : t('重置额度')}
        title={counting ? undefined : afterLimit ? t('5 小时额度用完后可用 · 每周 1 次。会占用每周额度。点击后有 10 秒可以取消，然后由 Claude Code 自己完成重置')
          : weekly ? t('重置 5 小时额度：每周 1 次，会占用每周额度。点击后有 10 秒可以取消，然后由 Claude Code 自己完成重置')
          : t('点击后有 10 秒可以取消，然后由 {agent} 自己完成重置', { agent: claude ? 'Claude Code' : 'Codex' })}
        onClick={counting ? undefined : start}>
        <span className="activity-estop-hazard" aria-hidden="true" />
        <span className="activity-estop-bezel" aria-hidden="true" />
        <span className="activity-estop-dome">{counting ? <b>{count}</b> : <ArrowCounterClockwise size={24} weight="bold" aria-hidden="true" />}</span>
        {counting && <svg className="activity-estop-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="47" pathLength={100} style={{ animationDuration: `${COUNTDOWN}s` }} /></svg>}
      </button>
      <span className="activity-estop-label">{counting ? t('{seconds} 秒后重置', { seconds: count }) : t('重置额度')}</span>
    </div>
    {counting ? <button ref={cancelButton} type="button" className="activity-reset-cancel" onClick={() => setCount(null)}>{t('取消')}</button>
      : <small>{afterLimit ? t('5 小时额度用完后可用 · 每周 1 次')
        : left === null ? weekly ? t('每周可重置 1 次 5 小时额度') : claude ? t('剩余次数未知') : queryNote
        : !claude ? t('剩余 {count} 次', { count: left })
        : none ? said?.again ? t('本周已用，{date} 后可再用', { date: said.again }) : t('没有可用的重置')
        : weekly ? t('本周还可重置 1 次') : t('剩余 {count} 次', { count: left })}</small>}
    {note && <p className="activity-reset-note" role="status">{note}</p>}
  </div>;
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
      </li>
      : <li key={prompt.id} title={prompt.text}><span className="activity-prompt-state">{t('排队中')}</span><p>{prompt.text}</p></li>)}
  </ol>;
}
