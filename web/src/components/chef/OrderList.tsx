import {
  MEAL_EMOJI,
  MEAL_LABEL,
  MEAL_TYPES,
  STATUS_LABEL,
  type DishFeedback,
  type MealType,
  type Order,
  type OrderStatus,
} from '../../api/types';
import { OrderCard, STATUS_STYLE } from '../OrderCard';
import type { SummaryDish } from '../DishRecipeDetail';
import { Button, cn } from '../ui/base';
import { EmptyState, ErrorState, Skeleton } from '../ui/feedback';
import type { Filter } from './types';

/** 状态分组顺序：待接单排最前，已取消垫底 */
const STATUS_ORDER: OrderStatus[] = ['pending', 'cooking', 'done', 'cancelled'];

/**
 * 订单区（全天版）：先按餐别分组，餐别里再按状态小节展示，
 * 当天要做什么一目了然；状态筛选（filter）在上层已套用，这里只管分组呈现。
 */
export function OrderList({
  orders,
  loading,
  error,
  onRetry,
  filter,
  newIds,
  canViewPrep,
  /** 未选大厨时锁住订单卡上的记名按钮（接单/做好） */
  statusLocked,
  onOpenPrep,
  onStatusChange,
  onDefer,
  onDelete,
  recipes,
  me,
  feedbacksByDish,
  onLoadFeedback,
}: {
  orders: Order[];
  loading: boolean;
  /** 拉取失败：没有旧数据时给出重试入口，避免看板一直空着 */
  error?: string | null;
  onRetry?: () => void;
  filter: Filter;
  newIds: number[];
  canViewPrep: boolean;
  statusLocked?: boolean;
  onOpenPrep: () => void;
  onStatusChange: (orderId: number, status: OrderStatus) => void;
  onDefer: (orderId: number, mealType: MealType, mealDate: string) => void;
  onDelete: (orderId: number) => void;
  /** dish_id → 菜谱摘要：传了订单卡里的菜名才能点开看做法 */
  recipes?: Map<number, SummaryDish>;
  me?: { id: number; name: string; avatar: string; color: string } | null;
  feedbacksByDish?: Record<number, DishFeedback[]>;
  onLoadFeedback?: (dishId: number) => void;
}) {
  // 餐别 → 状态两级分组：没有订单的餐别、没有订单的状态小节都不出现
  const groups = MEAL_TYPES.map((meal) => ({
    meal,
    statuses: STATUS_ORDER.map((status) => ({
      status,
      list: orders.filter((order) => order.meal_type === meal && order.status === status),
    })).filter((section) => section.list.length > 0),
  })).filter((group) => group.statuses.length > 0);

  return (
    <section className="mt-3 px-4">
      {error && orders.length === 0 ? (
        <ErrorState title="订单没加载出来" description={error} onRetry={onRetry} />
      ) : loading ? (
        <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-2.5">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          emoji="🍳"
          title={filter === 'all' ? '今天还没有订单' : `没有「${STATUS_LABEL[filter]}」的订单`}
          description={
            filter === 'all'
              ? '家人点完菜后，订单会实时出现在这里，也会推送提醒。'
              : '换个筛选条件看看，或者等家人下单。'
          }
          action={
            canViewPrep ? (
              <Button variant="soft" onClick={onOpenPrep}>
                看合并备料
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="space-y-4">
          {groups.map(({ meal, statuses }) => (
            <div key={meal} className="space-y-2">
              {/* 一级：餐别标题 + 全餐单数 */}
              <div className="flex items-center gap-1.5">
                <span className="text-[15px] leading-none">{MEAL_EMOJI[meal]}</span>
                <h2 className="text-[13px] font-bold">{MEAL_LABEL[meal]}</h2>
                <span className="rounded-full bg-cream-100 px-2 py-0.5 text-[11px] font-medium text-ink-500">
                  {statuses.reduce((sum, section) => sum + section.list.length, 0)} 单
                </span>
              </div>
              {statuses.map(({ status, list }) => (
                <div key={status} className="space-y-1.5">
                  {/* 二级：状态小节（沿用订单卡的状态配色） */}
                  <div className="flex items-center gap-1.5 pl-1">
                    <span className={cn('chip px-2 py-0.5 text-[10px]', STATUS_STYLE[status])}>
                      {STATUS_LABEL[status]}
                    </span>
                    <span className="text-[11px] text-ink-400">{list.length}</span>
                  </div>
                  <div
                    className={cn(
                      'space-y-2.5',
                      list.length > 1 && 'lg:grid lg:grid-cols-2 lg:items-start lg:gap-2.5 lg:space-y-0',
                    )}
                  >
                    {list.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        isNew={newIds.includes(order.id)}
                        statusLocked={statusLocked}
                        onStatusChange={(next) => onStatusChange(order.id, next)}
                        onDefer={(mealDate) => onDefer(order.id, order.meal_type, mealDate)}
                        onDelete={() => onDelete(order.id)}
                        recipes={recipes}
                        me={me}
                        feedbacksByDish={feedbacksByDish}
                        onLoadFeedback={onLoadFeedback}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
