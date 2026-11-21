/**
 * 用餐考勤的历史固化（v19）。
 *
 * 设计：dayAttendance 是**纯读**——按「订单 > 已落库判定 > 星期规则 > 默认在家」推导，不写库，
 * 所以 GET /nutrition、/analytics 这些读接口没有写副作用。历史固化由
 * lockAttendanceHistory() 负责：改 away.* 规则之前把过去没落库的日子按**当时**的规则落库。
 * 过去的日子一旦落库（locked = 1）就不再随之后的规则变化。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import {
  dayAttendance,
  homeMealCount,
  lockAttendanceHistory,
  writeAwayWeekdays,
} from '../src/services/attendanceService.js';
import { buildNutritionReport } from '../src/services/nutritionService.js';
import { addDays, todayString } from '../src/lib/units.js';

/** 往前找最近的那个星期 weekday（0=周日），保证是过去的日子 */
function pastWeekday(weekday: number, skipWeeks = 1): string {
  let date = addDays(todayString(), -7 * skipWeeks);
  while (new Date(`${date}T00:00:00`).getDay() !== weekday) date = addDays(date, -1);
  return date;
}

/** 插一条过去日期的订单，给 lockAttendanceHistory 一个「最早日期」准头（成员用自增 id，避免撞主键） */
function seedPastOrder(mealDate: string, mealType: 'breakfast' | 'lunch' | 'dinner' = 'breakfast'): void {
  const memberId = Number(run(`INSERT INTO members (name, avatar) VALUES ('锚点', '🙂')`).lastInsertRowid);
  run(
    `INSERT INTO orders (member_id, meal_date, meal_type, status, headcount) VALUES (?, ?, ?, 'done', 3)`,
    memberId,
    mealDate,
    mealType,
  );
}

function rowOf(date: string, mealType: string) {
  return get<{ at_home: number; locked: number; source: string }>(
    'SELECT at_home, locked, source FROM meal_attendance WHERE meal_date = ? AND meal_type = ?',
    date,
    mealType,
  );
}

const mealOf = (date: string, mealType: 'breakfast' | 'lunch' | 'dinner') =>
  dayAttendance(date).find((meal) => meal.meal_type === mealType)!;

describe('考勤历史固化', () => {
  // 每个用例从同一套规则出发：工作日午餐在外吃，其余在家
  beforeEach(() => {
    writeAwayWeekdays('breakfast', []);
    writeAwayWeekdays('lunch', [1, 2, 3, 4, 5]);
    writeAwayWeekdays('dinner', []);
  });

  it('查询是纯读：查过去的日子不落库；改规则前 lockAttendanceHistory 才固化历史', () => {
    const wednesday = pastWeekday(3, 1);
    const before = mealOf(wednesday, 'lunch');
    assert.equal(before.at_home, false); // 周三 → 命中「工作日午餐在外」
    assert.equal(before.source, 'rule');
    assert.equal(before.locked, false); // 读路径不固化
    assert.equal(rowOf(wednesday, 'lunch'), undefined, '读路径不该写库');

    // 改规则前先固化：给个更早的订单当锚点，再回填
    seedPastOrder(pastWeekday(3, 3));
    lockAttendanceHistory(addDays(wednesday, 1));
    assert.equal(rowOf(wednesday, 'lunch')?.locked, 1);

    // 整条「午餐在外」规则撤掉：已经固化的历史不该跟着变
    writeAwayWeekdays('lunch', []);
    assert.equal(mealOf(wednesday, 'lunch').at_home, false);
  });

  it('改规则之前先回填：lockAttendanceHistory 把过去没落库的日子按旧规则固化', () => {
    // 用更早的一周（5 周前）当锚点，避开上一个用例已经固化过的周次
    const anchor = pastWeekday(3, 5);
    seedPastOrder(anchor, 'lunch');

    const locked = lockAttendanceHistory(upTo(anchor));
    assert.ok(locked > 0, '应固化出若干条历史判定');

    // 有订单的那一餐不固化（订单本身就是稳定事实），其余餐次都固化
    assert.equal(rowOf(anchor, 'lunch'), undefined);
    assert.equal(rowOf(anchor, 'dinner')?.locked, 1);
    assert.equal(rowOf(anchor, 'breakfast')?.locked, 1);

    // 幂等：同一范围再跑一次没有新东西可固化
    assert.equal(lockAttendanceHistory(upTo(anchor)), 0);
  });

  it('今天不固化：还要能实时反映新下的订单', () => {
    const today = todayString();
    mealOf(today, 'lunch');
    assert.equal(rowOf(today, 'lunch'), undefined);
    assert.equal(mealOf(today, 'lunch').locked, false);
  });

  it('固化之后，历史营养报告的在家餐次不再随规则变化', () => {
    const day = pastWeekday(5, 1); // 周五：默认午餐在外
    const before = buildNutritionReport(day);
    assert.equal(before.home_meals, homeMealCount(day));

    // 改规则前先固化历史（锚点用更早的一天，不影响 day 本身）
    seedPastOrder(pastWeekday(5, 2));
    lockAttendanceHistory(addDays(day, 1));

    // 把周五从「在外吃」拿掉（改成在家）：已固化的那天口径不该变
    writeAwayWeekdays('lunch', [1, 2, 3, 4]);
    const after = buildNutritionReport(day);
    assert.equal(after.home_meals, before.home_meals);
    assert.equal(mealOf(day, 'lunch').at_home, false);
  });
});

/** 把回填的范围限定到 date 当天（端点参数是「不含」，所以 +1 天） */
function upTo(date: string): string {
  return addDays(date, 1);
}
