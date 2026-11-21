import { UtensilsCrossed } from 'lucide-react';
import { api } from '../api/client';
import { MEAL_TAG_META, MEAL_TYPES, type Dish, type MealType } from '../api/types';
import { DishPanelShell } from './DishPanelShell';
import { ChoiceChip } from './ui/base';
import { useDishPatch } from '../hooks/useDishPatch';

/**
 * 菜品餐别标签：标了早餐 / 午餐 / 晚餐中的哪几餐，可多选，都不标 = 通用菜。
 * 点菜页切到某个餐别时，标了该餐别的菜排前面、其余垫底；
 * 「帮我配一桌 / 随机」也优先从本餐别的菜里挑。
 * 只影响展示层排序，历史订单与营养汇总不受影响。
 */
export function DishMealTagPanel({ dish, onUpdated }: { dish: Dish; onUpdated?: (dish: Dish) => void }) {
  const { current, busy, patch } = useDishPatch(dish, onUpdated);

  const toggle = (meal: MealType) => {
    const next = current.meal_types.includes(meal)
      ? current.meal_types.filter((item) => item !== meal)
      : [...current.meal_types, meal];
    return patch(() => api.dishes.updateMealTypes(current.id, next), {
      success: () =>
        next.length > 0
          ? `「${current.name}」已标为 ${next.map((item) => MEAL_TAG_META[item].label).join('、')}适用`
          : `「${current.name}」已恢复通用菜`,
    });
  };

  return (
    <DishPanelShell
      icon={<UtensilsCrossed size={14} className="text-brand-500" />}
      title="餐别标签"
      badge={
        current.meal_types.length > 0
          ? `${current.meal_types.map((item) => MEAL_TAG_META[item].label).join('、')}适用`
          : '通用菜'
      }
      badgeClass={current.meal_types.length > 0 ? 'bg-brand-50 text-brand-600' : 'bg-cream-200 text-ink-400'}
    >
      <p className="mt-2 text-[11px] leading-4 text-ink-400">
        点亮这道菜适合的餐别（可多选，都不点 = 通用菜）。点菜页切到对应餐别时它排前面，
        不带标签的菜照常显示、排在后面。
      </p>
      <div className="mt-2 flex gap-1.5">
        {MEAL_TYPES.map((meal) => {
          const on = current.meal_types.includes(meal);
          const meta = MEAL_TAG_META[meal];
          return (
            <ChoiceChip
              key={meal}
              active={on}
              disabled={busy}
              aria-pressed={on}
              aria-label={`把「${current.name}」标为${meta.label}适用`}
              activeClassName={meta.chip}
              className="flex h-8 flex-1 items-center justify-center gap-1"
              onClick={() => void toggle(meal)}
            >
              <span aria-hidden>{meta.emoji}</span>
              {meta.label}
            </ChoiceChip>
          );
        })}
      </div>
    </DishPanelShell>
  );
}
