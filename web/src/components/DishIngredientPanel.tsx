import { Leaf } from 'lucide-react';
import { api } from '../api/client';
import type { Dish } from '../api/types';
import { DishPanelShell } from './DishPanelShell';
import { cn } from './ui/base';
import { useDishPatch } from '../hooks/useDishPatch';

/**
 * 菜品配料的「必有 / 可选」开关。
 *
 * 必有 = 缺了这道菜不成立，点菜页按必有食材的命中情况排序（核心齐的排前面）、采购时必买；
 * 可选 = 缺了只是口味打折，家里没有跳过就行、也不计入必买。
 * 标记挂在菜品 × 食材的关联行上，同一食材在不同菜里身份可以不同
 * （大葱在番茄炒蛋里可有可无，在葱油拌面里是主角）。
 */
export function DishIngredientPanel({ dish, onUpdated }: { dish: Dish; onUpdated?: (dish: Dish) => void }) {
  const { current, busy, patch } = useDishPatch(dish, onUpdated);

  const requiredCount = current.ingredients.filter((item) => item.required).length;
  const optionalCount = current.ingredients.length - requiredCount;

  /** 切换一样配料的必选性；成功不弹提示（连点几下太吵），失败才说话 */
  const setRequired = (ingredientId: number, required: boolean) =>
    patch(() => api.dishes.updateIngredientRequired(current.id, ingredientId, required), {
      error: '没改上，请重试',
    });

  return (
    <DishPanelShell
      icon={<Leaf size={14} className="text-brand-500" />}
      title="配料的必有 / 可选"
      badge={`必有 ${requiredCount} · 可选 ${optionalCount}`}
      badgeClass="bg-cream-200 text-ink-600"
    >
      <p className="mt-2 text-[11px] leading-4 text-ink-400">
        必有是缺了这道菜就不成立的核心料，点菜页按它排序、采购时必买；
        可选缺了只是口味打折，家里没有跳过就行、也不计入必买。
      </p>

      {current.ingredients.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-400">这道菜还没有配料表。</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {current.ingredients.map((item) => (
            <div
              key={item.ingredient_id}
              className="flex items-center gap-2 rounded-xl2 border border-cream-300 bg-white px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-600">
                {item.name}
                <span className="ml-1 text-ink-400">{item.amount}g</span>
                {item.is_pantry ? <span className="ml-1 text-[10px] text-ink-400">常备</span> : null}
              </span>
              <div className="flex shrink-0 gap-0.5">
                {([true, false] as const).map((value) => {
                  const on = item.required === value;
                  return (
                    <button
                      key={value ? 'required' : 'optional'}
                      type="button"
                      disabled={busy || on}
                      aria-pressed={on}
                      aria-label={`把「${item.name}」设为${value ? '必有' : '可选'}`}
                      onClick={() => void setRequired(item.ingredient_id, value)}
                      className={cn(
                        'press h-6 rounded-full px-2 text-[11px] font-medium transition disabled:cursor-default',
                        on
                          ? value
                            ? 'bg-brand-500 text-white'
                            : 'bg-cream-200 text-ink-600'
                          : 'text-ink-400 hover:bg-cream-100',
                      )}
                    >
                      {value ? '必有' : '可选'}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-[11px] leading-4 text-ink-400">
        标「常备」的调料默认家里都有、本来就不参与「缺不缺」的判定，这里选完只是把口径记下来。
      </p>
    </DishPanelShell>
  );
}
