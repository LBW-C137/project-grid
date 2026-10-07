// Output shaped like Claude Code's or Codex's interface while it works: a block of coloured lines redrawn in
// place about ten times a second (spinner, elapsed time, token count, a bold heading and bullets), and every
// second a few new lines scrolled above it. Used by scripts/perf-probe.mjs to load the terminals the way a
// working agent does.
const rows = 14, out = process.stdout;
const colour = (r, g, b, text, bold = false) => `\x1b[${bold ? '1;' : ''}38;2;${r};${g};${b}m${text}\x1b[0m`;
const spinner = ['✻', '✽', '✶', '✳', '✢', '·'];
let frame = 0, drawn = false, line = 0;
function block() {
  const seconds = Math.floor(frame / 10), lines = [];
  lines.push('');
  lines.push(colour(255, 159, 213, '实现优惠券输入框', true));
  for (let index = 0; index < 4; index++) lines.push(`${colour(255, 107, 154, '●')} 第 ${index + 1} 步：更新 src/checkout/Coupon${index}.tsx，补上 ${frame % 7 + index} 个测试用例`);
  lines.push('');
  lines.push(`${colour(215, 119, 87, spinner[frame % spinner.length])} ${colour(215, 119, 87, 'Thinking…')} ${colour(150, 150, 150, `(${seconds}s · ↑ ${(frame * 37) % 9000} tokens · esc to interrupt)`)}`);
  lines.push('');
  lines.push(colour(120, 120, 120, '─'.repeat(100)));
  lines.push(`> ${colour(200, 200, 200, '在这里输入下一条指令')}`);
  lines.push(colour(120, 120, 120, '─'.repeat(100)));
  lines.push(colour(120, 120, 120, '  ⏵⏵ accept edits on (shift+tab to cycle)'));
  while (lines.length < rows) lines.push('');
  return lines;
}
setInterval(() => {
  frame++;
  let text = drawn ? `\x1b[${rows}A\r` : '';
  if (frame % 10 === 0) for (let index = 0; index < 3; index++) text += `\x1b[2K${colour(162, 221, 184, '⏺')} Update(src/module-${++line}.ts) — 修改了 ${line % 40 + 3} 行，测试通过\r\n`;
  for (const row of block()) text += `\x1b[2K${row}\r\n`;
  out.write(text); drawn = true;
}, 100);
