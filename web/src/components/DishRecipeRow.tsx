import { ChevronDown } from 'lucide-react';
import type { MealSummary } from '../api/types';
import { DishRecipeDetail } from './DishRecipeDetail';
import { Badge, cn } from './ui/base';

type SummaryDish = MealSummary['dishes'][number];

/**
 * 大厨做菜时的食谱行：菜名行，展开后是每人份配料与编号步骤。
 * 「大厨」页的「这一餐的菜谱」卡片和「合并备料」弹层共用，
 * 展开状态由使用方保管（两处各自记住展开的是哪道菜）。
 */
export function DishRecipeRow({
  dish,
  expanded,
  onToggle,
}: {
  dish: SummaryDish;
  expanded: boolean;
  onToggle: () => void;
}) {
  const stepLines = dish.steps.split('\n').filter((line) => line.trim() !== '');
  const expandable = stepLines.length > 0 || dish.ingredients.length > 0;

  return (
    <div className={cn('rounded-xl2 border bg-white transition', expanded ? 'border-brand-300' : 'border-cream-300')}>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn('flex w-full items-center gap-3 p-3 text-left', expandable && 'press')}
      >
        {dish.image_url ? (
          <img
            src={dish.image_url}
            alt={dish.name}
            loading="lazy"
            decoding="async"
            className="h-9 w-9 shrink-0 rounded-xl2 object-cover"
          />
        ) : (
          <span className="text-2xl">{dish.emoji}</span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold">{dish.name}</p>
          <p className="text-[11px] text-ink-400">
            {/* 已彻底删除的菜用的是订单快照，没有时长（0 不显示） */}
            {dish.cook_minutes > 0 ? `${dish.cook_minutes} 分钟 · ` : ''}来自 {dish.order_count} 份点单
            {expandable ? '' : ' · 还没写做法'}
          </p>
        </div>
        {dish.is_fried ? <Badge tone="alert">油炸</Badge> : <Badge tone="neutral">{dish.category}</Badge>}
        <span className="shrink-0 text-[15px] font-semibold text-brand-600">× {dish.servings}</span>
        {expandable ? (
          <ChevronDown size={16} className={cn('shrink-0 text-ink-400 transition', expanded && 'rotate-180')} />
        ) : null}
      </button>

      {expanded ? (
        <div className="border-t border-cream-200">
          <DishRecipeDetail dish={dish} />
        </div>
      ) : null}
    </div>
  );
}
