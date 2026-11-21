/**
 * 订单行快照（v17）：下单那一刻把菜名 / 分类 / 每人份热量 / BOM 冻结在订单行上。
 *
 * 这套改造要守住三件事，本文件逐条验证：
 * 1. 之后改配方（改用量、改食材营养、删菜）都不会改写历史订单与历史营养报告；
 * 2. 新订单永远按「当时的配方」算，不会跟着老快照走；
 * 3. 提交幂等 + 同菜合并：重试、双击、payload 里重复的菜都不会变成两份。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { all, run } from '../src/db/index.js';
import { mealSummary, createOrder, listOrders, type CreateOrderInput } from '../src/services/orderService.js';
import { buildNutritionReport } from '../src/services/nutritionService.js';
import { buildPurchaseList } from '../src/services/purchaseService.js';
import { deleteDish } from '../src/services/dishService.js';
import { nextSaturday } from './setup.js';

/** 次日：避开「今天刚好是周六」时与 day1 撞车，两天的口径互不干扰 */
function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 10);
}

const day1 = nextSaturday();
const day2 = dayAfter(day1);

before(() => {
  run(`INSERT INTO members (id, name, avatar) VALUES (1, '甲', '🙂')`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES (1, '鸡蛋', '蛋奶', 144, 13.3, 8.8, 2.8, 131, 0)`);
  run(`INSERT INTO dishes (id, name, emoji, category, spicy, tags)
       VALUES (1, '番茄炒蛋', '🍅', '荤菜', 1, '["家常"]')`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 1, 100)`);
});

describe('订单行快照（历史口径不被改写）', () => {
  it('改配方后：老订单的营养报告一个字不变，新下的单按新配方算', () => {
    createOrder({
      memberId: 1,
      mealDate: day1,
      mealType: 'lunch',
      late: true,
      items: [{ dishId: 1, servings: 1 }],
    });
    const beforeEdit = buildNutritionReport(day1);
    assert.equal(beforeEdit.totals.kcal, 144); // 鸡蛋 100g/份 × 1 份

    // 配方从 100g 改成 200g（相当于「这道菜后来加量了」）
    run('UPDATE dish_ingredients SET amount = 200 WHERE dish_id = 1');

    const afterEdit = buildNutritionReport(day1);
    assert.deepEqual(afterEdit.totals, beforeEdit.totals);

    // 新订单按最新配方：同一道菜这下是 288 kcal
    createOrder({
      memberId: 1,
      mealDate: day2,
      mealType: 'lunch',
      late: true,
      items: [{ dishId: 1, servings: 1 }],
    });
    assert.equal(buildNutritionReport(day2).totals.kcal, 288);
  });

  it('提交幂等与同菜合并：重试、双击、重复行都不会变成两份', () => {
    const token = 'test-token-dup';
    const payload: CreateOrderInput = {
      memberId: 1,
      mealDate: day2,
      mealType: 'dinner',
      late: true,
      clientToken: token,
      items: [{ dishId: 1, servings: 1 }],
    };
    const first = createOrder(payload);
    const retry = createOrder(payload);
    assert.equal(retry.id, first.id);
    assert.equal(all<{ id: number }>('SELECT id FROM orders WHERE client_token = ?', token).length, 1);

    // 同一道菜在一单里出现两次：合并成一行、份数相加，采购与备料才不会算两遍
    const merged = createOrder({
      memberId: 1,
      mealDate: day2,
      mealType: 'breakfast',
      late: true,
      items: [
        { dishId: 1, servings: 1 },
        { dishId: 1, servings: 2 },
      ],
    });
    assert.equal(merged.items.length, 1);
    assert.equal(merged.items[0].servings, 3);
  });

  it('菜被彻底删除后：订单详情、采购清单与大厨备料全靠快照说话', () => {
    const lunchOrder = listOrders({ date: day1, mealType: 'lunch' })[0];
    assert.ok(lunchOrder);
    assert.equal(lunchOrder.items[0].dish_id, 1);

    deleteDish(1);

    // 订单详情：菜名/emoji/分类仍在，只有 dish_id 置空
    const afterDelete = listOrders({ date: day1, mealType: 'lunch' })[0];
    assert.ok(afterDelete);
    assert.equal(afterDelete.items[0].dish_id, null);
    assert.equal(afterDelete.items[0].name, '番茄炒蛋');
    assert.equal(afterDelete.items[0].emoji, '🍅');
    assert.equal(afterDelete.items[0].category, '荤菜');

    // 采购清单：这道菜已经没有配料表了，按快照补上（100g/份 × 1 份）
    const list = buildPurchaseList(day1, 'lunch');
    const allItems = [...list.to_buy, ...list.optional, ...list.pantry, ...list.hidden];
    const egg = allItems.find((item) => item.name === '鸡蛋');
    assert.ok(egg, '菜被删后采购清单仍应列出它的食材');
    assert.equal(egg.amount, 100);
    assert.deepEqual(egg.from_dishes, ['番茄炒蛋']);

    // 大厨备料：菜名与每人份用量同样来自快照
    const summary = mealSummary(day1, 'lunch');
    assert.equal(summary.dishes.length, 1);
    assert.equal(summary.dishes[0].name, '番茄炒蛋');
    assert.equal(summary.dishes[0].dish_id, null);
    assert.deepEqual(summary.dishes[0].ingredients, [
      { name: '鸡蛋', amount: 100, is_pantry: false, required: true },
    ]);
  });
});
