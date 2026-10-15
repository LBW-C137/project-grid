import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ArrowUp, File, FileText, FilmStrip, Folder, Globe, Image as ImageIcon, SpinnerGap, X } from '@phosphor-icons/react';
import type { DirectoryListing, FilePreview as Preview } from '../../shared/types';
import { TextContent } from './FilePreview';
import { closePopup, showPopup, type PopupTarget } from './file-popup';
import { t } from '../../shared/i18n';
import './file-popup.css';
const MarkdownPreview = lazy(() => import('./MarkdownPreview').then(module => ({ default: module.MarkdownPreview })));

type Shown = { kind: 'preview'; preview: Preview } | { kind: 'picture'; url: string } | { kind: 'folder'; listing: DirectoryListing } | { kind: 'document'; content: string } | { kind: 'error'; message: string };

// A page, document, picture, video or folder shown over the current view, read only: Escape, the close button or a
// click beside it puts it away. A link inside a document, or an entry of a folder, opens the same way; a web address
// opens outside.
export function FilePopup({ target, onError }: { target: PopupTarget; onError: (message: string) => void }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const fileName = target.path.split(/[\\/]/).filter(Boolean).at(-1) || target.path;
  const name = target.kind === 'folder' && !target.path ? t('项目根目录') : fileName;
  useEffect(() => {
    let live = true, previewId: string | null = null;
    setShown(null);
    const read: Promise<Shown> = target.kind === 'picture' ? Promise.resolve({ kind: 'picture' as const, url: target.src })
      : target.kind === 'image'
      ? window.agentrix.agentImage(target.path).then(result => result.ok ? { kind: 'picture' as const, url: result.value.url } : { kind: 'error' as const, message: result.error })
      : target.kind === 'folder'
      ? window.agentrix.listDirectory(target.projectId, target.path).then(result => result.ok ? { kind: 'folder' as const, listing: result.value } : { kind: 'error' as const, message: result.error })
      : target.kind === 'document'
      ? window.agentrix.agentDocument(target.projectId, target.path).then(result => result.ok ? { kind: 'document' as const, content: result.value.truncated ? `${result.value.content}\n\n…` : result.value.content } : { kind: 'error' as const, message: result.error })
      : window.agentrix.readFile(target.projectId, target.path).then(result => {
        if (!result.ok) return { kind: 'error' as const, message: result.error };
        if ('previewId' in result.value) previewId = result.value.previewId;
        return { kind: 'preview' as const, preview: result.value };
      });
    void read.catch(() => ({ kind: 'error' as const, message: '无法预览此文件。' })).then(value => {
      if (live) setShown(value); else if (previewId) void window.agentrix.closePreview(previewId);
    });
    return () => { live = false; if (previewId) void window.agentrix.closePreview(previewId); };
  }, [target]);
  // Escape here never reaches the conversation behind it (where it would interrupt the agent).
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    card.current?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopup(); } };
    window.addEventListener('keydown', keys, true);
    return () => { window.removeEventListener('keydown', keys, true); if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);
  const openLink = (link: string) => {
    if (target.kind === 'image' || target.kind === 'picture') return;
    const projectId = target.projectId;
    void window.agentrix.openLink(projectId, link).then(result => {
      if (!result.ok) onError(result.error);
      else if (result.value.kind !== 'external') showPopup({ kind: result.value.kind === 'file' ? 'file' : 'folder', projectId, path: result.value.path });
    });
  };
  const parent = target.kind === 'folder' && target.path ? target.path.split('/').slice(0, -1).join('/') : null;
  const preview = shown?.kind === 'preview' ? shown.preview : null;
  const Icon = target.kind === 'folder' ? Folder : target.kind === 'image' || target.kind === 'picture' || preview?.kind === 'image' ? ImageIcon : preview?.kind === 'video' ? FilmStrip : preview?.kind === 'html' ? Globe : FileText;
  let body: ReactNode;
  if (!shown) body = <div className="file-popup-message"><SpinnerGap size={22} className="loading-spinner" />{t('正在读取文件…')}</div>;
  else if (shown.kind === 'error') body = <div className="file-popup-message" role="status"><Icon size={28} /><p>{t(shown.message)}</p></div>;
  else if (shown.kind === 'folder' && target.kind === 'folder') body = <div className="file-popup-folder" role="list">
    {parent !== null && <button type="button" role="listitem" onClick={() => showPopup({ ...target, path: parent })}><ArrowUp size={15} />{t('上一级')}</button>}
    {shown.listing.entries.map(entry => <button type="button" role="listitem" key={entry.path} title={entry.path}
      onClick={() => entry.kind === 'link' ? openLink(entry.path) : showPopup({ kind: entry.kind === 'directory' ? 'folder' : 'file', projectId: target.projectId, path: entry.path })}>
      {entry.kind === 'directory' ? <Folder size={15} weight="fill" /> : <File size={15} />}{entry.name}</button>)}
    {!shown.listing.entries.length && <p className="file-popup-message">{t('这个文件夹是空的。')}</p>}
  </div>;
  // Only its web links work: it has no folder of its own here for relative links and pictures to come from.
  else if (shown.kind === 'document') body = <div className="file-popup-document"><Suspense fallback={<div className="file-popup-message">{t('正在渲染 Markdown…')}</div>}><MarkdownPreview content={shown.content} baseUrl="about:blank" onOpenLink={openLink} /></Suspense></div>;
  else if (shown.kind === 'picture') body = <Picture url={shown.url} name={fileName} />;
  else if (preview?.kind === 'image') body = <Picture url={preview.url} name={fileName} />;
  else if (preview?.kind === 'html') body = <iframe className="html-preview-frame" title={t('HTML 页面预览')} src={preview.url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />;
  else if (preview?.kind === 'markdown') body = <div className="file-popup-document"><Suspense fallback={<div className="file-popup-message">{t('正在渲染 Markdown…')}</div>}><MarkdownPreview content={preview.content} baseUrl={preview.url} onOpenLink={openLink} /></Suspense></div>;
  else if (preview?.kind === 'video') body = <div className="file-popup-video"><video src={preview.url} controls autoPlay preload="metadata" playsInline aria-label={t('视频预览')} /></div>;
  else if (preview?.kind === 'text') body = <TextContent content={preview.content} />;
  else body = <div className="file-popup-message"><FileText size={28} /><p>{preview?.kind === 'unsupported' ? t(preview.reason) : t('无法预览此文件。')}</p></div>;
  const wide = preview?.kind === 'html' || preview?.kind === 'text' || preview?.kind === 'markdown' || shown?.kind === 'document';
  const picture = shown?.kind === 'picture' || preview?.kind === 'image';
  return <div className="file-popup-overlay" onMouseDown={event => { if (event.target === event.currentTarget) closePopup(); }}>
    <div ref={card} className={`file-popup${wide ? ' is-wide' : ''}${picture ? ' is-picture' : ''}`} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
      <div className="file-popup-head"><Icon size={15} /><strong title={target.path}>{name}</strong><small>{t('Esc 关闭')}</small>
        <button type="button" className="icon-button" title={t('关闭')} aria-label={t('关闭')} onClick={closePopup}><X size={15} /></button></div>
      <div className="file-popup-body">{body}</div>
    </div>
  </div>;
}

