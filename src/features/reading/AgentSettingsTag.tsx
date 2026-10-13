import { Lightning } from '@phosphor-icons/react';
import type { AgentSettings } from '../../shared/types';
import type { ScreenStatus } from '../agents/agent-screen-types';
import { t } from '../../shared/i18n';
import { modelName } from './model-name';

// What the agent runs with, on the message box's top edge at its right end: the model, how hard it thinks and whether
// fast mode is on, as its records show them (agent-settings.cjs), else as its footer on screen does.
export function AgentSettingsTag({ settings, status }: { settings: AgentSettings | null | undefined; status: ScreenStatus }) {
  const model = settings?.model ?? status.model, effort = settings?.effort ?? status.effort, fast = settings?.fast ?? status.fast ?? null;
  if (!model && !effort && fast === null) return null;
  // Codex prints "default" for a model's own effort.
  const parts = [model && modelName(model), effort && t('思考 {effort}', { effort: effort === 'default' ? t('默认') : effort }), fast !== null && (fast ? t('快速模式') : t('普通模式'))].filter(Boolean);
  return <span className={`reading-agent-settings${fast ? ' is-fast' : ''}`} role="status" title={t('当前模型、思考深度和速度模式')}>
    {fast && <Lightning size={11} weight="fill" aria-hidden="true" />}{parts.join(' · ')}
  </span>;
}
