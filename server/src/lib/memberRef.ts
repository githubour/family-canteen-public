/**
 * 「谁提交的」行的公共装配：菜品反馈 / 新菜建议都存 member_id，
 * 提交人可能已被移除（成员行删了、记录还留着），所以统一 LEFT JOIN members，
 * 并用兜底值填充快照——条目本身不因成员消失而消失。
 */
import { get } from '../db/index.js';
import type { MemberBrief } from '../../../shared/types.js';

/** 与 MemberColumns 一一对应的 SELECT 片段（配合下面的 JOIN 使用，别名固定为 m） */
export const MEMBER_SELECT_COLUMNS = 'm.name AS member_name, m.avatar AS member_avatar, m.color AS member_color';

/** LEFT JOIN members 的固定写法；alias 是主表别名（如 f / r） */
export function memberJoin(alias: string): string {
  return `LEFT JOIN members m ON m.id = ${alias}.member_id`;
}

/** LEFT JOIN members 后行上多出来的成员列（与 MEMBER_SELECT_COLUMNS 对齐） */
export interface MemberColumns {
  member_id: number | null;
  member_name: string | null;
  member_avatar: string | null;
  member_color: string | null;
}

/** 由成员列装配 MemberBrief；member_id 为空 = 匿名（或提交人已被移除） */
export function toMemberRef(row: MemberColumns): MemberBrief | null {
  if (row.member_id === null) return null;
  return {
    id: row.member_id,
    name: row.member_name ?? '已移除的家人',
    avatar: row.member_avatar ?? '🙂',
    color: row.member_color ?? '#FF6B35',
  };
}

/** 校验提交人：不在库里就当没填（匿名），避免把记录挂到不存在的成员上 */
export function resolveMemberId(raw: unknown): number | null {
  const wanted = Number(raw);
  if (!Number.isFinite(wanted) || wanted <= 0) return null;
  const member = get<{ id: number }>('SELECT id FROM members WHERE id = ?', wanted);
  return member?.id ?? null;
}
