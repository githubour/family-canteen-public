/**
 * 汇总服务：日 / 周维度的订单流水、菜品排行与成员口味画像。
 * 数据规模很小（每天几条订单），因此聚合直接在内存里做，SQL 只负责取数。
 */
import { all, get } from '../db/index.js';
import { parseStringArray } from '../lib/json.js';
import { addDays, round, todayString } from '../lib/units.js';
import type { AnalyticsOverview, CookStat } from '../types.js';
import { MEAL_COUNT_PER_DAY, homeMealCountByDate } from './attendanceService.js';
import { snapshotTotals } from './nutritionService.js';
import { roundNutrition, scaleNutrition } from './dishService.js';
import { readSetting } from './settingsService.js';

const RANGE_CONDITION = `o.status != 'cancelled' AND o.meal_date BETWEEN ? AND ?`;

interface MemberRow {
  id: number;
  name: string;
  avatar: string;
  color: string;
  order_count: number;
}

export function buildOverview(rangeDays = 7): AnalyticsOverview {
  const days = Math.min(Math.max(Math.round(rangeDays), 1), 60);
  const dateTo = todayString();
  const dateFrom = addDays(dateTo, -(days - 1));

  const orderCount = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM orders o WHERE ${RANGE_CONDITION}`,
    dateFrom,
    dateTo,
  );
  const itemCount = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${RANGE_CONDITION}`,
    dateFrom,
    dateTo,
  );
  const servingCount = get<{ c: number }>(
    `SELECT COALESCE(SUM(oi.servings), 0) AS c
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${RANGE_CONDITION}`,
    dateFrom,
    dateTo,
  );
  const mealSlotCount = get<{ c: number }>(
    `SELECT COUNT(DISTINCT o.meal_date || '|' || o.meal_type) AS c FROM orders o WHERE ${RANGE_CONDITION}`,
    dateFrom,
    dateTo,
  );
  const memberCount = get<{ c: number }>('SELECT COUNT(*) AS c FROM members');

  // 排行与分类占比一律按订单行快照聚合：改菜名 / 改分类 / 删菜都不会改写历史口径
  const topDishes = all<{ dish_id: number | null; name: string; emoji: string; count: number }>(
    `SELECT MAX(oi.dish_id) AS dish_id, oi.dish_name AS name, oi.dish_emoji AS emoji,
            SUM(oi.servings) AS count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE ${RANGE_CONDITION}
      GROUP BY oi.dish_name, oi.dish_emoji
      ORDER BY count DESC, oi.dish_name
      LIMIT 8`,
    dateFrom,
    dateTo,
  );

  const categoryDistribution = all<{ category: string; count: number }>(
    `SELECT oi.dish_category AS category, SUM(oi.servings) AS count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE ${RANGE_CONDITION}
      GROUP BY oi.dish_category
      ORDER BY count DESC`,
    dateFrom,
    dateTo,
  );

  const members = all<MemberRow>(
    `SELECT m.id, m.name, m.avatar, m.color,
            COUNT(DISTINCT CASE WHEN ${RANGE_CONDITION} THEN o.id END) AS order_count
       FROM members m
       LEFT JOIN orders o ON o.member_id = m.id
      GROUP BY m.id
      ORDER BY m.sort_order, m.id`,
    dateFrom,
    dateTo,
  );

  const memberProfiles = buildMemberProfiles(members, dateFrom, dateTo);
  const cookStats = buildCookStats(dateFrom, dateTo);

  // 每天在家吃了几餐：趋势图上据此区分「在外吃」与「真没吃」
  const homeMealsByDate = homeMealCountByDate(dateFrom, dateTo);
  let homeMealTotal = 0;

  // 趋势整段一次取数：逐日跑 buildNutritionReport 时 range=60 会串行执行几百条同步 SQL，
  // 期间事件循环整体停摆。这里 1 条查区间内订单人数、1 条查区间内全部订单行快照，
  // 内存按日分组后沿用报告的同一条计算路径（快照合并 → addNutrition/scaleNutrition → roundNutrition）。
  const headcountRows = all<{ meal_date: string; headcount: number }>(
    `SELECT o.meal_date, o.headcount FROM orders o WHERE ${RANGE_CONDITION}`,
    dateFrom,
    dateTo,
  );
  const itemRows = all<{ meal_date: string; servings: number; bom: string }>(
    `SELECT o.meal_date, oi.servings, oi.bom
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE ${RANGE_CONDITION}`,
    dateFrom,
    dateTo,
  );
  const headcountByDate = new Map<string, number>();
  for (const row of headcountRows) {
    headcountByDate.set(row.meal_date, Math.max(headcountByDate.get(row.meal_date) ?? 0, row.headcount));
  }
  const itemsByDate = new Map<string, { servings: number; bom: string }[]>();
  for (const row of itemRows) {
    const list = itemsByDate.get(row.meal_date);
    if (list) list.push(row);
    else itemsByDate.set(row.meal_date, [row]);
  }
  // 与报告同口径：当日 headcount = 当日非取消订单的最大值，没有订单时回落默认人数
  const fallbackHeadcount = Number(readSetting('default.headcount', '3')) || 3;

  const trend: AnalyticsOverview['trend'] = [];
  let kcalSum = 0;
  let kcalDays = 0;
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = addDays(dateTo, -index);
    const rows = itemsByDate.get(date) ?? [];
    // 人均口径：当日 BOM 展开总量 ÷ 当日 headcount，舍入沿用 roundNutrition 的 0 位
    const kcal = roundNutrition(
      scaleNutrition(snapshotTotals(rows), 1 / (headcountByDate.get(date) || fallbackHeadcount)),
    ).kcal;
    if (rows.length > 0) {
      kcalSum += kcal;
      kcalDays += 1;
    }
    const homeMeals = homeMealsByDate.get(date) ?? MEAL_COUNT_PER_DAY;
    homeMealTotal += homeMeals;
    trend.push({
      date,
      kcal,
      // 与 buildNutritionReport 的 dish_count 同义：当日非取消订单的 order_items 行数
      dishes: rows.length,
      home_meals: homeMeals,
    });
  }

  const items = Number(itemCount?.c ?? 0);
  const slots = Number(mealSlotCount?.c ?? 0);
  const totalMeals = days * MEAL_COUNT_PER_DAY;

  return {
    range_days: days,
    order_count: Number(orderCount?.c ?? 0),
    dish_count: items,
    serving_count: Number(servingCount?.c ?? 0),
    member_count: Number(memberCount?.c ?? 0),
    avg_dishes_per_meal: slots > 0 ? round(items / slots, 1) : 0,
    avg_kcal_per_capita: kcalDays > 0 ? round(kcalSum / kcalDays, 0) : 0,
    home_meal_count: homeMealTotal,
    away_meal_count: Math.max(totalMeals - homeMealTotal, 0),
    top_dishes: topDishes.map((row) => ({ ...row, count: Number(row.count) })),
    category_distribution: categoryDistribution.map((row) => ({ ...row, count: Number(row.count) })),
    cook_stats: cookStats,
    member_profiles: memberProfiles,
    trend,
  };
}

