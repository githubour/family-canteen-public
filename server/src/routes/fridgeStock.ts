import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { broadcast } from '../lib/sse.js';

export const fridgeStockRouter = Router();

/** 登记条目带食材名与分类：前端展示库存芯片时不用再查一次食材表 */
function listStock(): { ingredient_id: number; name: string; category: string }[] {
  return all(
    `SELECT fs.ingredient_id, i.name, i.category
       FROM fridge_stock fs JOIN ingredients i ON i.id = fs.ingredient_id
      ORDER BY fs.created_at DESC, fs.ingredient_id DESC`,
  );
}

fridgeStockRouter.get('/', (_req, res) => {
  res.json({ items: listStock() });
});

/** 登记一样冰箱里有的食材；重复登记幂等（库存是个集合） */
fridgeStockRouter.post('/', (req, res) => {
  const ingredientId = Number(req.body?.ingredientId);
  if (!Number.isInteger(ingredientId) || ingredientId <= 0) throw badRequest('要登记的食材不对');
  const ingredient = get('SELECT id FROM ingredients WHERE id = ?', ingredientId);
  if (!ingredient) throw badRequest('食材不存在，刷新后再试');
  run('INSERT OR IGNORE INTO fridge_stock (ingredient_id) VALUES (?)', ingredientId);
  broadcast('fridge:updated', {});
  res.status(201).json({ items: listStock() });
});

/** 撤掉一样（用完了 / 记错了） */
fridgeStockRouter.delete('/:ingredientId', (req, res) => {
  const ingredientId = Number(req.params.ingredientId);
  if (Number.isInteger(ingredientId) && ingredientId > 0) {
    run('DELETE FROM fridge_stock WHERE ingredient_id = ?', ingredientId);
    broadcast('fridge:updated', {});
  }
  res.json({ items: listStock() });
});

/** 一键清空：库存消化完，点菜页回到普通排序 */
fridgeStockRouter.delete('/', (_req, res) => {
  run('DELETE FROM fridge_stock');
  broadcast('fridge:updated', {});
  res.json({ items: listStock() });
});

/** 读一组 id：非正整数、去重、上限 100（一次整理不会超过这个量级） */
function readIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<number>();
  for (const entry of value) {
    const id = Number(entry);
    if (Number.isInteger(id) && id > 0) ids.add(id);
    if (ids.size >= 100) break;
  }
  return [...ids];
}

/**
 * 批量登记 / 撤掉——给「说一句话整理库存」的草稿确认用。
 *
 * 为什么要一个批量端点而不是让前端循环调单条：
 *   · 一次整理是**一件事**，半途失败会留下一个谁也不认识的中间状态；包进同一个事务后
 *     要么全成要么全不成，草稿还在屏幕上，重试即可（两个动作本身也都是幂等的）；
 *   · 一条 SSE 广播就够，不会因为一次确认给所有设备推十几条 fridge:updated。
 * 与 POST /api/purchase/batch-check 同一套路。
 */
fridgeStockRouter.post('/batch', (req, res) => {
  const body = (req.body ?? {}) as { add?: unknown; remove?: unknown };
  const add = readIdList(body.add);
  const remove = readIdList(body.remove);
  if (add.length === 0 && remove.length === 0) throw badRequest('没有要改的食材');

  // 外键能拦住不存在的 id，但那会以 500 冒出来；这里先挡一道，给一句能看懂的话
  const wanted = [...new Set([...add, ...remove])];
  const placeholders = wanted.map(() => '?').join(',');
  const known = new Set(
    all<{ id: number }>(`SELECT id FROM ingredients WHERE id IN (${placeholders})`, ...wanted).map((row) => row.id),
  );
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length > 0) throw badRequest(`有 ${missing.length} 样食材已经不在食材库里了，刷新后再试`);

  // 顺序有意为之：先删后插。这样万一同一个 id 既在 add 又在 remove（草稿前端不会这么发，
  // 但接口是公开的），最终结果是「有」——与提示词那条「宁可多登记一样，也不要错删」保持一致。
  transaction(() => {
    for (const id of remove) run('DELETE FROM fridge_stock WHERE ingredient_id = ?', id);
    for (const id of add) run('INSERT OR IGNORE INTO fridge_stock (ingredient_id) VALUES (?)', id);
  });
  broadcast('fridge:updated', {});
  res.json({ items: listStock() });
});
