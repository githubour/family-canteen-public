import { useState } from 'react';
import { CalendarClock, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import { MEAL_TAG_META, type Dish } from '../../api/types';
import { DishIngredientPanel } from '../DishIngredientPanel';
import { DishMealTagPanel } from '../DishMealTagPanel';
import { DishPhotoEditor } from '../DishPhotoEditor';
import { DishStepsEditor } from '../DishStepsEditor';
import { DishVisibilityPanel } from '../DishVisibilityPanel';
import { cn } from '../ui/base';
import { Skeleton, ErrorState } from '../ui/feedback';
import { toast } from '../ui/toast';
import { useAsync } from '../../hooks/useAsync';
import { groupBy } from '../../lib/collection';
import { currentMonthKey, monthKeyLabel, monthsSummary, relativeDateTime } from '../../lib/format';
import { runAction } from '../../lib/runAction';

/**
 * 菜品管理：点一下下架 / 恢复，右侧日历图标展开「实拍图 / 显示安排 / 餐别 / 做法 / 配料」。
 * 面板里改完的结果先回填到本地 overrides，行上的徽章不用等列表重新拉数。
 * 「彻底删除」走二次确认，确认层与删除请求都由 SettingsSheet 持有——
 * 它是独立弹层，必须渲染在主抽屉之外（主抽屉带 transform，嵌进去的 fixed 层会以它为包含块）。
 */
export function DishesTab({ onRequestDelete }: { onRequestDelete: (dish: Dish) => void }) {
  // includeInactive：被下架的菜也要能看到，否则移除之后就没法恢复了
  const dishes = useAsync(() => api.dishes.list({ includeInactive: true }), []);
  const [dishDraft, setDishDraft] = useState<Record<number, boolean>>({});
  const [dishOverrides, setDishOverrides] = useState<Record<number, Dish>>({});
  const [expandedDish, setExpandedDish] = useState<number | null>(null);

  const allDishes = dishes.data?.dishes ?? [];
  const loadFailed = dishes.error !== null && allDishes.length === 0;
  const activeOf = (dish: Dish) => dishDraft[dish.id] ?? dish.active;
  const activeCount = allDishes.filter(activeOf).length;
  const dishGroups = [...groupBy(allDishes, (dish) => dish.category).entries()];

  // 复核卡：每天 20:30 定时任务会把点菜建议自动建档，24 小时内置顶在这里
  // 过目（窗口与 cron 频率一比一，看过一天自然消失，不重复打扰），点一下即可下架否决。
  // 窗口外的历史新增交给下面的全量列表。
  const recentDishes = allDishes
    .filter((dish) => {
      const created = new Date(dish.created_at.replace(' ', 'T')).getTime();
      const age = Date.now() - created;
      return Number.isFinite(created) && age >= 0 && age <= 24 * 60 * 60 * 1000;
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const applyOverride = (next: Dish) => setDishOverrides((previous) => ({ ...previous, [next.id]: next }));

  const toggleDish = async (dish: Dish) => {
    const next = !activeOf(dish);
    setDishDraft((previous) => ({ ...previous, [dish.id]: next }));
    const ok = await runAction(
      () => api.dishes.setActive(dish.id, next),
      '操作失败',
      // 失败要把乐观改动撤回，否则界面在骗人
      () => setDishDraft((previous) => ({ ...previous, [dish.id]: !next })),
    );
    if (ok) toast(next ? `已恢复「${dish.name}」` : `已下架「${dish.name}」`, 'success');
  };

  return (
    <div className="space-y-3">
      <p className="rounded-xl2 bg-cream-200/70 px-3 py-2 text-[11px] leading-5 text-ink-400">
        点一下即可下架或恢复；右侧日历图标展开「实拍图 / 显示计划 / 餐别 / 做法 / 配料」——做好了拍一张，
        卡片就用真图；应季菜只在点亮月份出现，吃腻的菜可以歇到某个整月，到点自动回来；
        做法一行一步，写好后大厨在备料弹层里点菜名就能看；
        配料逐样标「必有 / 可选」——必有缺了这道菜不成立、点菜页按它排序，可选缺了跳过就行。
        下架与歇菜都不影响历史订单，被藏起来的菜在这里都能找回来；
        最右的垃圾桶是「彻底删除」——菜品与配料表一起清掉、不可撤销，
        但历史订单照旧：下单那一刻的菜名、份量与营养都留在订单里了。
      </p>
      {loadFailed ? null : (
        <p className="text-[12px] text-ink-400">
          共 {allDishes.length} 道 · 在售 {activeCount} · 已下架 {allDishes.length - activeCount}
        </p>
      )}
      {recentDishes.length > 0 ? (
        <div className="rounded-xl2 border border-cream-300 bg-cream-200/60 px-2.5 py-2">
          <p className="mb-1.5 text-[11px] leading-5 text-ink-400">
            <span className="font-semibold text-ink-600">最近新增（24 小时内）</span>
             点菜建议每天晚上自动建档，第二天在这里过一眼：不合口味点一下就下架，点错了再点一下恢复。
          </p>
          <div className="space-y-1.5">
            {recentDishes.map((dish) => (
              <button
                type="button"
                key={dish.id}
                onClick={() => void toggleDish(dish)}
                className={cn(
                  'press flex min-w-0 w-full items-center justify-between gap-2 rounded-xl2 border border-cream-300 bg-white px-3 py-2 text-left transition',
                  !activeOf(dish) && 'opacity-60',
                )}
              >
                <span className="min-w-0 truncate text-[13px]">
                  <span className="mr-1">{dish.emoji}</span>
                  {dish.name}
                  <span className="ml-1.5 text-[11px] text-ink-400">
                    {dish.nutrition.kcal} kcal · {relativeDateTime(dish.created_at)}
                  </span>
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                    activeOf(dish) ? 'bg-fresh/10 text-fresh' : 'bg-cream-200 text-ink-400',
                  )}
                >
                  {activeOf(dish) ? '在售 · 点下架' : '已下架 · 点恢复'}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {dishes.loading ? (
        <Skeleton className="h-40 w-full" />
      ) : loadFailed ? (
        <ErrorState title="菜单没加载出来" description={dishes.error} onRetry={dishes.reload} />
      ) : (
        dishGroups.map(([category, items]) => (
          <div key={category}>
            <p className="mb-1.5 text-[12px] font-semibold text-ink-600">
              {category}
              <span className="ml-1.5 font-normal text-ink-400">
                {items.filter(activeOf).length}/{items.length}
              </span>
            </p>
            <div className="space-y-1.5">
              {items.map((rawDish) => {
                // 面板里改完显示安排，先用回填的最新数据渲染，不等重新拉数
                const dish = dishOverrides[rawDish.id] ?? rawDish;
                const active = activeOf(dish);
                const hiddenNow = dish.hide_until !== '' && dish.hide_until > currentMonthKey();
                const seasonal = dish.season_months.length > 0;
                return (
                  <div key={dish.id}>
                    <div className="flex items-stretch gap-1.5">
                      <button
                        type="button"
                        onClick={() => void toggleDish(dish)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl2 border border-cream-300 bg-white px-3 py-2 text-left transition',
                          !active && 'opacity-60',
                        )}
                      >
                        <span className="min-w-0 truncate text-[13px]">
                          <span className="mr-1">{dish.emoji}</span>
                          {dish.name}
                          <span className="ml-1.5 text-[11px] text-ink-400">
                            {dish.cook_minutes} 分钟 · {dish.nutrition.kcal} kcal
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {hiddenNow ? (
                            <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] text-[#8A4B00]">
                              歇到 {monthKeyLabel(dish.hide_until)}
                            </span>
                          ) : null}
                          {seasonal ? (
                            <span className="rounded-full bg-cool/10 px-2 py-0.5 text-[11px] text-cool">
                              仅 {monthsSummary(dish.season_months)}
                            </span>
                          ) : null}
                          {dish.meal_types.map((meal) => (
                            <span
                              key={meal}
                              className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', MEAL_TAG_META[meal].chip)}
                            >
                              {MEAL_TAG_META[meal].label}
                            </span>
                          ))}
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[11px]',
                              active ? 'bg-fresh/10 text-fresh' : 'bg-cream-200 text-ink-400',
                            )}
                          >
                            {active ? '在售' : '已下架'}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`${dish.name} 的安排与做法`}
                        onClick={() => setExpandedDish(expandedDish === dish.id ? null : dish.id)}
                        className={cn(
                          'press flex w-9 shrink-0 items-center justify-center rounded-xl2 border transition',
                          expandedDish === dish.id
                            ? 'border-brand-300 bg-brand-50 text-brand-600'
                            : 'border-cream-300 bg-white text-ink-400',
                        )}
                      >
                        <CalendarClock size={15} />
                      </button>
                      <button
                        type="button"
                        aria-label={`彻底删除 ${dish.name}`}
                        onClick={() => onRequestDelete(dish)}
                        className="press flex w-9 shrink-0 items-center justify-center rounded-xl2 border border-cream-300 bg-white text-ink-400 transition hover:border-alert/40 hover:text-alert"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {expandedDish === dish.id ? (
                      <div className="mt-1.5 space-y-1.5">
                        <DishPhotoEditor dish={dish} onUpdated={applyOverride} />
                        <DishVisibilityPanel dish={dish} onUpdated={applyOverride} />
                        <DishMealTagPanel dish={dish} onUpdated={applyOverride} />
                        <DishStepsEditor dish={dish} onUpdated={applyOverride} />
                        <DishIngredientPanel dish={dish} onUpdated={applyOverride} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
