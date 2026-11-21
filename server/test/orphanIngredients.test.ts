/**
 * 孤立食材最小单测：食材库里没被任何菜品引用的条目要被挑出来（常备调料也算），
 * 补上菜品引用后要从清单消失——这是采购页「孤立食材」提醒的数据口径。
 * 删除只对孤立食材开放，并且要顺手清掉采购清单里留下的勾选痕迹
 * （purchase_state 对 ingredients 没有级联删除，不清会撞在外键上）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { createIngredient, deleteIngredient, listOrphanIngredients } from '../src/services/purchaseService.js';

run(`INSERT INTO dishes (id, name, emoji, category) VALUES (1, '测试炒蛋', '🍅', '荤菜')`);
run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
     VALUES (1, '番茄', '蔬果', 20, 1.0, 0.2, 4.0, 5, 1.2)`);
run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber)
     VALUES (2, '山药', '蔬果', 60, 1.9, 0.2, 12.4, 20, 0.8)`);
run(`INSERT INTO ingredients (id, name, category, kcal, protein, fat, carb, sodium, fiber, is_pantry)
     VALUES (3, '新调料', '调味', 0, 0, 0, 0, 0, 0, 1)`);
run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 1, 200)`);

describe('listOrphanIngredients（孤立食材）', () => {
  it('只挑出没被任何菜品引用的食材，常备调料也算', () => {
    const orphans = listOrphanIngredients();
    // ORDER BY category, name：蔬果(山药) 在 调味(新调料) 前
    assert.deepEqual(orphans.map((o) => o.name), ['山药', '新调料']);
    assert.equal(orphans.find((o) => o.name === '新调料')?.is_pantry, true);
    // 被引用的番茄不在清单里
    assert.equal(orphans.some((o) => o.name === '番茄'), false);
  });

  it('补上菜品引用后不再孤立', () => {
    run(`INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (1, 2, 150)`);
    assert.equal(listOrphanIngredients().some((o) => o.name === '山药'), false);
    assert.equal(listOrphanIngredients().length, 1);
  });

  it('createIngredient：手动补入立刻进入孤立清单，重名与空名拒绝', () => {
    const created = createIngredient('  羽衣甘蓝  ', '蔬果', false);
    assert.equal(created.name, '羽衣甘蓝');
    assert.equal(created.is_pantry, false);
    assert.ok(listOrphanIngredients().some((o) => o.name === '羽衣甘蓝'));
    assert.throws(() => createIngredient('羽衣甘蓝', '蔬果', false), /已经有/);
    assert.throws(() => createIngredient('   ', '蔬果', false), /名称/);
  });
});

describe('deleteIngredient（删除孤立食材）', () => {
  it('删掉后从食材库与孤立清单一起消失，返回刷新后的清单', () => {
    const before = listOrphanIngredients();
    const target = before.find((o) => o.name === '羽衣甘蓝');
    assert.ok(target);

    const after = deleteIngredient(target.id);
    assert.equal(after.some((o) => o.name === '羽衣甘蓝'), false);
    assert.equal(after.length, before.length - 1);
    assert.equal(get('SELECT id FROM ingredients WHERE id = ?', target.id), undefined);
  });

  it('已经用在菜谱里的食材拒绝删除（会破坏菜的配料表）', () => {
    // 山药在第二个用例里被挂进了 dish_ingredients
    assert.throws(() => deleteIngredient(2), /用在菜谱里/);
    assert.ok(get('SELECT id FROM ingredients WHERE id = ?', 2));
  });

  it('删除时一并清掉采购清单里的勾选痕迹，不留指向已删食材的孤儿行', () => {
    run(`INSERT INTO purchase_state (meal_date, meal_type, ingredient_id, checked)
         VALUES ('2026-01-01', 'dinner', 3, 1)`);
    assert.ok(get('SELECT id FROM purchase_state WHERE ingredient_id = ?', 3));

    // 常备调料同样可在孤立清单里删掉；没有这段清理，DELETE 会被外键挡下
    deleteIngredient(3);
    assert.equal(get('SELECT id FROM purchase_state WHERE ingredient_id = ?', 3), undefined);
    assert.equal(get('SELECT id FROM ingredients WHERE id = ?', 3), undefined);
  });

  it('不存在的食材直接报「食材不存在」', () => {
    assert.throws(() => deleteIngredient(9999), /不存在/);
  });
});
