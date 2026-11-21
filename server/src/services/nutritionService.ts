/**
 * 营养服务：把当日所有订单按 BOM 展开成人均营养摄入，并对照膳食指南生成建议。
 * 定位是「生活参考」，不是医疗或营养处方，措辞保持克制、可执行。
 */
import { all } from '../db/index.js';
import { parseBomSnapshot } from '../lib/bom.js';
import { sodiumToSalt, round, addDays } from '../lib/units.js';
import type { NutritionAdvice, NutritionFacts, NutritionReference, NutritionReport } from '../types.js';
import { MEAL_COUNT_PER_DAY, dayAttendance } from './attendanceService.js';
import {
  EMPTY_NUTRITION,
  addNutrition,
  roundNutrition,
  scaleNutrition,
} from './dishService.js';
import { readSetting } from './settingsService.js';

/** 淀粉类蔬菜不计入膳食指南的「蔬菜」口径 */
const STARCHY_VEGETABLES = new Set(['土豆', '山药', '莲藕', '玉米', '红薯', '芋头', '南瓜']);

/**
 * 膳食指南的「全天」推荐量。
 * 只在家吃 1 餐却被要求吃够全天 300g 蔬菜显然不合理，
 * 所以实际对照时会按在家餐次占比等比折算。
 */
const BASE_LIMITS = {
  energyMin: 1600,
  energyMax: 2400,
  proteinMin: 55,
  proteinMax: 90,
  fatMin: 45,
  fatMax: 75,
  carbMin: 250,
  carbMax: 350,
  fiberMin: 25,
  fiberMax: 30,
  saltMax: 5,
  vegetableMin: 300,
  vegetableMax: 500,
  meatMin: 40,
  meatMax: 75,
  seafoodMin: 40,
  seafoodMax: 75,
};

type Limits = typeof BASE_LIMITS;

function scaleLimits(scale: number): Limits {
  const scaled = {} as Record<keyof Limits, number>;
  for (const [key, value] of Object.entries(BASE_LIMITS) as [keyof Limits, number][]) {
    scaled[key] = round(value * scale, 0);
  }
  return scaled;
}

interface UsageRow {
  ingredient_id: number;
  name: string;
  category: string;
  amount: number;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
}

/** 把订单行的 BOM 快照按食材合并：同名食材跨菜累加用量，营养值取快照里每 100g 的值 */
function buildUsage(itemRows: { servings: number; bom: string }[]): UsageRow[] {
  const usageMap = new Map<number, UsageRow>();
  for (const row of itemRows) {
    for (const item of parseBomSnapshot(row.bom)) {
      const amount = item.amount * row.servings;
      const existing = usageMap.get(item.ingredient_id);
      if (existing) {
        existing.amount += amount;
      } else {
        usageMap.set(item.ingredient_id, {
          ingredient_id: item.ingredient_id,
          name: item.name,
          category: item.category,
          amount,
          kcal: item.kcal,
          protein: item.protein,
          fat: item.fat,
          carb: item.carb,
          sodium: item.sodium,
          fiber: item.fiber,
        });
      }
    }
  }
  return Array.from(usageMap.values());
}

/** 用量行 → 未舍入总营养：加/乘统一走 dishService 的实现，单日报告与汇总页趋势共用 */
function totalsOfUsage(usage: UsageRow[]): NutritionFacts {
  let totals: NutritionFacts = { ...EMPTY_NUTRITION };
  for (const row of usage) {
    totals = addNutrition(
      totals,
      scaleNutrition(
        {
          kcal: row.kcal,
          protein: row.protein,
          fat: row.fat,
          carb: row.carb,
          sodium: row.sodium,
          fiber: row.fiber,
        },
        row.amount / 100,
      ),
    );
  }
  return totals;
}

/** BOM 快照展开后的未舍入总营养：汇总页趋势按日复用，与单日报告保持同一条计算路径 */
export function snapshotTotals(itemRows: { servings: number; bom: string }[]): NutritionFacts {
  return totalsOfUsage(buildUsage(itemRows));
}

function statusOf(value: number, min: number, max: number): NutritionReference['status'] {
  if (value < min) return 'low';
  if (value > max) return 'high';
  return 'ok';
}

