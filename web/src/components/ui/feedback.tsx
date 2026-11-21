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
    <div className="glass-card animate-fade-up flex flex-col items-center justify-center rounded-xl2 border border-dashed border-cream-400 px-6 py-12 text-center">
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
/** 打开期间被替换掉的画布底色（内联值），最后一张弹层关掉时还原 */
let canvasColorPrev: { html: string; body: string } | null = null;
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
 * 画布底色：与 .sheet-skirt / .sheet-panel 的底色一致，弹层打开期间临时用它。
 *
 * 首页在 standalone 下把 html/body 底色设成头部橙（让状态栏背板跟橙头图接上）。
 * 这块底色是浏览器画的画布，铺满整个窗口——键盘弹出后布局视口只剩键盘上方那一截，
 * 下面露出的全是这块橙，iOS 键盘的玻璃再把它透上来，整片发橙，DOM 盖不住。
 * 所以弹层打开时换成弹层底色，最后一张弹层关掉再还原。
 */
const SHEET_CANVAS_COLOR = '#fdf6f0';

/**
 * 打开期间：锁住 body 滚动 + 临时换掉画布底色。
 *
 * 锁滚动用 position:fixed 法——iOS 对 body 上的 overflow:hidden 不买账。不锁的话，
 * iOS 键盘弹出时 Safari 会去滚整个文档来露出输入框，fixed 弹层跟着文档一起被顶走，
 * 「一打字整个界面跳到键盘上」就是它；锁死后 Safari 只能滚弹层内部的内容区，
 * 弹层本体稳住不动。
 */
function useSheetModalChrome(open: boolean) {
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
      // 只有页面自己给画布上过底色（首页 standalone 下的橙）才需要换：其他页面本来就是
      // 奶油底，换了没意义，桌面端还会在弹层四周看到一圈色差
      if (html.style.backgroundColor !== '' || body.style.backgroundColor !== '') {
        canvasColorPrev = { html: html.style.backgroundColor, body: body.style.backgroundColor };
        html.style.backgroundColor = SHEET_CANVAS_COLOR;
        body.style.backgroundColor = SHEET_CANVAS_COLOR;
      }
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
        if (canvasColorPrev) {
          html.style.backgroundColor = canvasColorPrev.html;
          body.style.backgroundColor = canvasColorPrev.body;
          canvasColorPrev = null;
        }
        const y = Number(body.dataset.sheetScrollY ?? '0');
        delete body.dataset.sheetScrollY;
        window.scrollTo(0, y);
      }
    };
  }, [open]);
}

/**
 * 面板高度上限：百分比相对「弹层容器」，也就是键盘弹出后的可见区。
 *
 * 不能用 vh —— iOS 上 vh 不跟键盘收缩（键盘弹出时仍是 793pt），弹层会按键盘前的
 * 高度撑开、顶部连同标题栏一起被顶出屏幕。百分比的参照系是 fixed inset-0 的容器，
 * 它随布局视口一起缩，键盘态算出来的就是「键盘上方还能用多少」。
 */
const MAX_HEIGHT_CLASS: Record<'82%' | '88%', string> = {
  '82%': 'max-h-[82%]',
  '88%': 'max-h-[88%]',
};

/**
 * 键盘态：只认布局视口的收缩，不做任何 visualViewport 补偿。
 *
 * index.html 的 viewport 带 interactive-widget=resizes-content，iOS 键盘弹出时布局视口
 * 原生缩到键盘上沿，fixed inset-0 的弹层跟着缩——面板底边天然就是键盘上沿，
 * 不需要按机型量偏移量，也不会出现「弹层被抬到键盘上方几十像素」的空隙。
 * 这个 hook 只负责回答「键盘开着吗」，用来把停靠区的底部留白压到 0。
 *
 * 基线是整个应用共用的一份「键盘收起时的布局视口高度」：如果拿弹层打开那一刻的
 * innerHeight 当基线，用户先在别处弹出键盘再打开弹层时就会误判成没键盘。
 */
const KEYBOARD_MIN_SHRINK = 120;
let layoutHeightBase = typeof window === 'undefined' ? 0 : Math.round(window.innerHeight);

function useKeyboardOpen(active: boolean): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!active) {
      setOpen(false);
      return undefined;
    }
    const measure = () => {
      const height = Math.round(window.innerHeight);
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      // 没有输入焦点时的视口高度就是基线：旋转换到更矮的横屏、地址栏收起都能自愈。
      // 键盘只会在输入框有焦点时改变高度，所以那种情况不动基线。
      if (height > layoutHeightBase || !typing) layoutHeightBase = height;
      setOpen(layoutHeightBase - height >= KEYBOARD_MIN_SHRINK);
    };
    // 旋转会换一套基线：横屏本来就比竖屏矮，不重设会被当成键盘
    let timer = 0;
    const onOrientation = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        layoutHeightBase = Math.round(window.innerHeight);
        measure();
      }, 350);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', onOrientation);
    // 这个键盘行为下 innerHeight 变化不一定派发 resize（Hermes 真机实测），
    // 300ms 轮询兜底；只读一个数值，开销可以忽略
    const poll = window.setInterval(measure, 300);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', onOrientation);
    };
  }, [active]);

  return open;
}

