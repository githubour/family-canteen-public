import type { CreateDishPayload } from '../api/client';
import type { AiDishDraft } from '../api/types';

/**
 * AI 草稿 → `POST /api/dishes` 的入参。
 *
 * 这里最容易写错的一点：**BOM 必须带上全部配料**。
 * `ingredients` 是这道菜的完整配料表（服务端按名字关联 id 后逐行插 dish_ingredients），
 * `newIngredients` 只是「这些名字库里还没有，连同营养一起先建出来」的附加清单——
 * 两者是「全集」与「子集」的关系，不是互斥的两个抽屉。
 * 只把新食材放进 newIngredients 而不放进 ingredients，服务端会老老实实建好食材、
 * 但配料表里一行都不会有（不报错！），这道菜做出来就是缺主料的。见 web/test/aiDraft.test.ts。
 */
export function toCreatePayload(draft: AiDishDraft): CreateDishPayload {
  // 名称为空的行是「加了一条还没填完」的半成品，直接丢掉比报错友好
  const rows = draft.ingredients.filter((row) => row.name.trim() !== '');

  const missing = rows.filter((row) => row.is_new && row.nutrition === null);
  if (missing.length > 0) {
    // 卡片在营养没填齐时已经禁用了按钮，这里是兜底：宁可报错，也不许把 0 当营养送进去
    throw new Error(`「${missing.map((row) => row.name).join('、')}」的营养还没填`);
  }

  return {
    origin: 'ai',
    name: draft.name.trim(),
    category: draft.category,
    spicy: draft.spicy,
    tags: draft.tags,
    minutes: draft.minutes,
    difficulty: draft.difficulty,
    baseServings: draft.baseServings,
    emoji: draft.emoji,
    description: draft.description,
    steps: draft.steps.map((step) => step.trim()).filter((step) => step !== ''),
    mealTypes: draft.mealTypes,
    // 全集：命中库里的用库里的规范名（matched_name），新食材用模型给的名字
    ingredients: rows.map((row) => ({
      name: (row.matched_name ?? row.name).trim(),
      amount: row.amount,
      required: row.required,
    })),
    // 子集：只有库里真的没有的才连营养一起建；来源带上——参考表命中的标 seed，不挂「待复核」
    newIngredients: rows
      .filter((row) => row.is_new)
      .map((row) => ({
        name: row.name.trim(),
        category: row.category,
        kcal: row.nutrition?.kcal ?? 0,
        protein: row.nutrition?.protein ?? 0,
        fat: row.nutrition?.fat ?? 0,
        carb: row.nutrition?.carb ?? 0,
        sodium: row.nutrition?.sodium ?? 0,
        fiber: row.nutrition?.fiber ?? 0,
        nutritionSource: row.nutrition_source === 'seed' ? ('seed' as const) : undefined,
      })),
  };
}