function reference(
  label: string,
  value: number,
  unit: string,
  min: number,
  max: number,
  scale = 1,
): NutritionReference {
  const scaledMin = round(min * scale, 0);
  const scaledMax = round(max * scale, 0);
  return {
    label,
    value: round(value, 1),
    unit,
    min: scaledMin,
    max: scaledMax,
    status: statusOf(value, scaledMin, scaledMax),
  };
}

export function buildNutritionReport(mealDate: string): NutritionReport {
  // 在家餐次占比：只在家吃晚餐时，不该拿全天的推荐量去衡量这一餐
  const meals = dayAttendance(mealDate);
  const homeMeals = meals.filter((meal) => meal.at_home).length;
  const scale = homeMeals > 0 ? homeMeals / MEAL_COUNT_PER_DAY : 0;
  const limits = scaleLimits(scale);

  const orders = all<{ headcount: number }>(
    `SELECT headcount FROM orders WHERE meal_date = ? AND status != 'cancelled'`,
    mealDate,
  );

  // 历史口径只认订单行上的 BOM 快照（下单那一刻的用量与营养值）：
  // 之后改配方、改食材营养表、甚至把菜删掉，过去的报告都不会跟着变形
  const itemRows = all<{ servings: number; bom: string }>(
    `SELECT oi.servings, oi.bom
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.meal_date = ? AND o.status != 'cancelled'`,
    mealDate,
  );

  const usage = buildUsage(itemRows);

  // 菜数直接用上面已取到的订单行数，不必再查一次 COUNT
  const dishCount = itemRows.length;

  const fallbackHeadcount = Number(readSetting('default.headcount', '3')) || 3;
  // 当日人数取各订单 headcount 的**最大值**：同一户人家一起吃，人数不能相加
  // （相加会把同一批人重复计入），取最大值即「这一户至少多少人」；没有订单时回落默认人数。
  const headcount = orders.reduce((max, order) => Math.max(max, order.headcount), 0) || fallbackHeadcount;

  // 总营养折叠与趋势页共用 totalsOfUsage：同一条加/乘路径，两处口径不会再各写一套
  const totals = totalsOfUsage(usage);
  let vegetableGram = 0;
  let meatGram = 0;
  let seafoodGram = 0;
  const categoryKcal = new Map<string, number>();

  for (const row of usage) {
    const factor = row.amount / 100;
    const kcal = row.kcal * factor;
    categoryKcal.set(row.category, (categoryKcal.get(row.category) ?? 0) + kcal);

    if (row.category === '蔬果' && !STARCHY_VEGETABLES.has(row.name)) vegetableGram += row.amount;
    if (row.category === '肉禽蛋') meatGram += row.amount;
    if (row.category === '水产') seafoodGram += row.amount;
  }

  const perCapita = scaleNutrition(totals, 1 / headcount);

  const saltGram = sodiumToSalt(perCapita.sodium);
  const fatEnergyRatio = perCapita.kcal > 0 ? ((perCapita.fat * 9) / perCapita.kcal) * 100 : 0;
  const vegetablePerCapita = vegetableGram / headcount;
  const meatPerCapita = meatGram / headcount;
  const seafoodPerCapita = seafoodGram / headcount;

  // 区间一律取自 BASE_LIMITS（与 buildAdvice 用同一份阈值），不再逐字重抄一遍数字
  const references: NutritionReference[] = [
    reference('能量', perCapita.kcal, 'kcal', BASE_LIMITS.energyMin, BASE_LIMITS.energyMax, scale),
    reference('蛋白质', perCapita.protein, 'g', BASE_LIMITS.proteinMin, BASE_LIMITS.proteinMax, scale),
    reference('脂肪', perCapita.fat, 'g', BASE_LIMITS.fatMin, BASE_LIMITS.fatMax, scale),
    reference('碳水化合物', perCapita.carb, 'g', BASE_LIMITS.carbMin, BASE_LIMITS.carbMax, scale),
    reference('膳食纤维', perCapita.fiber, 'g', BASE_LIMITS.fiberMin, BASE_LIMITS.fiberMax, scale),
    reference('食盐', saltGram, 'g', 0, BASE_LIMITS.saltMax, scale),
    reference('蔬菜', vegetablePerCapita, 'g', BASE_LIMITS.vegetableMin, BASE_LIMITS.vegetableMax, scale),
    reference('畜禽肉', meatPerCapita, 'g', BASE_LIMITS.meatMin, BASE_LIMITS.meatMax, scale),
    reference('水产品', seafoodPerCapita, 'g', BASE_LIMITS.seafoodMin, BASE_LIMITS.seafoodMax, scale),
  ];

  const byCategory = Array.from(categoryKcal.entries())
    .map(([category, kcal]) => ({ category, kcal: round(kcal / headcount, 0) }))
    .sort((a, b) => b.kcal - a.kcal);

  return {
    meal_date: mealDate,
    headcount,
    dish_count: dishCount,
    meals,
    home_meals: homeMeals,
    totals: roundNutrition(totals),
    per_capita: roundNutrition(perCapita),
    salt_gram: round(saltGram, 1),
    fat_energy_ratio: round(fatEnergyRatio, 1),
    vegetable_gram: round(vegetablePerCapita, 0),
    meat_gram: round(meatPerCapita, 0),
    seafood_gram: round(seafoodPerCapita, 0),
    references,
    by_category: byCategory,
    advice: buildAdvice(mealDate, perCapita, {
      saltGram,
      fatEnergyRatio,
      vegetablePerCapita,
      seafoodPerCapita,
      dishCount,
      homeMeals,
      scale,
      limits,
    }),
  };
}

