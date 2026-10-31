/**
 * 单位换算与「购买单位」格式化。
 * 全站唯一的换算出处：采购聚合、大厨备料、营养计算都从这里取，禁止散落魔法数字。
 */
import { isValidISODate } from '../types.js';
import { badRequest } from './errors.js';

/** 1 斤 = 500 克 */
const GRAM_PER_JIN = 500;

/**
 * 把「基准单位下的需求量」格式化成菜市场能直接用的说法。
 * - 无特殊购买单位的食材：不足 500g 显示克，超过则显示斤；
 * - 有特殊购买单位（个 / 根 / 头 / 瓶 / 袋…）：向上取整到整数份，并附上估算克重。
 */
export function formatBuyAmount(amount: number, buyUnit: string, buyFactor: number): string {
  const grams = Math.round(amount);
  if (!buyUnit || buyUnit === 'g') {
    if (amount >= GRAM_PER_JIN) {
      const jin = amount / GRAM_PER_JIN;
      return `${trimZero(jin)} 斤（约 ${grams}g）`;
    }
    return `${grams} g`;
  }
  const factor = buyFactor > 0 ? buyFactor : 1;
  const count = Math.max(1, Math.ceil(amount / factor));
  return `${count} ${buyUnit}（约 ${grams}g）`;
}

function trimZero(value: number): string {
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return fixed.replace(/\.0$/, '');
}

/** 人体对钠的生理需求换算：食盐(g) ≈ 钠(mg) × 2.54 ÷ 1000 */
export function sodiumToSalt(sodiumMg: number): number {
  return (sodiumMg * 2.54) / 1000;
}

/** 保留指定小数位，避免浮点噪声进入接口响应 */
export function round(value: number, digits = 1): number {
  const base = 10 ** digits;
  return Math.round((value + Number.EPSILON) * base) / base;
}

/** 以 Asia/Shanghai 为准的 YYYY-MM-DD（容器 TZ 正确时等价于本地日期） */
export function todayString(date = new Date()): string {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 加 n 天 */
export function addDays(dateString: string, days: number): string {
  const base = new Date(`${dateString}T00:00:00`);
  base.setDate(base.getDate() + days);
  return todayString(base);
}

/** 当前时间的 HH:mm */
export function nowHHmm(date = new Date()): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 读 query 里的日期参数：缺省用今天；传了就必须是真实存在的 YYYY-MM-DD。
 * 不能再回落到今天——那会把「参数写错」伪装成「就是今天的数据」，和静默吞掉 status 错误同类。
 */
export function readDateParam(value: unknown): string {
  if (value === undefined || value === '') return todayString();
  if (!isValidISODate(value)) throw badRequest('日期需要是有效的 YYYY-MM-DD');
  return value;
}
