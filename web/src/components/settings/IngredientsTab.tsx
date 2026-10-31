import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../../api/client';
import type { IngredientRecord, NutritionSource } from '../../api/types';
import { ChoiceChip, cn } from '../ui/base';
import { ErrorState, Skeleton } from '../ui/feedback';
import { toast } from '../ui/toast';
import { useAsync } from '../../hooks/useAsync';
import { groupBy } from '../../lib/collection';
import { runAction } from '../../lib/runAction';

/**
 * 食材与常备：点一下切换「常备 / 需采购」，立即保存（不进草稿）。
 * 页签只在被打开时挂载，所以每次进来都是新拉的数据，本地乐观改动自然清零。
 * 搜索框在本地过滤（名字或分类），食材都在前端、不用打接口。
 *
 * AI 加菜新建的食材，营养是模型填的（nutrition_source = 'ai'），在这里黄标「待复核」：
 * 营养页要跟膳食指南对照，AI 估的数字值得人工扫一眼，核对完点一下「已核对」即可转成 manual。
 */
export function IngredientsTab() {
  const ingredients = useAsync(() => api.settings.ingredients(), []);
  const [pantryDraft, setPantryDraft] = useState<Record<number, boolean>>({});
  const [sourceDraft, setSourceDraft] = useState<Record<number, NutritionSource>>({});
  const [keyword, setKeyword] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);

  const togglePantry = async (ingredient: IngredientRecord) => {
    const next = !(pantryDraft[ingredient.id] ?? ingredient.is_pantry === 1);
    setPantryDraft((previous) => ({ ...previous, [ingredient.id]: next }));
    await runAction(
      () => api.settings.updateIngredient(ingredient.id, { is_pantry: next }),
      '操作失败',
      // 失败要把乐观改动撤回，否则界面在骗人（跟菜品下架同一套）
      () => setPantryDraft((previous) => ({ ...previous, [ingredient.id]: !next })),
    );
  };

  /** 复核 AI 填的营养：标成「已核对」，黄标随之消失 */
  const review = async (ingredient: IngredientRecord) => {
    setSourceDraft((previous) => ({ ...previous, [ingredient.id]: 'manual' }));
    const ok = await runAction(
      () => api.settings.reviewIngredient(ingredient.id, 'manual'),
      '标记失败',
      () => setSourceDraft((previous) => ({ ...previous, [ingredient.id]: 'ai' })),
    );
    if (ok) toast(`已核对「${ingredient.name}」的营养`, 'success');
  };

  const all = ingredients.data?.ingredients ?? [];
  const loadFailed = ingredients.error !== null && all.length === 0;
  const sourceOf = (item: IngredientRecord): NutritionSource => sourceDraft[item.id] ?? item.nutrition_source;
  const pendingCount = all.filter((item) => sourceOf(item) === 'ai').length;

  const query = keyword.trim().toLowerCase();
  const filtered = all
    .filter((item) => (onlyPending ? sourceOf(item) === 'ai' : true))
    .filter(
      (item) =>
        query === '' || item.name.toLowerCase().includes(query) || item.category.toLowerCase().includes(query),
    );
  const grouped = [...groupBy(filtered, (item) => item.category).entries()];

  return (
    <div className="space-y-3">
      <p className="rounded-xl2 bg-cream-200/70 px-3 py-2 text-[11px] leading-5 text-ink-400">
        标为「常备」的食材不会进入采购任务，只会在清单底部折叠显示。
        带「待复核」的是 AI 加菜时填的营养，核对完点一下右边的按钮即可。
      </p>

      {pendingCount > 0 ? (
        <ChoiceChip active={onlyPending} onClick={() => setOnlyPending((value) => !value)}>
          {onlyPending ? '显示全部食材' : `只看待复核（${pendingCount}）`}
        </ChoiceChip>
      ) : null}

      <div className="flex h-10 items-center gap-2 rounded-full border border-cream-300 bg-white px-3">
        <Search size={15} className="shrink-0 text-ink-200" />
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜食材或分类，如酸奶、调料"
          className="h-full w-full bg-transparent text-[14px] placeholder:text-ink-200"
        />
        {keyword ? (
          <button type="button" onClick={() => setKeyword('')} aria-label="清空">
            <X size={15} className="text-ink-200" />
          </button>
        ) : null}
      </div>

      {ingredients.loading ? (
        <Skeleton className="h-40 w-full" />
      ) : loadFailed ? (
        <ErrorState title="食材库没加载出来" description={ingredients.error} onRetry={ingredients.reload} />
      ) : query ? (
        filtered.length > 0 ? (
          <p className="text-[12px] text-ink-400">匹配 {filtered.length} 项</p>
        ) : (
          <p className="text-[12px] text-ink-400">没有叫「{keyword.trim()}」的食材</p>
        )
      ) : null}

      {!ingredients.loading && !loadFailed && filtered.length === 0 ? (
        <p className="text-[12px] text-ink-400">
          {onlyPending ? '没有待复核的食材，AI 填过的营养都核对完了' : '没有符合条件的食材'}
        </p>
      ) : null}

      {grouped.map(([category, items]) => (
        <div key={category}>
          <p className="mb-1.5 text-[12px] font-semibold text-ink-600">{category}</p>
          <div className="space-y-1.5">
            {items.map((item) => {
              const isPantry = pantryDraft[item.id] ?? item.is_pantry === 1;
              const pending = sourceOf(item) === 'ai';
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded-xl2 border border-cream-300 bg-white pr-2"
                >
                  <button
                    type="button"
                    onClick={() => void togglePantry(item)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left"
                  >
                    <span className="min-w-0 truncate text-[13px]">
                      {item.name}
                      <span className="ml-1.5 text-[11px] text-ink-400">
                        {item.kcal} kcal/100g · 买{item.buy_unit}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                        isPantry ? 'bg-brand-50 text-brand-600' : 'bg-cream-200 text-ink-400',
                      )}
                    >
                      {isPantry ? '常备' : '需采购'}
                    </span>
                  </button>

                  {pending ? (
                    <>
                      <span className="chip shrink-0 bg-warn/15 text-[#B45309]">待复核</span>
                      <button
                        type="button"
                        onClick={() => void review(item)}
                        className="press shrink-0 rounded-full bg-fresh/10 px-2 py-1 text-[11px] font-medium text-fresh"
                      >
                        已核对
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
