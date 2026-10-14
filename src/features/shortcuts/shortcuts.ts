import defaults from '../../../electron/shortcuts.json';
import type { Settings } from '../../shared/types';

// Keyboard shortcuts for app actions. Defaults are shared with the main process (electron/shortcuts.json),
// which must let them through; settings keep only what the user changed.
// A shortcut is written as "Ctrl+Shift+F": modifiers in the order Ctrl, Alt, Shift, then one key.
export type ShortcutAction = 'search' | 'addProject' | 'voice' | 'overview' | 'decisions' | 'explorer' | 'settings' | 'nextProject' | 'previousProject' | 'projectAbove' | 'projectBelow' | 'maximize' | 'fullscreen' | 'newTerminal' | 'removeProject';
export const SHORTCUT_ACTIONS: { id: ShortcutAction; label: string }[] = [
  { id: 'search', label: '搜索项目' },
  { id: 'addProject', label: '添加项目' },
  { id: 'voice', label: '语音输入' },
  { id: 'overview', label: '返回总览' },
  { id: 'decisions', label: '回到决策' },
  { id: 'explorer', label: '展开或收起目录栏' },
  { id: 'nextProject', label: '下一个项目' },
  { id: 'previousProject', label: '上一个项目' },
  { id: 'projectAbove', label: '上方的项目' },
  { id: 'projectBelow', label: '下方的项目' },
  { id: 'maximize', label: '放大或还原当前项目' },
  { id: 'fullscreen', label: '窗口全屏或还原' },
  { id: 'newTerminal', label: '新建终端并分屏' },
  { id: 'removeProject', label: '移除当前项目' },
  { id: 'settings', label: '打开设置' },
];
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = defaults;

const KEYS: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
function keyName(code: string) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return KEYS[code] || null;
}

// The shortcut an event would record, or null for a bare key, a lone modifier, or a key without a name.
export function shortcutFromEvent(event: KeyboardEvent) {
  const key = keyName(event.code);
  if (!key || event.metaKey) return null;
  const function_key = /^F\d+$/.test(key);
  if (!event.ctrlKey && !event.altKey && !function_key) return null;
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

// How a shortcut reads on screen: the arrow keys as arrows (Ctrl+Shift+→).
const ARROWS: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓' };
export const shortcutLabel = (value: string) => value.replace(/\b(Left|Right|Up|Down)$/, key => ARROWS[key]);

let current: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS };
// Set while App renders, like the language, so every hint in that render shows the chosen keys, as they read on screen.
export function applyShortcuts(settings: Settings['shortcuts']) { current = { ...DEFAULT_SHORTCUTS, ...settings }; }
export function shortcut(action: ShortcutAction) { return shortcutLabel(current[action]); }
export function actionFor(event: KeyboardEvent): ShortcutAction | null {
  const pressed = shortcutFromEvent(event);
  if (!pressed) return null;
  return (Object.keys(current) as ShortcutAction[]).find(action => current[action] === pressed) || null;
}

// Inside text boxes and the editor (not terminals), standard editing keys keep their usual meaning; Ctrl+Shift with an
// arrow selects by word where there is text to select, and in an empty box moves between projects.
const EDITING = new Set(['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y']);
const SELECTING = new Set(['Ctrl+Shift+Left', 'Ctrl+Shift+Right', 'Ctrl+Shift+Up', 'Ctrl+Shift+Down']);
export function editingKeyInField(event: KeyboardEvent) {
  const target = event.target as Element | null;
  const field = target?.closest?.('input, textarea, select, [contenteditable="true"]');
  if (!field || field.classList.contains('xterm-helper-textarea')) return false;
  const pressed = shortcutFromEvent(event) || '';
  return EDITING.has(pressed) || (SELECTING.has(pressed) && !!('value' in field ? (field as HTMLInputElement).value : field.textContent));
}
