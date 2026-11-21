/**
 * 订单行上的 BOM 快照解析。
 *
 * 快照是下单那一刻冻结的「每人份用料」数组，菜品被删除、食材被改名或改营养之后，
 * 历史营养报告与采购清单都靠它还原当时的吃法。解析失败一律退化成空数组：
 * 历史页面宁可少显一行，也不能因为一条脏数据整页 500。
 */
import { parseJson } from './json.js';
import type { OrderBomItem } from '../types.js';

export function parseBomSnapshot(raw: string | null | undefined): OrderBomItem[] {
  const parsed = parseJson<unknown>(raw, null);
  if (!Array.isArray(parsed)) return [];
  // 身份 / 用量 / 六项营养都是下游（采购聚合、营养折算）的必需项：缺一项就会算出 NaN
  // 或产生 undefined 分组键。宁可少显一行，也不让一条脏数据把整份报告带歪。
  const isNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
  return parsed.filter((item): item is OrderBomItem => {
    if (!item || typeof item !== 'object') return false;
    const entry = item as Record<string, unknown>;
    return (
      Number.isInteger(entry.ingredient_id) &&
      typeof entry.name === 'string' &&
      entry.name !== '' &&
      isNumber(entry.amount) &&
      isNumber(entry.kcal) &&
      isNumber(entry.protein) &&
      isNumber(entry.fat) &&
      isNumber(entry.carb) &&
      isNumber(entry.sodium) &&
      isNumber(entry.fiber)
    );
  });
}
