import type { AppSettings, Member } from '../api/types';
import { useAppStore } from '../store/app';
import { useIdentity } from '../store/identity';

export function useCurrentMember(): Member | null {
  const members = useAppStore((state) => state.members);
  const memberId = useIdentity((state) => state.memberId);
  return members.find((member) => member.id === memberId) ?? null;
}

export function useMembers(): Member[] {
  return useAppStore((state) => state.members);
}

export function useSettings(): AppSettings | null {
  return useAppStore((state) => state.settings);
}
