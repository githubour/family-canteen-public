/**
 * 新菜建议：家人把「想吃但菜单里没有」的菜名提上来，先攒着。
 * 这里刻意不落任何菜品属性（分类、配料、营养）——那些由开发者统一补齐后写入 dishes，
 * 所以本模块只负责「收集」这一件事。
 */
import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { MEMBER_SELECT_COLUMNS, memberJoin, resolveMemberId, toMemberRef, type MemberColumns } from '../lib/memberRef.js';
import { broadcast } from '../lib/sse.js';
import type { DishRequest } from '../types.js';

export const dishRequestsRouter = Router();

const MAX_NAME = 24;
const MAX_NOTE = 60;

interface RequestRow extends MemberColumns {
  id: number;
  name: string;
  note: string | null;
  created_at: string;
}

/** 提交人可能已被移除，用 LEFT JOIN 让建议本身仍能留在列表里 */
const SELECT_SQL = `
  SELECT r.id, r.name, r.note, r.member_id, r.created_at,
         ${MEMBER_SELECT_COLUMNS}
    FROM dish_requests r
    ${memberJoin('r')}
`;

function toRequest(row: RequestRow): DishRequest {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    member_id: row.member_id,
    member: toMemberRef(row),
    created_at: row.created_at,
  };
}

dishRequestsRouter.get('/', (_req, res) => {
  const rows = all<RequestRow>(`${SELECT_SQL} ORDER BY r.created_at DESC, r.id DESC`);
  res.json({ requests: rows.map(toRequest) });
});

dishRequestsRouter.post('/', (req, res) => {
  const { name, note, memberId } = req.body ?? {};
  const clean = String(name ?? '').trim().slice(0, MAX_NAME);
  if (!clean) throw badRequest('请填写想吃的菜名');

  // 两道拦截：菜单里已有的直接引导去点，重复提交的提示已经有人提过
  const existingDish = get<{ id: number; active: number }>('SELECT id, active FROM dishes WHERE name = ?', clean);
  if (existingDish) {
    // 下架的菜搜不到也点不了，别再让人「直接搜它就能点」——提示去恢复
    throw conflict(
      'DISH_EXISTS',
      existingDish.active === 1
        ? `菜单里已经有「${clean}」了，直接搜它就能点`
        : `菜单里有一道「${clean}」（当前已下架），让大厨在设置里恢复就行`,
    );
  }

  const duplicated = get<{ id: number }>('SELECT id FROM dish_requests WHERE name = ?', clean);
  if (duplicated) throw conflict('REQUEST_EXISTS', `「${clean}」已经提过了，等统一加入菜单`);

  const id = run(
    'INSERT INTO dish_requests (name, note, member_id) VALUES (?, ?, ?)',
    clean,
    note ? String(note).trim().slice(0, MAX_NOTE) : null,
    resolveMemberId(memberId),
  ).lastInsertRowid;

  broadcast('dish-request:updated', { id });
  const created = get<RequestRow>(`${SELECT_SQL} WHERE r.id = ?`, id);
  res.status(201).json({ request: created ? toRequest(created) : null });
});

/** 统一加入菜单后清空清单，避免一条条点（放在 /:id 之前，避免被参数路由吃掉） */
dishRequestsRouter.delete('/', (_req, res) => {
  const result = run('DELETE FROM dish_requests');
  broadcast('dish-request:updated', { cleared: true });
  res.json({ ok: true, removed: result.changes });
});

dishRequestsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = get<{ id: number }>('SELECT id FROM dish_requests WHERE id = ?', id);
  if (!row) throw notFound('这条新菜建议不存在');
  run('DELETE FROM dish_requests WHERE id = ?', id);
  broadcast('dish-request:updated', { id });
  res.json({ ok: true });
});
