import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { readingMarked } from './markdown-escape';
import createDOMPurify from 'dompurify';
import { ArrowDown, CaretDown, CaretUp, CheckCircle, CircleNotch, FileText, Globe, Image as ImageIcon, MagnifyingGlass, PaperPlaneRight, PencilSimple, Plugs, Robot, Sparkle, Stop, TerminalWindow, Wrench, X, XCircle, type Icon } from '@phosphor-icons/react';
import type { AgentCommand, ConversationEntry, ProjectTerminal } from '../../shared/types';
import { actionText, stepVerb } from '../agents/action-text';
import { dictateInto } from '../voice/voice-input';
import { readScreen, useScreen } from '../terminal/terminal-screen';
import { parseAgentScreen } from '../agents/agent-screen';
import { cliCloseKey, cliDialogShown, cliFooter, cliHistory, cliInputDraft, hasCliInput, isAtPrompt, isCliIdle, isSideConversation } from './cli-panel';
import { ReadingWelcome } from './ReadingWelcome';
import { ReadingChoice } from './ReadingChoice';
import { ReadingQuestion } from './ReadingQuestion';
import { ReadingSessions } from './ReadingSessions';
import { usesSessionPicker } from './reading-sessions';
import { dataUrl, thumbnail } from './image-thumbnail';
import { rememberPicture, withPictures } from './pasted-pictures';
import { useWelcomeStarting } from './reading-welcome';
import { ReadingCliPanel } from './ReadingCliPanel';
import { ReadingSignIn } from './ReadingSignIn';
import { signInScreen } from '../agents/sign-in-screen';
import { useReadingCli } from './useReadingCli';
import { choiceIdentity } from './choice-keys';
import { setChoiceVisible } from './reading-mode';
import { useStickToBottom } from './useStickToBottom';
import { conversationKey, useReadingConversation } from './useReadingConversation';
import { blocks, useVisibleTail } from './useVisibleTail';
import './reading.css';
import './reading-flow.css';
import { currentLanguage, t } from '../../shared/i18n';
import { useMentions } from './useMentions';
import { parseMarkdown, parsedMarkdown } from './markdown-parse';
import { MentionPalette } from './MentionPalette';
import { isTypedCommand, sameMessage, type PendingPrompt } from './pending-prompts';
import { usePendingPrompts } from './usePendingPrompts';
import { PendingPromptEntries, UserAvatar, UserImages, UserMessage } from './PendingPromptEntries';
import { AgentSettingsTag } from './AgentSettingsTag';
import { AgentCommandRun } from './AgentCommandRun';
import { FileCards, previewable } from './FileCards';
import { replyFiles } from './reply-files';
import { onComposerPrefill } from './composer-prefill';
import { showPopup } from '../files/file-popup';

const purifier = createDOMPurify(window);
// Switching to the CLI unmounts the composer; sent messages still belong to that terminal.
const history = new Map<string, string[]>();
// The entries on screen when /clear (or Codex's /new) was sent from here, per conversation. The agent starts a new
// conversation at once, but its file only appears with the next message; until then these stay hidden.
const cleared = new Map<string, ReadonlySet<string>>();
const clears = (agent: ProjectTerminal['agent'], text: string) => (agent === 'claude' ? /^\/clear(?:\s|$)/ : /^\/(?:clear|new)(?:\s|$)/).test(text.trim());
// A Markdown block the agent shows (a file's content, a draft) is laid out like the answer around it, its source a
// click away; inside it, Markdown blocks stay source. A very long one stays source too: this runs on the window's thread.
const DOCUMENT = /^(?:markdown|md|mdx)$/i, DOCUMENT_LIMIT = 20000;
// What the agent wrote, laid out as Markdown. Only plain structure survives: no raw HTML, no images (an
// answer has no business loading anything), and links open outside through the window's link handler.
function finish(parsed: string, nested = false): string {
  const html = purifier.sanitize(parsed, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr', 'br', 'em', 'strong', 's', 'del', 'input', 'kbd'],
    ALLOWED_ATTR: ['href', 'class', 'type', 'checked', 'disabled', 'start', 'align'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const root = document.createElement('div'); root.innerHTML = html;
  for (const box of root.querySelectorAll('input')) { box.type = 'checkbox'; box.disabled = true; }
  // Each code block gets a copy button over its top right corner.
  for (const pre of root.querySelectorAll('pre')) {
    const frame = document.createElement('div'); frame.className = 'reading-code';
    const language = pre.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1];
    const bar = document.createElement('div'); bar.className = 'reading-code-bar';
    bar.innerHTML = `<span></span><button type="button" data-copy-code>${t('复制')}</button>`;
    bar.querySelector('span')!.textContent = language || '';
    pre.replaceWith(frame); frame.append(bar, pre);
    const source = pre.textContent || '';
    if (nested || !language || !DOCUMENT.test(language) || !source.trim() || source.length > DOCUMENT_LIMIT) continue;
    const doc = document.createElement('div'); doc.className = 'reading-code-doc';
    doc.innerHTML = finish(readingMarked.parse(source) as string, true);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.codeSource = ''; toggle.textContent = t('源码');
    bar.querySelector('span')!.textContent = 'Markdown';
    bar.insertBefore(toggle, bar.querySelector('[data-copy-code]'));
    frame.classList.add('is-document'); frame.insertBefore(doc, pre);
  }
  return root.innerHTML;
}

const safely = (make: () => string) => { try { return make(); } catch { return null; } };
// Short answers are parsed here at once. A long one is parsed in a worker (markdown-parse): until it is ready the
// previous version stays (an answer still streaming) or the text shows plain, and a parse that takes too long leaves
// it plain rather than freezing the window. One parse per answer runs at a time, always of its latest text.
const QUICK = 4000;
export function Markdown({ text }: { text: string }) {
  const language = currentLanguage(), short = text.length <= QUICK;
  const quick = useMemo(() => short ? safely(() => finish(readingMarked.parse(text) as string)) : undefined, [text, language, short]);
  const [long, setLong] = useState<{ text: string; parsed: string | null } | null>(() => {
    const parsed = short ? undefined : parsedMarkdown(text);
    return parsed === undefined ? null : { text, parsed };
  });
  const target = useRef(text), pumping = useRef(false), alive = useRef(true);
  target.current = text;
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (short || pumping.current) return;
    pumping.current = true;
    void (async () => {
      let value = target.current;
      while (alive.current) {
        const parsed = await parseMarkdown(value);
        if (!alive.current) break;
        setLong({ text: value, parsed });
        if (target.current === value || target.current.length <= QUICK) break;
        value = target.current;
      }
      pumping.current = false;
    })();
  }, [text, short]);
  const html = useMemo(() => short ? quick : long?.parsed == null ? null : safely(() => finish(long.parsed!)), [short, quick, long, language]);
  if (html == null || (!short && long?.parsed === null && long.text === text)) return <p className="reading-plain">{text}</p>;
  return <div className="reading-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