/**
 * 底部抽屉：移动端主流交互，含遮罩与下滑收起；打开期间锁页面滚动。
 *
 * 键盘态不靠 JS 抬面板：viewport 的 interactive-widget=resizes-content 让布局视口
 * 直接缩到键盘上沿，fixed inset-0 的弹层跟着缩，面板底边就是键盘上沿。这里只做一件事——
 * 键盘开着时把面板与停靠区的底部留白压到 0，让停靠区最后一个控件的下边缘贴住键盘。
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  dock,
  maxHeight = '82%',
  focusField = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /**
   * 输入停靠区：固定在面板最底边、不参与滚动的那一块（输入框 + 它的主操作）。
   *
   * 键盘态下面板底边 = 键盘上沿，停靠区自身不留底部内边距，所以停靠区里最后一个
   * 控件的下边缘就贴在键盘上。中部内容仍在滚动区里滚动。
   */
  dock?: ReactNode;
  maxHeight?: '82%' | '88%';
  /**
   * 打开时是否把焦点落到第一个输入框。语音优先的弹层（AI 帮手）传 false：
   * 一打开就自动弹键盘的话，面板底下那截本来就该贴屏幕底边的区域会被顶上去。
   */
  focusField?: boolean;
}) {
  useSheetModalChrome(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardOpen(open);
  const wasKeyboardRef = useRef(false);
  /** 进入键盘态前的滚动位置：退出时还原，避免面板留在被滚过半的状态 */
  const preKbScrollRef = useRef(0);

  // onClose 通常是内联函数，每次渲染都会变；放进 ref，避免重开/重绑定时恢复焦点
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const focusFieldRef = useRef(focusField);
  focusFieldRef.current = focusField;

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
      // 优先聚焦显式标记的主操作，其次第一个输入控件；两者都没有就落在弹层本身。
      // 不再回退到「首个可聚焦元素」（也就是头部关闭按钮）——iOS 会给脚本聚焦的
      // 按钮补一圈系统焦点环，在横向滚动容器里被裁成残缺的蓝色边角。
      const explicit = panel.querySelector<HTMLElement>('[data-autofocus]');
      const field = focusFieldRef.current
        ? focusable.find((element) => element.matches('input, textarea, select'))
        : undefined;
      const preferred = explicit ?? field;
      if (!preferred || preferred.tagName === 'BUTTON') {
        panel.focus();
        return;
      }
      preferred.focus();
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

  // 键盘收起后还原滚动位置，避免底部内容一直停在被滚过的位置
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (keyboard && !wasKeyboardRef.current) {
      preKbScrollRef.current = container.scrollTop;
      wasKeyboardRef.current = true;
    } else if (!keyboard && wasKeyboardRef.current) {
      wasKeyboardRef.current = false;
      container.scrollTop = preKbScrollRef.current;
    }
  }, [keyboard]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="sheet-scrim absolute inset-0"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? '弹层'}
        tabIndex={-1}
        data-keyboard={keyboard ? 'true' : undefined}
        className={cn(
          'glass-overlay sheet-panel animate-slide-up outline-hidden relative flex w-full max-w-[480px] flex-col rounded-t-xl3 lg:max-w-2xl lg:animate-pop lg:rounded-xl3',
          // 键盘态把面板自身的底部留白也压掉：面板底边 = 键盘上沿，留白一压，
          // 停靠区最后一行就正好落在键盘上
          keyboard ? 'pb-0' : 'pb-4',
          MAX_HEIGHT_CLASS[maxHeight],
        )}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
          <div className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-cream-400 lg:hidden" />
          <p className="pt-2 text-[17px] font-semibold">{title}</p>
          <button type="button" onClick={onClose} className="press pt-2 text-[13px] text-ink-400">
            关闭
          </button>
        </div>
        <div className="no-scrollbar animate-fade-up min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          {children}
        </div>
        {dock ? (
          // 键盘态压掉底部内边距：停靠区最后一个控件的下边缘正好落在面板底边（= 键盘上沿）
          <div className={cn('shrink-0 px-5 pt-1', keyboard ? 'pb-0' : 'pb-3')}>{dock}</div>
        ) : null}
        {/* 实色垫片：iOS 键盘上沿那条系统 chrome 是半透的，会把面板下面的橙色渐变透上来，
            看着像弹层没关严。这里把面板底边往下续一段同色实色，弹层看起来就一路贴到键盘。
            桌面把弹层居中放，没有这个缺口，所以只在小屏渲染。 */}
        <div aria-hidden className="sheet-skirt pointer-events-none absolute inset-x-0 top-full h-[260px] lg:hidden" />
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
