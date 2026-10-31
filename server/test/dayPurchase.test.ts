/**
 * 采购清单的 day 口径（当天三餐合并）。
 *
 * 设计要点：day 是「合并读 + 按餐扇出写」——清单按食材折叠成一行，但勾选/改量/备注/隐藏
 * 仍然落在各餐自己的 purchase_state 上。本文件守住三件事：
 * 1. 合并口径正确（数量相加、meals 有序、来源菜名并集、手动条目按名折叠）；
 * 2. 扇出写到位（day 勾一下三餐都就绪；大厨页单餐取消后 day 回到未勾）；
 * 3. 改量按各餐原始量分摊，各餐之和恒等于用户输入的当日总量。
 *
 * 夹具：番茄被午晚两餐共用（150g / 300g），豆腐只出现在晚餐，盐是常备调料。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { all, get, run } from '../src/db/index.js';
import {
  addDayPurchaseCustom,
  addPurchaseCustom,
  batchSetDayChecked,
  buildDayPurchaseList,
  buildPurchaseList,
  buildPurchaseText,
  removeDayPurchaseCustom,
  resetDayPurchaseState,
  setDayPurchaseCustomState,
  setDayPurchaseHidden,
  setDayPurchaseState,
  setPurchaseCustomState,
  setPurchaseHidden,
  setPurchaseState,
} from '../src/services/purchaseService.js';
import { createOrder } from '../src/services/orderService.js';
import { MEAL_TYPES } from '../src/types.js';
import { nextSaturday } from './setup.js';

const mealDate = nextSaturday();

/** 某餐某食材的状态行 */
function stateOf(mealType: string, ingredientId: number) {
  return get<{ checked: number; override_amount: number | null; note: string | null; hidden: number }>(
    'SELECT checked, override_amount, note, hidden FROM purchase_state WHERE meal_date = ? AND meal_type = ? AND ingredient_id = ?',
    mealDate,
    mealType,
    ingredientId,
  );
}

const customRows = (name?: string) =>
  name === undefined
    ? all<{ id: number; name: string; checked: number; meal_type: string; amount_text: string }>(
        'SELECT id, name, checked, meal_type, amount_text FROM purchase_custom WHERE meal_date = ? ORDER BY id',
        mealDate,
      )
    : all<{ id: number; name: string; checked: number; meal_type: string; amount_text: string }>(
        'SELECT id, name, checked, meal_type, amount_text FROM purchase_custom WHERE meal_date = ? AND name = ? ORDER BY id',
        mealDate,
        name,
      );

const find = (name: string, scope: 'day' | 'lunch' | 'dinner') => {
  const list = scope === 'day' ? buildDayPurchaseList(mealDate) : buildPurchaseList(mealDate, scope);
  return [...list.to_buy, ...list.pantry, ...list.hidden].find((item) => item.name === name);
};

