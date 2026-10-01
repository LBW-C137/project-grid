import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, FolderSimplePlus, Keyboard, Sparkle, SquaresFour, Terminal as TerminalIcon } from '@phosphor-icons/react';
import { SHORTCUT_ACTIONS, shortcut } from './shortcuts';
import { WHATS_NEW } from './guide';
import { t } from './i18n';

type Page = { id: string; icon: ReactNode; title: string; body: ReactNode };

// A short guide: what the app does, the three steps of a working round, the shortcuts in use,
// and what changed in this version. It opens on first use and after each update (on the
// "what's new" page then), and from Settings at any time.
export function UsageGuide({ version, start, onClose }: { version: string; start: 'intro' | 'news'; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pages: Page[] = [
    { id: 'intro', icon: <SquaresFour size={26} />, title: t('欢迎使用 Project Grid'), body: <>
      <p>{t('在一个窗口里同时推进多个项目：每个项目一个方框、一个真实终端。Codex 或 Claude Code 每做完一轮，方框会亮起并语音提醒，你不必一直盯着。')}</p>
      <ul>
        <li>{t('多项目终端网格，可拖动排序，也能在一个项目里分屏')}</li>
        <li>{t('一轮完成时：呼吸灯、桌面通知和语音播报')}</li>
        <li>{t('本地语音输入，说完回车直接发送')}</li>
        <li>{t('文件浏览与编辑、Git 历史，以及重启后自动恢复会话')}</li>
      </ul></> },
    { id: 'add', icon: <FolderSimplePlus size={26} />, title: t('第一步：添加项目'), body: <>
      <p>{t('按 {key} 选择一个或多个项目文件夹，每个项目会打开自己的终端。也可以添加 SSH 远程项目。', { key: shortcut('addProject') })}</p>
      <p>{t('以前打开过的项目会出现在「最近的项目」里，点一下即可加回。')}</p></> },
    { id: 'run', icon: <TerminalIcon size={26} />, title: t('第二步：开始一轮任务'), body: <>
      <p>{t('在项目终端里输入 codex 或 claude 启动助手，然后直接写下要做的事。')}</p>
      <p>{t('按 {voice} 可以用说的，说完按回车发送；按 {split} 给同一个项目再开一个分屏终端。', { voice: shortcut('voice'), split: shortcut('newTerminal') })}</p></> },
    { id: 'wait', icon: <Bell size={26} />, title: t('第三步：等提醒，再继续'), body: <>
      <p>{t('这一轮做完时，方框从边缘缓缓亮起，并播报“哪个项目完成了什么”。工作中边框保持常亮，不会闪。')}</p>
      <p>{t('点标题栏或按 {key} 放大查看结果；在终端里发出下一条指令，就算看过了。', { key: shortcut('maximize') })}</p></> },
    { id: 'keys', icon: <Keyboard size={26} />, title: t('常用快捷键'), body: <>
      <dl className="guide-keys">{SHORTCUT_ACTIONS.map(action => <div key={action.id}><dt>{t(action.label)}</dt><dd><kbd>{shortcut(action.id)}</kbd></dd></div>)}</dl>
      <p className="guide-note">{t('这些快捷键都可以在设置的「键盘快捷键」里修改。')}</p></> },
    { id: 'news', icon: <Sparkle size={26} />, title: t('本次更新 v{version}', { version }), body: <ul>{WHATS_NEW.map(item => <li key={item}>{t(item)}</li>)}</ul> },
  ];
  const [index, setIndex] = useState(() => Math.max(0, pages.findIndex(page => page.id === start)));
  const page = pages[index], last = index === pages.length - 1;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' && !last) setIndex(index + 1);
      if (event.key === 'ArrowLeft' && index) setIndex(index - 1);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [index, last]);
  return <dialog className="settings-dialog guide-dialog" ref={dialog} aria-label={t('使用指南')} onCancel={onClose}>
    <div className="dialog-content">
      <div className="guide-head"><span className="guide-icon" aria-hidden="true">{page.icon}</span><div><span className="eyebrow">{t('使用指南')} · {index + 1} / {pages.length}</span><h2>{page.title}</h2></div></div>
      <div className="guide-body">{page.body}</div>
      <div className="guide-dots" aria-hidden="true">{pages.map((item, position) => <i key={item.id} className={position === index ? 'is-current' : ''} />)}</div>
      <div className="dialog-footer">
        <button type="button" className="text-button" onClick={onClose}>{t('跳过')}</button>
        <span className="guide-actions">
          {index > 0 && <button type="button" className="button secondary" onClick={() => setIndex(index - 1)}>{t('上一步')}</button>}
          <button type="button" className="button primary" autoFocus onClick={() => (last ? onClose() : setIndex(index + 1))}>{last ? t('开始使用') : t('下一步')}</button>
        </span>
      </div>
    </div>
  </dialog>;
}
