/**
 * 模型输出的「宽容读取」：三个 AI 工作流共用的一小组工具。
 *
 * JSON 里数字偶尔写成字符串、数组里偶尔混进非字符串，都在这里统一兜住；
 * 只读不改——「拒绝还是修正、notes 里怎么说」的口径归各工作流自己，
 * 因为同一种歪法在加菜卡片和库存草稿里该有不一样的交代。
 */
import { ApiError } from '../../lib/errors.js';
import type { NutritionFacts } from '../../types.js';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // 模型偶尔把数字写成字符串（"150"），顺手认下来
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number, label: string, notes: string[]): number {
  const parsed = readNumber(value);
  if (parsed === null) {
    if (value !== undefined) notes.push(`${label}没识别出来，已按 ${fallback} 处理`);
    return fallback;
  }
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) {
    const clamped = Math.min(Math.max(rounded, min), max);
    notes.push(`${label}${rounded} 超出范围，已按 ${clamped} 处理`);
    return clamped;
  }
  return rounded;
}

/** 六项营养都读到才算数；全 0 视为「没填」（铁律：不许填 0 糊弄） */
export function readNutrition(raw: unknown): NutritionFacts | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const keys = ['kcal', 'protein', 'fat', 'carb', 'sodium', 'fiber'] as const;
  const values = keys.map((key) => readNumber(source[key]));
  if (values.some((value) => value === null || value < 0)) return null;
  const facts = Object.fromEntries(keys.map((key, index) => [key, values[index] as number])) as unknown as NutritionFacts;
  return keys.every((key) => facts[key] === 0) ? null : facts;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 模型给了东西但没法用（缺菜名等）。
 * 与 lib/llm.ts 的 AI_UNAVAILABLE 分开：那个是「服务不可用、稍后重试」，
 * 这个换成说法往往就能成功——前端可以据此提示用户改一种描述方式。
 */
export function badOutput(message: string): ApiError {
  return new ApiError(502, 'AI_BAD_OUTPUT', message);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
