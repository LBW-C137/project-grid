import type { AgentActionBrief } from '../../shared/types';
import { t } from '../../shared/i18n';

// What each kind of step is called, in the card's one-line status and the reading view's tool lines.
const KIND_LABELS: Record<AgentActionBrief['kind'], string> = { edit: '修改', command: '运行', read: '读取', search: '搜索', web: '访问', skill: '技能', mcp: 'MCP', agent: '子代理', other: '调用' };

const base = (file: string) => file.split(/[\\/]/).pop() || file;
// What kind of step it is, in a word or two: a command says what it does ("运行测试"), others their kind.
export function stepVerb(action: AgentActionBrief) {
  return action.kind === 'command' && action.phrase ? t(action.phrase) : t(KIND_LABELS[action.kind]);
}
// "运行测试", "修改 App.tsx": what a step does, in a few words a person reads at a glance. The full command
// or path is left for the tooltip. An edit made through a shell script names no file.
export function actionText(action: AgentActionBrief) {
  const target = action.target;
  if (action.kind === 'edit') return target ? `${t('修改')} ${target.split('、').map(base).join('、')}` : t('通过命令修改文件');
  if (action.kind === 'read') return `${t('读取')} ${base(target)}`.trim();
  if (action.kind === 'search') return target ? t('搜索“{text}”', { text: target }) : t('搜索');
  if (action.kind === 'web') { let host = ''; try { host = new URL(target).host; } catch { } return host ? `${t('访问')} ${host}` : t('搜索网页“{text}”', { text: target }); }
  if (action.kind === 'skill') return `${t('使用技能')} ${target}`.trim();
  if (action.kind === 'mcp') { const [server, tool] = target.split(' · '); return t('调用 {server} 的 {tool}', { server, tool: tool || t('工具') }); }
  if (action.kind === 'agent') return `${t('派出子代理')} ${target}`.trim();
  if (action.kind === 'command') return action.phrase ? `${t(action.phrase)} ${action.object || ''}`.trim() : `${t('运行')} ${target}`.trim();
  return `${t('调用工具')} ${target}`.trim();
}
