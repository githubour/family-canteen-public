/**
 * 宽松 JSON 解析：数据库里的 JSON 文本可能因历史 bug 或手工改库而损坏，
 * 坏值一律退化成 fallback —— 宁可少显示一段，也不能让一条脏数据把接口打成 500。
 */

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON 字符串数组（菜标签等）：非数组退化成 []，非字符串项直接滤掉 */
export function parseStringArray(raw: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(raw, null);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}
