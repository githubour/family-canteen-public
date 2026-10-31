import { Check, PencilLine, X } from 'lucide-react';
import type { MealType, PurchaseItem } from '../api/types';
import { cn } from './ui/base';

/** 跨餐小标用短字，省地方：午·晚 · 番茄炒蛋 · 酿豆腐 */
const MEAL_SHORT: Record<MealType, string> = { breakfast: '早', lunch: '午', dinner: '晚' };

/** 采购条目：大字显示「买多少」，勾选与改量都在这行完成 */
export function PurchaseRow({
  item,
  onToggle,
  onEdit,
  onRemove,
}: {
  item: PurchaseItem;
  onToggle: () => void;
  /** 手动条目没有系统数量可改，不传就不显示铅笔 */
  onEdit?: () => void;
  /** 手动条目的移除（自动条目走改量弹层里的「这一餐不要」） */
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl2 border bg-white px-3 py-2.5 transition',
        item.checked ? 'border-fresh/30 bg-fresh/5' : 'border-cream-300/70',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={item.checked ? '取消已买' : '标记已买'}
        className={cn(
          'press flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition',
          item.checked ? 'border-fresh bg-fresh text-white' : 'border-cream-400 text-transparent',
        )}
      >
        <Check size={13} strokeWidth={3.2} />
      </button>

      <button
        type="button"
        onClick={onEdit}
        disabled={!onEdit}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <p className={cn('text-[14px] font-semibold', item.checked && 'text-ink-400 line-through')}>
          {item.name}
          {item.is_custom ? (
            <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-normal text-brand-500">
              手动
            </span>
          ) : null}
          {item.overridden ? (
            <span className="ml-1.5 rounded-full bg-cool/10 px-1.5 py-0.5 text-[10px] font-normal text-cool">
              已改量
            </span>
          ) : null}
        </p>
        <p className="truncate text-[11px] text-ink-400">
          {/* 只在跨餐条目上标「午·晚」：单餐的不用标，标了全是噪音 */}
          {item.meals.length > 1 ? (
            <span className="mr-1 font-medium text-ink-600">
              {item.meals.map((meal) => MEAL_SHORT[meal]).join('·')} ·
            </span>
          ) : null}
          {item.from_dishes.length > 0 ? item.from_dishes.join(' · ') : '手动添加'}
          {item.note ? ` · ${item.note}` : ''}
        </p>
      </button>

      <div className="shrink-0 text-right">
        <p
          className={cn(
            'text-[13px] font-semibold tabular-nums',
            item.checked ? 'text-ink-400' : 'text-brand-600',
          )}
        >
          {item.amount_text}
        </p>
        {item.price != null ? (
          <p className="text-[10px] text-ink-400">约 ¥{((item.price * item.amount) / 100).toFixed(1)}</p>
        ) : null}
      </div>

      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除 ${item.name}`}
          className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#FF453A]/10 text-[#FF453A]"
        >
          <X size={13} strokeWidth={3} />
        </button>
      ) : onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label="修改数量"
          className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cream-200 text-ink-600"
        >
          <PencilLine size={13} />
        </button>
      ) : null}
    </div>
  );
}
