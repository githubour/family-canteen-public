import { DEFAULT_CUTOFF, type AppSettings, type MealType } from '../api/types';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

/** 取某餐次的截单时间：设置优先，否则用默认 */
export function cutoffFor(settings: AppSettings | null, mealType: MealType): string {
  return settings?.[`cutoff.${mealType}`] || DEFAULT_CUTOFF[mealType];
}

/**
 * 把 '1,2,3,4,5' 这样的星期集合解析成数字数组。
 * 过滤空串是必须的：''.split(',') 得到 ['']，而 Number('') === 0 —— 0 是合法的周日。
 */
export function parseWeekdays(raw: string | undefined | null): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
}

/** 星期集合序列化回设置字符串，去重并升序 */
export function stringifyWeekdays(days: number[]): string {
  return Array.from(new Set(days))
    .sort((a, b) => a - b)
    .join(',');
}

export function todayISO(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function shiftDay(iso: string, days: number): string {
  const base = new Date(`${iso}T00:00:00`);
  base.setDate(base.getDate() + days);
  return todayISO(base);
}

/** 解析本地日期；脏数据（如历史遗留的 2026-13-99）返回 null，展示层不要渲染 NaN */
function parseLocalDate(iso: string): Date | null {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateCN(iso: string): string {
  const date = parseLocalDate(iso);
  return date ? `${date.getMonth() + 1}月${date.getDate()}日` : iso;
}

export function formatWeekday(iso: string): string {
  const weekday = weekdayOf(iso);
  return weekday >= 0 ? WEEKDAYS[weekday] : '';
}

/** 取某个日期是星期几，索引与 JS getDay() 一致（0 = 周日）；非法日期返回 -1 */
export function weekdayOf(iso: string): number {
  return parseLocalDate(iso)?.getDay() ?? -1;
}

/** 点菜时可选的天数档位：0 = 今天，1 = 明天，2 = 后天 */
export const DAY_OFFSETS = [0, 1, 2] as const;

/** 把天数档位说成人话，用于按钮和标题 */
export function dayOffsetLabel(offset: number): string {
  if (offset <= 0) return '今天';
  if (offset === 1) return '明天';
  if (offset === 2) return '后天';
  return `${offset} 天后`;
}

export function relativeDayLabel(iso: string): string {
  const today = todayISO();
  if (iso === today) return '今天';
  if (iso === shiftDay(today, -1)) return '昨天';
  if (iso === shiftDay(today, 1)) return '明天';
  const weekday = formatWeekday(iso);
  return `${formatDateCN(iso)}${weekday ? ` ${weekday}` : ''}`;
}

/** 把绝对日期说成相对档位（今天/明天/后天，更远的给日期+星期），用于按天分组的行头与分布摘要 */
export function dayLabelForDate(iso: string): string {
  const today = todayISO();
  if (iso === today) return '今天';
  if (iso === shiftDay(today, 1)) return '明天';
  if (iso === shiftDay(today, 2)) return '后天';
  const weekday = formatWeekday(iso);
  return `${formatDateCN(iso)}${weekday ? ` ${weekday}` : ''}`;
}

/** 千分位整数，用于卡路里这类会上千的数字（4560 -> 4,560） */
export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('zh-CN');
}

/** 把库里的 'YYYY-MM-DD HH:MM:SS' 显示成「今天 11:04」这种更好读的相对时间 */
export function relativeDateTime(sqliteTime: string): string {
  const date = sqliteTime.slice(0, 10);
  const time = sqliteTime.slice(11, 16);
  const today = todayISO();
  if (date === today) return `今天 ${time}`;
  if (date === shiftDay(today, -1)) return `昨天 ${time}`;
  return `${formatDateCN(date)} ${time}`;
}

function nowMinutes(date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function cutoffMinutes(cutoff: string): number {
  const [hour, minute] = cutoff.split(':').map((value) => Number(value));
  return (hour || 0) * 60 + (minute || 0);
}

interface Countdown {
  passed: boolean;
  text: string;
  minutesLeft: number;
}

/** 计算距截单时间的剩余时长，用于点菜页与购物车页的倒计时胶囊 */
export function cutoffCountdown(cutoff: string, date = new Date()): Countdown {
  const left = cutoffMinutes(cutoff) - nowMinutes(date);
  if (left <= 0) return { passed: true, text: '已过截单时间', minutesLeft: left };
  const hours = Math.floor(left / 60);
  const minutes = left % 60;
  const text = hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
  return { passed: false, text: `距截单还有 ${text}`, minutesLeft: left };
}

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 17) return '下午好';
  if (hour < 21) return '晚上好';
  return '夜宵时间';
}

/** 根据当前时间猜一个默认餐次，省去一次点击 */
export function guessMealType(date = new Date()): MealType {
  const hour = date.getHours();
  if (hour < 9) return 'breakfast';
  if (hour < 15) return 'lunch';
  return 'dinner';
}

export function dateRangeLabel(days: number): string {
  return `近 ${days} 天`;
}

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 把「歇 N 天」换算成歇到哪个月（YYYY-MM）。界面按月粒度恢复，
 * 所以短歇（比如歇 1 周）如果还落在本月，就顺延到下个月——保证至少歇过当前月。
 */
export function snoozeMonthKey(days: number, now = new Date()): string {
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const key = monthKeyOf(target);
  const current = monthKeyOf(now);
  if (key <= current) {
    return monthKeyOf(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  }
  return key;
}

export function monthKeyLabel(key: string): string {
  const [year, month] = key.split('-');
  return year && month ? `${year} 年 ${Number(month)} 月` : key;
}

/** 当前月份键（YYYY-MM），用于判断歇菜是否已经到期 */
export function currentMonthKey(now = new Date()): string {
  return monthKeyOf(now);
}

/** 季节月份的紧凑说法：连续区间收成「9-11 月」，零散的逐个列 */
export function monthsSummary(months: number[]): string {
  if (months.length === 0) return '全年';
  const sorted = [...months].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const month of sorted.slice(1)) {
    if (month === prev + 1) {
      prev = month;
      continue;
    }
    parts.push(start === prev ? `${start} 月` : `${start}-${prev} 月`);
    start = month;
    prev = month;
  }
  parts.push(start === prev ? `${start} 月` : `${start}-${prev} 月`);
  return parts.join('、');
}
