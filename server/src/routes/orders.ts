import { Router } from 'express';
import {
  createOrder,
  deferOrder,
  deleteOrder,
  listOrders,
  menuSummaryByDate,
  recentOrders,
  updateOrderStatus,
} from '../services/orderService.js';
import { todayString } from '../lib/units.js';
import { badRequest } from '../lib/errors.js';
import { MEAL_TYPES, ORDER_STATUSES, isValidISODate, type MealType, type OrderStatus } from '../types.js';

export const ordersRouter = Router();

function isMealType(value: unknown): value is MealType {
  return typeof value === 'string' && (MEAL_TYPES as string[]).includes(value);
}

/** 非法状态直接 400：静默返回空列表会把「参数写错」伪装成「今天没有订单」 */
function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as string[]).includes(value);
}

ordersRouter.get('/', (req, res) => {
  if (req.query.status !== undefined && !isOrderStatus(req.query.status)) {
    throw badRequest(`status 只能是 ${ORDER_STATUSES.join(' / ')}`);
  }
  if (req.query.date !== undefined && !isValidISODate(req.query.date)) {
    throw badRequest('date 需要是有效的 YYYY-MM-DD');
  }
  const orders = listOrders({
    date: typeof req.query.date === 'string' ? req.query.date : undefined,
    mealType: isMealType(req.query.mealType) ? req.query.mealType : undefined,
    status: isOrderStatus(req.query.status) ? req.query.status : undefined,
    memberId: req.query.memberId ? Number(req.query.memberId) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json({ orders });
});

/** 首页「家里最近」：按 updated_at 取少量订单，避免首页拉 100 条历史。 */
ordersRouter.get('/recent', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 5;
  res.json({ orders: recentOrders(limit) });
});

/** 大厨端看板数据：按餐次把当日订单与本餐备料汇总一起返回 */
ordersRouter.get('/summary', (req, res) => {
  if (req.query.date !== undefined && !isValidISODate(req.query.date)) {
    throw badRequest('date 需要是有效的 YYYY-MM-DD');
  }
  const date = typeof req.query.date === 'string' ? req.query.date : todayString();
  res.json({ summaries: menuSummaryByDate(date) });
});

ordersRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const order = createOrder({
    memberId: Number(body.memberId),
    mealDate: typeof body.mealDate === 'string' ? body.mealDate : undefined,
    mealType: body.mealType,
    headcount: body.headcount !== undefined ? Number(body.headcount) : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
    late: Boolean(body.late),
    // 幂等键（可选）：同一个 token 重复提交只会得到同一张订单，前端重试与双击都安全
    clientToken: typeof body.clientToken === 'string' ? body.clientToken : undefined,
    items: Array.isArray(body.items) ? body.items : [],
  });
  res.status(201).json({ order });
});

ordersRouter.patch('/:id/status', (req, res) => {
  // chefId = 操作大厨看板的人，用于把这单的做菜记录记到谁头上
  const chefId = req.body?.chefId !== undefined ? Number(req.body.chefId) : null;
  const order = updateOrderStatus(Number(req.params.id), req.body?.status as OrderStatus, chefId);
  res.json({ order });
});

/** 顺延：待接单的订单整单挪到之后的某天（不传 mealDate 默认顺延一天） */
ordersRouter.post('/:id/defer', (req, res) => {
  const mealDate = typeof req.body?.mealDate === 'string' ? req.body.mealDate : undefined;
  const order = deferOrder(Number(req.params.id), mealDate);
  res.json({ order });
});

ordersRouter.delete('/:id', (req, res) => {
  deleteOrder(Number(req.params.id));
  res.json({ ok: true });
});
