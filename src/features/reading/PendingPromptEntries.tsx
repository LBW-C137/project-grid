import { useLayoutEffect, useRef, useState } from 'react';
import { User } from '@phosphor-icons/react';
import type { PendingPrompt } from './pending-prompts';
import { withPictures } from './pasted-pictures';
import { showPopup } from '../files/file-popup';
import { t } from '../../shared/i18n';
import './pending-prompts.css';

// What the user wrote, folded to three lines when it runs longer (a pasted log, a long brief), with a button to read
// all of it. Whether it runs longer is measured on the laid-out text, so a long line that wraps counts too.
// Your messages are headed by a person, the agent's by its own mark.
export function UserAvatar() {
  return <span className="reading-user-avatar" role="img" aria-label={t('你')}><User size={15} weight="fill" /></span>;
}

export function UserText({ text }: { text: string }) {
  const node = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false), [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = node.current; if (!element) return;
    const measure = () => { if (!element.classList.contains('is-folded')) return; setLong(element.scrollHeight > element.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return <>
    <p ref={node} className={open ? undefined : 'is-folded'}>{text}</p>
    {(long || open) && <button type="button" className="text-button reading-user-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('收起') : t('展开全文')}</button>}
  </>;
}

// The pictures a message carried, small, under its text.
// A message's words and pictures; the path of a picture pasted for an SSH project shows as that picture.
export function UserMessage({ text, images }: { text: string; images?: readonly string[] }) {
  const shown = withPictures(text, images);
  return <>{shown.text && <UserText text={shown.text} />}{shown.images.length > 0 && <UserImages images={shown.images} />}</>;
}

// A click shows the picture larger, in the popup over the conversation.
export function UserImages({ images }: { images: readonly string[] }) {
  return <div className="reading-user-images">{images.map((src, index) => {
    const name = t('附加的图片 {n}', { n: index + 1 });
    return <button type="button" key={index} title={t('点击放大')} aria-label={t('放大 {name}', { name })} onClick={() => showPopup({ kind: 'picture', src, path: name })}>
      <img src={src} alt={name} loading="lazy" decoding="async" /></button>;
  })}</div>;
}

// Messages sent from here that no record has shown yet. One the agent never took, even after it was sent again,
// says so and offers to send it once more or drop it.
export function PendingPromptEntries({ prompts, undelivered = () => false, onResend, onDiscard }: {
  prompts: readonly PendingPrompt[]; undelivered?: (prompt: PendingPrompt) => boolean; onResend?: (prompt: PendingPrompt) => void; onDiscard?: (prompt: PendingPrompt) => void;
}) {
  return prompts.map(prompt => {
    const lost = undelivered(prompt);
    return <div key={prompt.id} className={`reading-user reading-pending${prompt.sending ? ' is-sending' : ''}${lost ? ' is-undelivered' : ''}`}>
      <UserAvatar /><UserMessage text={prompt.text} images={prompt.images} />{prompt.sending && <small role="status">{t('发送中')}</small>}
      {lost && <div className="reading-undelivered" role="alert"><small>{t('未送达：助手没有收到这条消息')}</small>
        <button type="button" className="text-button" onClick={() => onResend?.(prompt)}>{t('重新发送')}</button>
        <button type="button" className="text-button" onClick={() => onDiscard?.(prompt)}>{t('移除')}</button></div>}
    </div>;
  });
}
