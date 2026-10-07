import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { CaretDown, CaretRight, CircleNotch, PaperPlaneRight, Stop, Terminal } from '@phosphor-icons/react';
import type { ConversationEntry, ProjectTerminal } from './types';
import { actionText, stepVerb } from './ActivityPane';
import './reading.css';
import { t } from './i18n';

const purifier = createDOMPurify(window);
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
// it, and the toggle in the card header switches back to it at any time.
export function ReadingView({ terminal, onShowTerminal, onError, onOpenLink }: { terminal: ProjectTerminal; onShowTerminal: () => void; onError: (message: string) => void; onOpenLink: (target: string) => void }) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null), stick = useRef(true), input = useRef<HTMLTextAreaElement>(null);
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
  useEffect(() => { input.current?.focus(); }, [terminal.id]);
  const working = terminal.codexActive && terminal.codexActivity === 'working';
  const agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const grouped = useMemo(() => blocks(entries), [entries]);
  // Sent the way dictation sends: pasted as one piece, then Enter once the paste has landed.
  const send = async () => {
    const text = draft.trim(); if (!text || !terminal.sessionId) return;
    const pasted = await window.projectGrid.pasteTerminal(terminal.id, text, terminal.sessionId);
    if (!pasted.ok) { onError(pasted.error); return; }
    setDraft(''); stick.current = true;
    await new Promise(resolve => setTimeout(resolve, 400));
    window.projectGrid.writeTerminal(terminal.id, '\r');
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
      {working ? <><CircleNotch size={13} className="loading-spinner" /><span>{terminal.action ? t('正在{step}', { step: actionText(terminal.action) }) : t('{agent} 正在思考', { agent })}</span></> : <span>{terminal.codexActive ? terminal.codexActivity === 'complete' ? t('本轮已完成') : t('等待指令') : t('终端就绪')}</span>}
    </div>
    <div className="reading-composer">
      <textarea ref={input} rows={1} aria-label={t('给 {agent} 的消息', { agent })} placeholder={terminal.codexActive ? t('给 {agent} 发消息，Enter 发送，Shift+Enter 换行', { agent }) : t('输入命令，Enter 发送')} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={keys}
        onFocus={() => window.projectGrid.terminalFocus(terminal.id, false)} />
      {working && <button type="button" className="icon-button" title={t('中断（Esc）')} aria-label={t('中断（Esc）')} onClick={() => window.projectGrid.writeTerminal(terminal.id, '\x1b')}><Stop size={15} weight="fill" /></button>}
      <button type="button" className="icon-button reading-send" title={t('发送')} aria-label={t('发送')} disabled={!draft.trim() || !terminal.sessionId} onClick={() => void send()}><PaperPlaneRight size={15} weight="fill" /></button>
    </div>
  </div>;
}