before(() => {
  run(`INSERT INTO members (id, name, avatar) VALUES (1, '甲', '🙂')`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, price_per_100g)
       VALUES (1, '番茄', '蔬果', 20, 1.0, 0.2, 4.0, 5, 1.2, 8)`);
  // 常备调料：不进采购任务，单独成组
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, is_pantry)
       VALUES (2, '盐', '调味', 0, 0, 0, 0, 39000, 0, 1)`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, price_per_100g)
       VALUES (3, '豆腐', '豆制品', 80, 8.0, 4.0, 2.0, 7, 0.4, 3)`);

  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (1, '番茄炒蛋', '🍅', '素菜')`);
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (2, '番茄豆腐汤', '🍲', '汤')`);
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (3, '夜宵豆腐', '🌙', '素菜')`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 1, 150)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 2, 2)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (2, 1, 300)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (2, 3, 200)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (2, 2, 1)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (3, 3, 100)`);

  // 午晚各一单：午餐只点番茄炒蛋，晚餐是番茄豆腐汤 + 夜宵豆腐
  createOrder({ memberId: 1, mealDate, mealType: 'lunch', late: true, items: [{ dishId: 1, servings: 1 }] });
  createOrder({
    memberId: 1,
    mealDate,
    mealType: 'dinner',
    late: true,
    items: [
      { dishId: 2, servings: 1 },
      { dishId: 3, servings: 1 },
    ],
  });
});

describe('采购清单 day 口径', () => {
  it('合并读：跨餐食材数量相加、meals 有序、来源菜名为并集', () => {
    const list = buildDayPurchaseList(mealDate);
    assert.equal(list.meal_type, 'day');
    assert.equal(list.generated_from, 2); // 午晚两单

    const tomato = find('番茄', 'day');
    assert.ok(tomato);
    assert.equal(tomato.amount, 450); // 150 + 300
    assert.equal(tomato.amount_text, '450 g');
    assert.deepEqual(tomato.meals, ['lunch', 'dinner']);
    assert.deepEqual([...tomato.from_dishes].sort(), ['番茄炒蛋', '番茄豆腐汤']);
    assert.equal(tomato.price, 8);

    // 只在晚餐出现的食材：meals 只有一餐
    const tofu = find('豆腐', 'day');
    assert.deepEqual(tofu?.meals, ['dinner']);
    assert.equal(tofu?.amount, 300); // 200 + 100

    // 常备调料单独成组，同样带 meals
    assert.deepEqual(list.pantry.map((item) => item.name), ['盐']);
    assert.deepEqual(list.pantry[0].meals, ['lunch', 'dinner']);

    // 预估花费按合并后的总量算：番茄 4.5×8 + 豆腐 3×3 = 45（盐是常备，不计）
    assert.equal(list.estimated_cost, 45);
    assert.equal(list.checked_count, 0);
  });

  it('按餐口径不受影响（回归）：数量只算本餐，meals 只有本餐', () => {
    const lunch = buildPurchaseList(mealDate, 'lunch');
    assert.equal(lunch.meal_type, 'lunch');
    assert.equal(lunch.generated_from, 1);
    assert.equal(find('番茄', 'lunch')?.amount, 150);
    assert.deepEqual(find('番茄', 'lunch')?.meals, ['lunch']);
    assert.deepEqual(find('豆腐', 'lunch'), undefined); // 午餐没有豆腐

    buildPurchaseList(mealDate, 'dinner');
    assert.equal(find('番茄', 'dinner')?.amount, 300);
    assert.deepEqual(find('番茄', 'dinner')?.meals, ['dinner']);
  });

  it('勾选扇出：day 勾一下两餐都就绪；大厨页取消一餐后 day 回到未勾', () => {
    const list = setDayPurchaseState({ mealDate, ingredientId: 1, checked: true });
    assert.equal(find('番茄', 'day')?.checked, true);
    assert.equal(stateOf('lunch', 1)?.checked, 1);
    assert.equal(stateOf('dinner', 1)?.checked, 1);
    assert.equal(list.checked_count > 0, true);

    // 大厨页把晚餐那份点掉：day 是交集语义，立刻回到未勾，但午餐仍然就绪
    setPurchaseState({ mealDate, mealType: 'dinner', ingredientId: 1, checked: false });
    assert.equal(find('番茄', 'day')?.checked, false);
    assert.equal(stateOf('lunch', 1)?.checked, 1);
  });

  it('改量分摊：各餐按原始量占比写 override_amount，最后一餐吃误差保证总和相等', () => {
    setDayPurchaseState({ mealDate, ingredientId: 1, overrideAmount: 900 });
    assert.equal(stateOf('lunch', 1)?.override_amount, 300); // 900 × 150/450
    assert.equal(stateOf('dinner', 1)?.override_amount, 600); // 剩余全给最后一餐
    assert.equal(find('番茄', 'day')?.amount, 900);
    assert.equal(find('番茄', 'day')?.overridden, true);

    // 清空 = 恢复系统计算值
    setDayPurchaseState({ mealDate, ingredientId: 1, overrideAmount: null });
    assert.equal(stateOf('lunch', 1)?.override_amount, null);
    assert.equal(find('番茄', 'day')?.amount, 450);
    assert.equal(find('番茄', 'day')?.overridden, false);

    // 非法输入与「不在今天任何订单里」的食材
    assert.throws(() => setDayPurchaseState({ mealDate, ingredientId: 1, overrideAmount: 0 }), /大于 0/);
    assert.throws(() => setDayPurchaseState({ mealDate, ingredientId: 999, checked: true }), /没有这个食材/);
  });

  it('「今天不要」扇出到每一餐；大厨只藏一餐时 day 照常显示', () => {
    setDayPurchaseHidden(mealDate, 1, true);
    assert.equal(stateOf('lunch', 1)?.hidden, 1);
    assert.equal(stateOf('dinner', 1)?.hidden, 1);
    const hiddenList = buildDayPurchaseList(mealDate);
    assert.equal(hiddenList.to_buy.some((item) => item.name === '番茄'), false);
    assert.deepEqual(hiddenList.hidden.map((item) => item.name), ['番茄']);

    setDayPurchaseHidden(mealDate, 1, false);
    assert.equal(buildDayPurchaseList(mealDate).to_buy.some((item) => item.name === '番茄'), true);
    assert.equal(buildDayPurchaseList(mealDate).hidden.length, 0);

    // 大厨页单独藏掉晚餐那份：day 仍要显示（午餐还有量）
    setPurchaseHidden(mealDate, 'dinner', 1, true);
    assert.equal(buildDayPurchaseList(mealDate).to_buy.some((item) => item.name === '番茄'), true);
    setPurchaseHidden(mealDate, 'dinner', 1, false);
  });

  it('手动条目：day 添加后三餐各一行、视图里折叠成一行，按名称勾选与删除都会扇出', () => {
    const added = addDayPurchaseCustom(mealDate, '小米辣', '3 根');
    assert.equal(customRows('小米辣').length, 3); // 三餐各一行同名
    const folded = added.to_buy.find((item) => item.name === '小米辣');
    assert.ok(folded);
    assert.equal(folded.is_custom, true);
    assert.equal(folded.amount_text, '3 根');
    assert.deepEqual(folded.meals, []);

    // 重复添加同名：各餐已有则跳过，不会翻倍
    addDayPurchaseCustom(mealDate, '小米辣', '3 根');
    assert.equal(customRows('小米辣').length, 3);

    // 大厨页在早餐单独加一条同名的：day 里仍然合并成一行
    addPurchaseCustom(mealDate, 'breakfast', '小米辣', '1 个');
    assert.equal(customRows('小米辣').length, 4);
    const merged = buildDayPurchaseList(mealDate).to_buy.filter((item) => item.name === '小米辣');
    assert.equal(merged.length, 1);

    // day 勾选 → 四行都勾；大厨取消其中一餐 → day 回到未勾
    setDayPurchaseCustomState(mealDate, '小米辣', true);
    assert.equal(customRows('小米辣').every((row) => row.checked === 1), true);
    assert.equal(buildDayPurchaseList(mealDate).to_buy.find((item) => item.name === '小米辣')?.checked, true);
    setPurchaseCustomState(mealDate, 'breakfast', customRows('小米辣')[0].id, false);
    assert.equal(buildDayPurchaseList(mealDate).to_buy.find((item) => item.name === '小米辣')?.checked, false);

    // day 删除 → 同名行一起清掉
    removeDayPurchaseCustom(mealDate, '小米辣');
    assert.equal(customRows('小米辣').length, 0);
  });

  it('day 批量勾选与恢复数量覆盖三餐', () => {
    const checked = batchSetDayChecked(mealDate, true);
    assert.equal(checked.to_buy.every((item) => item.checked), true);
    for (const mealType of MEAL_TYPES) {
      const perMeal = buildPurchaseList(mealDate, mealType);
      const expected = perMeal.to_buy.filter((item) => item.ingredient_id != null).length;
      const rows = get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM purchase_state WHERE meal_date = ? AND meal_type = ? AND checked = 1',
        mealDate,
        mealType,
      );
      assert.equal(Number(rows?.c ?? 0), expected, `${mealType} 的勾选行数应与条目数一致`);
    }

    const cleared = resetDayPurchaseState(mealDate);
    assert.equal(get<{ c: number }>('SELECT COUNT(*) AS c FROM purchase_state WHERE meal_date = ?', mealDate)?.c, 0);
    assert.equal(get<{ c: number }>('SELECT COUNT(*) AS c FROM purchase_custom WHERE meal_date = ?', mealDate)?.c, 0);
    assert.equal(cleared.checked_count, 0);
    assert.equal(cleared.total > 0, true);
  });

  it('菜名含逗号时来源菜名保持完整（分隔符不是逗号）', () => {
    // 另起一天，避免影响前面按固定 mealDate 建立的数量与来源断言
    const date = new Date(`${mealDate}T00:00:00`);
    date.setDate(date.getDate() + 7);
    const commaDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    run(`INSERT INTO dishes (id, name, emoji, category) VALUES (4, '番茄,鸡蛋', '🍅', '素菜')`);
    run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (4, 1, 100)`);
    createOrder({ memberId: 1, mealDate: commaDate, mealType: 'lunch', late: true, items: [{ dishId: 4, servings: 1 }] });

    const day = buildDayPurchaseList(commaDate).to_buy.find((item) => item.name === '番茄');
    assert.deepEqual(day?.from_dishes, ['番茄,鸡蛋']);

    const lunch = buildPurchaseList(commaDate, 'lunch').to_buy.find((item) => item.name === '番茄');
    assert.deepEqual(lunch?.from_dishes, ['番茄,鸡蛋']);
  });

  it('文本导出：day 标题不带餐别词、数量是合并值；按餐仍带餐别', () => {
    const dayText = buildPurchaseText(buildDayPurchaseList(mealDate));
    assert.equal(dayText.split('\n')[0], `【${mealDate} 采购清单】`);
    assert.match(dayText, /番茄 {2}450 g/);

    const lunchText = buildPurchaseText(buildPurchaseList(mealDate, 'lunch'));
    assert.equal(lunchText.split('\n')[0], `【${mealDate} 午餐采购清单】`);
    assert.match(lunchText, /番茄 {2}150 g/);
  });
});
