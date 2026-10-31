/**
 * 订单服务：创建、查询、状态机流转。
 * 成功后统一广播 SSE 事件，并在配置开启时推送手机通知。
 */
import { all, get, run, transaction } from '../db/index.js';
import { parseBomSnapshot } from '../lib/bom.js';
import { broadcast } from '../lib/sse.js';
import { addDays, nowHHmm, round, todayString } from '../lib/units.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import {
  MAX_HEADCOUNT,
  MEAL_LABEL,
  MEAL_TYPES,
  ORDER_STATUSES,
  isValidISODate,
  type MealType,
  type Member,
  type Order,
  type OrderItem,
  type OrderRow,
  type OrderStatus,
} from '../types.js';
import { buildOrderSnapshots, getDishesByIds } from './dishService.js';
import { sendNotification } from './notifyService.js';
import { getCutoff, readSetting } from './settingsService.js';

const log = createLogger('order');

interface CreateOrderItemInput {
  dishId: number;
  servings?: number;
  note?: string;
}

export interface CreateOrderInput {
  memberId: number;
  mealDate?: string;
  mealType: MealType;
  headcount?: number;
  note?: string;
  /** 已过截单时间时，前端确认后置为 true 可继续提交 */
  late?: boolean;
  /** 提交幂等键：客户端每次「确认菜单」生成一次，重试/手抖双击复用同一个值，不会变成两张订单 */
  clientToken?: string;
  items: CreateOrderItemInput[];
}

interface OrderFilter {
  date?: string;
  mealType?: MealType;
  status?: OrderStatus;
  memberId?: number;
  limit?: number;
}

interface OrderRowWithMember extends OrderRow {
  member_name: string;
  member_avatar: string;
  member_color: string;
}

const ORDER_SELECT = `SELECT o.*, m.name AS member_name, m.avatar AS member_avatar, m.color AS member_color
   FROM orders o JOIN members m ON m.id = o.member_id`;

function hydrateOrders(rows: OrderRowWithMember[]): Order[] {
  if (rows.length === 0) return [];

  const placeholders = rows.map(() => '?').join(',');
  // 菜名 / emoji / 分类直接读订单行上的快照：菜品后来改名、改分类甚至被删除，历史订单都保持原样
  const itemRows = all<{
    id: number;
    order_id: number;
    dish_id: number | null;
    servings: number;
    note: string | null;
    name: string;
    emoji: string;
    category: string;
  }>(
    `SELECT oi.id, oi.order_id, oi.dish_id, oi.servings, oi.note,
            oi.dish_name AS name, oi.dish_emoji AS emoji, oi.dish_category AS category
       FROM order_items oi
      WHERE oi.order_id IN (${placeholders})
      ORDER BY oi.id`,
    ...rows.map((row) => row.id),
  );

  const grouped = new Map<number, OrderItem[]>();
  for (const item of itemRows) {
    const entry: OrderItem = {
      id: item.id,
      dish_id: item.dish_id,
      name: item.name,
      emoji: item.emoji,
      category: item.category,
      servings: item.servings,
      note: item.note,
    };
    const list = grouped.get(item.order_id);
    if (list) list.push(entry);
    else grouped.set(item.order_id, [entry]);
  }

  return rows.map((row) => ({
    id: row.id,
    member_id: row.member_id,
    meal_date: row.meal_date,
    meal_type: row.meal_type,
    status: row.status,
    note: row.note,
    headcount: row.headcount,
    created_at: row.created_at,
    updated_at: row.updated_at,
    member: {
      id: row.member_id,
      name: row.member_name,
      avatar: row.member_avatar,
      color: row.member_color,
    },
    items: grouped.get(row.id) ?? [],
  }));
}
export function listOrders(filter: OrderFilter = {}): Order[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.date) {
    conditions.push('o.meal_date = ?');
    params.push(filter.date);
  }
  if (filter.mealType) {
    conditions.push('o.meal_type = ?');
    params.push(filter.mealType);
  }
  if (filter.status) {
    conditions.push('o.status = ?');
    params.push(filter.status);
  }
  if (filter.memberId) {
    conditions.push('o.member_id = ?');
    params.push(filter.memberId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // 只接受有限正整数：?limit=Infinity 这类值拼进 SQL 会变成「no such column: Infinity」直接 500
  const limit =
    typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
      ? `LIMIT ${Math.floor(filter.limit)}`
      : '';
  // meal_type 用 CASE 按早午晚排序：直接按值排是字母序（breakfast < dinner < lunch），
  // 会把晚餐排到午餐前面
  const rows = all<OrderRowWithMember>(
    `${ORDER_SELECT} ${where}
      ORDER BY o.meal_date DESC,
               CASE o.meal_type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'dinner' THEN 3 ELSE 4 END,
               o.created_at DESC ${limit}`,
    ...params,
  );
  return hydrateOrders(rows);
}

/** 首页「家里最近」：按最近更新时间取少量订单，避免为了 5 条记录拉 100 条。 */
export function recentOrders(limit = 5): Order[] {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 5, 1), 20);
  const rows = all<OrderRowWithMember>(
    `${ORDER_SELECT} ORDER BY o.updated_at DESC, o.id DESC LIMIT ${safeLimit}`,
  );
  return hydrateOrders(rows);
}

