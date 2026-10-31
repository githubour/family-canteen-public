/**
 * 订单服务最小单测：创建（校验/钳制/默认值）、状态机流转、顺延、删除。
 * 用临时 SQLite（setup.ts 已把 DB_PATH 指到临时目录）跑真实迁移，不 mock 数据层。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { all, get, run } from '../src/db/index.js';
import { ApiError } from '../src/lib/errors.js';
import { todayString } from '../src/lib/units.js';
import { buildOverview } from '../src/services/analyticsService.js';
import {
  createOrder,
  deferOrder,
  deleteOrder,
  getOrderById,
  listOrders,
  updateOrderStatus,
} from '../src/services/orderService.js';
import { deleteDish } from '../src/services/dishService.js';
import { nextSaturday } from './setup.js';

const memberId = 1;
const mealDate = nextSaturday();

function seed(): { activeDish: number; inactiveDish: number } {
  run(
    `INSERT INTO members (id, name, avatar) VALUES (1, '测试成员', '🙂')`,
  );
  run(
    `INSERT INTO dishes (id, name, emoji, category, active) VALUES (1, '番茄炒蛋', '🍅', '荤菜', 1)`,
  );
  run(
    `INSERT INTO dishes (id, name, emoji, category, active) VALUES (2, '已下架的菜', '🥫', '荤菜', 0)`,
  );
  return { activeDish: 1, inactiveDish: 2 };
}

function httpErrorOf(fn: () => unknown): ApiError {
  try {
    fn();
    throw new Error('预期抛出 ApiError，但没有');
  } catch (error) {
    assert.ok(error instanceof ApiError, `应抛 ApiError，实际 ${String(error)}`);
    return error;
  }
}

describe('orderService.createOrder', () => {
  before(seed);

  it('拒绝长得像日期但不存在的日期（2026-02-30 / 2026-13-99）', () => {
    for (const badDate of ['2026-02-30', '2026-13-99', '2026-00-10']) {
      const error = httpErrorOf(() =>
        createOrder({
          memberId,
          mealDate: badDate,
          mealType: 'dinner',
          items: [{ dishId: 1 }],
        }),
      );
      assert.equal(error.status, 400);
      assert.match(error.message, /有效的 YYYY-MM-DD/);
    }
  });

  it('正常创建：默认状态 pending、默认人数 3、items 带菜品信息', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1, servings: 2, note: '少辣' }],
    });
    assert.equal(order.status, 'pending');
    assert.equal(order.headcount, 3);
    assert.equal(order.meal_date, mealDate);
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].name, '番茄炒蛋');
    assert.equal(order.items[0].servings, 2);
    assert.equal(order.items[0].note, '少辣');
    assert.equal(order.member.name, '测试成员');
  });

  it('份数钳制到 1~20，缺省为 1', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'lunch',
      items: [{ dishId: 1, servings: 99 }],
    });
    assert.equal(order.items[0].servings, 20);
  });

  it('成员不存在 → 404', () => {
    const error = httpErrorOf(() =>
      createOrder({ memberId: 999, mealDate, mealType: 'dinner', items: [{ dishId: 1 }] }),
    );
    assert.equal(error.status, 404);
    assert.equal(error.code, 'NOT_FOUND');
  });

  it('餐次非法 / 空菜单 / 已下架菜品 → 400', () => {
    assert.equal(
      httpErrorOf(() => createOrder({ memberId, mealDate, mealType: '宵夜' as never, items: [{ dishId: 1 }] })).status,
      400,
    );
    assert.equal(
      httpErrorOf(() => createOrder({ memberId, mealDate, mealType: 'dinner', items: [] })).status,
      400,
    );
    const error = httpErrorOf(() =>
      createOrder({ memberId, mealDate, mealType: 'dinner', items: [{ dishId: 2 }] }),
    );
    assert.equal(error.status, 400);
    assert.match(error.message, /已下架/);
  });

  it('过去的日期 → 400', () => {
    const error = httpErrorOf(() =>
      createOrder({ memberId, mealDate: '2001-01-01', mealType: 'dinner', items: [{ dishId: 1 }] }),
    );
    assert.equal(error.status, 400);
    assert.match(error.message, /过去/);
  });
});

describe('orderService.updateOrderStatus', () => {
  it('pending → cooking → done 正向流转，并记下做菜记录', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      headcount: 2,
      items: [{ dishId: 1 }],
    });
    const cooking = updateOrderStatus(order.id, 'cooking', memberId);
    assert.equal(cooking.status, 'cooking');
    const done = updateOrderStatus(order.id, 'done', memberId);
    assert.equal(done.status, 'done');
    // 接单备料时记的那一笔仍在（不因点了完成而变化）
    assert.equal(get<{ c: number }>('SELECT COUNT(*) AS c FROM cook_logs WHERE order_id = ?', order.id)?.c, 1);
  });

  it('pending → done 非法跳转 → 409 INVALID_TRANSITION', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1 }],
    });
    const error = httpErrorOf(() => updateOrderStatus(order.id, 'done'));
    assert.equal(error.status, 409);
    assert.equal(error.code, 'INVALID_TRANSITION');
  });

  it('done → cooking 允许（把状态拨回备料中）', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1 }],
    });
    updateOrderStatus(order.id, 'cooking');
    updateOrderStatus(order.id, 'done');
    const again = updateOrderStatus(order.id, 'cooking');
    assert.equal(again.status, 'cooking');
  });
});

describe('orderService 做菜记录', () => {
  /** 这单的全部做菜记录（按时间正序） */
  function cookLogsOf(orderId: number) {
    return all<{ member_id: number | null; dishes: number; servings: number; kcal: number }>(
      `SELECT member_id, dishes, servings, kcal FROM cook_logs WHERE order_id = ? ORDER BY id`,
      orderId,
    );
  }

  it('接单备料即记一笔：记到做菜人头上，并快照份数与卡路里', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      headcount: 2,
      items: [{ dishId: 1, servings: 2 }],
    });
    updateOrderStatus(order.id, 'cooking', memberId);
    const logs = cookLogsOf(order.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].member_id, memberId);
    assert.equal(logs[0].servings, 2);
  });

  it('汇总同时给出“道次”与真实“份数”，两者不再混用', () => {
    const before = buildOverview(7);
    createOrder({
      memberId,
      mealDate: todayString(),
      mealType: 'lunch',
      late: true,
      items: [{ dishId: 1, servings: 3 }],
    });
    const after = buildOverview(7);
    assert.equal(after.dish_count - before.dish_count, 1);
    assert.equal(after.serving_count - before.serving_count, 3);
  });

  it('忘点「做好了」也不丢统计：接单后就直接进汇总口径', () => {
    const order = createOrder({
      memberId,
      mealDate: todayString(),
      mealType: 'dinner',
      late: true,
      items: [{ dishId: 1 }],
    });
    updateOrderStatus(order.id, 'cooking', memberId);
    // 不再点「完成」——旧实现要 finished_at 非空才计入，现在接单就算
    const stats = buildOverview(7).cook_stats.find((item) => item.member_id === memberId);
    assert.ok(stats && stats.cook_count >= 1, '没点完成也要计入做菜统计');
  });

  it('重复点接单不重复记；完成后退回备料中也不重复记', () => {
    const order = createOrder({ memberId, mealDate, mealType: 'dinner', items: [{ dishId: 1 }] });
    updateOrderStatus(order.id, 'cooking', memberId);
    updateOrderStatus(order.id, 'cooking', memberId); // 状态没变化，不该重复
    assert.equal(cookLogsOf(order.id).length, 1);

    updateOrderStatus(order.id, 'done', memberId);
    updateOrderStatus(order.id, 'cooking', memberId); // 只是把状态拨回去，不是又做了一次
    assert.equal(cookLogsOf(order.id).length, 1);
  });

  it('退回待接单 / 取消：这一轮的记录被删掉，不计入统计', () => {
    const revert = createOrder({ memberId, mealDate, mealType: 'dinner', items: [{ dishId: 1 }] });
    updateOrderStatus(revert.id, 'cooking', memberId);
    updateOrderStatus(revert.id, 'pending', memberId);
    assert.equal(cookLogsOf(revert.id).length, 0);

    const cancel = createOrder({ memberId, mealDate, mealType: 'dinner', items: [{ dishId: 1 }] });
    updateOrderStatus(cancel.id, 'cooking', memberId);
    updateOrderStatus(cancel.id, 'cancelled', memberId);
    assert.equal(cookLogsOf(cancel.id).length, 0);
  });

  it('接单时没认人：点完成时把最近一条记录补到做菜人名下', () => {
    const order = createOrder({ memberId, mealDate, mealType: 'dinner', items: [{ dishId: 1 }] });
    updateOrderStatus(order.id, 'cooking'); // 没带 chefId
    assert.equal(cookLogsOf(order.id)[0].member_id, null);
    updateOrderStatus(order.id, 'done', memberId);
    assert.equal(cookLogsOf(order.id)[0].member_id, memberId);
  });

  it('接单前菜品被彻底删除：kcal 按订单快照记，不归零', () => {
    // 独立建一道带配料的菜（100g × 200kcal/100g = 每人份 200 kcal）
    run(`INSERT INTO ingredients (name, category, kcal) VALUES ('快照食材', '蔬果', 200)`);
    const ingredient = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', '快照食材');
    run(`INSERT INTO dishes (name, emoji, category, active) VALUES ('快照测试菜', '🍲', '荤菜', 1)`);
    const dish = get<{ id: number }>('SELECT id FROM dishes WHERE name = ?', '快照测试菜');
    assert.ok(ingredient && dish);
    run(
      `INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, unit, required) VALUES (?, ?, 100, 'g', 1)`,
      dish.id,
      ingredient.id,
    );

    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: dish.id, servings: 2 }],
    });
    const snapshot = get<{ kcal_per_serving: number }>(
      'SELECT kcal_per_serving FROM order_items WHERE order_id = ?',
      order.id,
    );
    assert.equal(snapshot?.kcal_per_serving, 200);

    deleteDish(dish.id); // 接单备料之前把菜彻底删掉
    updateOrderStatus(order.id, 'cooking', memberId);

    const logs = cookLogsOf(order.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].servings, 2);
    // 2 份 × 200 kcal：按下单快照记，不因菜品被删或配方变化而归零
    assert.equal(logs[0].kcal, 400);
  });
});

