import type { ScreenChoice } from './agent-screen-types';

export function selectedChoiceIndex(choice: ScreenChoice): number {
  return Math.max(0, choice.options.findIndex(option => option.selected));
}

// Use positions, not printed numbers: menus may start at a number other than one.
export function choiceKeys(selected: number, target: number): string[] {
  const distance = target - selected;
  return [...Array.from({ length: Math.abs(distance) }, () => distance > 0 ? '\x1b[B' : '\x1b[A'), '\r'];
}

// Cursor updates are the same prompt; a second menu (e.g. effort after model) is a new prompt. In a question, a tick,
// a typed answer, notes or another page are new too, so its card starts again from the CLI's state.
export function choiceIdentity(choice: ScreenChoice): string {
  const options = choice.options.map(({ number, label, detail, hotkey, checked }) => checked === undefined ? [number, label, detail, hotkey] : [number, label, detail, hotkey, checked]);
  const question = choice.question && { ...choice.question, submit: choice.question.submit && true };
  return JSON.stringify([choice.kind, choice.title, choice.context, options, choice.hint, ...(question ? [question] : [])]);
}

export async function writeChoiceKeys(selected: number, target: number, write: (key: string) => void, active: () => boolean = () => true) {
  const keys = choiceKeys(selected, target);
  for (let index = 0; index < keys.length; index++) {
    if (!active()) return;
    write(keys[index]);
    if (index < keys.length - 1) await new Promise(resolve => setTimeout(resolve, 25));
  }
}
