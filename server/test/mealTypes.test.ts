/**
 * 菜品餐别标签（v15 迁移 + PATCH meal_types + 按餐别推荐/随机）。
 * 用临时 SQLite（setup.ts 已把 DB_PATH 指到临时目录）跑真实迁移，起真实 HTTP 打接口。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { listDishes } from '../src/services/dishService.js';
import { startTestServer, type TestServer } from './testServer.js';

/** 整个文件共用一个服务：起一次，全部用例跑完再关 */
let server: TestServer | undefined;

async function start(): Promise<string> {
  server = await startTestServer();
  return server.base;
}

after(() => {
  server?.close();
  server = undefined;
});

/** 找一道测试用的菜：没有就插一道 */
function ensureDish(name: string, category = '荤菜'): number {
  const existing = get<{ id: number }>('SELECT id FROM dishes WHERE name = ?', name);
  if (existing) return existing.id;
  const result = run(
    `INSERT INTO dishes (name, emoji, category, active) VALUES (?, '🍳', ?, 1)`,
    name,
    category,
  );
  return result.lastInsertRowid;
}

describe('菜品餐别标签', () => {
  let dishId: number;
  let base = '';

  before(async () => {
    base = await start();
    dishId = ensureDish('餐别测试菜');
  });

  it('v15 迁移后 meal_types 默认为 []（老菜=通用菜）', () => {
    const row = get<{ meal_types: string }>('SELECT meal_types FROM dishes WHERE id = ?', dishId);
    assert.equal(row?.meal_types, '[]');
    assert.deepEqual(listDishes({ onlyActive: false }).find((d) => d.id === dishId)?.meal_types, []);
  });

  it('PATCH meal_types 写入并回读（多选，按固定顺序规范化）', async () => {
    const res = await fetch(`${base}/api/dishes/${dishId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meal_types: ['dinner', 'lunch'] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dish: { meal_types: string[] } };
    assert.deepEqual(body.dish.meal_types, ['lunch', 'dinner']);

    // 重启进程也能读对：直接走服务层的解析路径
    assert.deepEqual(listDishes({ onlyActive: false }).find((d) => d.id === dishId)?.meal_types, [
      'lunch',
      'dinner',
    ]);
  });

  it('PATCH meal_types 非法值 400，库不落脏数据', async () => {
    const res = await fetch(`${base}/api/dishes/${dishId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meal_types: ['supper'] }),
    });
    assert.equal(res.status, 400);
    const row = get<{ meal_types: string }>('SELECT meal_types FROM dishes WHERE id = ?', dishId);
    assert.equal(row?.meal_types, '["lunch","dinner"]');
  });

  it('PATCH meal_types 非数组 400', async () => {
    const res = await fetch(`${base}/api/dishes/${dishId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meal_types: 'lunch' }),
    });
    assert.equal(res.status, 400);
  });

  it('PATCH meal_types 重复值去重、空数组=恢复通用菜', async () => {
    const dedup = await fetch(`${base}/api/dishes/${dishId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meal_types: ['breakfast', 'breakfast', 'lunch'] }),
    });
    assert.equal(dedup.status, 200);
    assert.deepEqual(((await dedup.json()) as { dish: { meal_types: string[] } }).dish.meal_types, [
      'breakfast',
      'lunch',
    ]);

    const clear = await fetch(`${base}/api/dishes/${dishId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meal_types: [] }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(((await clear.json()) as { dish: { meal_types: string[] } }).dish.meal_types, []);
  });

  it('PATCH 其他字段仍正常（回归：steps 与 meal_types 互不干扰）', async () => {
    const res = await fetch(`${base}/api/dishes/${dishId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps: '第一步\n第二步' }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { dish: { steps: string } }).dish.steps, '第一步\n第二步');
  });

  it('PATCH 也接受 camelCase 的 mealTypes（与建菜口径一致）', async () => {
    const res = await fetch(`${base}/api/dishes/${dishId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mealTypes: ['breakfast'] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dish: { meal_types: string[] } };
    assert.deepEqual(body.dish.meal_types, ['breakfast']);
  });

  it('推荐：早餐优先挑标了早餐的菜', async () => {
    // 前面的用例把 dishId 留在了早餐标记层；不清掉的话早餐池多出一道，
    // 随机在 3 选 2 时未必同时抽中 a、b，断言会随机失败（曾实测 60% 挂）
    run(`UPDATE dishes SET meal_types = '[]' WHERE id = ?`, dishId);

    // 备料：2 道早餐菜 + 2 道通用菜（同为主食/普通，结构不受限）
    const a = ensureDish('早餐测试粥', '主食');
    const b = ensureDish('早餐测试蛋', '主食');
    const c = ensureDish('晚餐测试排骨', '荤菜');
    ensureDish('通用测试豆腐', '素菜');
    run(`UPDATE dishes SET meal_types = '["breakfast"]' WHERE id IN (?, ?)`, a, b);

    const res = await fetch(`${base}/api/dishes/recommend?headcount=3&mealType=breakfast`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dishes: { id: number }[] };
    const ids = body.dishes.map((dish) => dish.id);
    assert.ok(ids.includes(a) && ids.includes(b), `早餐推荐应优先含标记菜：${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(c), '只标了晚餐的菜不该被早餐推荐选中（池子足够时）');
  });

  it('随机：带 mealType 时先出标记菜', async () => {
    const a = ensureDish('随机早餐菜', '主食');
    run(`UPDATE dishes SET meal_types = '["breakfast"]' WHERE id = ?`, a);
    // 连抽多次，每次都应是标记菜（标记层非空时不落回）
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/api/dishes/random?count=1&mealType=breakfast`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { dishes: { id: number; meal_types: string[] }[] };
      assert.equal(body.dishes.length, 1);
      assert.ok(
        body.dishes[0].meal_types.includes('breakfast'),
        `随机应出早餐标记菜，实际 ${JSON.stringify(body.dishes[0])}`,
      );
    }
  });
});
