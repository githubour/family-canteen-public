import { create } from 'zustand';
import { api } from '../api/client';
import type { AppSettings, Member } from '../api/types';

interface AppState {
  members: Member[];
  settings: AppSettings | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  setMembers: (members: Member[]) => void;
  setSettings: (settings: AppSettings) => void;
}

/** 全局共享的成员与设置；由 SSE 事件驱动刷新，避免各页面重复拉取 */
export const useAppStore = create<AppState>((set) => ({
  members: [],
  settings: null,
  loaded: false,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true });
    const [membersResult, settingsResult] = await Promise.all([api.members.list(), api.settings.get()])
      .then(([members, settings]) => [members, settings] as const)
      .catch((error: unknown) => {
        console.error('[app] 初始化数据加载失败', error);
        set({ loading: false, error: error instanceof Error ? error.message : '加载失败' });
        return [null, null] as const;
      });

    if (!membersResult || !settingsResult) return;
    set({
      members: membersResult.members,
      settings: settingsResult.settings,
      loaded: true,
      loading: false,
      error: null,
    });
  },

  setMembers: (members) => set({ members }),
  setSettings: (settings) => set({ settings }),
}));
