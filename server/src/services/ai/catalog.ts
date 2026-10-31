/**
 * AI 起草共用的「食材目录」：库内食材快照 + 《中国食物成分表》参考表 + 名字归并。
 *
 * 由三个 AI 工作流（加菜 / 改菜 / 登记库存）共用：
 * 加菜用它复用已有食材并给新食材兜营养，改菜用它把模型说的名字对回配料表，
 * 登记库存用它把「西红柿」对成库里的「番茄」。
 */
import { all } from '../../db/index.js';
import { NUTRITION_REFERENCE } from '../../data/nutritionReference.js';
import { synonymGroupOf } from '../../lib/synonyms.js';
import type { NutritionFacts } from '../../types.js';

/**
 * 食材库快照：一条一行，够做匹配、热量预览与库存判定（不必再回查库）。
 * id 与 is_pantry 是给库存登记用的：登记要以 id 落库，而常备调料按现有设计不用登记。
 */
export interface CatalogItem {
  id: number;
  name: string;
  category: string;
  isPantry: boolean;
  nutrition: NutritionFacts;
}

export function loadCatalog(): CatalogItem[] {
  return all<{
    id: number;
    name: string;
    category: string;
    is_pantry: number;
    kcal: number;
    protein: number;
    fat: number;
    carb: number;
    sodium: number;
    fiber: number;
  }>(
    `SELECT id, name, category, is_pantry, kcal, protein, fat, carb, sodium, fiber
       FROM ingredients ORDER BY category, name`,
  ).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    isPantry: row.is_pantry === 1,
    nutrition: {
      kcal: row.kcal,
      protein: row.protein,
      fat: row.fat,
      carb: row.carb,
      sodium: row.sodium,
      fiber: row.fiber,
    },
  }));
}

/**
 * 《中国食物成分表》参考表，拼成 resolveIngredient 认得的形状：
 * 只用名字匹配（含别名 / 前缀），id 与分类在这里没有意义。
 */
export const REFERENCE_ITEMS: CatalogItem[] = NUTRITION_REFERENCE.map((entry, index) => ({
  id: -1 - index,
  name: entry.name,
  category: '参考表',
  isPantry: false,
  nutrition: {
    kcal: entry.kcal,
    protein: entry.protein,
    fat: entry.fat,
    carb: entry.carb,
    sodium: entry.sodium,
    fiber: entry.fiber,
  },
}));

/** 公共前缀长度：多个别名候选时用来挑最像的那个（「鸡胸」→「鸡胸肉」而不是「鸡翅」） */
export function commonPrefixLength(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/**
 * 配料名 → 库里的食材。
 *
 * 四道关口，越往后越保守，最终宁可不认（当新食材让人在卡片上改）也不瞎并：
 * 1. 精确匹配；
 * 2. 别名组里**正好是组内某个别名**的库内食材（西红柿 ↔ 番茄、菠萝 ↔ 凤梨），唯一就直接用；
 * 3. 库里的名字**以查询词开头**的（「鸡胸」→ 库里的「鸡胸肉」）——只在第 2 步定不下来时才用，
 *    所以「菠萝」不会因为库里还有「菠萝酱」而被并过去（第 2 步已用「凤梨」定下来了）；
 * 4. 第 2 步有多个候选（「鸡肉」组里有鸡翅 / 鸡腿 / 鸡胸肉）时按公共前缀挑最像的，
 *    并列就放弃——硬猜容易猜错，而且这类错会一路传到采购清单上。
 *
 * 两条踩过的坑：
 *   · 别名归并**不能**用 expandSearchTerms 的包含匹配：那样「沙姜」包含「姜」会被并成
 *     「生姜」，两样完全不同的食材，采购清单会买错东西、AI 填的营养也被丢掉；
 *   · 一律不做编辑距离模糊匹配：把「猪里脊」并到「猪五花」上，采购会少买肉且很难发现。
 */
export function resolveIngredient(rawName: string, byName: Map<string, CatalogItem>): CatalogItem | null {
  const name = rawName.trim();
  if (name === '') return null;

  const exact = byName.get(name);
  if (exact) return exact;

  const group = synonymGroupOf(name);
  if (!group) return null;

  const aliasHits = group
    .map((alias) => byName.get(alias))
    .filter((item): item is CatalogItem => item !== undefined);
  if (aliasHits.length === 1) return aliasHits[0];

  const prefixHits = [...byName.values()].filter(
    (item) => item.name.startsWith(name) && !aliasHits.includes(item),
  );
  if (aliasHits.length === 0) return prefixHits.length === 1 ? prefixHits[0] : null;

  const scored = aliasHits
    .map((item) => ({ item, score: commonPrefixLength(name, item.name) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && scored[0].score > scored[1].score) return scored[0].item;

  return prefixHits.length === 1 ? prefixHits[0] : null;
}
