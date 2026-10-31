import type { Dish, MealType } from '../../api/types';
import { Badge, Button } from '../ui/base';
import { Sheet } from '../ui/feedback';

/** 「配一桌」结果弹层：按结构挑好的菜，可以直接全加，也可以换一批 */
export function ComboSheet({
  dishes,
  mealType,
  headcount,
  onClose,
  onRebuild,
  onAddAll,
}: {
  /** null = 关闭 */
  dishes: Dish[] | null;
  mealType: MealType;
  headcount: number;
  onClose: () => void;
  onRebuild: () => void;
  onAddAll: () => void;
}) {
  return (
    <Sheet
      open={Boolean(dishes)}
      onClose={onClose}
      title={mealType === 'breakfast' ? `为 ${headcount} 人配的早餐` : `为 ${headcount} 人配的一桌`}
    >
      <div className="pb-4">
        <p className="mb-3 text-[12px] text-ink-400">
          {mealType === 'breakfast'
            ? '早餐按「主食 + 一样搭配」挑的，可以直接用，也可以换掉不喜欢的。'
            : '按「蔬菜 + 荤菜 + 汤」的结构挑的，可以直接用，也可以换掉不喜欢的。'}
        </p>
        <div className="space-y-2">
          {(dishes ?? []).map((dish) => (
            <div key={dish.id} className="flex items-center gap-3 rounded-xl2 border border-cream-300 bg-white p-3">
              <span className="text-2xl">{dish.emoji}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold">{dish.name}</p>
                <p className="text-[11px] text-ink-400">
                  {dish.category} · {dish.cook_minutes} 分钟 · {dish.nutrition.kcal} kcal
                </p>
              </div>
              <Badge tone="neutral">{dish.spicy ? '辣' : '不辣'}</Badge>
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" block onClick={onRebuild}>
            换一批
          </Button>
          <Button block onClick={onAddAll}>
            全部加入
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
