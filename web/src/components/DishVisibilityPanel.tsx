import { CalendarClock, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import type { Dish } from '../api/types';
import { DishPanelShell } from './DishPanelShell';
import { ChoiceChip } from './ui/base';
import { useDishPatch } from '../hooks/useDishPatch';
import { currentMonthKey, monthKeyLabel, monthsSummary, snoozeMonthKey } from '../lib/format';

const SNOOZE_OPTIONS = [
  { label: '歇 1 周', days: 7 },
  { label: '歇 1 个月', days: 31 },
  { label: '歇 3 个月', days: 92 },
  { label: '歇半年', days: 183 },
] as const;

const ALL_MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

/**
 * 菜品显示安排：季节窗口（每年固定月份出现）+「歇菜」（藏到某个月自动回来）。
 * 只影响点菜页 / 随机 / 配一桌的默认菜单，历史订单与营养汇总不受影响；
 * 被藏起来的菜在「后台汇总 → 设置 → 菜品」里找得回来。
 */
export function DishVisibilityPanel({ dish, onUpdated }: { dish: Dish; onUpdated?: (dish: Dish) => void }) {
  const { current, busy, patch } = useDishPatch(dish, onUpdated);

  const hiddenNow = current.hide_until !== '' && current.hide_until > currentMonthKey();
  const seasonal = current.season_months.length > 0;

  const apply = (payload: { season_months?: number[]; hide_until?: string }, message: string) =>
    patch(() => api.dishes.updateVisibility(current.id, payload), { success: () => message });

  const toggleMonth = (month: number) => {
    const next = current.season_months.includes(month)
      ? current.season_months.filter((m) => m !== month)
      : [...current.season_months, month].sort((a, b) => a - b);
    return apply(
      { season_months: next },
      next.length > 0
        ? `「${current.name}」只在 ${monthsSummary(next)} 出现`
        : `「${current.name}」恢复全年显示`,
    );
  };

  return (
    <DishPanelShell
      icon={<CalendarClock size={14} className="text-brand-500" />}
      title="显示安排"
      badge={
        hiddenNow
          ? `歇到 ${monthKeyLabel(current.hide_until)}`
          : seasonal
            ? `只在 ${monthsSummary(current.season_months)}`
            : '全年显示'
      }
      badgeClass={
        hiddenNow ? 'bg-warn/10 text-[#8A4B00]' : seasonal ? 'bg-cool/10 text-cool' : 'bg-cream-200 text-ink-400'
      }
    >
      {/* 歇一阵：按月粒度恢复，短歇会自动顺延到下个月起 */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {SNOOZE_OPTIONS.map((option) => (
          <button
            key={option.days}
            type="button"
            disabled={busy}
            onClick={() =>
              void apply(
                { hide_until: snoozeMonthKey(option.days) },
                `已把「${current.name}」歇到 ${monthKeyLabel(snoozeMonthKey(option.days))}`,
              )
            }
            className="press h-7 rounded-full border border-cream-300 bg-white px-2.5 text-[12px] font-medium text-ink-600 transition hover:border-brand-300 disabled:opacity-50"
          >
            {option.label}
          </button>
        ))}
        <input
          type="month"
          value={current.hide_until}
          min={currentMonthKey()}
          disabled={busy}
          aria-label="歇到指定月份"
          onChange={(event) => {
            const value = event.target.value;
            if (value) void apply({ hide_until: value }, `已把「${current.name}」歇到 ${monthKeyLabel(value)}`);
          }}
          className="h-7 rounded-full border border-cream-300 bg-white px-2.5 text-[12px] text-ink-600 disabled:opacity-50"
        />
        {hiddenNow ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply({ hide_until: '' }, `「${current.name}」已恢复显示`)}
            className="press flex h-7 items-center gap-1 rounded-full bg-fresh/10 px-2.5 text-[12px] font-medium text-fresh disabled:opacity-50"
          >
            <RotateCcw size={12} />
            提前恢复
          </button>
        ) : null}
      </div>

      {/* 季节窗口：点亮 = 只在这些月份出现，全不点 = 全年显示 */}
      <p className="mt-3 text-[11px] leading-4 text-ink-400">
        应季菜只点亮出现的月份（都不点 = 全年显示），每年到月自动上桌、过月自动收起。
      </p>
      <div className="mt-1.5 grid grid-cols-6 gap-1.5">
        {ALL_MONTHS.map((month) => {
          const on = current.season_months.includes(month);
          return (
            <ChoiceChip
              key={month}
              active={on}
              size="sm"
              disabled={busy}
              className="h-7"
              onClick={() => void toggleMonth(month)}
            >
              {month} 月
            </ChoiceChip>
          );
        })}
      </div>
    </DishPanelShell>
  );
}
