/**
 * 营养服务最小单测：BOM 展开 → 人均口径 → 膳食指南对照。
 * 用可手算的数据（固定克重与营养值）断言算术，而不是只看「有没有输出」。
 * 口径约定：配料 amount 是每人份克重，营养值是每 100g；周六默认三餐在家（scale=1）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { run } from '../src/db/index.js';
import { buildNutritionReport } from '../src/services/nutritionService.js';
import { createOrder } from '../src/services/orderService.js';
import { nextSaturday } from './setup.js';

const mealDate = nextSaturday();

function seedNutrition(): { memberA: number } {
  run(`INSERT INTO members (id, name, avatar) VALUES (1, '甲', '🙂')`);
  run(`INSERT INTO members (id, name, avatar) VALUES (2, '乙', '🧑')`);

  // 营养值均为每 100g 口径；category 参与蔬菜/肉类/水产归类
  const ingredients: Array<[number, string, string, number, number, number, number, number, number]> = [
    // id, name, category, kcal, protein, fat, carb, sodium, fiber
    [1, '番茄', '蔬果', 20, 1.0, 0.2, 4.0, 5, 1.2],
    [2, '食用油', '调味', 900, 0, 100, 0, 0, 0],
    [3, '鲈鱼', '水产', 105, 20, 3.5, 0, 80, 0],
    [4, '土豆', '蔬果', 77, 2.0, 0.2, 17.0, 3, 1.8], // 淀粉类蔬菜：不计入「蔬菜」口径
  ];
  for (const [id, name, category, kcal, protein, fat, carb, sodium, fiber] of ingredients) {
    run(
      `INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, category, kcal, protein, fat, carb, sodium, fiber,
    );
  }

  // 番茄炒蛋：番茄 200g + 油 10g → 每人份 130 kcal
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (1, '番茄炒蛋', '🍅', '素菜')`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 1, 200)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 2, 10)`);
  // 白灼虾：鲈鱼 150g → 157.5 kcal
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (2, '白灼虾', '🐟', '荤菜')`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (2, 3, 150)`);
  // 酸辣土豆丝：土豆 100g（淀粉类，验证蔬菜口径排除）
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (3, '酸辣土豆丝', '🥔', '素菜')`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (3, 4, 100)`);

  return { memberA: 1 };
}

describe('nutritionService.buildNutritionReport', () => {
  before(seedNutrition);

  it('手算口径：BOM 展开、人均、淀粉类蔬菜排除、指南对照', () => {
    // 走真实下单路径（headcount=3）：番茄炒蛋 ×2 + 鲈鱼 ×1 + 土豆丝 ×1
    // late: true 是为了不依赖跑测试当天的时刻（周六当天跑时可能已过晚餐截单）
    createOrder({
      memberId: 1,
      mealDate,
      mealType: 'dinner',
      headcount: 3,
      late: true,
      items: [
        { dishId: 1, servings: 2 },
        { dishId: 2, servings: 1 },
        { dishId: 3, servings: 1 },
      ],
    });

    const report = buildNutritionReport(mealDate);

    assert.equal(report.headcount, 3);
    assert.equal(report.dish_count, 3); // order_items 共 3 条（番茄炒蛋×2 + 鲈鱼 + 土豆丝）
    assert.equal(report.home_meals, 3); // 周六：三餐在家

    // 总量：番茄 400g + 油 20g + 鲈鱼 150g + 土豆 100g
    // kcal = 400×0.20 + 20×9.00 + 150×1.05 + 100×0.77 = 80 + 180 + 157.5 + 77 = 494.5
    assert.equal(report.totals.kcal, 495);
    // 人均 = 494.5 / 3 = 164.83 → 165
    assert.equal(report.per_capita.kcal, 165);
    // 蛋白 = 400×1.0% + 150×20% + 100×2.0% = 4 + 30 + 2 = 36 → 人均 12
    assert.equal(report.per_capita.protein, 12);
    // 钠 = 400×5mg + 150×80mg + 100×3mg = 14300mg → 人均 4766.7 → 48（mg）
    assert.equal(report.per_capita.sodium, 48);

    // 淀粉类蔬菜不计入蔬菜口径：只有番茄 400g → 人均 133.3
    const vegetable = report.references.find((item) => item.label === '蔬菜');
    assert.ok(vegetable, 'references 应包含蔬菜');
    assert.equal(vegetable.value, 133.3);
    assert.equal(vegetable.status, 'low'); // 133.3 < 300

    const energy = report.references.find((item) => item.label === '能量');
    assert.ok(energy);
    assert.equal(energy.value, 164.8);
    assert.equal(energy.status, 'low'); // 164.8 < 1600

    const salt = report.references.find((item) => item.label === '食盐');
    assert.ok(salt);
    assert.equal(salt.status, 'ok'); // 0.1g ≤ 5g

    // 分类热量最高的是油（调味）：180/3 = 60 kcal/人
    assert.equal(report.by_category[0].category, '调味');
    assert.equal(report.by_category[0].kcal, 60);
  });

  it('没有订单的日期：人数回退默认 3，热量为 0 判 low', () => {
    const emptyDate = nextSaturday();
    // 与上面用例错开：顺延一天到周日（同样三餐在家）
    const d = new Date(`${emptyDate}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const offsetMs = d.getTimezoneOffset() * 60 * 1000;
    const sunday = new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);

    const report = buildNutritionReport(sunday);
    assert.equal(report.dish_count, 0);
    assert.equal(report.headcount, 3);
    assert.equal(report.totals.kcal, 0);
    const energy = report.references.find((item) => item.label === '能量');
    assert.equal(energy?.status, 'low');
  });
});
