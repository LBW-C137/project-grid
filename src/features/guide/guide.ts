// What the usage guide's last page lists for this release. Update it with every version: the guide opens on
// first use and after each update, on this page for people who are updating.
export const WHATS_NEW: string[] = [
  '同一个项目里，Claude Code 和 Codex 的开发记忆自动继承：打开任何一个，它都会先知道之前在这里做过什么（你提的要求、它的回答、改了哪些文件、跑了哪些检查），什么都不用做。',
  '项目的开发记忆永久保存在这台电脑上，不会因为 CLI 清理自己的记录而丢失。',
  '助手会把可以反复用的做法沉淀成项目仓库里 skills 文件夹下的技能，下次直接照着做；写进仓库前会自动去掉个人隐私（用户名、个人目录、IP、邮箱、电话、密码和密钥等）。',
  'SSH 远程项目里，Codex 的阅读视图现在能显示完整的对话：回答、表格和每一步命令，不再只有你发的消息。',
  '截图可以粘贴给 SSH 远程项目里的助手了：远程那边读不到这台电脑的剪贴板，图片会先放进远程电脑的临时目录，再把路径交给它。决策页的输入框也能直接粘贴截图。',
  'Codex 也能在阅读视图里恢复会话：输入 /resume 会列出这个项目的其他 Codex 会话，名字和 Codex 自己的一样；选一个，就在同一个终端里切过去，阅读视图跟着显示它的历史。',
  '支持较老的 Linux 服务器（如 CentOS 7 的 Python 3.6）；远程 Git 版本过旧时，Git 面板会直接说明需要 2.11 或更高版本。',
];
