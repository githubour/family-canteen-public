import { useMemo } from 'react';
import { BookOpen, CalendarDays } from 'lucide-react';
import { MEAL_LABEL, type Dish, type DishFeedback, type MealType, type Member } from '../../api/types';
import { DAY_OFFSETS, dayOffsetLabel } from '../../lib/format';
import { DishFeedbackBar } from '../DishFeedbackBar';
import { DishPhotoEditor } from '../DishPhotoEditor';
import { DishVisibilityPanel } from '../DishVisibilityPanel';
import { mealDateFromOffset } from '../../store/cart';
import { Badge, Button, cn } from '../ui/base';
import { Sheet } from '../ui/feedback';
import { DishHideTrigger } from './DishHideConfirmSheet';

const SERVING_OPTIONS = [1, 2, 3];

/**
 * 菜品详情弹层：头图 + 营养三宫格 + 配料 + 做法 + 选天 + 份数 + 加购，
 * 下面接反馈栏（给大模型的改菜线索）与显示安排面板（季节窗口 / 歇菜）。
 * 反馈数据按 dish_id 缓存在页面里，这里只负责展示与转发 onFeedbackChanged。
 */
export function DishDetailSheet({
  dish,
  stockIds,
  mealType,
  onClose,
  feedbacks,
  me,
  onFeedbackChanged,
  onDishUpdated,
  cartServings,
  servings,
  onSelectServings,
  day,
  onSelectDay,
  onAdd,
  onRequestHide,
}: {
  /** null = 关闭 */
  dish: Dish | null;
  /** 冰箱库存里有的食材 id 集合：配料里命中的标绿，一眼看出哪些不用买 */
  stockIds: Set<number>;
  /** 点菜目标餐次：加入时用它，页面上说清楚，避免"以为加的是午餐、结果进了晚餐" */
  mealType: MealType;
  onClose: () => void;
  feedbacks: DishFeedback[];
  me: Member | null;
  onFeedbackChanged: () => void;
  /** 家人在弹层里传了实拍图：把弹层里的 dish 换成最新版（列表由 SSE/reload 兜底） */
  onDishUpdated?: (dish: Dish) => void;
  /** 购物车里已有几份（undefined = 还没加过；跨天合计） */
  cartServings: number | undefined;
  servings: number;
  onSelectServings: (servings: number) => void;
  /** 给哪天吃：0 = 今天，1 = 明天，2 = 后天。打开弹层时默认跟随点菜目标 */
  day: number;
  onSelectDay: (day: number) => void;
  onAdd: (dish: Dish, servings: number, target: { mealDate: string }) => void;
  onRequestHide: (dish: Dish) => void;
}) {
  // 做法：一行一步，忽略空行；空数组 = 这道菜还没写做法
  const steps = useMemo(() => (dish?.steps ?? '').split('\n').filter((line) => line.trim() !== ''), [dish?.steps]);

  // 配料分两组：必有（缺了这道菜不成立）与可选（缺了只是口味打折，跳过就行）。
  // 库存判断同样只看非调料：常备调料默认家里有。
  const requiredItems = useMemo(() => (dish?.ingredients ?? []).filter((item) => item.required), [dish?.ingredients]);
  const optionalItems = useMemo(() => (dish?.ingredients ?? []).filter((item) => !item.required), [dish?.ingredients]);
  const missingOf = (items: typeof requiredItems) =>
    items.filter((item) => !item.is_pantry && !stockIds.has(item.ingredient_id)).length;
  const requiredMissing = missingOf(requiredItems);
  const optionalMissing = missingOf(optionalItems);

  return (
    <Sheet open={Boolean(dish)} onClose={onClose} title={dish?.name}>
      {dish ? (
        <div className="pb-4">
          <div className="flex items-center gap-3 rounded-xl2 bg-linear-to-br from-brand-50 to-cream-200 p-4">
            {dish.image_url ? (
              <img
                src={dish.image_url}
                alt={dish.name}
                decoding="async"
                className="h-[64px] w-[64px] shrink-0 rounded-xl2 object-cover shadow-card"
              />
            ) : (
              <span className="text-[44px]">{dish.emoji}</span>
            )}
            <div className="min-w-0">
              <p className="text-[13px] text-ink-600">{dish.description}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Badge tone="brand">{dish.cook_minutes} 分钟</Badge>
                <Badge tone="neutral">{'★'.repeat(dish.difficulty)} 难度</Badge>
                {dish.tags.map((tag) => (
                  <Badge key={tag} tone="fresh">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              { label: '热量', value: dish.nutrition.kcal, unit: 'kcal' },
              { label: '蛋白质', value: dish.nutrition.protein, unit: 'g' },
              { label: '脂肪', value: dish.nutrition.fat, unit: 'g' },
            ].map((item) => (
              <div key={item.label} className="rounded-xl2 bg-cream-100 p-2.5 text-center">
                <p className="text-[11px] text-ink-400">{item.label}</p>
                <p className="text-[15px] font-semibold tabular-nums">
                  {item.value}
                  <span className="ml-0.5 text-[10px] text-ink-400">{item.unit}</span>
                </p>
              </div>
            ))}
          </div>

          <div className="mb-2 mt-4 flex items-baseline justify-between gap-2">
            <p className="text-[13px] font-semibold">配料（每人份）</p>
            {requiredMissing > 0 ? (
              <span className="shrink-0 text-[11px] font-medium text-alert">缺 {requiredMissing} 样核心料</span>
            ) : (
              <span className="shrink-0 text-[11px] font-medium text-fresh">
                {optionalMissing > 0 ? `核心齐 · 可选缺 ${optionalMissing} 样` : '核心齐'}
              </span>
            )}
          </div>
          <div className="space-y-2.5">
            <IngredientChips label="必有" items={requiredItems} stockIds={stockIds} />
            {optionalItems.length > 0 ? (
              <IngredientChips label="可选 · 家里没有也能做" items={optionalItems} stockIds={stockIds} muted />
            ) : null}
          </div>

          {/* 做法：点菜时对照当前做法再记改菜反馈，建议才有依据；空 = 后台还没写 */}
          {steps.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
                <BookOpen size={14} className="text-brand-500" />
                做法 · {steps.length} 步
              </p>
              <ol className="space-y-2">
                {steps.map((line, index) => (
                  <li key={index} className="flex gap-2.5">
                    <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-600">
                      {index + 1}
                    </span>
                    <span className="text-[13px] leading-5 text-ink-600">{line}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="mt-4 text-[12px] leading-5 text-ink-400">这道菜还没写做法，记反馈时可以直接提。</p>
          )}

          {/* 给哪天吃：默认跟随点菜目标，单道菜可以单独改天；餐次统一用目标餐次 */}
          <div className="mt-5 rounded-xl2 bg-cream-100 p-3">
            <p className="mb-2 flex items-center justify-between gap-2 text-[13px] font-semibold">
              <span className="flex items-center gap-1.5">
                <CalendarDays size={14} className="text-brand-500" />
                哪天吃？
              </span>
              <span className="text-[11px] font-normal text-ink-400">都按「{MEAL_LABEL[mealType]}」加</span>
            </p>
            <div className="flex gap-1.5">
              {DAY_OFFSETS.map((offset) => (
                <button
                  key={offset}
                  type="button"
                  onClick={() => onSelectDay(offset)}
                  className={cn(
                    'press flex-1 rounded-full px-3 py-1.5 text-[12px] font-medium transition',
                    day === offset
                      ? 'warm-gradient text-white shadow-float'
                      : 'border border-cream-300 bg-white text-ink-600',
                  )}
                >
                  {dayOffsetLabel(offset)}
                </button>
              ))}
            </div>
            <div className="mt-2.5 flex items-center justify-between">
              <span className="text-[13px] text-ink-600">
                {cartServings ? `购物车里已有 ${cartServings} 份` : '要做几份？'}
              </span>
              <div className="flex gap-1.5">
                {SERVING_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onSelectServings(n)}
                    className={cn(
                      'press h-7 rounded-full px-3 text-[12px] font-medium transition',
                      servings === n
                        ? 'warm-gradient text-white shadow-float'
                        : 'border border-cream-300 bg-white text-ink-600',
                    )}
                  >
                    {n} 份
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Button
            block
            size="lg"
            className="mt-3"
            onClick={() => onAdd(dish, servings, { mealDate: mealDateFromOffset(day) })}
          >
            {cartServings ? '再加' : '加入菜单'} · {dayOffsetLabel(day)}·{MEAL_LABEL[mealType]} · {servings} 份
          </Button>

          {/* 反馈：点菜时随手记一条，提交后 AI 当场给出「现在 → 建议」，就地勾选确认 */}
          <div className="mt-4 -mx-5">
            <DishFeedbackBar
              dishId={dish.id}
              feedbacks={feedbacks}
              me={me}
              onChanged={onFeedbackChanged}
              onDishChanged={onDishUpdated}
            />
          </div>

          {/* 实拍图：做好了这道菜谁都能随手传一张，上传即换掉 emoji（SSE 把列表一起刷掉） */}
          <div className="mt-3">
            <DishPhotoEditor dish={dish} onUpdated={onDishUpdated} />
          </div>

          {/* 季节窗口 / 歇菜：点菜时顺手安排，改完 SSE 会把菜单列表一起刷掉 */}
          <div className="mt-3">
            <DishVisibilityPanel dish={dish} />
          </div>

          <DishHideTrigger onClick={() => onRequestHide(dish)} />
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * 配料 chip 组：必有组缺货标红「缺」，可选组整体弱化并标「可跳过」。
 * 点菜时一眼看清「能不能做」与「要不要顺路买」。
 */
function IngredientChips({
  label,
  items,
  stockIds,
  muted,
}: {
  label: string;
  items: Dish['ingredients'];
  /** 冰箱库存里有的食材 id 集合 */
  stockIds: Set<number>;
  /** 可选组：整体弱化，缺货不报警，只提示可跳过 */
  muted?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className={cn('mb-1 text-[11px]', muted ? 'text-ink-400' : 'text-ink-600')}>{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((ingredient) => {
          const stocked = stockIds.has(ingredient.ingredient_id);
          return (
            <span
              key={ingredient.ingredient_id}
              className={cn(
                'rounded-full px-2.5 py-1 text-[12px]',
                stocked
                  ? 'border border-fresh/30 bg-fresh/10 font-medium text-fresh'
                  : muted
                    ? 'border border-dashed border-cream-400 bg-white/60 text-ink-400'
                    : ingredient.is_pantry
                      ? 'bg-fresh/5 text-fresh'
                      : 'border border-alert/25 bg-white text-ink-600',
              )}
            >
              {ingredient.name} {ingredient.amount}g
              {stocked ? (
                <span className="ml-1 text-[10px] font-medium">✓ 库存有</span>
              ) : ingredient.is_pantry ? (
                <span className="ml-1 text-[10px]">常备</span>
              ) : muted ? (
                <span className="ml-1 text-[10px]">可跳过</span>
              ) : (
                <span className="ml-1 text-[10px] font-medium text-alert">缺</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
