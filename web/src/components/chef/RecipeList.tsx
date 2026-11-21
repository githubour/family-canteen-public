import type { MealSummary } from '../../api/types';
import { DishRecipeRow } from '../DishRecipeRow';

/**
 * 这一餐要做的菜：每道菜的配料与做法点菜名展开。
 * 「大厨」页的菜谱卡片与「合并备料」弹层共用同一份组件，
 * 展开的是哪道菜由使用方各记一份（两处互不影响）。
 */
/**
 * 备料行的展开标识：菜品还在时用 dish_id，被彻底删除的菜退回快照菜名——
 * 否则多道已删菜会挤在同一个 null 上一起展开。
 */
function dishRowKey(dish: MealSummary['dishes'][number]): string {
  return dish.dish_id != null ? `d${dish.dish_id}` : `s${dish.name}`;
}

export function RecipeList({
  dishes,
  expandedId,
  onToggle,
}: {
  dishes: MealSummary['dishes'];
  expandedId: string | null;
  onToggle: (rowKey: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      {dishes.map((dish) => {
        const rowKey = dishRowKey(dish);
        return (
          <DishRecipeRow
            key={rowKey}
            dish={dish}
            expanded={expandedId === rowKey}
            onToggle={() => onToggle(expandedId === rowKey ? null : rowKey)}
          />
        );
      })}
    </div>
  );
}
