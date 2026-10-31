/**
 * 用餐考勤：判断「某天某餐是在家吃还是在外吃」。
 *
 * 要解决的问题：工作日午餐通常在公司吃，家里根本没有订单。若把它当成
 * 「漏点了」，人均热量与膳食指南对照就会得出「吃太少」的错误结论。
 *
 * 判定优先级（从强到弱）：
 *   1. 有订单           → 在家吃（点了菜就是在家吃，规则不该盖过事实）
 *   2. 库里已有这一行   → 人工覆盖值，或系统固化下来的历史快照
 *   3. 命中星期规则     → 按规则（默认「周一~周五午餐在外吃」）
 *   4. 都没有           → 默认在家吃
 *
 * **历史固化（v19）**：第 3、4 条是「按当前设置现算」的，一旦改规则就会把历史一起改写
 * （周三晚餐改成在外吃 → 过去所有周三都变成在外，营养页的折算区间跟着变）。
 * 所以改动 away 规则**之前**要先调 lockAttendanceHistory()，把今天之前、既没有订单也没有
 * 人工覆盖的餐次按当时的规则统一落库固化（locked = 1）。
 * 本模块的 dayAttendance 是**纯读**——不在读路径里写库，GET /nutrition、/analytics 因此没有写副作用。
 * 今天与未来不固化——今天还要能实时反映新下的订单，未来本来就该跟着规则变。
 */
import { all, run, transaction } from '../db/index.js';
import { addDays, todayString } from '../lib/units.js';
import { MEAL_TYPES, type AttendanceSource, type MealAttendance, type MealType } from '../types.js';
import { readSetting, writeSetting } from './settingsService.js';

/**
 * 默认规则：工作日午餐在外吃。存的是 JS getDay()，0 = 周日。
 * 导出是因为设置接口也要用同一份兜底值——否则库里没有这行时，
 * 界面会显示成「一个都没勾」，而实际规则却是生效的。
 */
export const DEFAULT_AWAY: Record<MealType, string> = {
  breakfast: '',
  lunch: '1,2,3,4,5',
  dinner: '',
};