interface AdviceContext {
  saltGram: number;
  fatEnergyRatio: number;
  vegetablePerCapita: number;
  seafoodPerCapita: number;
  dishCount: number;
  homeMeals: number;
  scale: number;
  limits: Limits;
}

function grams(value: number): string {
  return `${Math.round(value)}g`;
}

/** 推荐区间的说法：整天口径 vs 只在家吃几餐的折算口径 */
function rangeText(label: string, min: number, max: number, partial: boolean, unit = 'g'): string {
  return partial
    ? `按在家餐次折算，${label}推荐约 ${min}~${max}${unit}。`
    : `膳食指南建议每人每天 ${label} ${min}~${max}${unit}。`;
}

function buildAdvice(mealDate: string, perCapita: NutritionFacts, ctx: AdviceContext): NutritionAdvice[] {
  if (ctx.dishCount === 0) {
    return [
      {
        id: 'empty',
        level: 'info',
        title: '这一天还没有点菜',
        detail: '去点菜页选几道菜，营养分析会自动根据配料表生成。',
      },
    ];
  }

  const advice: NutritionAdvice[] = [];
  const { limits } = ctx;
  const partial = ctx.scale < 1;

  // 先把口径说清楚，否则「只在家吃晚餐」会被误读成「吃得很少」
  if (partial) {
    advice.push({
      id: 'partial-day',
      level: 'info',
      title: `只统计了在家吃的 ${ctx.homeMeals} 餐`,
      detail: `这一天另有 ${MEAL_COUNT_PER_DAY - ctx.homeMeals} 餐在外吃，不计入这里的人均口径；下面的推荐区间已按在家餐次等比折算，数值偏低不代表当天摄入不足。`,
    });
  }

  if (ctx.vegetablePerCapita < limits.vegetableMin) {
    advice.push({
      id: 'vegetable-low',
      level: 'warn',
      title: `蔬菜只有 ${grams(ctx.vegetablePerCapita)}，明显偏少`,
      detail: `${rangeText('蔬菜', limits.vegetableMin, limits.vegetableMax, partial)}加一道清炒西兰花或清炒时蔬就能补上，成本很低。`,
    });
  } else if (ctx.vegetablePerCapita > limits.vegetableMax * 1.3) {
    advice.push({
      id: 'vegetable-high',
      level: 'info',
      title: `蔬菜 ${grams(ctx.vegetablePerCapita)}，量很足`,
      detail: '已超过推荐上限，注意主食与蛋白质的搭配别被挤掉。',
    });
  } else {
    advice.push({
      id: 'vegetable-ok',
      level: 'good',
      title: `蔬菜 ${grams(ctx.vegetablePerCapita)}，落在推荐区间`,
      detail: '维持这个蔬菜量，长期来看很稳。',
    });
  }

  if (ctx.saltGram > limits.saltMax) {
    advice.push({
      id: 'salt-high',
      level: 'warn',
      title: `折合食盐约 ${ctx.saltGram.toFixed(1)}g，超过 ${limits.saltMax}g 上限`,
      detail: '主要来自酱油、豆瓣酱等调味料。下一顿炒菜可以少放半勺生抽，或改用醋、柠檬提味。',
    });
  } else if (ctx.saltGram > 0 && ctx.saltGram <= limits.saltMax * 0.6) {
    advice.push({
      id: 'salt-low',
      level: 'good',
      title: `食盐约 ${ctx.saltGram.toFixed(1)}g，口味清淡`,
      detail: `远低于${partial ? '折算后' : '每日'} ${limits.saltMax}g 的建议上限，继续保持。`,
    });
  }

  if (ctx.fatEnergyRatio > 35) {
    advice.push({
      id: 'fat-high',
      level: 'warn',
      title: `脂肪供能比 ${ctx.fatEnergyRatio.toFixed(1)}%，偏高`,
      detail: '今天菜里有油炸或红烧类。下一餐可以换成清蒸、白灼，把用油量压下来。',
    });
  } else if (ctx.fatEnergyRatio > 0 && ctx.fatEnergyRatio < 20) {
    advice.push({
      id: 'fat-low',
      level: 'info',
      title: `脂肪供能比 ${ctx.fatEnergyRatio.toFixed(1)}%，偏低`,
      detail: '适量油脂有助于吸收脂溶性维生素，可以加一小勺坚果或芝麻油。',
    });
  }

  if (perCapita.protein < limits.proteinMin) {
    advice.push({
      id: 'protein-low',
      level: 'info',
      title: `蛋白质 ${grams(perCapita.protein)}，略低于推荐`,
      detail: `${rangeText('蛋白质', limits.proteinMin, limits.proteinMax, partial)}下一餐加一道白灼虾、香菇炖鸡或一个水煮蛋，就能补足。`,
    });
  } else if (perCapita.protein >= limits.proteinMin) {
    advice.push({
      id: 'protein-ok',
      level: 'good',
      title: `蛋白质 ${grams(perCapita.protein)}，达标`,
      detail: '优质蛋白来源覆盖得不错。',
    });
  }

  if (perCapita.fiber < limits.fiberMin) {
    advice.push({
      id: 'fiber-low',
      level: 'info',
      title: `膳食纤维 ${grams(perCapita.fiber)}，偏少`,
      detail: `${rangeText('膳食纤维', limits.fiberMin, limits.fiberMax, partial)}把部分白米饭换成杂粮饭，或多一道菌菇、豆类菜，提升很快。`,
    });
  }

  if (ctx.seafoodPerCapita === 0) {
    advice.push({
      id: 'seafood-none',
      level: 'info',
      title: '今天没有水产品',
      detail: '指南建议每周吃鱼 2 次或水产品 300~500g，白灼虾、蒜蓉粉丝蒸扇贝都是低油做法。',
    });
  }

  const repeatWindowStart = addDays(mealDate, -2);
  // 只看订单行上的菜名快照：菜品被彻底删除后（dish_id 置空）这道菜仍能被识别为「重复」
  const repeats = all<{ name: string; days: number }>(
    `SELECT oi.dish_name AS name, COUNT(DISTINCT o.meal_date) AS days
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.meal_date >= ? AND o.meal_date <= ? AND o.status != 'cancelled'
      GROUP BY oi.dish_name
     HAVING days >= 2
      ORDER BY days DESC
      LIMIT 3`,
    repeatWindowStart,
    mealDate,
  );
  for (const repeat of repeats) {
    advice.push({
      id: `repeat-${repeat.name}`,
      level: 'info',
      title: `「${repeat.name}」近 3 天出现了 ${repeat.days} 次`,
      detail: '同一道菜连着吃容易腻，也减少了食材多样性。可以试试同类别里其它菜。',
    });
  }

  if (advice.every((item) => item.level === 'good')) {
    advice.push({
      id: 'overall',
      level: 'good',
      title: '今日搭配整体均衡',
      detail: '蔬菜、蛋白质、油盐都在合理范围内，保持这个节奏就好。',
    });
  }

  return advice;
}

