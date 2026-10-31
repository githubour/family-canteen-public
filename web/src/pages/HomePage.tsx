import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChefHat, ClipboardList, ShoppingBasket, Sparkles, Timer, UtensilsCrossed } from 'lucide-react';
import { api } from '../api/client';
import { useServerEvents } from '../api/sse';
import { MEAL_LABEL, STATUS_LABEL, type AppSettings } from '../api/types';
import { AiHelperSheet } from '../components/ai/AiHelperSheet';
import { FridgeStockSheet } from '../components/FridgeStockSheet';
import { IdentityPickerSheet } from '../components/IdentityPickerSheet';
import { STATUS_STYLE } from '../components/OrderCard';
import { Button, cn } from '../components/ui/base';
import { ErrorState } from '../components/ui/feedback';
import { toast } from '../components/ui/toast';
import { useAsync } from '../hooks/useAsync';
import { useCurrentMember, useMembers, useSettings } from '../hooks/useCurrentMember';
import { useToday, useNow } from '../hooks/useNow';
import {
  cutoffCountdown,
  cutoffFor,
  formatDateCN,
  formatWeekday,
  greeting,
  guessMealType,
  relativeDateTime,
  relativeDayLabel,
} from '../lib/format';
import { memberTheme } from '../lib/memberTheme';
import { useIdentity } from '../store/identity';
import { useCart } from '../store/cart';

/** role 不为空的两个入口需要先认人（同一个人可以既点菜又下厨，不做互斥） */
const ROLE_ENTRIES = [
  {
    to: '/order',
    title: '我要点菜',
    desc: '像在餐馆一样翻菜单',
    icon: UtensilsCrossed,
    accent: 'from-brand-400 to-brand-600',
    role: 'diner' as const,
  },
  {
    to: '/chef',
    title: '我是大厨',
    desc: '看今天的订单与备料',
    icon: ChefHat,
    accent: 'from-[#FF8A3D] to-[#F0521B]',
    role: 'chef' as const,
  },
  {
    to: '/purchase',
    title: '我要采购',
    desc: '按清单去菜场买菜',
    icon: ShoppingBasket,
    accent: 'from-fresh to-[#0E7C3A]',
    role: null,
  },
  {
    to: '/admin',
    title: '看汇总',
    desc: '点了啥 · 吃得怎么样',
    icon: ClipboardList,
    accent: 'from-cool to-[#1D4ED8]',
    role: null,
  },
];

