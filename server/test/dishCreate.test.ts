/**
 * 新建菜品接口（POST /api/dishes，routes/dishes → dishService.createDish）：
 * 内容即数据的入口——BOM 按食材名关联、newIngredients 连营养入库 / 补全零营养行、
 * 重名与缺食材的拦截、餐别与做法的清洗口径。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

interface DishBody {
  id: number;
  name: string;
  category: string;
  meal_types: string[];
  steps: string;
  ingredients: { name: string; amount: number; required: boolean }[];
  nutrition: { kcal: number; protein: number; fat: number; carb: number; sodium: number; fiber: number };
}

let server: TestServer | undefined;
let base = '';

const post = (body: unknown) =>
  fetch(`${base}/api/dishes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const dishIdByName = async (name: string): Promise<number> => {
  const list = (await (await fetch(`${base}/api/dishes`)).json()) as { dishes: DishBody[] };
  const hit = list.dishes.find((item) => item.name === name);
  assert.ok(hit, `列表里应该有「${name}」`);
  return hit.id;
};

const minimal = {
  name: '小炒肉',
  category: '荤菜',
  ingredients: [{ name: '鸡腿', amount: 150 }],
};

/** 明天：未来日期不受截单限制，测试跑在任何时段都稳定 */
const tomorrow = () => {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
};

before(async () => {
  server = await startTestServer();
  base = server.base;
  // 鸡腿：库内已有食材；柚子：模拟采购页手动建的零营养行，等 newIngredients 补全
  run(`INSERT INTO ingredients (name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES ('鸡腿', '肉禽蛋', 181, 16.0, 13.0, 0, 64.0, 0)`);
  run(`INSERT INTO ingredients (name, category) VALUES ('柚子', '蔬果')`);
  run(`INSERT INTO members (id, name, avatar, color) VALUES (1, '测试家人', '🙂', '#123456')`);
});

after(() => {
  server?.close();
  server = undefined;
});