// A picture fits the window whole. One larger than that shows at its own size on a click, at the spot clicked; there
// the mouse drags it about, and another click fits it again.
function Picture({ url, name }: { url: string; name: string }) {
  const [full, setFull] = useState(false), [larger, setLarger] = useState(false);
  const box = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null);
  const focus = useRef<{ x: number; y: number; at: { x: number; y: number } } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  // Whether the window shows it smaller than it is, measured while it fits.
  const measure = () => { const img = image.current; if (img && !full) setLarger(img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1); };
  useEffect(() => { if (full) return; measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }, [full]);
  // At its own size, the point clicked stays under the pointer.
  useLayoutEffect(() => {
    const spot = focus.current, view = box.current, img = image.current; focus.current = null;
    if (!full || !spot || !view || !img) return;
    const frame = view.getBoundingClientRect();
    view.scrollLeft = spot.x * img.naturalWidth - (spot.at.x - frame.left);
    view.scrollTop = spot.y * img.naturalHeight - (spot.at.y - frame.top);
  }, [full]);
  const press = (event: ReactMouseEvent) => {
    if (event.button !== 0 || !box.current) return;
    event.preventDefault();
    drag.current = { x: event.clientX, y: event.clientY, left: box.current.scrollLeft, top: box.current.scrollTop, moved: false };
    const move = (moving: MouseEvent) => {
      const start = drag.current, view = box.current; if (!start || !view) return;
      if (Math.abs(moving.clientX - start.x) + Math.abs(moving.clientY - start.y) > 4) start.moved = true;
      if (full && start.moved) { view.scrollLeft = start.left - (moving.clientX - start.x); view.scrollTop = start.top - (moving.clientY - start.y); }
    };
    const release = (released: MouseEvent) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', release);
      const start = drag.current; drag.current = null;
      if (!start || start.moved || !(full || larger)) return;
      const img = image.current?.getBoundingClientRect();
      if (!full && img) focus.current = { x: (released.clientX - img.left) / img.width, y: (released.clientY - img.top) / img.height, at: { x: released.clientX, y: released.clientY } };
      setFull(!full);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', release);
  };
  const hint = full ? t('拖动查看，单击缩小到窗口大小') : larger ? t('单击查看原始大小') : undefined;
  return <div ref={box} className={`file-popup-picture${full ? ' is-full' : larger ? ' is-larger' : ''}`} title={hint} onMouseDown={press}>
    <img ref={image} src={url} alt={name} draggable={false} onLoad={measure} />
  </div>;
}
