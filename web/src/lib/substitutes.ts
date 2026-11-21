/**
 * 食材替代提示：**只做提示，不改变「能不能做」的判定**。
 *
 * 与服务端 lib/synonyms.ts 同一个分组口径：搜「鸡肉」会联想到鸡翅 / 鸡腿 / 鸡胸，
 * 库存里正好有同组食材时，缺的那样就可以标一句「可用 xx 代替」。
 * 为什么不做成自动替代：部位/品种并不等价（鸡翅和鸡胸的口感、用量差很多），
 * 算成「能做」会让采购清单少买且很难发现；这里只把选项摆出来，买不买仍由人决定。
 */

/** 名字 → 所属别名组：先整词命中（与 synonymGroupOf 同口径），再退到「至少 2 字的别名包含」（鸡胸肉 → 鸡胸组） */
export function groupForName(name: string, groups: string[][]): string[] | null {
  const target = name.trim();
  if (target === '') return null;
  return (
    groups.find((group) => group.includes(target)) ??
    groups.find((group) => group.some((alias) => alias.length >= 2 && target.includes(alias))) ??
    null
  );
}

/** 缺的食材 → 库存里同组、且不是它自己的那个名字；没有就返回 null */
export function findSubstitute(missingName: string, stockNames: string[], groups: string[][]): string | null {
  const group = groupForName(missingName, groups);
  if (!group) return null;
  for (const name of stockNames) {
    if (name === missingName) continue;
    if (groupForName(name, groups) === group) return name;
  }
  return null;
}
