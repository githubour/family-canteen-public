/**
 * 预置数据导入必须只补缺、不覆盖：
 * 用户可能在「食材」页改过分类/单位/营养/价格，也可能改过菜名与做法。
 * 部署或重复执行 seed 时这些都原样保留。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { seedAll } from '../src/db/seed/run.js';

interface IngredientRow {
  id: number;
  category: string;
  buy_unit: string;
  kcal: number;
  price_per_100g: number | null;
}

describe('预置数据 seed', () => {
  it('重复执行只插入缺失项，不覆盖用户改过的食材与菜品', () => {
    seedAll();

    const ingredient = get<IngredientRow>('SELECT id, category, buy_unit, kcal, price_per_100g FROM ingredients ORDER BY id LIMIT 1');
    assert.ok(ingredient, '首次 seed 后应有食材');
    const dish = get<{ id: number }>('SELECT id FROM dishes ORDER BY id LIMIT 1');
    assert.ok(dish, '首次 seed 后应有菜品');
    const countsBefore = get<{ i: number; d: number }>(
      'SELECT (SELECT COUNT(*) FROM ingredients) AS i, (SELECT COUNT(*) FROM dishes) AS d',
    );
    assert.ok(countsBefore);

    run(
      "UPDATE ingredients SET category = '用户分类', buy_unit = '份', kcal = 999, price_per_100g = 123 WHERE id = ?",
      ingredient.id,
    );
    run("UPDATE dishes SET description = '用户改过的简介' WHERE id = ?", dish.id);

    seedAll();

    const after = get<IngredientRow>(
      'SELECT id, category, buy_unit, kcal, price_per_100g FROM ingredients WHERE id = ?',
      ingredient.id,
    );
    // node:sqlite 返回的行是 null-prototype 对象，展开后再做严格比较
    assert.deepEqual({ ...after }, {
      id: ingredient.id,
      category: '用户分类',
      buy_unit: '份',
      kcal: 999,
      price_per_100g: 123,
    });
    assert.equal(
      get<{ description: string }>('SELECT description FROM dishes WHERE id = ?', dish.id)?.description,
      '用户改过的简介',
      '已有菜品不应被 seed 覆盖',
    );

    const countsAfter = get<{ i: number; d: number }>(
      'SELECT (SELECT COUNT(*) FROM ingredients) AS i, (SELECT COUNT(*) FROM dishes) AS d',
    );
    assert.deepEqual(countsAfter, countsBefore, '重复 seed 不应产生重复数据');
  });
});