function settingKey(mealType: MealType): string {
  return `away.${mealType}`;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00`).getDay();
}

function isValidWeekday(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

function readAwayWeekdays(mealType: MealType): number[] {
  const raw = readSetting(settingKey(mealType), DEFAULT_AWAY[mealType]);
  // 注意 ''.split(',') 得到的是 ['']，而 Number('') === 0 —— 0 是合法星期（周日）。
  // 不先把空串滤掉的话，「没有在外吃规则」会被误判成「周日在外吃」。
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number(value))
    .filter(isValidWeekday);
}

export function writeAwayWeekdays(mealType: MealType, weekdays: number[]): void {
  const clean = Array.from(new Set(weekdays.filter(isValidWeekday))).sort((a, b) => a - b);
  writeSetting(settingKey(mealType), clean.join(','));
}

function readAwayRules(): Record<MealType, number[]> {
  return {
    breakfast: readAwayWeekdays('breakfast'),
    lunch: readAwayWeekdays('lunch'),
    dinner: readAwayWeekdays('dinner'),
  };
}

interface AttendanceRow {
  meal_type: string;
  at_home: number;
  locked: number;
  source: string;
}

/** 某天库里已有的判定：人工覆盖（locked=0）与固化快照（locked=1）都算「已定论」 */
function readAttendanceRows(date: string): Map<MealType, AttendanceRow> {
  const rows = all<AttendanceRow>(
    'SELECT meal_type, at_home, locked, source FROM meal_attendance WHERE meal_date = ?',
    date,
  );
  const map = new Map<MealType, AttendanceRow>();
  for (const row of rows) {
    if ((MEAL_TYPES as string[]).includes(row.meal_type)) map.set(row.meal_type as MealType, row);
  }
  return map;
}

function readOrderCounts(date: string): Map<MealType, number> {
  const rows = all<{ meal_type: string; c: number }>(
    `SELECT meal_type, COUNT(*) AS c FROM orders
      WHERE meal_date = ? AND status != 'cancelled'
      GROUP BY meal_type`,
    date,
  );
  const map = new Map<MealType, number>();
  for (const row of rows) {
    if ((MEAL_TYPES as string[]).includes(row.meal_type)) {
      map.set(row.meal_type as MealType, Number(row.c));
    }
  }
  return map;
}

/**
 * 某一天三餐的用餐情况，顺序与 MEAL_TYPES 一致。
 *
 * **纯读**：只按「订单 > 已落库判定 > 星期规则 > 默认在家」推导，不写库——
 * 读接口（营养 / 趋势）因而没有写副作用。历史固化由 lockAttendanceHistory
 * （改规则前调用）负责，见文件头说明。
 */
export function dayAttendance(date: string): MealAttendance[] {
  const rows = readAttendanceRows(date);
  const counts = readOrderCounts(date);
  const rules = readAwayRules();
  const weekday = weekdayOf(date);

  return MEAL_TYPES.map((mealType) => {
    const orderCount = counts.get(mealType) ?? 0;
    if (orderCount > 0) {
      // 有订单就是事实（点了菜就是在家吃），不需要也不应该固化
      return { meal_type: mealType, at_home: true, source: 'orders', order_count: orderCount, locked: false };
    }
    const row = rows.get(mealType);
    if (row) {
      return {
        meal_type: mealType,
        at_home: row.at_home === 1,
        source: row.source as AttendanceSource,
        order_count: 0,
        locked: row.locked === 1,
      };
    }
    const away = rules[mealType].includes(weekday);
    return {
      meal_type: mealType,
      at_home: !away,
      source: away ? 'rule' : 'default',
      order_count: 0,
      locked: false,
    };
  });
}

/** 把一条判定落库固化（历史快照）；已有人工覆盖或快照时不覆盖 */
function lockMeal(date: string, mealType: MealType, atHome: boolean, source: AttendanceSource): void {
  run(
    `INSERT INTO meal_attendance (meal_date, meal_type, at_home, source, locked, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))
     ON CONFLICT(meal_date, meal_type) DO NOTHING`,
    date,
    mealType,
    atHome ? 1 : 0,
    source,
  );
}

/** 在家吃的餐次数（0~3），用于折算膳食指南的参照区间（仅测试调用） */
export function homeMealCount(date: string): number {
  return dayAttendance(date).filter((meal) => meal.at_home).length;
}

/**
 * 把 [from, to] 区间里「已经过去、还没落库」的考勤判定按**当前**规则固化。
 * 有订单的餐次不用固化（订单本身就是稳定事实），返回固化了多少条。
 */
function lockHistoryRange(from: string, to: string): number {
  const yesterday = addDays(todayString(), -1);
  const effectiveTo = to < yesterday ? to : yesterday;
  if (!from || from > effectiveTo) return 0;

  const existing = new Set(
    all<{ key: string }>(
      `SELECT meal_date || '|' || meal_type AS key FROM meal_attendance
        WHERE meal_date BETWEEN ? AND ?`,
      from,
      effectiveTo,
    ).map((row) => row.key),
  );
  const ordered = new Set(
    all<{ key: string }>(
      `SELECT meal_date || '|' || meal_type AS key FROM orders
        WHERE meal_date BETWEEN ? AND ? AND status != 'cancelled'
        GROUP BY meal_date, meal_type`,
      from,
      effectiveTo,
    ).map((row) => row.key),
  );

  const rules = readAwayRules();
  const pending: { date: string; mealType: MealType; atHome: boolean; source: AttendanceSource }[] = [];
  for (let date = from; date <= effectiveTo; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    for (const mealType of MEAL_TYPES) {
      const key = `${date}|${mealType}`;
      if (existing.has(key) || ordered.has(key)) continue;
      const away = rules[mealType].includes(weekday);
      pending.push({ date, mealType, atHome: !away, source: away ? 'rule' : 'default' });
    }
  }
  if (pending.length === 0) return 0;

  transaction(() => {
    for (const item of pending) lockMeal(item.date, item.mealType, item.atHome, item.source);
  });
  return pending.length;
}

/** 系统里最早的考勤日期（订单或已有机考勤记录），没有则 null */
function earliestAttendanceDate(): string | null {
  const row = all<{ d: string | null }>(
    `SELECT MIN(d) AS d FROM (
       SELECT MIN(meal_date) AS d FROM orders
       UNION ALL
       SELECT MIN(meal_date) AS d FROM meal_attendance
     )`,
  )[0];
  return row?.d ?? null;
}

/**
 * 把今天之前所有还没固化的考勤判定按当前规则落库。
 *
 * **改动 away.* 规则之前必须先调用它**：那些日子如果一直靠现算，规则一改它们就会集体变脸，
 * 历史与营养折算区间跟着一起改——这正是这个函数要堵的洞。重复调用是幂等的（只补缺的）。
 */
export function lockAttendanceHistory(before: string = todayString()): number {
  const from = earliestAttendanceDate();
  if (!from) return 0;
  return lockHistoryRange(from, addDays(before, -1));
}

/**
 * 一段日期区间内每天「在家吃」的餐次数。
 * 趋势图上要按天标出哪些天有餐次在外吃，一次算完比逐天查库省事。
 */
export function homeMealCountByDate(from: string, to: string): Map<string, number> {
  // 纯读：不再顺手固化。历史由改规则前的 lockAttendanceHistory 统一固化，读接口无写副作用

  // 人工覆盖行与固化快照行都表示「这条已定论」，一视同仁地当覆盖值用
  const attendanceRows = all<{ meal_date: string; meal_type: string; at_home: number }>(
    'SELECT meal_date, meal_type, at_home FROM meal_attendance WHERE meal_date BETWEEN ? AND ?',
    from,
    to,
  );
  const overrides = new Map<string, boolean>();
  for (const row of attendanceRows) overrides.set(`${row.meal_date}|${row.meal_type}`, row.at_home === 1);

  const orderRows = all<{ meal_date: string; meal_type: string; c: number }>(
    `SELECT meal_date, meal_type, COUNT(*) AS c FROM orders
      WHERE meal_date BETWEEN ? AND ? AND status != 'cancelled'
      GROUP BY meal_date, meal_type`,
    from,
    to,
  );
  const orders = new Map<string, number>();
  for (const row of orderRows) orders.set(`${row.meal_date}|${row.meal_type}`, Number(row.c));

  const rules = readAwayRules();
  const result = new Map<string, number>();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    let home = 0;
    for (const mealType of MEAL_TYPES) {
      const key = `${date}|${mealType}`;
      if ((orders.get(key) ?? 0) > 0) {
        home += 1;
        continue;
      }
      const override = overrides.get(key);
      if (override !== undefined) {
        if (override) home += 1;
        continue;
      }
      if (!rules[mealType].includes(weekday)) home += 1;
    }
    result.set(date, home);
  }
  return result;
}

export const MEAL_COUNT_PER_DAY = MEAL_TYPES.length;