export function getOrderById(id: number): Order | null {
  const rows = all<OrderRowWithMember>(`${ORDER_SELECT} WHERE o.id = ?`, id);
  return hydrateOrders(rows)[0] ?? null;
}

export function createOrder(input: CreateOrderInput): Order {
  const mealDate = input.mealDate || todayString();
  // 与 deferOrder 同一套严格校验：只校验格式不够，2026-13-99 这类「长得像日期」的值
  // 会绕过字符串比较直接入库，之后营养计算 new Date('2026-13-99') 直接 500。
  if (!isValidISODate(mealDate)) throw badRequest('日期需要是有效的 YYYY-MM-DD');
  const member = get<Member>('SELECT * FROM members WHERE id = ?', input.memberId);
  if (!member) throw notFound('成员不存在');
  if (!MEAL_LABEL[input.mealType]) throw badRequest(`餐次只能是 ${MEAL_TYPES.join(' / ')}`);
  if (!Array.isArray(input.items) || input.items.length === 0) throw badRequest('请至少点一道菜');

  // 幂等：同一个 client_token 已经建过单（网络重试、手抖双击、用户反复点提交）就直接返回那一单，
  // 不再产生第二张——否则采购、备料、营养与统计会全部翻倍
  const token = input.clientToken?.trim();
  if (token) {
    const existing = get<OrderRow>('SELECT * FROM orders WHERE client_token = ?', token);
    if (existing) {
      const order = getOrderById(existing.id);
      if (order) return order;
    }
  }

  const today = todayString();
  if (mealDate < today) throw badRequest('不能给已经过去的日期补录订单');

  const cutoff = getCutoff(input.mealType);
  if (mealDate === today && !input.late && nowHHmm() > cutoff) {
    throw conflict('CUTOFF_PASSED', `${MEAL_LABEL[input.mealType]}已过截单时间（${cutoff}），是否仍然提交？`, {
      cutoff,
      mealType: input.mealType,
    });
  }

  const dishMap = getDishesByIds(input.items.map((item) => item.dishId));
  for (const item of input.items) {
    const dish = dishMap.get(item.dishId);
    if (!dish) throw badRequest(`菜品 #${item.dishId} 不存在`);
    if (!dish.active) throw badRequest(`「${dish.name}」已下架`);
  }

  const fallbackHeadcount = Number(readSetting('default.headcount', '3')) || 3;
  // 非数字入参（比如 'abc'）不能落到 clamp 的 min=1：那会把人数记成 1，营养人均虚高
  const requestedHeadcount = Number(input.headcount);
  const headcount = clamp(
    Math.round(Number.isFinite(requestedHeadcount) ? requestedHeadcount : fallbackHeadcount),
    1,
    MAX_HEADCOUNT,
  );

  // 同一道菜在一单里重复出现（前端合并遗漏、接口直调）等比合并成一行：份数相加、备注取第一个非空的。
  // 否则备料、采购与统计会把这道菜算两遍。
  const merged = new Map<number, { servings: number; note: string | null }>();
  for (const item of input.items) {
    const servings = clamp(Math.round(item.servings ?? 1), 1, 20);
    const note = item.note?.trim() || null;
    const previous = merged.get(item.dishId);
    if (previous) {
      previous.servings = Math.min(previous.servings + servings, 20);
      if (!previous.note) previous.note = note;
    } else {
      merged.set(item.dishId, { servings, note });
    }
  }

  // 下单时刻的快照：菜名 / 分类 / 每人份热量 / BOM（含食材名与当时的营养值）一起写进订单行，
  // 此后改配方、改食材营养、甚至把菜删掉，都不会改写这单的历史口径
  const snapshots = buildOrderSnapshots(Array.from(merged.keys()));

  const orderId = transaction(() => {
    const id = run(
      `INSERT INTO orders (member_id, meal_date, meal_type, status, note, headcount, client_token)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      input.memberId,
      mealDate,
      input.mealType,
      input.note?.trim() || null,
      headcount,
      input.clientToken?.trim() || null,
    ).lastInsertRowid;
    for (const [dishId, item] of merged) {
      const snapshot = snapshots.get(dishId);
      if (!snapshot) continue;
      run(
        `INSERT INTO order_items
           (order_id, dish_id, servings, note, dish_name, dish_emoji, dish_category,
            dish_spicy, dish_tags, kcal_per_serving, bom)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        dishId,
        item.servings,
        item.note,
        snapshot.dish_name,
        snapshot.dish_emoji,
        snapshot.dish_category,
        snapshot.dish_spicy,
        snapshot.dish_tags,
        snapshot.kcal_per_serving,
        snapshot.bom,
      );
    }
    return id;
  });

  const order = getOrderById(orderId);
  if (!order) throw notFound('订单创建异常');

  log.info(`新订单 #${order.id}：${member.name} ${order.meal_date} ${MEAL_LABEL[order.meal_type]} ${order.items.length} 道菜`);
  broadcast('order:created', { order });
  void sendNotification({
    title: `${member.avatar} ${member.name} 点了${MEAL_LABEL[order.meal_type]}`,
    body: order.items.map((item) => `${item.emoji} ${item.name} × ${item.servings}`).join('\n'),
  });

  return order;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** 状态机：允许的流转方向，避免看板出现非法跳转 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['cooking', 'cancelled'],
  cooking: ['done', 'pending', 'cancelled'],
  done: ['cooking'],
  cancelled: ['pending'],
};