// A picture the agent generated, shown where it answered; a click shows it full size in a popup.
function GeneratedImage({ src, path, prompt }: { src: string; path: string; prompt: string }) {
  const open = () => showPopup({ kind: 'image', path });
  return <figure className="reading-generated">
    <button type="button" title={t('打开原图')} aria-label={t('打开原图')} onClick={open}><img src={src} alt={prompt || t('生成的图片')} /></button>
    {prompt && <figcaption title={prompt}>{prompt}</figcaption>}
  </figure>;
}

// A reply, headed by the agent's own mark as its CLI writes it (Claude's ✻, Codex's •), with the local pictures, pages
// and videos it names shown under it (the agents are told they can show one this way: reading-note.cjs).
function AssistantReply({ entry, agent, projectId, onError }: { entry: ConversationEntry; agent: 'claude' | 'codex'; projectId: string; onError: (message: string) => void }) {
  const named = useMemo(() => entry.text ? replyFiles(entry.text) : [], [entry.text]);
  return <div className={`reading-assistant is-${agent}${entry.text ? ' has-mark' : ''}`}>{entry.text ? <><i className="reading-agent-mark" aria-hidden="true">{agent === 'claude' ? '✻' : '•'}</i><Markdown text={entry.text} /></> : null}
    {named.length > 0 && <FileCards projectId={projectId} files={named} renderMarkdown={text => <Markdown text={text} />} onError={onError} quiet />}
    {entry.generated && entry.images?.[0] && <GeneratedImage src={entry.images[0]} {...entry.generated} />}</div>;
}