describe('新建菜品接口', () => {
  it('最小入参建菜：默认值齐全，营养由 BOM 算出，GET 列表立即可见', async () => {
    const res = await post(minimal);
    assert.equal(res.status, 201);
    const { dish } = (await res.json()) as { dish: DishBody };
    assert.equal(dish.name, '小炒肉');
    assert.equal(dish.category, '荤菜');
    assert.deepEqual(dish.meal_types, []);
    assert.equal(dish.steps, '');
    assert.equal(dish.ingredients[0].name, '鸡腿');
    assert.equal(dish.ingredients[0].required, true);
    // 150g 鸡腿 @181kcal/100g → 271.5 → 四舍五入 272
    assert.equal(dish.nutrition.kcal, 272);

    assert.ok((await dishIdByName('小炒肉')) > 0);
  });

  it('newIngredients：缺的食材连营养入库；同名零营养行被补全而不是新建', async () => {
    const res = await post({
      name: '沙姜焖鸡',
      category: '荤菜',
      spicy: 1,
      mealTypes: ['dinner', 'lunch', 'dinner'],
      tags: ['家常', '家常', '下饭'],
      steps: ['腌 15 分钟', '焖 20 分钟'],
      ingredients: [
        { name: '鸡腿', amount: 100, required: true },
        { name: '沙姜', amount: 50, required: false },
        { name: '柚子', amount: 80, required: false },
      ],
      newIngredients: [
        { name: '沙姜', category: '蔬果', kcal: 42, protein: 1.0, fat: 0.2, carb: 8.0, sodium: 3.0, fiber: 0.4, price: 1.5 },
        { name: '柚子', category: '蔬果', buyUnit: '个', buyFactor: 1000, kcal: 42, protein: 0.8, fat: 0.2, carb: 9.5, sodium: 3.0, fiber: 0.4 },
      ],
    });
    assert.equal(res.status, 201);
    const { dish } = (await res.json()) as { dish: DishBody };
    // 餐别去重并按固定顺序排序；标签去重；做法一行一步拼文本
    assert.deepEqual(dish.meal_types, ['lunch', 'dinner']);
    assert.match(dish.steps, /^腌 15 分钟\n焖 20 分钟$/);
    assert.equal(dish.ingredients.find((item) => item.name === '沙姜')?.required, false);

    // 沙姜是新插入的；柚子没有多出第二行——原来的零营养行被就地补全
    const shajiang = get<{ c: number; kcal: number }>(
      "SELECT COUNT(*) AS c, MAX(kcal) AS kcal FROM ingredients WHERE name = '沙姜'",
    );
    assert.equal(Number(shajiang?.c), 1);
    assert.equal(Number(shajiang?.kcal), 42);
    const youzi = get<{ c: number; kcal: number; buy_unit: string }>(
      "SELECT COUNT(*) AS c, MAX(kcal) AS kcal, MAX(buy_unit) AS buy_unit FROM ingredients WHERE name = '柚子'",
    );
    assert.equal(Number(youzi?.c), 1, '同名食材必须被补全，不能多出一行');
    assert.equal(Number(youzi?.kcal), 42);
    assert.equal(youzi?.buy_unit, '个');
  });

  it('newIngredients 的 nutritionSource 按食材覆盖：参考表命中的标 seed，其余跟 origin', async () => {
    const res = await post({
      origin: 'ai',
      name: '蚝油生菜',
      category: '素菜',
      ingredients: [
        { name: '鸡腿', amount: 150, required: true },
        { name: '蚝油', amount: 10, required: true },
        { name: '奇香粉', amount: 3, required: false },
      ],
      newIngredients: [
        // 蚡油走「成分表参考表命中」的路；奇香粉是模型估的
        { name: '蚝油', category: '调料', kcal: 114, protein: 4.7, fat: 0.3, carb: 23.4, sodium: 2600, fiber: 0, nutritionSource: 'seed' },
        { name: '奇香粉', category: '调料', kcal: 50, protein: 1, fat: 0.5, carb: 9, sodium: 5, fiber: 1 },
      ],
    });
    assert.equal(res.status, 201);
    assert.equal(
      get<{ s: string }>("SELECT nutrition_source AS s FROM ingredients WHERE name = '蚝油'")?.s,
      'seed',
      '显式 seed 覆盖 origin 的 ai',
    );
    assert.equal(
      get<{ s: string }>("SELECT nutrition_source AS s FROM ingredients WHERE name = '奇香粉'")?.s,
      'ai',
      '没写的沿用 origin=ai 的默认',
    );

    // 非法来源直接拦下，别让它悄悄落成别的值
    const bad = await post({
      origin: 'ai',
      name: '坏来源菜',
      category: '素菜',
      ingredients: [{ name: '鸡腿', amount: 100 }],
      newIngredients: [
        { name: '坏来源粉', category: '调料', kcal: 1, protein: 1, fat: 1, carb: 1, sodium: 1, fiber: 1, nutritionSource: 'robot' },
      ],
    });
    assert.equal(bad.status, 400);
  });

  it('拦截：重名 409；缺食材、坏分类、坏辣度、空配料、坏餐别 400', async () => {
    const duplicated = await post(minimal);
    assert.equal(duplicated.status, 409);
    assert.equal(((await duplicated.json()) as { error: { code: string } }).error.code, 'DISH_EXISTS');

    const unknown = await post({ ...minimal, name: '芋头焖鸡', ingredients: [{ name: '芋头', amount: 100 }] });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { error: { message: string } }).error.message, /芋头/);

    assert.equal((await post({ ...minimal, name: '乱分类', category: '大菜' })).status, 400);
    assert.equal((await post({ ...minimal, name: '爆辣', spicy: 4 })).status, 400);
    assert.equal((await post({ ...minimal, name: '空配料', ingredients: [] })).status, 400);
    assert.equal((await post({ ...minimal, name: '坏餐别', mealTypes: ['supper'] })).status, 400);
  });

  it('建完的菜直接能下单：订单行带快照与每人份热量', async () => {
    const dishId = await dishIdByName('小炒肉');
    const order = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: 1,
        mealType: 'dinner',
        mealDate: tomorrow(),
        items: [{ dishId, servings: 1 }],
        headcount: 2,
        clientToken: 'dish-create-smoke',
      }),
    });
    assert.equal(order.status, 201);
    const body = (await order.json()) as { order: { items: { id: number; name: string }[] } };
    const line = body.order.items.find((item) => item.name === '小炒肉');
    assert.ok(line, '新建的菜要能出现在订单行上');
    // 下单快照把每人份热量冻结在订单行上（历史口径不依赖菜品表现状）
    const snapshot = get<{ kcal_per_serving: number; dish_category: string }>(
      'SELECT kcal_per_serving, dish_category FROM order_items WHERE id = ?',
      line.id,
    );
    assert.ok(snapshot);
    assert.equal(Number(snapshot.kcal_per_serving), 272);
    assert.equal(snapshot.dish_category, '荤菜');
  });
});
