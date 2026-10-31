import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { Button, cn } from './base';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-xl2', className)} />;
}

export function CardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="card overflow-hidden p-3">
          <Skeleton className="mb-3 h-24 w-full" />
          <Skeleton className="mb-2 h-4 w-3/4 rounded-full" />
          <Skeleton className="h-3 w-1/2 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  emoji = '🍽️',
  title,
  description,
  action,
}: {
  emoji?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="animate-fade-up flex flex-col items-center justify-center rounded-xl2 border border-dashed border-cream-400 bg-white/60 px-6 py-12 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-3xl">
        {emoji}
      </div>
      <p className="text-[17px] font-semibold">{title}</p>
      {description ? <p className="mt-1 max-w-[260px] text-[13px] leading-5 text-ink-400">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** 加载失败：给出原因与重试入口，避免断网时页面永久停在骨架屏上 */
export function ErrorState({
  title = '没能加载数据',
  description,
  onRetry,
  className,
}: {
  title?: string;
  description?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'animate-fade-up flex flex-col items-center justify-center rounded-xl2 border border-dashed border-alert/40 bg-alert/5 px-6 py-10 text-center',
        className,
      )}
    >
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-alert/10 text-alert">
        <WifiOff size={24} />
      </div>
      <p className="text-[16px] font-semibold">{title}</p>
      <p className="mt-1 max-w-[280px] text-[12px] leading-5 text-ink-400">
        {description || '检查一下网络，或稍后再试。'}
      </p>
      {onRetry ? (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function Progress({ value, max, tone = 'brand' }: { value: number; max: number; tone?: 'brand' | 'fresh' }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-cream-300">
      <div
        className={cn(
          'h-full rounded-full transition-all duration-500',
          tone === 'brand' ? 'warm-gradient' : 'bg-fresh',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** 已打开的 Sheet 层数：支持弹层叠弹层，只在第一层打开时锁页面、最后一层关闭时恢复 */
let openSheetCount = 0;
/** 打开中的弹层栈：只有最上层处理 Esc / Tab，避免嵌套弹层互相抢焦点 */
const sheetStack: symbol[] = [];

/** 弹层内可聚焦元素；排除隐藏/禁用项 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.tabIndex !== -1 && element.getClientRects().length > 0);
}

/**
 * 打开期间锁住 body 滚动（position:fixed 法——iOS 对 body 上的 overflow:hidden 不买账）。
 * 不锁的话，iOS 键盘弹出时 Safari 会去滚整个文档来露出输入框，fixed 弹层跟着文档
 * 一起被顶走，「一打字整个界面跳到键盘上」就是它；锁死后 Safari 只能滚弹层内部的
 * 内容区，弹层本体稳住不动。
 */
function useSheetScrollLock(open: boolean) {
  useEffect(() => {
    if (!open) return undefined;
    openSheetCount += 1;
    const body = document.body;
    const html = document.documentElement;
    if (openSheetCount === 1) {
      const y = window.scrollY;
      // 记住页面滚动位置，用 top 偏移保持视觉不动，关闭时再还原
      body.dataset.sheetScrollY = String(y);
      body.style.position = 'fixed';
      body.style.top = `-${y}px`;
      body.style.left = '0';
      body.style.right = '0';
      body.style.width = '100%';
      html.style.overflow = 'hidden';
    }
    return () => {
      openSheetCount -= 1;
      if (openSheetCount === 0) {
        body.style.position = '';
        body.style.top = '';
        body.style.left = '';
        body.style.right = '';
        body.style.width = '';
        html.style.overflow = '';
        const y = Number(body.dataset.sheetScrollY ?? '0');
        delete body.dataset.sheetScrollY;
        window.scrollTo(0, y);
      }
    };
  }, [open]);
}

/**
 * 键盘补偿：正在输入时把弹层抬到键盘上沿之上。可视视口高度 = 屏高 - 键盘，
 * 抬完之后输入框天然在键盘上方，Safari 连平移视口的动机都没有；
 * 桌面没有键盘（innerHeight == 可视高度），恒为 0 不起任何作用。
 */
function useKeyboardOverlap(active: boolean) {
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const update = () => {
      // 万一 iOS 偷偷滚了文档就拨回来（body 已锁，正常恒为 0）
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      const focused = document.activeElement;
      const typing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement;
      // 只在打字时抬升，避免捏合缩放这类无关的视口变化误触发
      setOverlap(typing ? Math.max(0, Math.round(window.innerHeight - vv.height)) : 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('focusin', update);
    window.addEventListener('focusout', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('focusin', update);
      window.removeEventListener('focusout', update);
      setOverlap(0);
    };
  }, [active]);
  return overlap;
}

/** 底部抽屉：移动端主流交互，含遮罩与下滑收起；打开期间锁页面滚动，输入时整体抬到键盘上方 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  maxHeight = '82vh',
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  maxHeight?: string;
}) {
  useSheetScrollLock(open);
  const keyboardOverlap = useKeyboardOverlap(open);
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose 通常是内联函数，每次渲染都会变；放进 ref，避免重开/重绑定时恢复焦点
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const token = Symbol('sheet');
    sheetStack.push(token);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = focusableIn(panel);
      // 优先聚焦显式标记的主操作，其次第一个输入控件；最后才退回面板首项。
      // 旧实现总是聚焦头部“关闭”，身份选择等高频弹层每次都要多按一次 Tab。
      const explicit = panel.querySelector<HTMLElement>('[data-autofocus]');
      const preferred =
        explicit ??
        focusable.find((element) => element.matches('input, textarea, select')) ??
        focusable[0];
      // 按钮不做程序化聚焦：iOS 会给脚本聚焦的按钮补一圈系统焦点环，
      // 在横向滚动容器（选人头像行）里被裁成残缺的蓝色边角。
      // 先落在弹层本身，第一次 Tab 再跳到主操作上（见下方 Tab 处理）。
      if (explicit?.tagName === 'BUTTON') {
        panel.focus();
        return;
      }
      (preferred ?? panel).focus();
    }, 30);

    const onKey = (event: KeyboardEvent) => {
      if (sheetStack[sheetStack.length - 1] !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = focusableIn(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // 焦点还在弹层本体（打开时的落点）时也算“在环外”，Tab 顺着进到主操作，
      // 而不是停到头部“关闭”上；其余环绕规则保持原样
      const trapped = panel.contains(active) && active !== panel;
      if (event.shiftKey && (!trapped || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!trapped) {
        event.preventDefault();
        (panel.querySelector<HTMLElement>('[data-autofocus]') ?? first).focus();
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
      const index = sheetStack.lastIndexOf(token);
      if (index >= 0) sheetStack.splice(index, 1);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  // 键盘弹出时：弹层整体抬到键盘上方并压缩到可视高度内，输入框永远在键盘之上
  const lifted = keyboardOverlap > 0;
  const effectiveMaxHeight = lifted ? `calc(100vh - ${keyboardOverlap + 12}px)` : maxHeight;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center lg:items-center"
      style={{ paddingBottom: lifted ? keyboardOverlap : 0, transition: 'padding-bottom 200ms ease-out' }}
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-ink-900/45 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? '弹层'}
        tabIndex={-1}
        className="animate-slide-up outline-hidden relative w-full max-w-[480px] rounded-t-xl3 bg-cream-100 pb-4 shadow-2xl lg:max-w-2xl lg:animate-pop lg:rounded-xl3"
        style={{ maxHeight: effectiveMaxHeight, transition: 'max-height 200ms ease-out' }}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <div className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-cream-400 lg:hidden" />
          <p className="pt-2 text-[17px] font-semibold">{title}</p>
          <button type="button" onClick={onClose} className="press pt-2 text-[13px] text-ink-400">
            关闭
          </button>
        </div>
        <div className="no-scrollbar overflow-y-auto px-5 pb-2" style={{ maxHeight: `calc(${effectiveMaxHeight} - 60px)` }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  unit,
  tone = 'brand',
  icon,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: 'brand' | 'fresh' | 'cool' | 'warn';
  icon?: ReactNode;
}) {
  const tones = {
    brand: 'from-brand-50 to-white text-brand-600',
    fresh: 'from-fresh/10 to-white text-fresh',
    cool: 'from-cool/10 to-white text-cool',
    warn: 'from-warn/15 to-white text-[#B45309]',
  } as const;
  return (
    <div className={cn('rounded-xl2 border border-cream-300/60 bg-linear-to-b p-3', tones[tone])}>
      <div className="flex items-center gap-1 text-[11px] font-medium opacity-80">
        {icon}
        {label}
      </div>
      <p className="mt-1 flex items-baseline gap-0.5">
        <span className="text-xl font-semibold tabular-nums text-ink-900">{value}</span>
        {unit ? <span className="text-[11px] text-ink-400">{unit}</span> : null}
      </p>
    </div>
  );
}
