/**
 * 采购清单接口。
 *
 * mealType 传三餐之一（大厨页备料弹层用），或传 'day' = 当天三餐合并口径（采购页默认）：
 * 很多时候一天只买一次菜，按早午晚分三次看反而啰嗦。day 只是读写口径，状态仍落在各餐自己的
 * purchase_state / purchase_custom 上（读是三餐合并、写是三餐扇出），所以备料弹层与采购页
 * 永远共用同一份进度。
 */
import { Router } from 'express';
import {
  addDayPurchaseCustom,
  addPurchaseCustom,
  batchSetChecked,
  batchSetDayChecked,
  buildDayPurchaseList,
  buildPurchaseList,
  buildPurchaseText,
  createIngredient,
  deleteIngredient,
  listOrphanIngredients,
  removeDayPurchaseCustom,
  removePurchaseCustom,
  resetDayPurchaseState,
  resetPurchaseState,
  setDayPurchaseCustomState,
  setDayPurchaseHidden,
  setDayPurchaseState,
  setPurchaseCustomState,
  setPurchaseHidden,
  setPurchaseState,
} from '../services/purchaseService.js';
import { badRequest } from '../lib/errors.js';
import { readDateParam } from '../lib/units.js';
import {
  MEAL_TYPES,
  isValidISODate,
  type MealType,
  type PurchaseList,
  type PurchaseScope,
} from '../types.js';

export const purchaseRouter = Router();

function isMealType(value: unknown): value is MealType {
  return typeof value === 'string' && (MEAL_TYPES as string[]).includes(value);
}

/** 'day' = 当天三餐合并；其余是具体餐次 */
function isScope(value: unknown): value is PurchaseScope {
  return value === 'day' || isMealType(value);
}

function readScope(query: Record<string, unknown>): { date: string; scope: PurchaseScope } {
  const raw = query.mealType;
  if (!isScope(raw)) throw badRequest(`请指定 mealType=${MEAL_TYPES.join('|')}|day`);
  return { date: readDateParam(query.date), scope: raw };
}

/** 读 body 里的 mealDate / mealType，手动调整的几个端点共用 */
function readScopeBody(body: Record<string, unknown>): { date: string; scope: PurchaseScope } {
  const raw = body.mealType;
  if (!body.mealDate || !isScope(raw)) throw badRequest('缺少 mealDate 或 mealType');
  if (!isValidISODate(body.mealDate)) throw badRequest('mealDate 需要是有效的 YYYY-MM-DD');
  return { date: body.mealDate, scope: raw };
}

/** 读正数 id：Number('') / Number(null) 都是 0，不能只判断「是整数」 */
function readPositiveId(value: unknown, message: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(message);
  return id;
}

/** 改量上限：家庭采购不会超过这个量级，挡住误输入的 1e9（会进成本估算） */
const MAX_OVERRIDE_AMOUNT = 100_000;

/** 按口径取清单：day 走三餐合并，其余走单餐（大厨页备料弹层用） */
function listFor(date: string, scope: PurchaseScope): PurchaseList {
  return scope === 'day' ? buildDayPurchaseList(date) : buildPurchaseList(date, scope);
}

/** 归一改量入参：undefined = 不改，null / 空串 = 恢复系统计算值，其余必须是有限正数 */
function readOverrideAmount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_OVERRIDE_AMOUNT) {
    throw badRequest(`数量要大于 0 且不超过 ${MAX_OVERRIDE_AMOUNT}`);
  }
  return amount;
}

purchaseRouter.get('/', (req, res) => {
  const { date, scope } = readScope(req.query as Record<string, unknown>);
  res.json({ list: listFor(date, scope) });
});

/** 孤立食材：没被任何菜品引用的食材，采购页据此提醒「记得建菜谱」 */
purchaseRouter.get('/orphans', (_req, res) => {
  res.json({ ingredients: listOrphanIngredients() });
});