// Where a generated picture will appear: a bar that keeps moving and the seconds so far, so a picture that takes
// half a minute does not look stuck.
// When each picture began to be drawn, by its step: the card is drawn again as the conversation grows.
const drawingSince = new Map<string, number>();
function ImageProgress({ step }: { step: string }) {
  if (!drawingSince.has(step)) { drawingSince.set(step, Date.now()); if (drawingSince.size > 20) drawingSince.delete(drawingSince.keys().next().value!); }
  const since = drawingSince.get(step)!, [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <div className="reading-generating" role="status">
    <span className="reading-generating-bar" aria-hidden="true"><i /></span>
    <span>{t('正在生成图片… {seconds} 秒', { seconds: Math.max(0, Math.floor((now - since) / 1000)) })}</span><small>{t('通常需要 20–40 秒')}</small>
  </div>;
}

type ConversationEntryTool = NonNullable<ConversationEntry['tool']>;
// What a group of steps did, by kind, in the order the kinds first came: "读取 2 个文件 · 运行 1 条命令".
const GROUP_PARTS: Record<ConversationEntryTool['kind'], string> = {
  read: '读取 {count} 个文件', edit: '编辑 {count} 个文件', command: '运行 {count} 条命令', search: '搜索 {count} 处', web: '访问 {count} 个网页',
  skill: '使用 {count} 个技能', mcp: '调用 {count} 个 MCP 工具', agent: '派出 {count} 个子代理', other: '调用 {count} 个工具',
};
const STEP_ICONS: Record<ConversationEntryTool['kind'], Icon> = { read: FileText, edit: PencilSimple, command: TerminalWindow, search: MagnifyingGlass, web: Globe, skill: Sparkle, mcp: Plugs, agent: Robot, other: Wrench };
export function groupSummary(entries: readonly ConversationEntry[]) {
  const counts = new Map<ConversationEntryTool['kind'], number>();
  // An edit counts the files it changed (its target names them, "a、b"), every other step counts once.
  for (const entry of entries) if (entry.tool) {
    const files = entry.tool.kind === 'edit' ? Math.max(1, entry.tool.written?.length || entry.tool.target.split('、').filter(Boolean).length) : 1;
    counts.set(entry.tool.kind, (counts.get(entry.tool.kind) || 0) + files);
  }
  return [...counts].map(([kind, count]) => t(GROUP_PARTS[kind], { count })).join(' · ');
}

function ToolGroup({ entries, live, projectId, onError }: { entries: ConversationEntry[]; live: boolean; projectId: string; onError: (message: string) => void }) {
  const running = entries.some(entry => !entry.tool?.done);
  const [open, setOpen] = useState(false);
  const failed = entries.filter(entry => entry.tool?.failed).length;
  const shown = open || (live && running);
  // A picture being generated: Codex reports no progress, so the wait is shown as such, with the time it has taken.
  const drawing = entries.find(entry => !entry.tool?.done && /image_?gen/i.test(`${entry.tool?.tool} ${entry.tool?.target}`));
  // The documents, pages and videos these steps finished writing, each once.
  const files = useMemo(() => [...new Set(entries.flatMap(entry => entry.tool?.done && !entry.tool.failed ? entry.tool.written ?? [] : []))].filter(previewable), [entries]);
  const Lead = STEP_ICONS[entries[0]?.tool?.kind ?? 'other'];
  return <div className={`reading-tools${running ? ' is-running' : ''}${shown ? ' is-open' : ''}${failed ? ' has-failed' : ''}`}>
    <button type="button" className="reading-tools-head" aria-expanded={shown} onClick={() => setOpen(!open)}>
      <StepState running={running} failed={failed > 0} />
      <Lead size={16} weight="duotone" className="reading-tools-lead" />
      <span>{groupSummary(entries)}</span>
      {failed > 0 && <em>{t('{count} 个失败', { count: failed })}</em>}
      {shown ? <CaretUp size={13} weight="bold" className="reading-tools-caret" /> : <CaretDown size={13} weight="bold" className="reading-tools-caret" />}
    </button>
    {shown && <ul className="reading-tools-tree">{entries.map(entry => {
      const tool = entry.tool!, Step = STEP_ICONS[tool.kind];
      return <li key={entry.id} className={`${tool.done ? '' : 'is-running'} ${tool.failed ? 'is-failed' : ''} reading-tool-${tool.kind}`}>
        <StepState running={!tool.done} failed={tool.failed} filled />
        <Step size={16} className="reading-tool-icon" />
        <b>{stepVerb(tool)}</b><code title={tool.target}>{tool.target}</code>{tool.detail && <small>{tool.detail}</small>}
      </li>;
    })}</ul>}
    {drawing && <ImageProgress step={drawing.id} />}
    {files.length > 0 && <FileCards projectId={projectId} files={files} renderMarkdown={text => <Markdown text={text} />} onError={onError} />}
  </div>;
}
// A step's state: a ring while it runs, a check when it is done, a cross when it failed.
function StepState({ running, failed, filled = false }: { running: boolean; failed: boolean; filled?: boolean }) {
  if (running) return <CircleNotch size={17} weight="bold" className="reading-step-state is-running loading-spinner" aria-label={t('进行中')} />;
  return failed ? <XCircle size={17} weight="fill" className="reading-step-state is-failed" aria-label={t('失败')} />
    : <CheckCircle size={17} weight={filled ? 'fill' : 'regular'} className="reading-step-state" aria-label={t('已完成')} />;
}

// The agent's conversation laid out for reading: your prompts, its answers as Markdown with copyable code,
// and its tool calls folded between them. The real terminal stays underneath; what is written here goes to
// it, and the toggle in the card header switches back to it at any time. autoFocus: the card is expanded and
// this is its terminal in use, so the message box takes the keyboard (never a small card's).
// The agent at work, as its CLI shows it: a live mark, what it is doing, how long the round has run and how to stop it.
function WorkingLine({ agent, label }: { agent: 'claude' | 'codex'; label: string }) {
  const [started] = useState(() => Date.now()), [now, setNow] = useState(started);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <div className={`reading-status is-working is-${agent}`} role="status">
    <i className="reading-status-mark" aria-hidden="true">{agent === 'claude' ? null : '•'}</i>
    <span>{label}…</span><small>{t('（{seconds} 秒 · Esc 中断）', { seconds: Math.floor((now - started) / 1000) })}</small>
  </div>;
}

export function ReadingView({ projectId, terminal, remote = false, autoFocus, onShowTerminal, onError, onOpenLink }: { projectId: string; terminal: ProjectTerminal; remote?: boolean; autoFocus: boolean; onShowTerminal: () => void; onError: (message: string) => void; onOpenLink: (target: string) => void }) {
  const conversationEntries = useReadingConversation(terminal.id, terminal.sessionId);
  const [hidden, setHidden] = useState(() => cleared.get(conversationKey(terminal.id, terminal.sessionId)));
  useEffect(() => { setHidden(cleared.get(conversationKey(terminal.id, terminal.sessionId))); }, [terminal.id, terminal.sessionId]);
  // What /clear hid stays hidden only while that conversation is the one shown: once the agent has moved to another
  // (its new conversation came in), resuming the old one later shows it again rather than an empty page.
  useEffect(() => {
    if (!hidden || !conversationEntries.length || conversationEntries.some(entry => hidden.has(entry.id))) return;
    cleared.delete(conversationKey(terminal.id, terminal.sessionId)); setHidden(undefined);
  }, [conversationEntries, hidden]);
  const entries = useMemo(() => hidden ? conversationEntries.filter(entry => !hidden.has(entry.id)) : conversationEntries, [conversationEntries, hidden]);
  const { pending, echo, cancelEcho } = usePendingPrompts(terminal.id, terminal.sessionId, entries);
  const visibleEntries = useMemo(() => [...entries, ...pending], [entries, pending]);
  const sendSession = useRef(terminal.sessionId); sendSession.current = terminal.sessionId;
  const visibleScreen = useScreen(terminal.id);
  const screen = useMemo(() => parseAgentScreen(terminal.agent === 'claude' ? 'claude' : 'codex', visibleScreen?.rows ?? []), [terminal.agent, visibleScreen]);
  // The CLI signing in before its input exists (a link to open, a code to paste): a popup, never a stuck welcome.
  const signIn = useMemo(() => {
    const kind = terminal.agent === 'claude' ? 'claude' : 'codex';
    return terminal.codexActive && visibleScreen && !screen.choice && !hasCliInput(kind, visibleScreen.rows, screen) ? signInScreen(kind, visibleScreen.rows) : null;
  }, [terminal.agent, terminal.codexActive, visibleScreen, screen]);
  const choiceKey = screen.choice ? choiceIdentity(screen.choice) : null;
  const [sessionsOpen, setSessionsOpen] = useState(false);
  useEffect(() => { setSessionsOpen(false); }, [terminal.id, terminal.sessionId, terminal.agent]);
  const welcomeIsStarting = useWelcomeStarting(terminal.agentStartedAt, screen);
  const hasChoice = screen.choice !== null || sessionsOpen, choiceVisible = useRef(hasChoice); choiceVisible.current = hasChoice;
  const mounted = useRef(true);
  const choiceHost = useRef<HTMLDivElement>(null), restoreComposer = useRef(false), wasChoice = useRef(false);
  const [draft, setDraft] = useState('');
  const [commands, setCommands] = useState<AgentCommand[]>([]), [requested, setRequested] = useState(false);
  const [dismissed, setDismissed] = useState(false), [selection, setSelection] = useState(0);
  const historyAt = useRef<number | null>(null), unsent = useRef(''), caret = useRef<number | null>(null), sending = useRef(false);
  // A command whose dialog did not close when its popup was put away; the next message closes it first.
  const leftOpen = useRef<string | null>(null);
  // Images pasted for the next message. The agent holds them itself; this only counts them.
  const [images, setImages] = useState<string[]>([]);
  // An SSH project's pictures for the next message: files saved on that computer. Their paths join the message only as
  // it is sent (both CLIs take a picture's path as the picture); the message box shows the words alone.
  const [serverPictures, setServerPictures] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const cli = useReadingCli(terminal.id, terminal.sessionId, terminal.agent === 'claude' ? 'claude' : 'codex', input, autoFocus);
  // A question's own key hint with no card read from it (the question is taller than the view, or its hint wrapped):
  // a message typed here would land in the question, so the box waits and the terminal shows the question instead.
  const unreadQuestion = !screen.choice && !!visibleScreen?.rows.some(row => /\benter to submit (?:answer|all)\b/i.test(row) || /^\s*Enter to select\b.*\bEsc to cancel\b/i.test(row));
  useEffect(() => { if (unreadQuestion && !cli.busy) onShowTerminal(); }, [unreadQuestion, cli.busy]);
  // A slash command never holds the message box; only a question or permission on screen does.
  const inputBlocked = hasChoice || unreadQuestion;
  const conversation = conversationKey(terminal.id, terminal.sessionId);
  const { stuck, unseen, toBottom, ready, holdPosition } = useStickToBottom(scroller, content, visibleEntries, conversation);
  useLayoutEffect(() => { if (caret.current !== null) { input.current?.setSelectionRange(caret.current, caret.current); caret.current = null; } });
  useEffect(() => { if (draft.startsWith('/') || !entries.length) setRequested(true); }, [draft, entries.length]);
  // Capture composer ownership before disabling it; another card's focus must stay where it is.
  if (hasChoice && !wasChoice.current) restoreComposer.current = document.activeElement === input.current || sessionsOpen || document.activeElement?.closest('.reading-cli-panel')?.getAttribute('data-terminal-id') === terminal.id || (cli.busy && autoFocus && document.activeElement === document.body);
  useLayoutEffect(() => {
    setChoiceVisible(terminal.id, hasChoice);
    if (hasChoice) {
      if (restoreComposer.current && (!wasChoice.current || document.activeElement === document.body)) (choiceHost.current?.firstElementChild as HTMLElement | null)?.focus();
    } else if (wasChoice.current) {
      if (restoreComposer.current && document.activeElement === document.body) input.current?.focus();
      restoreComposer.current = false;
    }
    wasChoice.current = hasChoice;
  }, [terminal.id, hasChoice, choiceKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; setChoiceVisible(terminal.id, false);
    };
  }, [terminal.id]);
  useEffect(() => {
    setCommands([]);
    if (!requested) return;
    let active = true;
    void window.agentrix.terminalCommands(terminal.id).then(result => {
      if (active) { setCommands(result.ok ? result.value : []); if (!result.ok) onError(result.error); }
    }).catch(error => { if (active) onError(String(error)); });
    return () => { active = false; };
  }, [terminal.id, terminal.agent, requested]);
  const matches = useMemo(() => {
    const query = draft.slice(1).toLowerCase(), name = (command: AgentCommand) => command.name.slice(1).toLowerCase();
    // The command named exactly comes first (a project's /doc before the built-in /doctor), then those it begins.
    const rank = (command: AgentCommand) => name(command) === query ? 0 : name(command).startsWith(query) ? 1 : 2;
    return commands.filter(command => name(command).includes(query)).sort((a, b) => rank(a) - rank(b));
  }, [commands, draft]);
  // A command recalled from history (↑) is sent as it is: the list stays shut, so ↑ goes on through history.
  const palette = !inputBlocked && !dismissed && historyAt.current === null && /^\/[^\s]*$/.test(draft), selected = matches[selection];
  const listId = `reading-commands-${terminal.id}`, optionId = (index: number) => `${listId}-${index}`;
  useEffect(() => { setSelection(0); }, [draft, commands]);
  useEffect(() => { if (palette) document.getElementById(optionId(selection))?.scrollIntoView({ block: 'nearest' }); }, [palette, selection]);
  const edit = (value: string) => { setDraft(value); setDismissed(false); historyAt.current = null; };
  // Text written for this terminal on the home page waits here for the reader to send it.
  useEffect(() => onComposerPrefill(terminal.id, text => { setDraft(text); setDismissed(true); requestAnimationFrame(() => input.current?.focus()); }), [terminal.id]);
  const complete = (command: AgentCommand) => {
    caret.current = command.name.length + 1; edit(command.name + ' '); input.current?.focus();
  };
  const mentions = useMentions({ projectId, draft, input, disabled: inputBlocked || /^\/[^\s]*$/.test(draft), edit, onError });
  useEffect(() => {
    if (!autoFocus) return;
    if (choiceVisible.current) { restoreComposer.current = true; (choiceHost.current?.firstElementChild as HTMLElement | null)?.focus(); }
    else if (!cli.busy) input.current?.focus();
  }, [terminal.id, autoFocus]);
  // Claude's own screen has the last word: a round its hooks opened without closing (a local slash command) must not
  // keep "thinking" on screen while Claude sits idle at its prompt.
  // It is at its prompt even with an interrupted prompt put back in its input.
  const claudeIdle = terminal.agent === 'claude' && !!visibleScreen && isAtPrompt('claude', visibleScreen.rows, screen);
  const working = terminal.codexActive && terminal.codexActivity === 'working' && !claudeIdle;
  const agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const grouped = useMemo(() => blocks(entries), [entries]);
  const tail = useVisibleTail(grouped, conversation, scroller, stuck, holdPosition);
  // One message at a time: a second Enter while the first is still being pasted waits for nothing and sends nothing.
  const send = async (text = draft.trim(), own = true) => {
    if (sending.current) return;
    sending.current = true;
    try { await deliver(text, own); } catch (error) { if (mounted.current) onError(String(error)); } finally { sending.current = false; }
  };
  // Closes what a command left open and waits for the CLI's input to come back. Keys typed while a dialog is still
  // open land in it: Enter on Claude's /config switches the selected setting, and the dialog stays on its old tab
  // under the new command's name. A dialog that does not close after a few tries is left alone, nothing typed.
  // untilInput: also wait for the input to come back (a message is typed next); putting a popup away needs only the
  // dialog gone.
  const closeDialog = async (agent: 'claude' | 'codex', command?: string, untilInput = true) => {
    const look = (first = false) => {
      const current = readScreen(terminal.id);
      if (!current) return { key: null, closed: true };
      const parsed = parseAgentScreen(agent, current.rows), key = cliCloseKey(agent, current.rows, parsed, first ? command : undefined, cli.panel?.rows);
      return { key, closed: !key && (!untilInput || hasCliInput(agent, current.rows, parsed)) };
    };
    let state = look(true);
    if (!state.key) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (state.key) window.agentrix.writeTerminal(terminal.id, state.key);
      for (let waited = 0; waited < 900 && !(state = look()).closed; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
      if (state.closed) { await new Promise(resolve => setTimeout(resolve, 60)); return true; }
    }
    return false;
  };
  // Escape (or a click beside it) with a command's popup open puts it away at once and closes what the command opened
  // (a dialog, a pager, a side conversation) rather than interrupting the round, pressing again while the dialog only
  // left an inner mode (Claude's /config search). Putting it away never asks anything of the reader: a dialog still
  // open (one that ignores Escape while it loads) is remembered and closed before the next message is typed.
  // A popup being put away closes its dialog in the background; a message sent meanwhile waits for that, so its keys
  // never land in the dialog still closing.
  const closing = useRef<Promise<void> | null>(null);
  const closeCommand = async () => {
    const agentKind = terminal.agent === 'claude' ? 'claude' : 'codex', command = cli.panel?.command ?? '', current = readScreen(terminal.id), busy = cli.busy;
    const key = busy && current ? cliCloseKey(agentKind, current.rows, parseAgentScreen(agentKind, current.rows), command, cli.panel?.rows) : null;
    cli.close();
    // Still in the CLI's input (Claude holds a command there while its hooks run): its dialog may open after this, so
    // the next message looks for it first.
    if (!key) { if (busy) leftOpen.current = command; return; }
    if (key === '\x03') { window.agentrix.writeTerminal(terminal.id, key); return; }
    const work = closeDialog(agentKind, command, false).then(closed => { leftOpen.current = closed ? null : command; });
    closing.current = work;
    await work.finally(() => { if (closing.current === work) closing.current = null; });
  };
  const interrupt = () => window.agentrix.writeTerminal(terminal.id, '\x1b');
  // The CLI recognises slash commands and shell mode from typed keys, not bracketed paste.
  // own: written in the composer here (it is cleared, with its pictures); otherwise a message sent again, which leaves
  // whatever is being written now alone and takes no pictures with it.
  const deliver = async (words: string, own = true) => {
    const attached = own ? images : [], pictures = own ? serverPictures : [];
    const text = pictures.length ? (isTypedCommand(words) ? [words, ...pictures] : [...pictures, words]).filter(Boolean).join(' ') : words;
    if (inputBlocked || (!text && !attached.length) || !terminal.sessionId) return;
    const typed = isTypedCommand(text), sessionId = terminal.sessionId, agentKind = terminal.agent === 'claude' ? 'claude' : 'codex';
    if (closing.current) await closing.current;
    // A command's dialog still open (Claude's /usage, /config) would take this message's keys and Enter: close it first,
    // whether a command of ours opened it or the screen shows one open anyway.
    // In a Codex side conversation a message is part of it: the card stays and nothing is closed. Its messages never
    // reach the main conversation's records, so they get no echo there either.
    const before = readScreen(terminal.id);
    const side = !!cli.panel && isSideConversation(agentKind, cli.panel.command, [...cli.panel.rows, ...before?.rows ?? []]);
    const stray = !side && !!before && cliDialogShown(agentKind, before.rows, parseAgentScreen(agentKind, before.rows));
    if (cli.panel && !cli.busy) cli.close();
    if ((cli.busy || leftOpen.current !== null || stray) && !side) {
      const command = cli.panel?.command ?? leftOpen.current ?? undefined;
      cli.close(); leftOpen.current = null;
      if (!await closeDialog(agentKind, command)) { if (mounted.current) onError(t('命令的对话框没有关闭，请在终端中关闭后再发送。')); return; }
    }
    if (!mounted.current || choiceVisible.current || sendSession.current !== sessionId) return;
    if (usesSessionPicker(terminal, text, remote)) {
      choiceVisible.current = true; restoreComposer.current = document.activeElement === input.current;
      if (own) edit('');
      setSessionsOpen(true); return;
    }
    // What the CLI shows above its input before the command is typed, to tell its output from what was there, and its
    // footer, where a setting the command changes shows.
    const now = readScreen(terminal.id), parsedNow = typed && now ? parseAgentScreen(agentKind, now.rows) : null;
    const shown = now && parsedNow ? cliHistory(agentKind, now.rows, parsedNow) : undefined;
    const footer = now && parsedNow && isCliIdle(agentKind, now.rows, parsedNow) ? cliFooter(parsedNow) : undefined;
    const pendingId = text && !typed && !side ? echo(text, attached) : null;
    if (pendingId) toBottom();
    // Text left in the CLI's own input would be sent along with this message. An earlier message of ours whose Enter
    // was lost goes first, never wiped; anything else (Claude puts an interrupted prompt back there) is cleared with
    // Ctrl+U. With pictures attached it was cleared when the first one was pasted, and Ctrl+U would take them too.
    const left = text && !attached.length ? inputDraft(agentKind) : '';
    // The composer is empty from here: what is written next is the next message, never wiped when this one is typed.
    if (own) { edit(''); setImages([]); setServerPictures([]); }
    // What the message box gives back on Up: the words, never a picture's path.
    const remember = () => { if (words) history.set(terminal.id, [...(history.get(terminal.id) || []), words].slice(-50)); };
    // Sent again while it still waits there: Enter is all it needs.
    if (left && !typed && sameMessage(text, left)) {
      toBottom(); window.agentrix.writeTerminal(terminal.id, '\r'); await submitted(agentKind, text);
      remember();
      return;
    }
    if (left && pending.some(prompt => sameMessage(prompt.text, left))) { window.agentrix.writeTerminal(terminal.id, '\r'); await submitted(agentKind, left); }
    else if (left) { window.agentrix.writeTerminal(terminal.id, '\x15'); await new Promise(resolve => setTimeout(resolve, 60)); }
    if (text) {
      if (typed) window.agentrix.writeTerminal(terminal.id, text);
      else {
        const pasted = await window.agentrix.pasteTerminal(terminal.id, text, terminal.sessionId);
        if (!pasted.ok) {
          if (pendingId) cancelEcho(pendingId);
          // Not sent: the words and pictures come back to the composer unless something new was written there meanwhile.
          if (own && mounted.current && !input.current?.value) { edit(words); setServerPictures(pictures); }
          onError(pasted.error); return;
        }
        if (!mounted.current || choiceVisible.current || sendSession.current !== sessionId) return;
      }
      remember();
    }
    toBottom();
    if (text) await new Promise(resolve => setTimeout(resolve, typed ? 150 : 400));
    if (!mounted.current || choiceVisible.current || sendSession.current !== sessionId) return;
    // A command whose result comes in the conversation (/init, /review, a skill or a saved prompt) gets no popup: the
    // reading view shows its round as it goes. Codex's /side is a conversation of its own and keeps its popup. Codex's
    // resume list shows as a choice of its own.
    const name = text.split(/\s/)[0], listed = commands.find(command => command.name === name);
    const inConversation = typed && (listed?.view === 'reading' && !(agentKind === 'codex' && name === '/side') || agentKind === 'codex' && name === '/resume');
    if (typed && !inConversation) cli.begin(text, shown, footer);
    if (clears(terminal.agent, text)) { const ids = new Set(conversationEntries.map(entry => entry.id)); cleared.set(conversation, ids); setHidden(ids); }
    window.agentrix.writeTerminal(terminal.id, '\r');
    if (text && !typed) await submitted(agentKind, text);
    else if (typed) void commandSubmitted(agentKind, text, sessionId);
  };
  // What is typed in the CLI's own input right now.
  const inputDraft = (agent: 'claude' | 'codex') => { const current = readScreen(terminal.id); return current ? cliInputDraft(agent, current.rows, parseAgentScreen(agent, current.rows)) : ''; };
  // A message is sent once it has left the CLI's input. An Enter the CLI did not take (it arrived while the CLI was
  // busy redrawing, compacting or taking the paste) leaves it there: Enter again, a few times.
  const submitted = async (agent: 'claude' | 'codex', text: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 700));
      if (!mounted.current || choiceVisible.current || !sameMessage(text, inputDraft(agent))) return;
      window.agentrix.writeTerminal(terminal.id, '\r');
    }
  };
  // A command still sitting in the CLI's input after its Enter (one that arrived while the CLI redrew) is entered again,
  // slowly, since Claude keeps a command there for a moment while its hooks run. One that never leaves is reported,
  // and its popup put away, rather than waited on for good.
  const commandSubmitted = async (agent: 'claude' | 'codex', text: string, sessionId: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1600));
      if (!mounted.current || choiceVisible.current || sendSession.current !== sessionId || inputDraft(agent).trim() !== text.trim()) return;
      if (attempt === 0) window.agentrix.writeTerminal(terminal.id, '\r');
    }
    cli.close();
    onError(t('{command} 没有发出去，还留在它的输入框里。', { command: text.split(/\s/)[0] }));
  };
  const sendRef = useRef(send); sendRef.current = send;
  // The safety net: a message no record has shown once its echo timed out, while the agent sits idle, is sent again
  // (twice at most). A user record that came in after it, even worded differently, means it arrived.
  const resent = useRef(new Map<string, number>());
  const [idleSince, setIdleSince] = useState(() => Date.now()), [, setTick] = useState(0);
  useEffect(() => { if (!working) setIdleSince(Date.now()); }, [working]);
  const stalled = pending.filter(prompt => !prompt.sending), idle = !working && !cli.busy && !hasChoice && Date.now() - idleSince >= 5000;
  useEffect(() => {
    if (!stalled.length || working || cli.busy || hasChoice) return;
    const wait = idleSince + 5000 - Date.now();
    if (wait > 0) { const timer = setTimeout(() => setTick(tick => tick + 1), wait + 50); return () => clearTimeout(timer); }
    for (const prompt of stalled) {
      if (entries.some(entry => entry.role === 'user' && entry.at >= prompt.at - 500)) { cancelEcho(prompt.id); continue; }
      const tries = resent.current.get(prompt.text) ?? 0;
      if (tries >= 2 || sending.current) continue;
      resent.current.set(prompt.text, tries + 1);
      cancelEcho(prompt.id); void sendRef.current(prompt.text, false);
      break;
    }
  });
  const undelivered = (prompt: PendingPrompt) => idle && !prompt.sending && (resent.current.get(prompt.text) ?? 0) >= 2;
  const resend = (prompt: PendingPrompt) => { cancelEcho(prompt.id); void send(prompt.text, false); };
  // Dictation into this terminal lands here while the reading view shows: the words appear at the cursor as
  // soon as they are recognised, and Enter (or the shortcut again) sends the whole message.
  useEffect(() => dictateInto(terminal.id, (text, submit) => {
    if (choiceVisible.current) return;
    const node = input.current, value = node?.value ?? '', here = !!node && document.activeElement === node;
    const at = here ? node.selectionStart : value.length, end = here ? node.selectionEnd : value.length;
    const next = value.slice(0, at) + text + value.slice(end);
    if (submit) { void sendRef.current(next.trim()); return; }
    caret.current = at + text.length; edit(next); node?.focus();
  }), [terminal.id]);
  // An image pasted here goes to the agent the way it takes one in its own input: it reads the clipboard on its
  // paste key (Ctrl+V in Codex, Alt+V in Claude Code on Windows) and attaches the image to the next message.
  const pasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    if (data.getData('text/plain') || ![...data.items].some(item => item.kind === 'file' && item.type.startsWith('image/'))) return;
    event.preventDefault();
    if (!terminal.codexActive || !terminal.sessionId) { onError(t('启动 Codex 或 Claude Code 后才能粘贴图片。')); return; }
    // The first picture goes into a clean input: text left there (a prompt Claude put back after an interrupt) would be
    // sent with this message, and once pictures are in it Ctrl+U would take them too. One of ours still waiting stays.
    const agentKind = terminal.agent === 'claude' ? 'claude' : 'codex', left = !images.length && !remote ? inputDraft(agentKind) : '';
    const clearFirst = !!left && !pending.some(prompt => sameMessage(prompt.text, left));
    if (clearFirst) window.agentrix.writeTerminal(terminal.id, '\x15');
    // Over SSH the CLI cannot reach this computer's clipboard: the picture goes over as a file on that computer, whose
    // path joins the message when it is sent (serverPictures).
    if (remote) {
      const file = [...data.items].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
      if (!file) return;
      void file.arrayBuffer().then(bytes => window.agentrix.saveImage(terminal.id, bytes, file.type)).then(saved => {
        if (!saved.ok) { onError(saved.error); return; }
        // The picture shows as itself (in the box above the composer and in the message), never as its long path.
        void thumbnail(file).catch(() => dataUrl(file)).then(small => { rememberPicture(saved.value, small); setPictureTick(tick => tick + 1); }).catch(() => {});
        setServerPictures(list => [...list, saved.value].slice(-4));
      }).catch(error => onError(String(error)));
      return;
    }
    const pasteKey = terminal.agent === 'claude' ? '\x1bv' : '\x16';
    if (clearFirst) setTimeout(() => window.agentrix.writeTerminal(terminal.id, pasteKey), 60);
    else window.agentrix.writeTerminal(terminal.id, pasteKey);
    // The agent takes the picture from the clipboard; a copy is kept here to show in the message, small (a 4K
    // screenshot decoded at full size costs tens of megabytes per copy).
    const file = [...data.items].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { onError(t('图片太大（超过 25 MB），请压缩后再粘贴。')); return; }
    // A picture this window cannot decode still went to the agent: it is listed as it came.
    void thumbnail(file).catch(() => dataUrl(file)).then(small => {
      setImages(list => [...list, small].slice(-4));
    }).catch(() => onError(t('无法读取这张图片。')));
  };
  // The attached pictures wait in the CLI's own input as "[Image #1]" placeholders, which Ctrl+U clears with them.
  // An SSH project's pictures show above the composer by the copies made when they were pasted.
  const [, setPictureTick] = useState(0);
  const shownImages = [...images, ...withPictures(serverPictures.join(' ')).images];
  const attachedCount = images.length + serverPictures.length;
  const removeImages = () => {
    setServerPictures([]);
    if (!images.length) { input.current?.focus(); return; }
    window.agentrix.writeTerminal(terminal.id, '');
    setImages([]); input.current?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); window.agentrix.writeTerminal(terminal.id, '\x1b[Z'); return; }
    if (mentions.keys(event)) return;
    if (palette) {
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); if (matches.length) setSelection(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length); return; }
      if (selected && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
        event.preventDefault(); if (event.key === 'Enter' && draft === selected.name) void send(); else complete(selected); return;
      }
    } else {
      if (event.key === 'Escape') { if (cli.panel || cli.busy) { event.preventDefault(); void closeCommand(); } else if (working) { event.preventDefault(); interrupt(); } return; }
      const node = event.currentTarget, sent = history.get(terminal.id) || [];
      if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && node.selectionStart === node.selectionEnd && ((event.key === 'ArrowUp' && node.selectionStart === 0) || (event.key === 'ArrowDown' && node.selectionEnd === draft.length))) {
        if (event.key === 'ArrowUp' && sent.length) {
          event.preventDefault(); if (historyAt.current === null) { unsent.current = draft; historyAt.current = sent.length; }
          historyAt.current = Math.max(0, historyAt.current - 1); caret.current = 0; setDraft(sent[historyAt.current]);
        } else if (event.key === 'ArrowDown' && historyAt.current !== null) {
          event.preventDefault(); historyAt.current++;
          const next = historyAt.current >= sent.length ? unsent.current : sent[historyAt.current];
          if (historyAt.current >= sent.length) historyAt.current = null;
          caret.current = next.length; setDraft(next);
        } else return;
        node.setSelectionRange(caret.current!, caret.current!);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };
  // What the agent is doing, written at the end of the conversation the way its CLI writes it, never in a corner.
  const status = screen.choice?.kind === 'question' ? <div className="reading-status" role="status">{t('等待你回答问题')}</div>
    // Without a choice to answer here (one the reading view cannot lay out), the terminal is a click away.
    : terminal.needsInput !== null ? <div className="reading-status" role="status"><span>{t('等待你确认：{message}', { message: terminal.needsInput })}</span>
      {!screen.choice && <button type="button" className="text-button" onClick={onShowTerminal}>{t('切换到终端')}</button>}</div>
    : working || pending.some(prompt => prompt.sending) ? <WorkingLine key={terminal.sessionId} agent={terminal.agent === 'claude' ? 'claude' : 'codex'} label={terminal.action ? t('正在{step}', { step: actionText(terminal.action) }) : t('{agent} 正在思考', { agent })} />
    : null;
  let body: ReactNode;
  // A run of the CLI that is no conversation (codex update): what it does and what it prints, no message box.
  if (terminal.agentCommand) body = <AgentCommandRun agent={terminal.agent === 'claude' ? 'claude' : 'codex'} command={terminal.agentCommand} rows={visibleScreen?.rows ?? []} onShowTerminal={onShowTerminal} />;
  else if (!entries.length && !pending.length) body = <ReadingWelcome agent={terminal.agent === 'claude' ? 'claude' : 'codex'} commands={commands} complete={complete} disabled={inputBlocked}
    screen={screen} starting={welcomeIsStarting} />;
  else body = <>
    {tail.earlier > 0 && <button type="button" className="text-button reading-earlier" onClick={tail.showEarlier}>{t('显示更早的对话（{count}）', { count: tail.earlier })}</button>}
    {tail.visible.map((block, index) => block.kind === 'tools'
    ? <ToolGroup key={block.id} entries={block.entries} live={index === tail.visible.length - 1} projectId={projectId} onError={onError} />
    : block.entry.role === 'user'
      ? <div key={block.entry.id} className={`reading-user${block.entry.answer ? ' is-answer' : ''}`}><UserAvatar />
        {block.entry.answer && <span className="reading-user-label">{t('你回答了它的问题')}</span>}<UserMessage text={block.entry.text || ''} images={block.entry.images} /></div>
      : <AssistantReply key={block.entry.id} entry={block.entry} agent={terminal.agent === 'claude' ? 'claude' : 'codex'} projectId={projectId} onError={onError} />)}
  </>;
  return <div className="reading-view" onClick={event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy-code]');
    const toggle = (event.target as Element).closest<HTMLButtonElement>('[data-code-source]');
    if (toggle) { const source = toggle.closest('.reading-code')!.classList.toggle('is-source'); toggle.textContent = t(source ? '预览' : '源码'); return; }
    if (button) { const code = button.closest('.reading-code')?.querySelector(':scope > pre')?.textContent || ''; void window.agentrix.copy(code).then(result => { if (result.ok) { button.textContent = t('已复制'); setTimeout(() => { button.textContent = t('复制'); }, 1400); } else onError(result.error); }); return; }
    const link = (event.target as Element).closest<HTMLAnchorElement>('.reading-markdown a');
    if (link) { event.preventDefault(); const href = link.getAttribute('href') || ''; if (href) onOpenLink(href); }
  }}>
    <div className="reading-scroll-area">
      <div className="reading-scroll" ref={scroller} tabIndex={0}><div className="reading-content" ref={content} style={{ visibility: entries.length && !ready ? 'hidden' : undefined }}>{body}<PendingPromptEntries prompts={pending} undelivered={undelivered} onResend={resend} onDiscard={prompt => cancelEcho(prompt.id)} />
        {status}</div></div>
      {signIn && <ReadingSignIn agent={terminal.agent === 'claude' ? 'claude' : 'codex'} screen={signIn} terminalId={terminal.id} projectId={projectId} onError={onError} />}
      {!screen.choice && !sessionsOpen && !signIn && cli.panel && <ReadingCliPanel command={cli.panel.command} rows={cli.panel.rows} done={!!cli.panel.done} terminalId={terminal.id} onClose={() => { void closeCommand(); input.current?.focus(); }} onShowTerminal={onShowTerminal} />}
      {!stuck && <div className="reading-latest">
        {unseen > 0 && <span className="reading-unseen" role="status">{t('{count} 条新消息', { count: unseen })}</span>}
        <button type="button" className="icon-button reading-jump" title={t('跳到最新消息')} aria-label={t('跳到最新消息')} onClick={() => toBottom('smooth')}><ArrowDown size={18} /></button>
      </div>}
    </div>
    {attachedCount > 0 && <div className="reading-attachments" role="status"><ImageIcon size={14} />{t('已附加 {count} 张图片，随下一条消息发送', { count: attachedCount })}<UserImages images={shownImages} />
      <button type="button" className="reading-attachments-remove" onClick={removeImages} title={t('移除图片')} aria-label={t('移除图片')}><X size={12} weight="bold" /></button></div>}
    {screen.choice && !sessionsOpen && <div className="reading-choice-host" ref={choiceHost} onFocusCapture={() => { restoreComposer.current = true; }} onBlurCapture={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) restoreComposer.current = false;
    }}>{screen.choice.kind === 'question'
      ? <ReadingQuestion key={choiceKey} choice={screen.choice} terminalId={terminal.id} onError={onError} />
      : <ReadingChoice key={choiceKey} choice={screen.choice} terminalId={terminal.id} onError={onError} />}</div>}
    {sessionsOpen && <div className="reading-choice-host" ref={choiceHost} onFocusCapture={() => { restoreComposer.current = true; }} onBlurCapture={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) restoreComposer.current = false;
    }}><ReadingSessions key={`${terminal.id}-${terminal.sessionId}`} terminalId={terminal.id} agent={terminal.agent === 'codex' ? 'codex' : 'claude'} onError={onError} onClose={() => setSessionsOpen(false)} onSent={text => {
      history.set(terminal.id, [...(history.get(terminal.id) || []), text].slice(-50)); setImages([]); toBottom();
    }} /></div>}
    {/* The command list is part of the page, above the message box, not a popup over the conversation. */}
    {palette && <div className="reading-commands is-inline" id={listId} role="listbox" aria-label={t('命令')}>{matches.map((command, index) => <div key={command.name} id={optionId(index)} role="option" aria-selected={selection === index} className="reading-command" onMouseDown={event => event.preventDefault()} onClick={() => complete(command)}>
        <code>{command.name}</code><span>{command.source === 'builtin' ? t(command.description) : command.description}</span>{command.source !== 'builtin' && <small>{command.source === 'project' ? t('项目') : command.source === 'user' ? t('用户') : t('技能')}</small>}
    </div>)}</div>}
    <div className="reading-composer" style={terminal.agentCommand ? { display: 'none' } : undefined}>
      {terminal.codexActive && <AgentSettingsTag settings={terminal.agentSettings} status={screen.status} />}
      <MentionPalette mentions={mentions} />
      <textarea ref={input} rows={1} disabled={inputBlocked} onPaste={pasteImage} onSelect={mentions.trackCaret} aria-label={t('给 {agent} 的消息', { agent })} aria-expanded={palette || mentions.open} aria-controls={palette ? listId : mentions.open ? mentions.listId : undefined} aria-activedescendant={palette && selected ? optionId(selection) : mentions.open && mentions.files[mentions.selection] ? mentions.optionId(mentions.selection) : undefined} placeholder={terminal.codexActive ? t('给 {agent} 发消息，/ 查看命令，@ 提及文件，Enter 发送，Shift+Enter 换行', { agent }) : t('输入命令，Enter 发送')} value={draft} onChange={event => edit(event.target.value)} onKeyDown={keys}
        onFocus={() => window.agentrix.terminalFocus(terminal.id, false)} />
      {working && <button type="button" className="icon-button" disabled={inputBlocked} title={t('中断（Esc）')} aria-label={t('中断（Esc）')} onClick={interrupt}><Stop size={15} weight="fill" /></button>}
      <button type="button" className="icon-button reading-send" title={t('发送')} aria-label={t('发送')} disabled={inputBlocked || (!draft.trim() && !attachedCount) || !terminal.sessionId} onClick={() => void send()}><PaperPlaneRight size={15} weight="fill" /></button>
    </div>
  </div>;
}
