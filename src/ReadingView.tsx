import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { CaretDown, CaretRight, CircleNotch, Image as ImageIcon, PaperPlaneRight, Stop, Terminal } from '@phosphor-icons/react';
import type { AgentCommand, ConversationEntry, ProjectTerminal } from './types';
import { actionText, stepVerb } from './ActivityPane';
import { dictateInto } from './voice-input';
import './reading.css';
import { t } from './i18n';

const purifier = createDOMPurify(window);
// Switching to the CLI unmounts the composer; sent messages still belong to that terminal.
const history = new Map<string, string[]>();
// What the agent wrote, laid out as Markdown. Only plain structure survives: no raw HTML, no images (an
// answer has no business loading anything), and links open outside through the window's link handler.
function render(text: string) {
  const html = purifier.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), {
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
  }
  return root.innerHTML;
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => { try { return render(text); } catch { return null; } }, [text]);
  if (html === null) return <p className="reading-plain">{text}</p>;
  return <div className="reading-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

type Block = { kind: 'message'; entry: ConversationEntry } | { kind: 'tools'; id: string; entries: ConversationEntry[] };
// Tool calls that follow one another fold into one group between the messages around them.
function blocks(entries: ConversationEntry[]): Block[] {
  const result: Block[] = [];
  for (const entry of entries) {
    const last = result.at(-1);
    if (entry.role === 'tool') { if (last?.kind === 'tools') last.entries.push(entry); else result.push({ kind: 'tools', id: entry.id, entries: [entry] }); }
    else result.push({ kind: 'message', entry });
  }
  return result;
}

function ToolGroup({ entries, live }: { entries: ConversationEntry[]; live: boolean }) {
  const running = entries.some(entry => !entry.tool?.done);
  const [open, setOpen] = useState(false);
  const failed = entries.filter(entry => entry.tool?.failed).length;
  const shown = open || (live && running);
  return <div className={`reading-tools ${running ? 'is-running' : ''}`}>
    <button type="button" className="reading-tools-head" aria-expanded={shown} onClick={() => setOpen(!open)}>
      {running ? <CircleNotch size={13} className="loading-spinner" /> : shown ? <CaretDown size={12} /> : <CaretRight size={12} />}
      <span>{entries.length === 1 ? actionText(entries[0].tool!) : t('调用了 {count} 个工具', { count: entries.length })}</span>
      {failed > 0 && <em>{t('{count} 个失败', { count: failed })}</em>}
    </button>
    {shown && <ul>{entries.map(entry => <li key={entry.id} className={`${entry.tool!.done ? '' : 'is-running'} ${entry.tool!.failed ? 'is-failed' : ''} reading-tool-${entry.tool!.kind}`}>
      <b>{stepVerb(entry.tool!)}</b><code title={entry.tool!.target}>{entry.tool!.target}</code>{entry.tool!.detail && <small>{entry.tool!.detail}</small>}
    </li>)}</ul>}
  </div>;
}

