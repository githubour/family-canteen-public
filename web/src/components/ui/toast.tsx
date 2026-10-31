import { create } from 'zustand';
import { Check, X } from 'lucide-react';

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastState {
  items: ToastItem[];
  push: (message: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (message, tone = 'info') => {
    const id = Date.now() + Math.random();
    set((state) => ({ items: [...state.items, { id, tone, message }] }));
    setTimeout(() => set((state) => ({ items: state.items.filter((item) => item.id !== id) })), 2600);
  },
  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
}));

export function toast(message: string, tone: ToastTone = 'info'): void {
  useToastStore.getState().push(message, tone);
}

/** 顶部悬浮提示：iOS 通知横幅的材质——深色玻璃 + 白字，成功/失败只靠一枚小徽章示意，点按可提前关闭 */
export function ToastHost() {
  const items = useToastStore((state) => state.items);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    // 顶部让出灵动岛/摄像头区域（全面屏 PWA 下 safe-area-inset-top ≈ 59pt；
    // 浏览器里视口本就在状态栏下方，该值为 0，不受影响）
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[60] flex flex-col items-center gap-2 px-4"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => dismiss(item.id)}
          className="animate-pop pointer-events-auto flex max-w-[420px] items-center gap-2 rounded-full border border-white/10 bg-ink-900/70 py-2 pl-3 pr-4 text-[13px] font-medium text-white shadow-hud backdrop-blur-xl backdrop-saturate-[1.8]"
        >
          {item.tone === 'success' && (
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[#34C759]">
              <Check size={11} strokeWidth={3.5} className="text-white" />
            </span>
          )}
          {item.tone === 'error' && (
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[#FF453A]">
              <X size={11} strokeWidth={3.5} className="text-white" />
            </span>
          )}
          <span className="text-left leading-tight">{item.message}</span>
        </button>
      ))}
    </div>
  );
}
