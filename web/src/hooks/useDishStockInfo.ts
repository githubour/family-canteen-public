import { useMemo } from 'react';
import type { Dish, FridgeStockItem, MealType } from '../api/types';

/** 只需要菜品列表与搜索词，与 api.dishes.list 的返回结构对齐 */
interface DishListData {
  dishes: Dish[];
  search_terms?: string[];
}

/**
 * 一道菜与库存的关系。
 * 必有食材决定「能不能做」，可选食材只决定「要不要多买两样」——
 * 番茄炒蛋缺番茄 vs 缺大葱，从这两个数上就分得清。
 */
export interface DishStockInfo {
  /** 必有食材（非调料）命中库存的样数 */
  requiredMatched: number;
  /** 缺几样必有：0 = 核心齐，这道菜随时能做 */
  requiredMissing: number;
  /** 可选食材（非调料）命中库存的样数 */
  optionalMatched: number;
  optionalTotal: number;
  /** 必有全齐 → 缺的可选跳过就行，照样能做出这道菜 */
  canMake: boolean;
  /** 必有齐、可选也齐 → 一点菜都不用买 */
  freeAll: boolean;
  /** 用上库存的总样数（必有 + 可选）：卡片提示「为什么排在前面」 */
  matched: number;
}

/**
 * 菜品与冰箱库存的关系：点菜页据此把「核心食材齐、马上能做」的菜排到前面。
 * 全部是纯派生计算，与渲染无关，所以独立成 hook——点菜页只负责把结果传给子组件。
 *
 * 排序规则：先按餐别（标了当前餐别的排前面），档内同一套库存序——
 *   ① 缺几样必有食材，升序（0 在前：核心齐的菜优先吃，缺得多的往下沉）；
 *   ② 同样必备程度时，可选食材命中库存多的在前（顺手消耗存货）。
 * 同序保持原顺序（Array.sort 稳定）。
 */
export function useDishStockInfo(
  dishesData: DishListData | null,
  fridgeData: { items: FridgeStockItem[] } | null,
  onlyFree: boolean,
  mealType: MealType,
) {
  const fridgeItems = fridgeData?.items;
  const stockIds = useMemo(() => new Set((fridgeItems ?? []).map((item) => item.ingredient_id)), [fridgeItems]);

  // 每道菜与库存的关系：常备调料默认家里有，不参与匹配；
  // 非调料配料按 required 一分为二，必有算「缺不缺」，可选算「能顺带用掉多少」。
  const stockInfo = useMemo(() => {
    const map = new Map<number, DishStockInfo>();
    if (stockIds.size === 0) return map;
    for (const dish of dishesData?.dishes ?? []) {
      const required = dish.ingredients.filter((item) => !item.is_pantry && item.required);
      const optional = dish.ingredients.filter((item) => !item.is_pantry && !item.required);
      const requiredMatched = required.filter((item) => stockIds.has(item.ingredient_id)).length;
      const optionalMatched = optional.filter((item) => stockIds.has(item.ingredient_id)).length;
      const requiredMissing = required.length - requiredMatched;
      const canMake = requiredMissing === 0;
      map.set(dish.id, {
        requiredMatched,
        requiredMissing,
        optionalMatched,
        optionalTotal: optional.length,
        canMake,
        freeAll: canMake && optionalMatched === optional.length,
        matched: requiredMatched + optionalMatched,
      });
    }
    return map;
  }, [dishesData, stockIds]);

  const hasStock = stockIds.size > 0;
  const canMakeCount = useMemo(() => [...stockInfo.values()].filter((info) => info.canMake).length, [stockInfo]);

  // 「只看能做」开着时过滤到必有食材齐的菜（可选缺了不算事，跳过就行）；库存清空后自动回到全部。
  // 标签在后台「设置 → 菜品」的餐别标签里维护，没标过的菜全都在垫底档、同样按库存排。
  const listedDishes = useMemo(() => {
    const all = dishesData?.dishes ?? [];
    const list = onlyFree && hasStock ? all.filter((dish) => stockInfo.get(dish.id)?.canMake) : all;
    const mealRankOf = (dish: Dish) => (dish.meal_types.includes(mealType) ? 0 : 1);
    return [...list].sort((a, b) => {
      const mealA = mealRankOf(a);
      const mealB = mealRankOf(b);
      if (mealA !== mealB) return mealA - mealB;
      const infoA = stockInfo.get(a.id);
      const infoB = stockInfo.get(b.id);
      if (!infoA || !infoB) return 0;
      if (infoA.requiredMissing !== infoB.requiredMissing) return infoA.requiredMissing - infoB.requiredMissing;
      if (infoA.optionalMatched !== infoB.optionalMatched) return infoB.optionalMatched - infoA.optionalMatched;
      return 0;
    });
  }, [dishesData, onlyFree, hasStock, stockInfo, mealType]);

  // 搜索命中的食材：卡片左下角标出「含 xx」，搜食材时能看出每道菜为什么被搜出来。
  // 匹配词用服务端返回的 search_terms（含联想展开的别名，如搜「西红柿」会带上「番茄」），
  // 与服务端过滤永远同一份口径
  const ingredientHits = useMemo(() => {
    const terms = dishesData?.search_terms ?? [];
    if (terms.length === 0) return new Map<number, string[]>();
    const map = new Map<number, string[]>();
    for (const dish of dishesData?.dishes ?? []) {
      const hits = dish.ingredients
        .filter((item) => terms.some((term) => item.name.includes(term)))
        .map((item) => item.name);
      if (hits.length > 0) map.set(dish.id, hits);
    }
    return map;
  }, [dishesData]);

  return { stockIds, stockInfo, hasStock, canMakeCount, listedDishes, ingredientHits };
}