/** chefId 必须是库里真实存在的成员，否则当成本次未记录做菜人 */
function resolveChefId(chefId?: number | null): number | null {
  const id = Number(chefId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return get<{ id: number }>('SELECT id FROM members WHERE id = ?', id)?.id ?? null;
}

/**
 * 做菜记录：谁把单子接去做了，就记在谁头上（与订单状态同一事务，保证「状态变了但没记上」不会发生）。
 * - 进入备料中：记一条，并快照这份订单的菜数、份数与总卡路里（后面改订单或配料表不影响已记的数）
 * - 完成：只补记做菜人（正常流程在接单时就记了；从别处推进来的单可能没记）
 * - 退回待接单 / 取消：这一轮开工没做成，把最近一条记录删掉，不计入统计
 * - 完成后再退回备料中：只是把状态拨回去（改错了 / 想再核对），不是又做了一次，不再记一笔
 *
 * 不记开始/结束时间：计时时代大厨经常忘了点「做好了」，工时本身就是脏数据，
 * 且「做没做过」比「做了多久」重要——接单即记，忘了点完成也不会丢统计。
 */
function syncCookLog(order: OrderRow, status: OrderStatus, chefId?: number | null): void {
  if (status === 'cooking') {
    // 已经是备料中（重复点接单）或从「已完成」退回备料中：都不该再记一笔，
    // 否则同一单的做菜次数会虚增（见上一条说明）
    if (order.status === 'cooking' || order.status === 'done') return;
    // 卡路里 = Σ(份数 × 该菜每人份 kcal)，每人份 kcal 取订单行上「下单那一刻」的快照
    // （而不是现查配料表现算）：菜品之后改配方甚至被彻底删除，这一笔的数都不受影响
    const snapshot = get<{ dishes: number; servings: number; kcal: number }>(
      `SELECT COUNT(*) AS dishes,
              COALESCE(SUM(oi.servings), 0) AS servings,
              COALESCE(SUM(oi.servings * oi.kcal_per_serving), 0) AS kcal
         FROM order_items oi
        WHERE oi.order_id = ?`,
      order.id,
    );
    run(
      `INSERT INTO cook_logs (order_id, member_id, meal_date, meal_type, dishes, servings, kcal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      order.id,
      resolveChefId(chefId),
      order.meal_date,
      order.meal_type,
      Number(snapshot?.dishes ?? 0),
      Number(snapshot?.servings ?? 0),
      round(Number(snapshot?.kcal ?? 0), 1),
    );
    return;
  }

  if (status === 'done') {
    // 补记做菜人：接单时没认人（比如另一端直接推了状态）的单，在这里把最近一条记录归到名下
    const chef = resolveChefId(chefId);
    if (chef !== null) {
      run(
        `UPDATE cook_logs SET member_id = ?
          WHERE id = (SELECT id FROM cook_logs WHERE order_id = ? ORDER BY id DESC LIMIT 1)
            AND member_id IS NULL`,
        chef,
        order.id,
      );
    }
    return;
  }

  if (status === 'pending' || status === 'cancelled') {
    // 最近一条就是这一轮的记录：退回意味着这次开工没做成，删掉不计入统计
    run(
      `DELETE FROM cook_logs WHERE id = (SELECT id FROM cook_logs WHERE order_id = ? ORDER BY id DESC LIMIT 1)`,
      order.id,
    );
  }
}

export function updateOrderStatus(id: number, status: OrderStatus, chefId?: number | null): Order {
  if (!ORDER_STATUSES.includes(status)) throw badRequest('订单状态不合法');
  const current = get<OrderRow>('SELECT * FROM orders WHERE id = ?', id);
  if (!current) throw notFound('订单不存在');

  if (current.status !== status && !ALLOWED_TRANSITIONS[current.status].includes(status)) {
    throw conflict('INVALID_TRANSITION', `不能从「${current.status}」直接变更为「${status}」`);
  }

  transaction(() => {
    run(`UPDATE orders SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?`, status, id);
    syncCookLog(current, status, chefId);
  });

  const order = getOrderById(id);
  if (!order) throw notFound('订单不存在');

  log.info(`订单 #${id} 状态 → ${status}`);
  broadcast('order:updated', { order });
  return order;
}

/**
 * 顺延订单：临时不做饭时，把还没接的单整单挪到之后某天的同一餐次。
 * 只对待接单开放——备料中/已完成的单挪日期，做菜记录和当天汇总的口径都会乱；
 * 菜品、份数、备注原样保留，SSE 推 order:updated 后点菜人的「我的订单」自动跟到新日期。
 * 目标日期不传默认顺延一天；允许选回今天（误顺延想拉回来），但不允许落到过去。
 */
export function deferOrder(id: number, mealDate?: string): Order {
  const current = get<OrderRow>('SELECT * FROM orders WHERE id = ?', id);
  if (!current) throw notFound('订单不存在');
  if (current.status !== 'pending') throw conflict('NOT_PENDING', '只有待接单的订单可以顺延');

  const target = mealDate || addDays(current.meal_date, 1);
  if (!isValidISODate(target)) throw badRequest('日期需要是有效的 YYYY-MM-DD');
  if (target < todayString()) throw badRequest('不能顺延到已经过去的日期');
  if (target === current.meal_date) throw badRequest('订单已经在这天了，选个别的日子');

  run(`UPDATE orders SET meal_date = ?, updated_at = datetime('now','localtime') WHERE id = ?`, target, id);
  const order = getOrderById(id);
  if (!order) throw notFound('订单不存在');

  log.info(`订单 #${id} 顺延：${current.meal_date} → ${target} ${MEAL_LABEL[order.meal_type]}`);
  broadcast('order:updated', { order });
  void sendNotification({
    title: `📅 ${order.member.name}的${MEAL_LABEL[order.meal_type]}订单顺延了`,
    body: `${current.meal_date} → ${target}，菜还是原来那些`,
  });
  return order;
}



export function deleteOrder(id: number): void {
  const current = get<OrderRow>('SELECT * FROM orders WHERE id = ?', id);
  if (!current) throw notFound('订单不存在');

  // 删单 + 清采购状态必须同事务：不能单删了、状态却没清，也不能状态清了、单还在。
  transaction(() => {
    run('DELETE FROM orders WHERE id = ?', id);

    // 这一餐已经没有有效订单了：一并清掉这一餐的勾选/改量/隐藏状态。
    // 否则同一天以后再有人点同一道菜，旧的“这一餐不要/改过的量”会突然复活。
    // purchase_custom（手动添加的采购项）是按天维护的独立清单，保留不动。
    const remaining = get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM orders
        WHERE meal_date = ? AND meal_type = ? AND status != 'cancelled'`,
      current.meal_date,
      current.meal_type,
    );
    if (Number(remaining?.c ?? 0) === 0) {
      run(
        'DELETE FROM purchase_state WHERE meal_date = ? AND meal_type = ?',
        current.meal_date,
        current.meal_type,
      );
    }
  });

  log.info(`订单 #${id} 已删除`);
  broadcast('order:deleted', { id, mealDate: current.meal_date, mealType: current.meal_type });
  // 采购/备料页都按订单实时聚合，删单必须让它们重新拉一次（手动条目与做菜统计按各自规则保留）
  broadcast('purchase:updated', { mealDate: current.meal_date, mealType: current.meal_type });
}

interface MealDishAggregate {
  /** 菜品被彻底删除后为 null：菜名、分类与用量改从订单行快照来 */
  dish_id: number | null;
  name: string;
  emoji: string;
  category: string;
  servings: number;
  order_count: number;
  is_fried: boolean;
  cook_minutes: number;
  /** 做法步骤（一行一步，空串 = 没写）：备料弹层点菜名展开用 */
  steps: string;
  /** 实拍图路径（空串 = 用 emoji）：备料弹层小缩略图 */
  image_url: string;
  /** 每人份配料（含常备调料）：大厨页菜谱与备料弹层展开对照用 */
  ingredients: MealDishIngredient[];
}

interface MealDishIngredient {
  name: string;
  /** 每人份用量（g） */
  amount: number;
  is_pantry: boolean;
  /** true = 必有（缺了这道菜不成立）；false = 可选 */
  required: boolean;
}

interface MealSummary {
  meal_date: string;
  meal_type: MealType;
  order_count: number;
  member_count: number;
  headcount: number;
  dish_count: number;
  total_servings: number;
  status_count: Record<OrderStatus, number>;
  dishes: MealDishAggregate[];
}

/** 大厨端「合并备料」视图：把同一餐次所有订单的菜品汇总，一次备料 */
export function mealSummary(mealDate: string, mealType: MealType): MealSummary {
  // 只取一次订单：未取消的做备料聚合，全量的数状态
  const allOrders = listOrders({ date: mealDate, mealType });
  const orders = allOrders.filter((order) => order.status !== 'cancelled');

  const statusCount: Record<OrderStatus, number> = { pending: 0, cooking: 0, done: 0, cancelled: 0 };
  for (const order of allOrders) statusCount[order.status] += 1;

  // 按「菜品」合并：还在菜谱里的按 id 合并，已被彻底删除的按快照菜名合并（dish_id 为 null）
  const map = new Map<string, MealDishAggregate>();
  const keyOf = (item: OrderItem) => (item.dish_id != null ? `d${item.dish_id}` : `s${item.name}`);
  for (const order of orders) {
    for (const item of order.items) {
      const key = keyOf(item);
      const existing = map.get(key);
      if (existing) {
        existing.servings += item.servings;
        existing.order_count += 1;
      } else {
        map.set(key, {
          dish_id: item.dish_id,
          name: item.name,
          emoji: item.emoji,
          category: item.category,
          servings: item.servings,
          order_count: 1,
          is_fried: false,
          cook_minutes: 0,
          steps: '',
          image_url: '',
          ingredients: [],
        });
      }
    }
  }

  // 还在的菜才去查做法 / 实拍图（被删的只剩快照里的菜名与用量）
  const liveDishIds = Array.from(map.values()).flatMap((dish) => (dish.dish_id != null ? [dish.dish_id] : []));
  const placeholder = liveDishIds.map(() => '?').join(',');
  const detailRows =
    liveDishIds.length > 0
      ? all<{ id: number; is_fried: number; cook_minutes: number; steps: string; image_url: string }>(
          `SELECT id, is_fried, cook_minutes, steps, image_url FROM dishes WHERE id IN (${placeholder})`,
          ...liveDishIds,
        )
      : [];
  const detailMap = new Map(detailRows.map((row) => [row.id, row]));

  // 每人份配料：做菜时对照的食谱用量，常备调料一并列出并打标
  const bomRows =
    liveDishIds.length > 0
      ? all<{ dish_id: number; name: string; amount: number; is_pantry: number; required: number }>(
          `SELECT di.dish_id, i.name, di.amount, i.is_pantry, di.required
             FROM dish_ingredients di
             JOIN ingredients i ON i.id = di.ingredient_id
            WHERE di.dish_id IN (${placeholder})
            ORDER BY di.id`,
          ...liveDishIds,
        )
      : [];
  const bomMap = new Map<number, MealDishIngredient[]>();
  for (const row of bomRows) {
    const list = bomMap.get(row.dish_id) ?? [];
    list.push({
      name: row.name,
      amount: row.amount,
      is_pantry: row.is_pantry === 1,
      required: row.required !== 0,
    });
    bomMap.set(row.dish_id, list);
  }

  // 没有当前配方的行（菜被删了、或这道菜压根没录配料）：回退到订单行上的 BOM 快照，
  // 大厨今天照样看得到要备哪些料，不会因为后台删了一道菜就凭空少一栏
  const snapshotRows = all<{ dish_name: string; bom: string }>(
    `SELECT oi.dish_name, oi.bom
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.meal_date = ? AND o.meal_type = ? AND o.status != 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM dish_ingredients di WHERE di.dish_id = oi.dish_id)
      GROUP BY oi.dish_name`,
    mealDate,
    mealType,
  );
  const snapshotMap = new Map(
    snapshotRows.map((row) => [
      row.dish_name,
      parseBomSnapshot(row.bom).map((item) => ({
        name: item.name,
        amount: item.amount,
        is_pantry: item.is_pantry === 1,
        // 老快照没有 required：按必有处理最稳妥，不会凭空少买一样
        required: item.required !== 0,
      })),
    ]),
  );

  for (const aggregate of map.values()) {
    if (aggregate.dish_id != null) {
      const detail = detailMap.get(aggregate.dish_id);
      if (detail) {
        aggregate.is_fried = detail.is_fried === 1;
        aggregate.cook_minutes = detail.cook_minutes;
        aggregate.steps = detail.steps;
        aggregate.image_url = detail.image_url;
      }
    }
    aggregate.ingredients =
      (aggregate.dish_id != null ? bomMap.get(aggregate.dish_id) : undefined) ??
      snapshotMap.get(aggregate.name) ??
      [];
  }

  const dishes = Array.from(map.values()).sort((a, b) => b.servings - a.servings);
  return {
    meal_date: mealDate,
    meal_type: mealType,
    order_count: orders.length,
    member_count: new Set(orders.map((order) => order.member_id)).size,
    headcount: orders.reduce((max, order) => Math.max(max, order.headcount), 0),
    dish_count: dishes.length,
    total_servings: dishes.reduce((sum, dish) => sum + dish.servings, 0),
    status_count: statusCount,
    dishes,
  };
}

export function menuSummaryByDate(mealDate: string): MealSummary[] {
  return MEAL_TYPES.map((mealType) => mealSummary(mealDate, mealType));
}
