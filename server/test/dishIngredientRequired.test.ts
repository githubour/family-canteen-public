/**
 * 后台「配料必有 / 可选」开关（dish_ingredients.required）的服务层行为。
 *
 * 标记挂在「菜品 × 食材」的关联行上，所以同一食材在不同菜里身份可以不同；
 * 后台点一下开关走的就是 setIngredientRequired。本文件守住三件事：
 * 1. 改完返回的菜品立刻带新值（后台面板不等重拉列表）；
 * 2. 只动这一道菜的这一行——同菜其它配料、别的菜的同名食材都不受影响；
 * 3. 菜不存在 / 配料不在菜里时明确报错。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { getDishById, listDishes, setIngredientRequired } from '../src/services/dishService.js';

before(() => {
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES (1, '大葱', '蔬果', 33, 1.7, 0.3, 6.5, 4.8, 1.3)`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES (2, '面条(生)', '粮油', 286, 8.5, 0.7, 61.9, 3.4, 1.5)`);
  run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES (3, '番茄', '蔬果', 20, 0.9, 0.2, 4.0, 5, 0.5)`);

  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (1, '葱油拌面', '🍜', '主食')`);
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (2, '番茄炒蛋', '🍅', '素菜')`);

  // 大葱在葱油拌面里是主角（必有），在番茄炒蛋里只是撒花（可选）
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (1, 1, 25, 1)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (1, 2, 120, 1)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (2, 1, 5, 0)`);
  run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, required) VALUES (2, 3, 150, 1)`);
});

/** 直接读库里的标记，避开装配层，验证真的落了盘 */
const requiredOf = (dishId: number, ingredientId: number) =>
  get<{ required: number }>(
    'SELECT required FROM dish_ingredients WHERE dish_id = ? AND ingredient_id = ?',
    dishId,
    ingredientId,
  )?.required;

describe('后台配料必有 / 可选开关', () => {
  it('改完直接返回新值，后台面板不用重拉列表', () => {
    const dish = setIngredientRequired(1, 1, false);
    assert.equal(dish.id, 1);
    assert.equal(dish.ingredients.find((item) => item.name === '大葱')?.required, false);
    assert.equal(requiredOf(1, 1), 0);

    const back = setIngredientRequired(1, 1, true);
    assert.equal(back.ingredients.find((item) => item.name === '大葱')?.required, true);
    assert.equal(requiredOf(1, 1), 1);
  });

  it('同一食材在不同菜里各改各的：只动这一道菜的这一行', () => {
    setIngredientRequired(2, 1, true); // 番茄炒蛋的大葱改回必有
    assert.equal(requiredOf(2, 1), 1);
    assert.equal(requiredOf(1, 1), 1); // 葱油拌面的大葱不受影响
    assert.equal(requiredOf(2, 3), 1); // 同菜其它配料不受影响

    setIngredientRequired(2, 1, false); // 复原夹具
    assert.equal(requiredOf(2, 1), 0);
  });

  it('改完菜品列表与详情里都是新值（点菜页排序读的就是它）', () => {
    setIngredientRequired(2, 1, true);
    const listed = listDishes({ category: '素菜' }).find((item) => item.id === 2);
    assert.equal(listed?.ingredients.find((item) => item.name === '大葱')?.required, true);

    setIngredientRequired(2, 1, false);
    assert.equal(getDishById(2)?.ingredients.find((item) => item.name === '大葱')?.required, false);
  });

  it('菜不存在 / 配料不在菜里时明确报错', () => {
    assert.throws(() => setIngredientRequired(999, 1, false), /菜品不存在/);
    assert.throws(() => setIngredientRequired(2, 2, false), /没有这个食材/);
  });
});
