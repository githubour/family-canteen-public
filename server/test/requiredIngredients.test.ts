/**
 * 必有 / 可选食材（dish_ingredients.required）。
 *
 * 这个标记有两处出口：点菜页按「必有食材」的命中情况排序（前端 hook 消费 Dish.ingredients.required），
 * 采购清单把「只有可选身份」的食材折进 optional 组、默认不算必买。本文件守住三件事：
 * 1. required 从 BOM 一路透出到菜品列表与大厨备料；
 * 2. 同一食材身份随菜而变——任一菜把它当必有就得买，全是可选才进 optional；
 * 3. 老数据（没写过 required 的行）默认按必有处理。
 *
 * 夹具：番茄炒蛋（番茄/鸡蛋必有、大葱可选）与葱油拌面（大葱是主角，必有）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { run } from '../src/db/index.js';
import { listDishes } from '../src/services/dishService.js';
import { createOrder, mealSummary } from '../src/services/orderService.js';
import { buildPurchaseList, buildPurchaseText } from '../src/services/purchaseService.js';
import { nextSaturday } from './setup.js';

const mealDate = nextSaturday();

before(() => {
  run(`INSERT INTO members (id, name, avatar) VALUES (1, '甲', '🙂')`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, price_per_100g)
       VALUES (1, '番茄', '蔬果', 20, 1.0, 0.2, 4.0, 5, 1.2, 8)`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, price_per_100g)
       VALUES (2, '鸡蛋', '肉禽蛋', 144, 13.3, 8.8, 2.8, 131, 0, 2)`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, price_per_100g)
       VALUES (3, '大葱', '蔬果', 33, 1.7, 0.3, 6.5, 4.8, 1.3, 1)`);
  // 常备调料：不进采购任务，单独成组
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, is_pantry)
       VALUES (4, '盐', '调料', 0, 0, 0, 0, 39000, 0, 1)`);

  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (1, '番茄炒蛋', '🍅', '素菜')`);
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (2, '葱油拌面', '🍜', '主食')`);

  // 番茄炒蛋：番茄 / 鸡蛋必有，大葱只是撒花
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (1, 1, 150, 1)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (1, 2, 75, 1)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (1, 3, 5, 0)`);
  // 老数据形态：不写 required 列，迁移默认值 1 = 必有
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 4, 1)`);
  // 葱油拌面：大葱是灵魂，必有
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (2, 3, 25, 1)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (2, 4, 2, 1)`);

  createOrder({ memberId: 1, mealDate, mealType: 'lunch', late: true, items: [{ dishId: 1, servings: 1 }] });
});

describe('必有 / 可选食材', () => {
  it('菜品 BOM 透出 required：没写的按必有算', () => {
    const dish = listDishes({ category: '素菜' }).find((item) => item.name === '番茄炒蛋');
    assert.ok(dish);
    const byName = new Map(dish.ingredients.map((item) => [item.name, item.required]));
    assert.equal(byName.get('番茄'), true);
    assert.equal(byName.get('鸡蛋'), true);
    assert.equal(byName.get('大葱'), false);
    assert.equal(byName.get('盐'), true);
  });

  it('采购清单：只有可选身份的食材进 optional 组，必买组不含它、花费也不计', () => {
    const lunch = buildPurchaseList(mealDate, 'lunch');
    assert.deepEqual(lunch.optional.map((item) => item.name), ['大葱']);
    assert.equal(lunch.optional[0].is_optional, true);
    assert.deepEqual(lunch.to_buy.map((item) => item.name).sort(), ['番茄', '鸡蛋']);
    assert.deepEqual(lunch.pantry.map((item) => item.name), ['盐']);
    assert.equal(lunch.to_buy.every((item) => item.is_optional === false), true);
    assert.equal(lunch.total, 2);
    // 番茄 1.5×8 + 鸡蛋 0.75×2 = 13.5；可选的大葱不计入预估
    assert.equal(lunch.estimated_cost, 13.5);
  });

  it('同一食材身份随菜而变：另一道菜把它当必有，当天就得买', () => {
    createOrder({ memberId: 1, mealDate, mealType: 'dinner', late: true, items: [{ dishId: 2, servings: 1 }] });
    const dinner = buildPurchaseList(mealDate, 'dinner');
    assert.equal(dinner.to_buy.some((item) => item.name === '大葱'), true);
    assert.equal(dinner.optional.length, 0);
  });

  it('大厨备料的每人份配料同样带 required', () => {
    const summary = mealSummary(mealDate, 'lunch');
    const dish = summary.dishes.find((item) => item.name === '番茄炒蛋');
    assert.ok(dish);
    assert.equal(dish.ingredients.find((item) => item.name === '大葱')?.required, false);
    assert.equal(dish.ingredients.find((item) => item.name === '番茄')?.required, true);
  });

  it('文本导出把可选加购单独成段', () => {
    const text = buildPurchaseText(buildPurchaseList(mealDate, 'lunch'));
    assert.match(text, /◆ 可选加购/);
    assert.match(text, /大葱/);
  });
});
