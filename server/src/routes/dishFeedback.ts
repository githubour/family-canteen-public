/**
 * 菜品反馈：就「某一道菜」收集自然语言反馈（偏咸、土豆没炖烂、火候不对…），
 * 大模型读它来修正配方与做法，修正完再删掉被覆盖到的条目。
 *
 * 这里负责「能存、能看、能删」，以及**读取侧的两个入口**：
 *   · 单道菜（点菜详情 / 订单卡里的反馈栏——提交后 AI 就地起草，确认也在这里）；
 *   · 全量聚合（只读，留给排障与命令行查看：哪道菜攒了几条）。
 * 真正的「改配方」不在这层：AI 只产出草稿，落库走 dishService 的
 * updateDish / replaceDishIngredients（与手工改菜同一条路径）。
 */
import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { MEMBER_SELECT_COLUMNS, memberJoin, resolveMemberId, toMemberRef, type MemberColumns } from '../lib/memberRef.js';
import { broadcast } from '../lib/sse.js';
import type { DishFeedback } from '../types.js';

export const dishFeedbackRouter = Router();

/** 反馈正文宽松一些：自然语言，不像新菜建议那样只是个菜名 */
const MAX_CONTENT = 500;

interface FeedbackRow extends MemberColumns {
  id: number;
  dish_id: number;
  content: string;
  created_at: string;
}

/** 提交人可能已被移除，用 LEFT JOIN 让反馈本身仍能留在列表里 */
const SELECT_SQL = `
  SELECT f.id, f.dish_id, f.content, f.member_id, f.created_at,
         ${MEMBER_SELECT_COLUMNS}
    FROM dish_feedback f
    ${memberJoin('f')}
`;

function toFeedback(row: FeedbackRow): DishFeedback {
  return {
    id: row.id,
    dish_id: row.dish_id,
    content: row.content,
    member_id: row.member_id,
    member: toMemberRef(row),
    created_at: row.created_at,
  };
}

/**
 * 反馈总览：按菜聚合。改菜已经在反馈栏里就地完成，这里不再有页面消费，
 * 保留它是为了排障时能一眼看到「哪道菜攒了几条、都是谁说的」。
 */
dishFeedbackRouter.get('/', (_req, res) => {
  const rows = all<FeedbackRow & { dish_name: string; dish_emoji: string }>(
    `SELECT f.id, f.dish_id, f.content, f.member_id, f.created_at,
            d.name AS dish_name, d.emoji AS dish_emoji,
            ${MEMBER_SELECT_COLUMNS}
       FROM dish_feedback f
       JOIN dishes d ON d.id = f.dish_id
       ${memberJoin('f')}
      ORDER BY f.dish_id ASC, f.created_at ASC, f.id ASC`,
  );

  // 按菜分组（顺序即上面的 dish_id ASC → 界面上的顺序稳定，不会每次刷新跳来跳去）
  const groups = new Map<number, { dish_id: number; dish_name: string; dish_emoji: string; feedbacks: DishFeedback[] }>();
  for (const row of rows) {
    const group = groups.get(row.dish_id) ?? {
      dish_id: row.dish_id,
      dish_name: row.dish_name,
      dish_emoji: row.dish_emoji,
      feedbacks: [],
    };
    group.feedbacks.push(toFeedback(row));
    groups.set(row.dish_id, group);
  }
  res.json({ groups: [...groups.values()] });
});

/**
 * 批量删除：改完一批配方后清掉「被这次改动覆盖到」的条目。
 *
 * 幂等——已经不在的 id 直接跳过而不是 404：一批改动分多次删（或重试）是正常操作，
 * 不能因为其中一条已经删过就把整批回滚掉。返回 removed 只用于给个说法。
 */
dishFeedbackRouter.post('/remove', (req, res) => {
  const raw = (req.body as { ids?: unknown })?.ids;
  const ids = [
    ...new Set(
      (Array.isArray(raw) ? raw : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
  if (ids.length === 0) throw badRequest('没有要删的反馈');

  const placeholders = ids.map(() => '?').join(',');
  // 先记下涉及哪几道菜，删除后好逐个广播（SSE 事件是按菜刷新的）
  const touched = all<{ dish_id: number }>(
    `SELECT DISTINCT dish_id FROM dish_feedback WHERE id IN (${placeholders})`,
    ...ids,
  );
  const removed = run(`DELETE FROM dish_feedback WHERE id IN (${placeholders})`, ...ids).changes;
  for (const row of touched) broadcast('dish-feedback:updated', { dishId: row.dish_id });
  res.json({ removed });
});

/** 某道菜的全部反馈，按时间正序（最早的在前，方便顺时序看问题演变） */
dishFeedbackRouter.get('/:dishId', (req, res) => {
  const dishId = Number(req.params.dishId);
  const rows = all<FeedbackRow>(
    `${SELECT_SQL} WHERE f.dish_id = ? ORDER BY f.created_at ASC, f.id ASC`,
    dishId,
  );
  res.json({ feedbacks: rows.map(toFeedback) });
});

/** 提交一条反馈；memberId 可不传（匿名） */
dishFeedbackRouter.post('/:dishId', (req, res) => {
  const dishId = Number(req.params.dishId);
  const dish = get<{ id: number }>('SELECT id FROM dishes WHERE id = ?', dishId);
  if (!dish) throw notFound('这道菜不存在');

  const { content, memberId } = req.body ?? {};
  const clean = String(content ?? '').trim().slice(0, MAX_CONTENT);
  if (!clean) throw badRequest('请填写反馈内容');

  const id = run(
    'INSERT INTO dish_feedback (dish_id, content, member_id) VALUES (?, ?, ?)',
    dishId,
    clean,
    resolveMemberId(memberId),
  ).lastInsertRowid;

  broadcast('dish-feedback:updated', { dishId });
  const created = get<FeedbackRow>(`${SELECT_SQL} WHERE f.id = ?`, id);
  res.status(201).json({ feedback: created ? toFeedback(created) : null });
});

/** 删除一条反馈（大模型修正完配方后清掉，或人工误删） */
dishFeedbackRouter.delete('/:dishId/:feedbackId', (req, res) => {
  const dishId = Number(req.params.dishId);
  const feedbackId = Number(req.params.feedbackId);
  const row = get<{ id: number }>('SELECT id FROM dish_feedback WHERE id = ? AND dish_id = ?', feedbackId, dishId);
  if (!row) throw notFound('这条反馈不存在');
  run('DELETE FROM dish_feedback WHERE id = ?', feedbackId);
  broadcast('dish-feedback:updated', { dishId });
  res.json({ ok: true });
});
