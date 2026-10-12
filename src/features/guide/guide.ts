// What the usage guide's last page lists for this release. Update it with every version: the guide opens on
// first use and after each update, on this page for people who are updating.
export const WHATS_NEW: string[] = [
  '阅读视图的发送更可靠：不会再把输入框里残留的旧内容当成新消息提交；关闭命令面板后发的消息不会落进还没关掉的对话框；自动重发不再清空你正在写的草稿。',
  '在权限卡上用 Tab 移到“取消”再按回车，不会再误批准。',
  '斜杠命令：/init、/review、技能等直接显示在对话里，不再弹出终端画面；同一条 Codex 命令连着执行也有结果；命令面板里 Ctrl+C 复制、Ctrl+V 粘贴，不会打断 CLI。',
  '回答里的 <title>、<url>、Promise<void> 这类写法照原样显示，不再吞掉后面的内容；Claude 里粘贴大截图的消息不再丢失。',
  'SSH 上 Codex 写的文件卡片可以预览；Codex 失败的命令显示为失败；Claude 被中断的步骤不再一直转圈。',
  '从项目编辑页回到决策页时，左边的文件栏不再留在页面上。',
];