/** 手动补入食材库：营养值默认 0（后台可补），新食材会立刻进入孤立食材提醒 */
purchaseRouter.post('/ingredients', (req, res) => {
  const body = req.body ?? {};
  const ingredient = createIngredient(
    typeof body.name === 'string' ? body.name : '',
    typeof body.category === 'string' ? body.category : '',
    body.is_pantry === true,
  );
  res.status(201).json({ ingredient });
});

/** 删掉一条孤立食材（加错了 / 不打算用了）；返回刷新后的清单，前端直接用它替换本地数据 */
purchaseRouter.delete('/ingredients/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('食材 id 不对');
  res.json({ ingredients: deleteIngredient(id) });
});

purchaseRouter.get('/text', (req, res) => {
  const { date, scope } = readScope(req.query as Record<string, unknown>);
  const list = listFor(date, scope);
  res.json({ text: buildPurchaseText(list), list });
});

purchaseRouter.patch('/state', (req, res) => {
  const body = req.body ?? {};
  const { date, scope } = readScopeBody(body);
  const ingredientId = readPositiveId(body.ingredientId, '缺少 ingredientId');

  const patch = {
    checked: body.checked === undefined ? undefined : Boolean(body.checked),
    overrideAmount: readOverrideAmount(body.overrideAmount),
    note: body.note === undefined ? undefined : body.note === null ? null : String(body.note),
  };
  const list =
    scope === 'day'
      ? setDayPurchaseState({ mealDate: date, ingredientId, ...patch })
      : setPurchaseState({ mealDate: date, mealType: scope, ingredientId, ...patch });
  res.json({ list });
});

purchaseRouter.post('/batch-check', (req, res) => {
  const body = req.body ?? {};
  const { date, scope } = readScopeBody(body);
  const checked = Boolean(body.checked);
  const list = scope === 'day' ? batchSetDayChecked(date, checked) : batchSetChecked(date, scope, checked);
  res.json({ list });
});

purchaseRouter.post('/reset', (req, res) => {
  const body = req.body ?? {};
  const { date, scope } = readScopeBody(body);
  const list = scope === 'day' ? resetDayPurchaseState(date) : resetPurchaseState(date, scope);
  res.json({ list });
});

purchaseRouter.post('/hidden', (req, res) => {
  const body = req.body ?? {};
  const { date, scope } = readScopeBody(body);
  const ingredientId = readPositiveId(body.ingredientId, '缺少 ingredientId');
  const hidden = Boolean(body.hidden);
  const list =
    scope === 'day' ? setDayPurchaseHidden(date, ingredientId, hidden) : setPurchaseHidden(date, scope, ingredientId, hidden);
  res.json({ list });
});

purchaseRouter.post('/custom', (req, res) => {
  const body = req.body ?? {};
  const { date, scope } = readScopeBody(body);
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('先填一下食材名称');
  if (name.length > 30) throw badRequest('食材名称太长了（30 字以内）');
  const amountText = String(body.amountText ?? '').trim().slice(0, 40);
  const list =
    scope === 'day' ? addDayPurchaseCustom(date, name, amountText) : addPurchaseCustom(date, scope, name, amountText);
  res.json({ list });
});

// 手动条目的勾选 / 删除：day 口径按「名称」定位（三餐各有一行同名，一起改），按餐口径用 customId
function readCustomName(body: Record<string, unknown>): string {
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('缺少 name');
  return name;
}

purchaseRouter.post('/custom/state', (req, res) => {
  const body = req.body ?? {};
  const { date, scope } = readScopeBody(body);
  const checked = Boolean(body.checked);
  if (scope === 'day') {
    res.json({ list: setDayPurchaseCustomState(date, readCustomName(body), checked) });
    return;
  }
  res.json({ list: setPurchaseCustomState(date, scope, readPositiveId(body.customId, '缺少 customId'), checked) });
});

purchaseRouter.post('/custom/remove', (req, res) => {
  const body = req.body ?? {};
  const { date, scope } = readScopeBody(body);
  if (scope === 'day') {
    res.json({ list: removeDayPurchaseCustom(date, readCustomName(body)) });
    return;
  }
  res.json({ list: removePurchaseCustom(date, scope, readPositiveId(body.customId, '缺少 customId')) });
});