export function HomePage() {
  const navigate = useNavigate();
  const members = useMembers();
  const settings = useSettings();
  const memberId = useIdentity((state) => state.memberId);
  const chefId = useIdentity((state) => state.chefId);
  const selectMember = useIdentity((state) => state.select);
  const selectChef = useIdentity((state) => state.selectChef);
  const current = useCurrentMember();
  const diner = members.find((member) => member.id === memberId) ?? null;
  const chef = members.find((member) => member.id === chefId) ?? null;
  const lines = useCart((state) => state.lines);
  /** 需要先认人的入口：先弹选人，选完再跳转 */
  const [pendingRole, setPendingRole] = useState<'diner' | 'chef' | null>(null);
  /** 滚过头部后浮出吸顶玻璃条，把状态栏区域和滚动的浅色内容隔开 */
  const [scrolled, setScrolled] = useState(false);
  /** 手动勾选库存的弹层（与点菜页 / 采购页同一个入口），首页只作为 AI 弹层里的次要出口 */
  const [fridgeOpen, setFridgeOpen] = useState(false);
  /** 唯一的 AI 入口：一句话交给模型分流到加菜或登记库存 */
  const [aiOpen, setAiOpen] = useState(false);

  // 「今天」只在跨过零点时更新（见 useToday）；30 秒跳动的倒计时收进了
  // <MealCountdownChip />（文件底部），不再带着整页每 30 秒重渲染
  const today = useToday();

  const summary = useAsync(() => api.orders.summary(today), [today]);
  const recent = useAsync(() => api.orders.recent(5), []);
  /** AI 没配 key 时右上角的 AI 按钮不出现——与所有 AI 入口的降级方式一致 */
  const aiStatus = useAsync(() => api.ai.status(), []);

  // 新订单/状态流转实时刷「家里最近」与全天统计；头部“今日已点”不能落后于列表
  useServerEvents({
    'order:created': () => {
      recent.reload();
      summary.reload();
    },
    'order:updated': () => {
      recent.reload();
      summary.reload();
    },
    'order:deleted': () => {
      recent.reload();
      summary.reload();
    },
  });

  // “今日已点”必须是全天三餐合计；只取当前餐次会把早/午餐已点的单显示成 0。
  // 道数按菜去重：同一道菜午晚各点一次，在“今日”口径里只算一道。
  const dayTotals = useMemo(() => {
    const summaries = summary.data?.summaries ?? [];
    const dishKeys = new Set<string>();
    for (const meal of summaries) {
      for (const dish of meal.dishes) {
        dishKeys.add(dish.dish_id != null ? `d${dish.dish_id}` : `s${dish.name}`);
      }
    }
    return {
      servings: summaries.reduce((sum, item) => sum + item.total_servings, 0),
      dishes: dishKeys.size,
    };
  }, [summary.data]);

  /** 首页头部是橙色：iOS 安装到主屏（standalone）后，状态栏背板会用页面底色填充，
      把底色临时同步成头部起点橙，避免状态栏区域出现奶油色「水位线」；离开首页自动
      还原。仅在 standalone 下生效——Safari 浏览器与桌面大屏（body 底色会露在内容
      两侧）保持奶油底色不变。 */
  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!standalone) return;
    const html = document.documentElement;
    html.style.backgroundColor = '#ff8a3d';
    document.body.style.backgroundColor = '#ff8a3d';
    return () => {
      html.style.backgroundColor = '';
      document.body.style.backgroundColor = '';
    };
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 140);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /** 家里最近：服务端按 updated_at 取 5 笔；下单、接单、状态流转都会把单浮到最上面。
   *  行上展示的也是 updated_at，排序与文案一致。 */
  const feed = useMemo(
    () =>
      [...(recent.data?.orders ?? [])]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id)
        .slice(0, 5),
    [recent.data],
  );

  const openEntry = (entry: (typeof ROLE_ENTRIES)[number]) => {
    if (entry.role === 'diner' && !memberId) {
      setPendingRole('diner');
      return;
    }
    if (entry.role === 'chef' && !chefId) {
      setPendingRole('chef');
      return;
    }
    navigate(entry.to);
  };

  return (
    <div className="pb-[132px] lg:pb-8">
      {/* 滚动吸顶条：头部滚走后从上方滑入（与底部悬浮 Tab 栏同款玻璃材质），盖住
          状态栏区域，黑色系统时钟不再叠在从底下穿过的浅色内容上；未滚动时整体
          上滑隐藏。平板/桌面是左侧竖栏布局，不需要它。 */}
      <div
        aria-hidden={!scrolled}
        className={cn(
          'glass-float fixed inset-x-0 top-0 z-40 rounded-b-xl3 border-t-0 pt-[env(safe-area-inset-top,0px)] transition-all duration-300 lg:hidden',
          scrolled ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0',
        )}
      >
        <div className="mx-auto flex h-11 max-w-[var(--app-max-w)] items-center justify-center px-5">
          <span className="text-[14px] font-semibold text-ink-900">
            {formatDateCN(today)} {formatWeekday(today)}
          </span>
        </div>
      </div>
      {/* 底部留白：竖屏要让内容从悬浮 Tab 栏（67px+边距+安全区 ≈111pt）底下滚出来
          并留约 20pt 呼吸——首版 168px 实机看偏大，回调到 132px；平板/桌面 Tab 是
          左侧竖栏，只留常规 32px。手机横屏（land）⊂ lg，同样收窄。 */}
      {/* 手机横屏（land）时竖向空间金贵，头部收一收，把入口卡片尽早露出来。
          pt 让出灵动岛/摄像头区域：全面屏 PWA 里问候语不能顶进摄像头底下 */}
      <header className="hero-gradient rounded-b-xl3 px-5 pb-8 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] text-white land:pb-6 land:pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] opacity-90">
              {greeting()}，{current ? current.name : '欢迎回家'}
            </p>
            <h1 className="mt-1 text-[26px] font-semibold leading-tight land:text-[21px]">
              {formatDateCN(today)} {formatWeekday(today)}
            </h1>
          </div>
          {/* AI 帮手：首页唯一的 AI 入口，放在右上角常驻，不用滚到底部去找。
              没配 key 时按钮不出现——与其他 AI 入口的降级方式一致 */}
          {aiStatus.data?.enabled ? (
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              aria-label="AI 帮手"
              className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur-sm active:bg-white/30 land:h-9 land:w-9"
            >
              <Sparkles size={19} />
            </button>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <MealCountdownChip settings={settings} />
          <span className="chip bg-white/20 text-white">
            今日已点 {dayTotals.servings} 份 · {dayTotals.dishes} 道菜
          </span>
        </div>
      </header>

      {/* 宽屏内容收在 1100px：hero 可以通栏，但卡片区不跟着 1440 视口无限拉伸 */}
      <div className="mx-auto w-full max-w-[1100px]">
      {/* 家里最近：谁点了什么、做到哪一步，实时的（SSE 带动刷新）；没有订单时不占位 */}
      {recent.error && feed.length === 0 ? (
        <section className="-mt-5 px-4">
          <ErrorState title="最近订单没加载出来" description={recent.error} onRetry={recent.reload} />
        </section>
      ) : feed.length > 0 ? (
        <section className="-mt-5 px-4">
          <div className="card p-4">
            <div className="mb-2.5 flex items-center justify-between">
              <p className="text-[15px] font-semibold">家里最近</p>
              <button type="button" onClick={() => navigate('/admin')} className="text-[12px] text-brand-500">
                看汇总
              </button>
            </div>
            <ul className="space-y-3">
              {feed.map((order) => {
                const names = order.items.map((item) => item.name);
                return (
                  <li key={order.id} className="flex items-center gap-2.5">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
                      style={{ backgroundColor: `${memberTheme(order.member).accent}22` }}
                    >
                      {order.member.avatar}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {order.member.name} · {relativeDayLabel(order.meal_date)} · {MEAL_LABEL[order.meal_type]} ·{' '}
                        {relativeDateTime(order.updated_at)}
                      </p>
                      <p className="truncate text-[11px] text-ink-400">
                        {names.slice(0, 2).join('、')}
                        {names.length > 2 ? ` 等 ${names.length} 道` : ''}
                      </p>
                    </div>
                    <span className={cn('chip shrink-0', STATUS_STYLE[order.status])}>
                      {STATUS_LABEL[order.status]}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="mt-4 grid grid-cols-2 gap-3 px-4 lg:grid-cols-4">
        {ROLE_ENTRIES.map((entry) => {
          const assigned =
            entry.role === 'diner' ? diner : entry.role === 'chef' ? chef : null;
          return (
            <button
              key={entry.to}
              type="button"
              onClick={() => openEntry(entry)}
              className="card press animate-fade-up flex flex-col items-start gap-2 p-4 text-left"
            >
              <span
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-xl2 bg-gradient-to-br text-white shadow-float',
                  entry.accent,
                )}
              >
                <entry.icon size={20} />
              </span>
              <span className="text-[15px] font-semibold">{entry.title}</span>
              <span className="text-[11px] leading-4 text-ink-400">{entry.desc}</span>
              {entry.role ? (
                <span
                  className={cn('chip mt-0.5 font-medium', !assigned && 'bg-warn/15 text-[#B45309]')}
                  style={assigned ? memberTheme(assigned).badge : undefined}
                >
                  {assigned ? `${assigned.avatar} ${assigned.name}` : '需先选人'}
                </span>
              ) : null}
            </button>
          );
        })}
      </section>

      {lines.length > 0 ? (
        <section className="mt-5 px-4">
          <div className="card flex items-center gap-3 p-3.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-xl">🧺</span>
            <div className="flex-1">
              <p className="text-[14px] font-semibold">购物车里还有 {lines.length} 道菜</p>
              <p className="text-[11px] text-ink-400">别忘了提交给大厨，截单后就来不及了</p>
            </div>
            <Button size="sm" onClick={() => navigate('/cart')}>
              去结算
            </Button>
          </div>
        </section>
      ) : null}

      </div>

      {/* AI 弹层与手动库存弹层：后者是前者里的次要出口，与点菜页 / 采购页共用同一个组件 */}
      <AiHelperSheet
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onManualStock={() => {
          setAiOpen(false);
          setFridgeOpen(true);
        }}
      />
      <FridgeStockSheet open={fridgeOpen} onClose={() => setFridgeOpen(false)} />

      {/* 「谁来点菜 / 谁来掌勺」共用一套选人弹层：标题与说明随入口变，行为一致 */}
      <IdentityPickerSheet
        open={pendingRole !== null}
        onClose={() => setPendingRole(null)}
        members={members}
        currentId={pendingRole === 'chef' ? chefId : memberId}
        title={pendingRole === 'chef' ? '今天谁来做菜' : '今天谁来点菜'}
        description={
          pendingRole === 'chef'
            ? '做的单子会记在这位大厨名下，点菜的人也可以掌勺。'
            : '菜单会记在这位家人名下，选好就能开点。'
        }
        onSelect={(member) => {
          if (pendingRole === 'chef') {
            selectChef(member.id);
            // 选完立刻跳页，头像动效看不到，这里用 toast 带上头像承接反馈
            toast(`${member.avatar} 今天由 ${member.name} 做菜`, 'success');
            setPendingRole(null);
            navigate('/chef');
          } else {
            selectMember(member.id);
            toast(`${member.avatar} 已切换为 ${member.name}`, 'success');
            setPendingRole(null);
            navigate('/order');
          }
        }}
      />
    </div>
  );
}

/**
 * 头部的餐次/截单 chip。自带 useNow：30 秒一次的时间跳动只重渲染这一小片，
 * 不再带着问候语、「家里最近」与入口卡整页重渲染（同 OrderPage 的 CutoffCountdown）。
 */
function MealCountdownChip({ settings }: { settings: AppSettings | null }) {
  const now = useNow();
  const mealType = guessMealType(now);
  const countdown = useMemo(() => cutoffCountdown(cutoffFor(settings, mealType), now), [settings, mealType, now]);
  return (
    <span className={cn('chip bg-white/20 text-white', countdown.passed && 'bg-white/15')}>
      <Timer size={12} />
      {MEAL_LABEL[mealType]} · {countdown.passed ? '已过截单时间' : countdown.text}
    </span>
  );
}
