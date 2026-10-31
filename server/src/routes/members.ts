import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parseJson } from '../lib/json.js';
import { broadcast } from '../lib/sse.js';
import type { Member, MemberRow } from '../types.js';

export const membersRouter = Router();

function parseDislikes(raw: string): string[] {
  const parsed = parseJson<unknown>(raw, null);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function toMember(row: MemberRow): Member {
  return { ...row, dislikes: parseDislikes(row.dislikes) };
}

function listMembers(): Member[] {
  return all<MemberRow>('SELECT * FROM members ORDER BY sort_order, id').map(toMember);
}

membersRouter.get('/', (_req, res) => {
  res.json({ members: listMembers() });
});

membersRouter.post('/', (req, res) => {
  const { name, avatar, color, role, dislikes } = req.body ?? {};
  if (!name || String(name).trim().length === 0) throw badRequest('请填写成员称呼');
  const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM members');
  const id = run(
    'INSERT INTO members (name, avatar, color, role, dislikes, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    String(name).trim().slice(0, 12),
    String(avatar ?? '🙂').slice(0, 8),
    String(color ?? '#FF6B35'),
    role === 'chef' || role === 'admin' ? role : 'diner',
    JSON.stringify(Array.isArray(dislikes) ? dislikes.map(String) : []),
    Number(count?.c ?? 0),
  ).lastInsertRowid;

  broadcast('member:updated', { id });
  const row = get<MemberRow>('SELECT * FROM members WHERE id = ?', id);
  res.status(201).json({ member: row ? toMember(row) : null });
});

membersRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = get<MemberRow>('SELECT * FROM members WHERE id = ?', id);
  if (!row) throw notFound('成员不存在');
  const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM orders WHERE member_id = ?', id);
  if (Number(used?.c ?? 0) > 0) throw conflict('MEMBER_IN_USE', '该成员已有历史订单，删除会导致记录断层，建议改名保留');
  run('DELETE FROM members WHERE id = ?', id);
  broadcast('member:updated', { id });
  res.json({ ok: true });
});