/**
 * 做菜统计：按人汇总做菜次数、道数与份数。
 * 接单备料即记一笔，不看有没有点「做好了」——大厨经常忘，漏算才是错的；
 * 做菜人被移除后 member_id 会被置空，这时归到「未记名」，不静默丢数据。
 */
function buildCookStats(dateFrom: string, dateTo: string): CookStat[] {
  const rows = all<{
    member_id: number | null;
    name: string | null;
    avatar: string | null;
    color: string | null;
    cook_count: number;
    dishes: number;
    servings: number;
    kcal: number;
  }>(
    `SELECT cl.member_id, m.name, m.avatar, m.color,
            COUNT(cl.id) AS cook_count,
            COALESCE(SUM(cl.dishes), 0) AS dishes,
            COALESCE(SUM(cl.servings), 0) AS servings,
            COALESCE(SUM(cl.kcal), 0) AS kcal
       FROM cook_logs cl
       LEFT JOIN members m ON m.id = cl.member_id
      WHERE cl.meal_date BETWEEN ? AND ?
      GROUP BY cl.member_id
      ORDER BY servings DESC, cook_count DESC`,
    dateFrom,
    dateTo,
  );

  return rows.map((row) => ({
    member_id: row.member_id,
    name: row.name ?? '未记名',
    avatar: row.avatar ?? '🍳',
    color: row.color ?? '#9C948C',
    cook_count: Number(row.cook_count ?? 0),
    dishes: Number(row.dishes ?? 0),
    servings: Number(row.servings ?? 0),
    kcal: round(Number(row.kcal ?? 0), 0),
  }));
}

