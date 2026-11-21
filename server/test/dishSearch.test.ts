/**
 * 食材别名联想（GET /api/dishes?q=...）与替代分组。
 *
 * 钉住两件事：
 *   1. 搜「鸡肉」会展开成鸡肉 / 鸡翅 / 鸡腿 / 鸡胸，所以带鸡腿、鸡胸肉的菜都能搜出来；
 *   2. 接口把同一份别名分组带给前端，前端据此提示「有鸡胸肉可替代鸡腿」，
 *      但「能不能做」仍按精确 ingredient_id 判定（这条在 web/test/substitutes.test.ts 里钉）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

let server: TestServer | undefined;
let base = '';

const ingredientId = (name: string): number => {
  const row = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', name);
  assert.ok(row, `夹具里应该有「${name}」`);
  return row.id;
};

interface DishListResponse {
  dishes: { name: string; ingredients: { name: string }[] }[];
  search_terms: string[];
  substitute_groups: string[][];
}

before(async () => {
  server = await startTestServer();
  base = server.base;

  for (const [name, category] of [
    ['鸡腿', '肉禽蛋'],
    ['鸡胸肉', '肉禽蛋'],
  ] as const) {
    run(
      `INSERT INTO ingredients (name, category, is_pantry, kcal, protein, fat, carb, sodium, fiber,
         nutrition_source)
       VALUES (?, ?, 0, 100, 1, 1, 1, 1, 1, 'seed')`,
      name,
      category,
    );
  }

  const dishes: [string, string][] = [
    ['沙姜鸡', '鸡腿'],
    ['鸡胸沙拉', '鸡胸肉'],
  ];
  for (const [dishName, ingredientName] of dishes) {
    const created = run(
      `INSERT INTO dishes (name, emoji, category, active) VALUES (?, '🍽️', '荤菜', 1)`,
      dishName,
    );
    run(
      'INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (?, ?, 100)',
      created.lastInsertRowid,
      ingredientId(ingredientName),
    );
  }
});

after(() => {
  server?.close();
  server = undefined;
});

describe('食材别名搜索与替代分组（GET /api/dishes?q=鸡肉）', () => {
  it('搜「鸡肉」能搜出含鸡腿、鸡胸肉的菜，并在 search_terms 里给出实际匹配到的别名', async () => {
    const body = (await (await fetch(`${base}/api/dishes?q=${encodeURIComponent('鸡肉')}`)).json()) as DishListResponse;
    const names = body.dishes.map((dish) => dish.name).sort();
    assert.deepEqual(names, ['沙姜鸡', '鸡胸沙拉']);
    assert.ok(body.search_terms.includes('鸡腿'));
    assert.ok(body.search_terms.includes('鸡胸'));
  });

  it('返回同一份别名分组，前端才能提示「同组可替代」', async () => {
    const body = (await (await fetch(`${base}/api/dishes`)).json()) as DishListResponse;
    const group = body.substitute_groups.find((items) => items.includes('鸡腿'));
    assert.ok(group, '别名分组里应该有鸡腿这一组');
    assert.ok(group.includes('鸡胸'));
    assert.ok(group.includes('鸡肉'));
  });
});
