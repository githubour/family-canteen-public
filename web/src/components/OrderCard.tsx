import { useState } from 'react';
import { Check, ChefHat, ChevronDown, FastForward, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import {
  MEAL_LABEL,
  STATUS_LABEL,
  type DishFeedback,
  type Order,
  type OrderStatus,
} from '../api/types';
import { relativeDayLabel, shiftDay, todayISO } from '../lib/format';
import { DishFeedbackBar } from './DishFeedbackBar';
import { DishRecipeDetail, type SummaryDish } from './DishRecipeDetail';
import { cn } from './ui/base';
import { ConfirmSheet } from './ui/ConfirmSheet';
import { toast } from './ui/toast';

/** 状态配色（chip 用）：订单卡与订单列表的状态分组头共用 */
export const STATUS_STYLE: Record<OrderStatus, string> = {
  pending: 'bg-warn/15 text-[#B45309]',
  cooking: 'bg-brand-100 text-brand-600',
  done: 'bg-fresh/10 text-fresh',
  cancelled: 'bg-cream-300 text-ink-400',
};

interface Action {
  label: string;
  /** 状态机流转目标；顺延按钮不走状态机，点了展开选日期的弹层 */
  next?: OrderStatus;
  defer?: boolean;
  icon: typeof Check;
  tone: 'primary' | 'soft' | 'ghost';
}

function actionsFor(status: OrderStatus, canDefer: boolean): Action[] {
  if (status === 'pending') {
    const actions: Action[] = [{ label: '接单备料', next: 'cooking', icon: ChefHat, tone: 'primary' }];
    // 做不了这餐时的出路：顺延（原样挪到之后某天）比直接取消温和，所以紧挨着主按钮
    if (canDefer) actions.push({ label: '顺延', icon: FastForward, tone: 'ghost', defer: true });
    actions.push({ label: '取消', next: 'cancelled', icon: X, tone: 'ghost' });
    return actions;
  }
  if (status === 'cooking') {
    return [
      { label: '做好了', next: 'done', icon: Check, tone: 'primary' },
      { label: '退回待接', next: 'pending', icon: Undo2, tone: 'soft' },
    ];
  }
  if (status === 'done') {
    return [{ label: '重新开做', next: 'cooking', icon: RotateCcw, tone: 'soft' }];
  }
  return [{ label: '恢复', next: 'pending', icon: Undo2, tone: 'soft' }];
}

export function OrderCard({
  order,
  isNew,
  /** 大厨页未选大厨时置 true：接单/做好这些会记做菜人的按钮被锁住，防止再出现「未记名」 */
  statusLocked,
  onStatusChange,
  /** 传了才显示「顺延」：目前只有大厨看板传，点菜人那边不给这个入口 */
  onDefer,
  onDelete,
  recipes,
  me,
  feedbacksByDish,
  onLoadFeedback,
}: {
  order: Order;
  isNew?: boolean;
  statusLocked?: boolean;
  onStatusChange: (status: OrderStatus) => void;
  /** 传了才显示「顺延」：目前只有大厨看板传，点菜人那边不给这个入口 */
  onDefer?: (mealDate: string) => void;
  onDelete?: () => void;
  /** dish_id → 菜谱摘要：传了菜名行才能点开，下拉里是配料+做法+反馈栏 */
  recipes?: Map<number, SummaryDish>;
  /** 反馈栏展示的当前人；不传按匿名提交 */
  me?: { id: number; name: string; avatar: string; color: string } | null;
  /** 按菜缓存的反馈列表：展开时展示，提交/删除后由页面刷新 */
  feedbacksByDish?: Record<number, DishFeedback[]>;
  /** 展开某道菜或反馈增删后，拉这道菜的最新反馈 */
  onLoadFeedback?: (dishId: number) => void;
}) {
  const time = order.created_at.slice(11, 16);
  // 自选日期的默认值 = 顺延一天；面板开着时保留上次选的日子
  const [deferOpen, setDeferOpen] = useState(false);
  const [deferDate, setDeferDate] = useState(() => shiftDay(order.meal_date, 1));
  // 删除是不可逆的，先弹确认（与删菜/删家人同一套交互）
  const [deleteOpen, setDeleteOpen] = useState(false);
  // 卡片里展开做法的那道菜（记下标，一张卡一次只开一道）
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <article
      className={cn(
        'card animate-fade-up p-3',
        isNew && 'ring-2 ring-brand-400/60 animate-pulse-ring',
        order.status === 'cancelled' && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-full text-lg"
          style={{ backgroundColor: `${order.member.color}22` }}
        >
          {order.member.avatar}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold">
            {order.member.name}
            <span className="ml-1.5 text-[11px] font-normal text-ink-400">
              {MEAL_LABEL[order.meal_type]} · {time} · {order.headcount} 人
            </span>
          </p>
          <p className="truncate text-[11px] text-ink-400">#{order.id} · {order.items.length} 道菜</p>
        </div>
        <span className={cn('chip shrink-0', STATUS_STYLE[order.status])}>
          {isNew ? '新订单' : STATUS_LABEL[order.status]}
        </span>
      </div>

      <ul className="mt-2.5 space-y-1 rounded-xl2 bg-cream-100/80 p-2.5">
        {order.items.map((item, index) => {
          // 有菜谱摘要的菜才能点开：下拉里是配料+做法+反馈栏，做菜时不用再去别处对照
          const recipe = item.dish_id != null ? recipes?.get(item.dish_id) : undefined;
          const open = openIdx === index;
          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={!recipe}
                aria-expanded={open}
                onClick={() => {
                  setOpenIdx(open ? null : index);
                  // 展开时才拉这道菜的反馈（缓存过也会重拉一遍，保证最新）
                  if (!open && item.dish_id != null) onLoadFeedback?.(item.dish_id);
                }}
                className={cn('flex w-full items-center gap-2 rounded-lg text-left text-[13px]', recipe && 'press')}
              >
                <span className="text-base">{item.emoji}</span>
                <span className="flex-1 truncate">{item.name}</span>
                <span className="shrink-0 text-ink-400">× {item.servings}</span>
                {recipe ? (
                  <ChevronDown
                    size={14}
                    className={cn('shrink-0 text-ink-400 transition', open && 'rotate-180')}
                  />
                ) : null}
              </button>
              {open && recipe ? (
                <div className="mt-1.5 overflow-hidden rounded-xl2 border border-brand-300 bg-white">
                  <DishRecipeDetail dish={recipe} />
                  {item.dish_id != null ? (
                    <DishFeedbackBar
                      dishId={item.dish_id}
                      feedbacks={feedbacksByDish?.[item.dish_id] ?? []}
                      me={me ?? null}
                      onChanged={() => {
                        if (item.dish_id != null) onLoadFeedback?.(item.dish_id);
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {order.note ? (
        <p className="mt-2 rounded-xl2 bg-warn/10 px-2.5 py-1.5 text-[12px] text-[#8A4B00]">备注：{order.note}</p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        {actionsFor(order.status, Boolean(onDefer)).map((action) => {
          // 记名按钮 = 会开做菜记录的流转（接单备料/做好了/重新开做）；未选大厨时锁住并提示
          const locked = Boolean(statusLocked && !action.defer && (action.next === 'cooking' || action.next === 'done'));
          return (
            <button
              key={action.defer ? 'defer' : (action.next ?? action.label)}
              type="button"
              onClick={() => {
                if (locked) {
                  toast('先在上方选好大厨，开工才有记录', 'error');
                  return;
                }
                if (action.defer) setDeferOpen((value) => !value);
                else onStatusChange(action.next as OrderStatus);
              }}
              className={cn(
                'press flex h-8 flex-1 items-center justify-center gap-1 rounded-full text-[12px] font-medium transition',
                action.tone === 'primary' && 'warm-gradient text-white shadow-float',
                action.tone === 'soft' && 'bg-brand-50 text-brand-600',
                action.tone === 'ghost' && 'bg-cream-200 text-ink-600',
                locked && 'opacity-40',
              )}
            >
              <action.icon size={13} />
              {action.label}
            </button>
          );
        })}
        {onDelete ? (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            aria-label="删除订单"
            className="press flex h-8 w-8 items-center justify-center rounded-full bg-alert/10 text-alert"
          >
            <Trash2 size={13} />
          </button>
        ) : null}
      </div>

      <ConfirmSheet
        open={deleteOpen}
        title="删除订单"
        confirmLabel="确认删除"
        cancelLabel="先不删"
        summary={
          <div className="flex items-center gap-3 rounded-xl2 bg-cream-100 p-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl"
              style={{ backgroundColor: `${order.member.color}22` }}
            >
              {order.member.avatar}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold">
                {order.member.name} · {MEAL_LABEL[order.meal_type]}
              </p>
              <p className="truncate text-[11px] text-ink-400">
                {relativeDayLabel(order.meal_date)} · {order.items.length} 道菜
              </p>
            </div>
          </div>
        }
        warning="删除后这张单的菜品会从大厨看板、合并备料和采购清单里消失，点菜人那边也会看到它没了；手动添加的采购项会保留。删除不能撤销，已经记下的做菜统计会保留在汇总里。"
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false);
          onDelete?.();
        }}
      />

      {/* 顺延选日期：快捷档直接点（以订单当前日期往后数），自选日期走系统日期选择器。
          允许选回今天——误顺延的单从这里就能拉回来，不用删了重点 */}
      {deferOpen && order.status === 'pending' && onDefer ? (
        <div className="mt-2 rounded-xl2 bg-cream-100 p-2.5">
          <p className="text-[11px] leading-4 text-ink-400">
            整单挪到哪天？菜和份数原样带走，点菜人那边会同步看到。
          </p>
          <div className="mt-2 flex gap-1.5">
            {[1, 2, 3].map((days) => {
              const iso = shiftDay(order.meal_date, days);
              // 「10月14日 周三」在三个并排的快捷档里放不下，带星期时只留日期；明天/后天保持原样
              const raw = relativeDayLabel(iso);
              const label = raw.includes(' ') ? raw.split(' ')[0] : raw;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => onDefer(iso)}
                  className="press flex-1 truncate rounded-full bg-white px-1 py-1.5 text-[12px] font-medium text-brand-600 shadow-card"
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="date"
              value={deferDate}
              min={todayISO()}
              onChange={(event) => setDeferDate(event.target.value)}
              aria-label="自选顺延日期"
              className="h-8 min-w-0 flex-1 rounded-lg border border-cream-300 bg-white px-2 text-[12px] text-ink-600"
            />
            <button
              type="button"
              disabled={!deferDate || deferDate === order.meal_date}
              onClick={() => onDefer(deferDate)}
              className="press h-8 shrink-0 rounded-full bg-brand-500 px-3.5 text-[12px] font-medium text-white disabled:opacity-40"
            >
              确定
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
