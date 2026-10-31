/**
 * 前端领域类型入口。
 *
 * 跨端共用的类型与常量统一定义在仓库根 `shared/types.ts`，这里原样再导出，
 * 所以已有的 `import { type Dish, MEAL_LABEL } from '../api/types'` 一概不用改。
 * 本文件只留纯前端概念：看板聚合形状、设置表单、筛选选项与 UI 配色。
 */

import {
  DISH_CATEGORIES,
  MEAL_LABEL,
  MEAL_TYPES,
  type MealType,
  type NutritionSource,
  type OrderStatus,
} from '../../../shared/types';

export * from '../../../shared/types';

/** 餐别标签的展示顺序与配色，后台编辑和点菜页徽章共用 */
export const MEAL_TAG_META: Record<MealType, { label: string; emoji: string; chip: string; dot: string }> = {
  breakfast: { label: '早餐', emoji: '🌅', chip: 'bg-amber-100 text-amber-700', dot: 'bg-amber-400' },
  lunch: { label: '午餐', emoji: '☀️', chip: 'bg-brand-50 text-brand-600', dot: 'bg-brand-400' },
  dinner: { label: '晚餐', emoji: '🌙', chip: 'bg-cool/10 text-cool', dot: 'bg-cool' },
};

/** 冰箱清空计划：登记了哪些食材家里现成有，点菜页据此把带库存的菜排到前面 */
export interface FridgeStockItem {
  ingredient_id: number;
  name: string;
  category: string;
}

/** 某个餐次的看板汇总（服务端 mealSummary 的出参形状） */
export interface MealSummary {
  meal_date: string;
  meal_type: MealType;
  order_count: number;
  member_count: number;
  headcount: number;
  dish_count: number;
  total_servings: number;
  status_count: Record<OrderStatus, number>;
  dishes: {
    /** 菜被彻底删除后为 null（做法/图查不到，菜名与用量来自订单行快照） */
    dish_id: number | null;
    name: string;
    emoji: string;
    category: string;
    servings: number;
    order_count: number;
    is_fried: boolean;
    cook_minutes: number;
    /** 做法步骤（一行一步，空串 = 没写）：备料弹层点菜名展开用 */
    steps: string;
    /** 实拍图路径（空串 = 用 emoji）：备料弹层小缩略图 */
    image_url: string;
    /** 每人份配料（含常备调料，打「常备」标）：大厨页菜谱与备料弹层展开对照用 */
    ingredients: { name: string; amount: number; is_pantry: boolean; required: boolean }[];
  }[];
}

/** 食材库记录（`GET /api/settings/ingredients` 的出参形状：字段与后端 SELECT 列表对齐） */
export interface IngredientRecord {
  id: number;
  name: string;
  category: string;
  unit: string;
  buy_unit: string;
  buy_factor: number;
  is_pantry: number;
  price_per_100g: number | null;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
  /** 营养来源：ai = AI 填的，需要复核（食材页黄标）；seed / manual 不用管 */
  nutrition_source: NutritionSource;
}

/** 餐次切换器的选项，顺序与 MEAL_TYPES 一致 */
export const MEAL_OPTIONS = MEAL_TYPES.map((value) => ({ value, label: MEAL_LABEL[value] }));

export const MEAL_EMOJI: Record<MealType, string> = { breakfast: '🌅', lunch: '☀️', dinner: '🌙' };

/** 点菜页分类筛选选项：「全部」是纯前端概念，其余 6 项与后端 DISH_CATEGORIES 同源 */
export const DISH_FILTER_OPTIONS = ['全部', ...DISH_CATEGORIES] as const;