describe('orderService.deferOrder', () => {
  it('待接单顺延到明天，菜品保留', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1, servings: 2 }],
    });
    const deferred = deferOrder(order.id);
    assert.notEqual(deferred.meal_date, order.meal_date);
    assert.equal(deferred.items.length, 1);
    assert.equal(deferred.items[0].servings, 2);
  });

  it('非待接单 → 409；目标日期在过去 → 400；同日 → 400', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1 }],
    });
    updateOrderStatus(order.id, 'cooking');
    assert.equal(httpErrorOf(() => deferOrder(order.id)).status, 409);

    const pending = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1 }],
    });
    assert.equal(httpErrorOf(() => deferOrder(pending.id, '2001-01-01')).status, 400);
    assert.equal(httpErrorOf(() => deferOrder(pending.id, pending.meal_date)).status, 400);
  });
});

describe('orderService.deleteOrder', () => {
  it('删除后查不到', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1 }],
    });
    deleteOrder(order.id);
    assert.equal(getOrderById(order.id), null);
  });

  it('删掉一餐最后一单时清掉该餐采购状态，但保留手动采购项', () => {
    const uniqueDate = '2031-01-04';
    run("INSERT OR IGNORE INTO ingredients (id, name, category) VALUES (1, '番茄', '蔬果')");
    const order = createOrder({
      memberId,
      mealDate: uniqueDate,
      mealType: 'breakfast',
      items: [{ dishId: 1 }],
    });
    run(
      'INSERT INTO purchase_state (meal_date, meal_type, ingredient_id, checked, hidden) VALUES (?, ?, 1, 1, 1)',
      uniqueDate,
      'breakfast',
    );
    run(
      'INSERT INTO purchase_custom (meal_date, meal_type, name, amount_text) VALUES (?, ?, ?, ?)',
      uniqueDate,
      'breakfast',
      '手动葱',
      '1 把',
    );

    deleteOrder(order.id);
    const state = get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM purchase_state WHERE meal_date = ? AND meal_type = ?',
      uniqueDate,
      'breakfast',
    );
    const custom = get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM purchase_custom WHERE meal_date = ? AND meal_type = ?',
      uniqueDate,
      'breakfast',
    );
    assert.equal(Number(state?.c ?? 0), 0);
    assert.equal(Number(custom?.c ?? 0), 1);
  });

  it('已开工的订单删除后，做菜记录保留并归到历史（order_id 置空）', () => {
    const order = createOrder({
      memberId,
      mealDate,
      mealType: 'dinner',
      items: [{ dishId: 1, servings: 2 }],
    });
    updateOrderStatus(order.id, 'cooking', memberId);
    const before = get<{ c: number }>('SELECT COUNT(*) AS c FROM cook_logs WHERE order_id = ?', order.id);
    assert.equal(Number(before?.c ?? 0), 1);

    deleteOrder(order.id);
    assert.equal(getOrderById(order.id), null);

    const kept = all<{ order_id: number | null; member_id: number | null; servings: number }>(
      'SELECT order_id, member_id, servings FROM cook_logs WHERE meal_date = ? AND meal_type = ?',
      mealDate,
      'dinner',
    ).filter((row) => row.order_id === null);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].member_id, memberId);
    assert.equal(kept[0].servings, 2);
  });
});

describe('orderService.listOrders', () => {
  it('limit 传 Infinity 等非法值不拼进 SQL（曾会 500），合法正整数照常截断', () => {
    createOrder({ memberId, mealDate, mealType: 'dinner', items: [{ dishId: 1 }] });
    const all = listOrders({ limit: Number.POSITIVE_INFINITY });
    assert.ok(all.length >= 1, '非法 limit 应退化为不限制，而不是报错');
    const one = listOrders({ limit: 1 });
    assert.equal(one.length, 1);
  });
});
