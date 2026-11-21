import type { AiFridgeCandidate, AiFridgeRow } from '../api/types';

/**
 * 库存草稿 → `POST /api/fridge-stock/batch` 的入参。
 *
 * 只有 status 为 add / remove 的行会被送出去，其余状态（already / pantry / unknown / dish）
 * 一律过滤掉——它们的存在意义是**向用户解释为什么那样食材没被动到**或**等人在行上拍板**，不是待办事项。
 * 这一条必须钉死：把 already 当 add 发出去会做无意义的重复登记，把 unknown 发出去更糟
 * （它的 ingredient_id 是 null，服务端会当成非法 id 拒掉整批）。
 */
export function toBatchPayload(rows: AiFridgeRow[]): { add: number[]; remove: number[] } {
  const add: number[] = [];
  const remove: number[] = [];

  for (const row of rows) {
    if (row.ingredient_id === null) continue;
    if (row.status === 'add') add.push(row.ingredient_id);
    else if (row.status === 'remove') remove.push(row.ingredient_id);
  }

  return { add, remove };
}

/** 草稿里真正会落库的行数（0 就不该让用户点确认） */
export function actionableCount(rows: AiFridgeRow[]): number {
  return rows.filter((row) => row.status === 'add' || row.status === 'remove').length;
}

/**
 * 「库里没有」的行按人点的候选合并：转成一条普通的登记 / 撤掉行。
 *
 * 撤掉依赖服务端 DELETE 的幂等——说「用完了」的东西本来就不在库存里时撤了也等于没撤，
 * 所以不必反查库存现状。候选是常备调料时转 pantry（提示不用登记），不产生动作。
 */
export function mergeUnknownRow(row: AiFridgeRow, candidate: AiFridgeCandidate): AiFridgeRow {
  return {
    ...row,
    ingredient_id: candidate.ingredient_id,
    name: candidate.name,
    category: candidate.category,
    status: candidate.is_pantry ? 'pantry' : row.want === 'missing' ? 'remove' : 'add',
    candidates: undefined,
  };
}
