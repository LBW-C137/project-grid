// What the usage guide's last page lists for this release. Update it with every version: the guide opens on
// first use and after each update, on this page for people who are updating.
export const WHATS_NEW: string[] = [
  '多个 Codex 终端空闲时不再反复扫描全部会话记录，后台 CPU 占用大幅下降。',
  '语音播报与语音识别模型在空闲几分钟后自动释放内存；有任务在处理或开始录音时会提前加载。',
  '大仓库的 Git 状态自动刷新会按读取耗时放慢，手动刷新不受影响。',
  'Git 栏里点开更改的文件，红绿分块显示每一处修改，逐块决定保留（暂存）还是还原。',
  '编辑文件时自动保存：停止输入约 1 秒后写入，切换文件或离开窗口前也会保存；可在设置里关闭。',
  '按 F11 让整个窗口全屏或还原，快捷键可在设置里修改。',
];
