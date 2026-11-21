/**
 * 彻底删除菜品（deleteDish）：有了订单行快照，删菜不再伤历史。
 *
 * 早期的实现是「有历史点单就不许删」，因为订单详情、营养与统计全靠 JOIN 菜品主数据现算。
 * 现在菜名 / 分类 / 每人份热量 / BOM 都冻结在订单行上（dish_id 是 ON DELETE SET NULL），
 * 所以任何菜都能真删：历史订单照常显示当时的菜名，营养报告口径不变，采购与备料回退快照。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { deleteDish, getDishById } from '../src/services/dishService.js';
import { createOrder, listOrders } from '../src/services/orderService.js';
import { buildNutritionReport } from '../src/services/nutritionService.js';
import { nextSaturday } from './setup.js';

const mealDate = nextSaturday();

before(() => {
  run(`INSERT INTO members (id, name, avatar) VALUES (1, '测试家人', '🙂')`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES (1, '鸡蛋', '蛋奶', 144, 13.3, 8.8, 2.8, 131, 0)`);
  // 1 号是正常在卖的菜（会被点），2 号是录错名字的废菜
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (1, '番茄炒蛋', '🍅', '荤菜')`);
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (2, '录错的菜', '🥴', '荤菜')`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 1, 100)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (2, 1, 100)`);
  run(`INSERT INTO dish_feedback (dish_id, content) VALUES (2, '名字录错了')`);
  createOrder({
    memberId: 1,
    mealDate,
    mealType: 'lunch',
    late: true,
    items: [{ dishId: 1, servings: 2 }],
  });
});

describe('deleteDish（彻底删除菜品）', () => {
  it('从没被点过的菜可以删，配料表与菜品反馈一起清掉', () => {
    const result = deleteDish(2);
    assert.equal(result.name, '录错的菜');
    assert.equal(result.removed_feedback, 1);
    assert.equal(result.kept_orders, 0);
    assert.equal(getDishById(2), null);
    // 级联生效：不留指向已删菜品的孤儿行
    assert.equal(get<{ c: number }>('SELECT COUNT(*) AS c FROM dish_ingredients WHERE dish_id = 2')?.c, 0);
    assert.equal(get<{ c: number }>('SELECT COUNT(*) AS c FROM dish_feedback WHERE dish_id = 2')?.c, 0);
    // 别人不受影响
    assert.ok(getDishById(1));
  });

  it('被点过的菜也能删：订单行的 dish_id 置空，菜名与营养仍由快照撑着', () => {
    const before = buildNutritionReport(mealDate);

    const result = deleteDish(1);
    assert.equal(result.name, '番茄炒蛋');
    assert.equal(result.kept_orders, 1);
    assert.equal(getDishById(1), null);

    // 历史订单照常：菜名 / emoji / 分类来自下单时的快照，只有 dish_id 变空
    const order = listOrders({ date: mealDate, mealType: 'lunch' })[0];
    assert.ok(order);
    assert.equal(order.items[0].dish_id, null);
    assert.equal(order.items[0].name, '番茄炒蛋');
    assert.equal(order.items[0].emoji, '🍅');
    assert.equal(order.items[0].category, '荤菜');

    // 营养报告一个字都不变（快照口径，不理会菜品是否还在）
    const after = buildNutritionReport(mealDate);
    assert.deepEqual(after.totals, before.totals);
    assert.equal(after.dish_count, before.dish_count);
  });

  it('不存在的菜品回 404，不会误删到别人', () => {
    assert.throws(() => deleteDish(999), /菜品不存在/);
  });
});
