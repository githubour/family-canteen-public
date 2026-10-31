/**
 * 服务端领域类型入口。
 *
 * 跨端共用的类型与常量统一定义在仓库根 `shared/types.ts`，这里原样再导出，
 * 所以已有的 `import { MEAL_TYPES } from '../types.js'` 一概不用改。
 *
 * 命名约定：以 Row 结尾的是数据库原始行（snake_case、0/1 布尔、JSON 字符串），
 * 不带后缀的是对外 API 使用的领域对象（camelCase、真实布尔、已反序列化）。
 */

import {
  MEAL_TYPES,
  type MealType,
  type MemberRole,
  type OrderStatus,
} from '../../shared/types.js';

export * from '../../shared/types.js';

/* ---------------------------------- 成员 ---------------------------------- */

export interface MemberRow {
  id: number;
  name: string;
  avatar: string;
  color: string;
  role: MemberRole;
  dislikes: string;
  sort_order: number;
  created_at: string;
}

/* ---------------------------------- 菜品 ---------------------------------- */

export interface DishRow {
  id: number;
  name: string;
  category: string;
  spicy: number;
  tags: string;
  cook_minutes: number;
  difficulty: number;
  base_servings: number;
  emoji: string;
  description: string | null;
  is_fried: number;
  active: number;
  created_at: string;
  season_months: string;
  hide_until: string;
  /** 做法步骤：一行一步的文本（空串 = 还没写），前端按行渲染成编号列表 */
  steps: string;
  /** 实拍图静态路径（/uploads/dishes/…），空串 = 没传图、展示层回退 emoji */
  image_url: string;
  /** 餐别标签：JSON 数组（如 ["breakfast","lunch"]），空数组 = 通用菜（不区分餐别） */
  meal_types: string;
}

/**
 * 清洗用户提交的餐别标签：去重、按 MEAL_TYPES 固定顺序排序、过滤非法值。
 * 输入不是数组时返回 undefined，让调用方自己决定是报错还是当作「没传」。
 */
export function normalizeMealTypes(input: unknown): MealType[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const set = new Set(
    input.filter((value): value is MealType => (MEAL_TYPES as string[]).includes(value as string)),
  );
  return MEAL_TYPES.filter((meal) => set.has(meal));
}

/* ---------------------------------- 订单 ---------------------------------- */

export interface OrderRow {
  id: number;
  member_id: number;
  meal_date: string;
  meal_type: MealType;
  status: OrderStatus;
  note: string | null;
  headcount: number;
  /** 客户端提交幂等键（一次性随机串，重试复用同一个）：撞到已有值就直接返回那张订单 */
  client_token: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 订单行上的 BOM 快照项：下单那一刻冻结的食材用量与其每 100g 营养。
 * 有了它，历史营养报告与采购清单在菜品被删除、食材被改名改营养之后仍然说得清当时吃了什么。
 */
export interface OrderBomItem {
  ingredient_id: number;
  name: string;
  category: string;
  /** 每人份用量（基准单位） */
  amount: number;
  unit: string;
  is_pantry: number;
  /** 1 = 必有，0 = 可选。缺省（老快照没有这一项）按必有处理 */
  required?: number;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
}

