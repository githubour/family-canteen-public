/**
 * 通用集合小工具（纯函数，可单独测）。
 */

/** 按 key 把列表归进 Map，保持首次出现的顺序（直接用 ES2024 标准库实现，Safari 17.4+ / Chrome 117+） */
export const groupBy = Map.groupBy;
