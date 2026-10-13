// A run of an agent's CLI that is no conversation (codex update, claude --version, codex login: the main process tells
// them apart, electron/features/agents/agent-command.cjs): what the reading view calls it, whether it is still at work,
// and the part of the terminal worth showing under it.
const TITLES: Record<string, string> = {
  update: '正在更新 {agent}…', upgrade: '正在更新 {agent}…', install: '正在安装 {agent}…', 'migrate-installer': '正在安装 {agent}…',
  login: '正在登录 {agent}…', 'setup-token': '正在登录 {agent}…', auth: '正在登录 {agent}…', logout: '正在退出 {agent} 的登录…',
  doctor: '正在检查 {agent}…', exec: '{agent} 正在执行一次性任务…', e: '{agent} 正在执行一次性任务…', '-p': '{agent} 正在执行一次性任务…',
  '--print': '{agent} 正在执行一次性任务…', mcp: '{agent} 的 MCP 设置', config: '{agent} 的设置', plugin: '{agent} 的插件',
  '--version': '{agent} 的版本', '-v': '{agent} 的版本', '-V': '{agent} 的版本', '--help': '{agent} 的帮助', '-h': '{agent} 的帮助', help: '{agent} 的帮助',
};
const QUICK = new Set(['--version', '-v', '-V', '--help', '-h', 'help']);

export function commandRun(command: string) {
  return { title: TITLES[command] ?? '正在运行 {agent} {command}…', working: !QUICK.has(command) };
}

// The terminal's rows from the command line typed on (the last row naming it), without the blank rows at the end; at most
// the last 40 when there is no such row.
export function commandRows(rows: readonly string[], cli: string, command: string): string[] {
  const named = new RegExp(String.raw`(?:^|\s)${cli}(?:\.exe)?\s+${command.replace(/[-]/g, '\\-')}(?:\s|$)`);
  // The screen's blank rows under what was printed go first, so that the last 40 are rows of output.
  const lines = rows.map(row => row.replace(/\s+$/, ''));
  while (lines.length && !lines.at(-1)) lines.pop();
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index--) if (named.test(lines[index])) { start = index + 1; break; }
  const shown = lines.slice(start >= 0 ? start : Math.max(0, lines.length - 40));
  while (shown.length && !shown[0]) shown.shift();
  return shown.slice(-40);
}
