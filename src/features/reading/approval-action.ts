import type { ScreenAgent, ScreenChoice } from '../agents/agent-screen-types';
import { readScreen, screenChoice } from '../terminal/terminal-screen.ts';
import { choiceIdentity, choiceKeys, selectedChoiceIndex } from './choice-keys.ts';

const expired = () => new Error('审批操作已失效，未发送本次按键。请重新查看请求，或切换到终端处理。');

// Capture the rendered incarnation and backend stamp, never latest.current or a fresh stamp at send time. Check
// before every delayed key, and let the main process check again at its synchronous PTY write boundary.
export async function writeApprovalAction(terminalId: string, agent: ScreenAgent, choice: ScreenChoice, target: number | 'cancel', active: () => boolean) {
  const captured = choice.approval;
  if (!captured?.stamp || !captured.instance) throw expired();
  const stamp = { ...captured.stamp }, instance = captured.instance, identity = choiceIdentity(choice);
  const actionId = crypto.randomUUID(); // one local transaction owns its navigation and final key
  const current = () => {
    const live = screenChoice(agent, readScreen(terminalId));
    if (!active() || !live?.approval || live.approval.instance !== instance || choiceIdentity(live) !== identity
      || live.approval.stamp?.sessionId !== stamp.sessionId || live.approval.stamp?.revision !== stamp.revision) throw expired();
    return live;
  };
  const live = current();
  if (target !== 'cancel' && !live.options[target]) throw expired();
  const keys = target === 'cancel' ? ['\x1b'] : choiceKeys(selectedChoiceIndex(live), target);
  for (let index = 0; index < keys.length; index++) {
    current();
    const result = await window.agentrix.writeApproval(terminalId, keys[index], stamp, actionId);
    if (!result.ok) throw new Error(result.error);
    if (result.value !== true) throw expired();
    if (index < keys.length - 1) await new Promise(resolve => setTimeout(resolve, 25));
  }
}
