import { useSyncExternalStore } from 'react';
import { User } from '@phosphor-icons/react';

// The picture the user chose in Settings, kept here so every mark of the user changes at once.
let avatar = '';
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const current = () => avatar;

export function setUserAvatar(next: string) {
  if (next === avatar) return;
  avatar = next;
  listeners.forEach(listener => listener());
}

// The user's mark: their picture as a round image, or the person icon when none is set.
export function UserAvatar({ size = 15 }: { size?: number }) {
  const source = useSyncExternalStore(subscribe, current, current);
  return source ? <img className="user-avatar" src={source} alt="" draggable={false} /> : <User size={size} weight="fill" />;
}