/** 取「份数降序、名称升序」的第一名；空表返回 undefined。与原 SQL 的 ORDER BY count DESC, 名称 同序 */
function pickTopByName(counts: Map<string, number>): string | undefined {
  let best: { name: string; count: number } | undefined;
  for (const [name, count] of counts) {
    if (!best || count > best.count || (count === best.count && name < best.name)) best = { name, count };
  }
  return best?.name;
}

/**
 * 成员画像：最爱吃的那道菜 / 分类、口味标签、辣度都只看订单行快照（与排行同一口径），
 * 之后菜谱改分类 / 改标签 / 删菜，历史画像保持不变。
 * 原实现每人 4 条查询在成员多时是典型 N+1，这里合并成 2 条按 member_id 分组的区间查询，
 * top-1 在内存里按「份数降序、名称升序」取，保持每人独立的第一名语义（不是全局 LIMIT 1）。
 */
function buildMemberProfiles(members: MemberRow[], dateFrom: string, dateTo: string) {
  const usageRows = all<{
    member_id: number;
    dish_name: string;
    dish_category: string;
    servings: number;
    spicy_weighted: number;
  }>(
    `SELECT o.member_id AS member_id, oi.dish_name AS dish_name, oi.dish_category AS dish_category,
            SUM(oi.servings) AS servings,
            SUM(oi.dish_spicy * oi.servings) AS spicy_weighted
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE ${RANGE_CONDITION}
      GROUP BY o.member_id, oi.dish_name, oi.dish_category`,
    dateFrom,
    dateTo,
  );

  const tagRows = all<{ member_id: number; tags: string; servings: number }>(
    `SELECT o.member_id AS member_id, oi.dish_tags AS tags, SUM(oi.servings) AS servings
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE ${RANGE_CONDITION}
      GROUP BY o.member_id, oi.dish_tags`,
    dateFrom,
    dateTo,
  );

  interface MemberAgg {
    dishCount: Map<string, number>;
    categoryCount: Map<string, number>;
    servings: number;
    spicyWeighted: number;
    tagScore: Map<string, number>;
  }
  const byMember = new Map<number, MemberAgg>();
  const aggOf = (memberId: number): MemberAgg => {
    let agg = byMember.get(memberId);
    if (!agg) {
      agg = { dishCount: new Map(), categoryCount: new Map(), servings: 0, spicyWeighted: 0, tagScore: new Map() };
      byMember.set(memberId, agg);
    }
    return agg;
  };

  for (const row of usageRows) {
    const agg = aggOf(row.member_id);
    const servings = Number(row.servings);
    // 同一菜名跨分类的分组在内存里再合并一次，份数为整数精确求和，口径与按人分组完全一致
    agg.dishCount.set(row.dish_name, (agg.dishCount.get(row.dish_name) ?? 0) + servings);
    agg.categoryCount.set(row.dish_category, (agg.categoryCount.get(row.dish_category) ?? 0) + servings);
    agg.servings += servings;
    agg.spicyWeighted += Number(row.spicy_weighted);
  }
  for (const row of tagRows) {
    const agg = aggOf(row.member_id);
    for (const tag of parseStringArray(row.tags)) {
      agg.tagScore.set(tag, (agg.tagScore.get(tag) ?? 0) + Number(row.servings));
    }
  }

  return members.map((member) => {
    const agg = byMember.get(member.id);
    const favorite = agg ? pickTopByName(agg.dishCount) : undefined;
    const favoriteCategory = agg ? pickTopByName(agg.categoryCount) : undefined;
    // 与原 SQL 的 SUM(spicy*servings)*1.0/NULLIF(SUM(servings),0) 同式：分母为 0 时按无数据出 0
    const avgSpicy = agg && agg.servings > 0 ? (agg.spicyWeighted * 1.0) / agg.servings : null;
    const topTags = agg
      ? Array.from(agg.tagScore.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([tag]) => tag)
      : [];

    return {
      member_id: member.id,
      name: member.name,
      avatar: member.avatar,
      color: member.color,
      order_count: Number(member.order_count ?? 0),
      favorite_dish: favorite ?? null,
      favorite_category: favoriteCategory ?? null,
      avg_spicy: avgSpicy != null ? round(avgSpicy, 1) : 0,
      top_tags: topTags,
    };
  });
}
