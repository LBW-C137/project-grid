import { parseAgentScreen } from '../agents/agent-screen';
import { cliInputDraft, isAtPrompt } from '../reading/cli-panel';
import { readScreen } from '../terminal/terminal-screen';
import { t } from '../../shared/i18n';

type Agent = 'claude' | 'codex';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// What the agent's screen holds now: null while its terminal has none (not drawn yet).
function look(terminalId: string, agent: Agent) {
  const rows = readScreen(terminalId)?.rows;
  return rows ? { rows, screen: parseAgentScreen(agent, rows) } : null;
}

// A message typed into the agent's own input, as a person would: whatever was left there is cleared, the text is pasted
// and Enter pressed, again if the CLI did not take it. Both CLIs queue a message sent while they work. While the agent
// waits on a choice or a question, its keys belong to that: nothing is sent. Gives an error, or null once sent.
export async function sendToAgent(terminalId: string, sessionId: string, agent: Agent, text: string): Promise<string | null> {
  const now = look(terminalId, agent);
  if (!now) return t('它的终端还没有准备好，请稍后再试。');
  if (now.screen.choice) return t('它在等你做一个选择，先处理那张决策卡再发送。');
  if (cliInputDraft(agent, now.rows, now.screen)) { window.agentrix.writeTerminal(terminalId, '\x15'); await pause(60); }
  const pasted = await window.agentrix.pasteTerminal(terminalId, text, sessionId);
  if (!pasted.ok) return pasted.error;
  await pause(400);
  window.agentrix.writeTerminal(terminalId, '\r');
  for (let attempt = 0; attempt < 2; attempt++) {
    await pause(700);
    const after = look(terminalId, agent);
    if (!after || !cliInputDraft(agent, after.rows, after.screen).trim()) break;
    window.agentrix.writeTerminal(terminalId, '\r');
  }
  return null;
}

// Waits until a just-started agent shows its input (it may first ask to trust the folder or to sign in, which the
// decision page takes). Gives whether it got there within the time.
export async function untilAtPrompt(terminalId: string, agent: Agent, timeout = 45000) {
  for (const end = Date.now() + timeout; Date.now() < end; await pause(400)) {
    const now = look(terminalId, agent);
    if (now && !now.screen.choice && isAtPrompt(agent, now.rows, now.screen)) return true;
  }
  return false;
}

// Whether the agent waits at its input right now (not working, not asking).
export function atPrompt(terminalId: string, agent: Agent) {
  const now = look(terminalId, agent);
  return !!now && isAtPrompt(agent, now.rows, now.screen);
}