// The agent's conversation laid out for reading: your prompts, its answers as Markdown with copyable code,
// and its tool calls folded between them. The real terminal stays underneath; what is written here goes to
// it, and the toggle in the card header switches back to it at any time. autoFocus: the card is expanded and
// this is its terminal in use, so the message box takes the keyboard (never a small card's).
export function ReadingView({ terminal, autoFocus, onShowTerminal, onError, onOpenLink }: { terminal: ProjectTerminal; autoFocus: boolean; onShowTerminal: () => void; onError: (message: string) => void; onOpenLink: (target: string) => void }) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [commands, setCommands] = useState<AgentCommand[]>([]), [requested, setRequested] = useState(false);
  const [dismissed, setDismissed] = useState(false), [selection, setSelection] = useState(0);
  const commandLoad = useRef<Promise<AgentCommand[]> | null>(null), historyAt = useRef<number | null>(null), unsent = useRef(''), caret = useRef<number | null>(null);
  // Images pasted for the next message. The agent holds them itself; this only counts them.
  const [images, setImages] = useState(0);
  const scroller = useRef<HTMLDivElement>(null), stick = useRef(true), input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (caret.current !== null) { input.current?.setSelectionRange(caret.current, caret.current); caret.current = null; } });
  useEffect(() => { if (draft.startsWith('/')) setRequested(true); }, [draft]);
  useEffect(() => {
    setCommands([]); commandLoad.current = null;
    if (!requested) return;
    let active = true;
    commandLoad.current = window.projectGrid.terminalCommands(terminal.id).then(result => {
      const next = result.ok ? result.value : [];
      if (active) { setCommands(next); if (!result.ok) onError(result.error); }
      return next;
    });
    return () => { active = false; };
  }, [terminal.id, terminal.agent, requested]);
  const matches = useMemo(() => {
    const query = draft.slice(1).toLowerCase(), name = (command: AgentCommand) => command.name.slice(1).toLowerCase();
    return commands.filter(command => name(command).includes(query)).sort((a, b) => Number(!name(a).startsWith(query)) - Number(!name(b).startsWith(query)));
  }, [commands, draft]);
  const palette = !dismissed && /^\/[^\s]*$/.test(draft), selected = matches[selection];
  const listId = `reading-commands-${terminal.id}`, optionId = (index: number) => `${listId}-${index}`;
  useEffect(() => { setSelection(0); }, [draft, commands]);
  useEffect(() => { if (palette) document.getElementById(optionId(selection))?.scrollIntoView({ block: 'nearest' }); }, [palette, selection]);
  const edit = (value: string) => { setDraft(value); setDismissed(false); historyAt.current = null; };
  const complete = (command: AgentCommand) => {
    caret.current = command.name.length + 1; edit(command.name + ' '); input.current?.focus();
  };
  useEffect(() => {
    let active = true; setEntries([]);
    void window.projectGrid.terminalConversation(terminal.id).then(result => { if (active && result.ok) setEntries(result.value); });
    const off = window.projectGrid.onTerminalConversation(packet => {
      if (packet.id !== terminal.id) return;
      if (packet.list) { setEntries(packet.list); return; }
      setEntries(current => {
        const next = [...current];
        for (const entry of packet.changes || []) { const at = next.findIndex(item => item.id === entry.id); if (at < 0) next.push(entry); else next[at] = entry; }
        return next.slice(-400);
      });
    });
    return () => { active = false; off(); };
  }, [terminal.id, terminal.sessionId]);
  // Follow new output while the reader is at the bottom; leave them where they are when they scrolled up.
  useLayoutEffect(() => { if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [entries]);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [terminal.id, autoFocus]);
  const working = terminal.codexActive && terminal.codexActivity === 'working';
  const agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const grouped = useMemo(() => blocks(entries), [entries]);
  // The CLI recognises slash commands and shell mode from typed keys, not bracketed paste.
  const send = async (text = draft.trim()) => {
    if ((!text && !images) || !terminal.sessionId) return;
    const typed = /^[\/!]/.test(text) && !/[\r\n]/.test(text);
    const available = typed && text.startsWith('/') ? await (commandLoad.current || window.projectGrid.terminalCommands(terminal.id).then(result => result.ok ? result.value : [])) : commands;
    if (text) {
      if (typed) window.projectGrid.writeTerminal(terminal.id, text);
      else {
        const pasted = await window.projectGrid.pasteTerminal(terminal.id, text, terminal.sessionId);
        if (!pasted.ok) { onError(pasted.error); return; }
      }
      history.set(terminal.id, [...(history.get(terminal.id) || []), text].slice(-50));
    }
    edit(''); setImages(0); stick.current = true;
    if (text) await new Promise(resolve => setTimeout(resolve, typed ? 150 : 400));
    window.projectGrid.writeTerminal(terminal.id, '\r');
    if (typed && (text.startsWith('!') || available.find(command => command.name.toLowerCase() === text.split(/\s/)[0].toLowerCase())?.view !== 'reading')) {
      onShowTerminal();
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-terminal-id="${terminal.id}"] .xterm-helper-textarea`)?.focus());
    }
  };
  const sendRef = useRef(send); sendRef.current = send;
  // Dictation into this terminal lands here while the reading view shows: the words appear at the cursor as
  // soon as they are recognised, and Enter (or the shortcut again) sends the whole message.
  useEffect(() => dictateInto(terminal.id, (text, submit) => {
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
    window.projectGrid.writeTerminal(terminal.id, terminal.agent === 'claude' ? '\x1bv' : '\x16');
    setImages(count => count + 1);
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); window.projectGrid.writeTerminal(terminal.id, '\x1b[Z'); return; }
    if (palette) {
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); if (matches.length) setSelection(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length); return; }
      if (selected && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
        event.preventDefault(); if (event.key === 'Enter' && draft === selected.name) void send(); else complete(selected); return;
      }
    } else {
      if (event.key === 'Escape') { if (working) { event.preventDefault(); window.projectGrid.writeTerminal(terminal.id, '\x1b'); } return; }
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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  let body: ReactNode;
  if (!entries.length) body = <div className="reading-empty"><p>{terminal.codexActive ? t('{agent} 的对话会显示在这里。', { agent }) : t('在终端里启动 Codex 或 Claude Code 后，这里按文档排版显示对话：标题、列表、代码块和工具调用。')}</p><button type="button" className="button secondary small" onClick={onShowTerminal}><Terminal size={14} />{t('切换到终端')}</button></div>;
  else body = grouped.map((block, index) => block.kind === 'tools'
    ? <ToolGroup key={block.id} entries={block.entries} live={index === grouped.length - 1} />
    : block.entry.role === 'user'
      ? <div key={block.entry.id} className="reading-user"><span>{t('你')}</span><p>{block.entry.text}</p></div>
      : <div key={block.entry.id} className="reading-assistant"><Markdown text={block.entry.text || ''} /></div>);
  return <div className="reading-view" onClick={event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy-code]');
    if (button) { const code = button.closest('.reading-code')?.querySelector('pre')?.textContent || ''; void window.projectGrid.copy(code).then(result => { if (result.ok) { button.textContent = t('已复制'); setTimeout(() => { button.textContent = t('复制'); }, 1400); } else onError(result.error); }); return; }
    const link = (event.target as Element).closest<HTMLAnchorElement>('.reading-markdown a');
    if (link) { event.preventDefault(); const href = link.getAttribute('href') || ''; if (href) onOpenLink(href); }
  }}>
    <div className="reading-scroll" ref={scroller} onScroll={event => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; }}>{body}</div>
    <div className={`reading-status ${working ? 'is-working' : ''}`} role="status">
      {terminal.needsInput !== null ? <><span>{t('等待你确认：{message}', { message: terminal.needsInput })}</span><button type="button" className="text-button" onClick={onShowTerminal}>{t('切换到终端')}</button></> : working ? <><CircleNotch size={13} className="loading-spinner" /><span>{terminal.action ? t('正在{step}', { step: actionText(terminal.action) }) : t('{agent} 正在思考', { agent })}</span></> : <span>{terminal.codexActive ? terminal.codexActivity === 'complete' ? t('本轮已完成') : t('等待指令') : t('终端就绪')}</span>}
    </div>
    {images > 0 && <div className="reading-attachments" role="status"><ImageIcon size={14} />{t('已附加 {count} 张图片，随下一条消息发送', { count: images })}</div>}
    <div className="reading-composer">
      {palette && <div className="dropdown reading-commands" id={listId} role="listbox" aria-label={t('命令')}>{matches.map((command, index) => <div key={command.name} id={optionId(index)} role="option" aria-selected={selection === index} className="reading-command" onMouseDown={event => event.preventDefault()} onClick={() => complete(command)}>
        <code>{command.name}</code><span>{command.source === 'builtin' ? t(command.description) : command.description}</span>{command.source !== 'builtin' && <small>{command.source === 'project' ? t('项目') : command.source === 'user' ? t('用户') : t('技能')}</small>}
      </div>)}</div>}
      <textarea ref={input} rows={1} onPaste={pasteImage} aria-label={t('给 {agent} 的消息', { agent })} aria-expanded={palette} aria-controls={palette ? listId : undefined} aria-activedescendant={palette && selected ? optionId(selection) : undefined} placeholder={terminal.codexActive ? t('给 {agent} 发消息，/ 查看命令，Enter 发送，Shift+Enter 换行', { agent }) : t('输入命令，Enter 发送')} value={draft} onChange={event => edit(event.target.value)} onKeyDown={keys}
        onFocus={() => window.projectGrid.terminalFocus(terminal.id, false)} />
      {working && <button type="button" className="icon-button" title={t('中断（Esc）')} aria-label={t('中断（Esc）')} onClick={() => window.projectGrid.writeTerminal(terminal.id, '\x1b')}><Stop size={15} weight="fill" /></button>}
      <button type="button" className="icon-button reading-send" title={t('发送')} aria-label={t('发送')} disabled={(!draft.trim() && !images) || !terminal.sessionId} onClick={() => void send()}><PaperPlaneRight size={15} weight="fill" /></button>
    </div>
  </div>;
}
