/**
 * 改菜：写入面（PATCH 可编辑字段 + PUT 整表替换配料表）与 AI 改菜草稿。
 *
 * 这一批钉住的都是「不能出错」的地方：
 *   · 写入面：重名要拦、非法值不落库、整表替换要么全成要么整条回滚（绝不留下空配料表）、
 *     改名不改写历史订单（订单行存的是下单时的快照）；
 *   · 草稿：模型提的改动要过服务端校验（草稿上不该出现「点确认必然 400」的条目）、
 *     没有反馈依据的改动一律丢掉、**每条反馈都必须有交代**（被改动覆盖 / 进 unhandled），
 *     而 unhandled 里的一条都不能被删——这是「不丢线索」的底线。
 *
 * 模型调用打桩（只拦 api.deepseek.com，其余 fetch 放行给测试服务器）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { all, get, run } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

const realFetch = globalThis.fetch;
let llmResponder: (() => Response) | null = null;
let lastLlmBody = '';

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.deepseek.com')) return realFetch(input, init);
  lastLlmBody = typeof init?.body === 'string' ? init.body : '';
  if (!llmResponder) return Promise.reject(new Error('测试没设置 LLM 响应'));
  return Promise.resolve(llmResponder());
}) as typeof fetch;

const llmReply = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let server: TestServer | undefined;
let base = '';
let dishId = 0;
let feedbackIds: number[] = [];

const patch = (id: number, body: unknown) =>
  fetch(`${base}/api/dishes/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const putBom = (id: number, body: unknown) =>
  fetch(`${base}/api/dishes/${id}/ingredients`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const postRevision = (id: number) =>
  fetch(`${base}/api/ai/dish-revision-draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dishId: id }),
  });

interface RevisionResponse {
  revision: {
    dish: { name: string; ingredients: { name: string; amount: number; required: boolean }[] };
    changes: {
      id: string;
      label: string;
      before: string;
      after: string;
      field?: string;
      value?: unknown;
      bom?: { action: string; name: string; ingredient_id: number; amount?: number };
      sources: { id: number; content: string }[];
      conflict: boolean;
      note: string;
    }[];
    unhandled: { feedback_id: number; content: string; reason: string }[];
    effects: string[];
  };
  notes: string[];
  model: string;
}

const bomNow = () =>
  all<{ name: string; amount: number; required: number }>(
    `SELECT i.name, di.amount, di.required
       FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
      WHERE di.dish_id = ? ORDER BY di.id`,
    dishId,
  );

before(async () => {
  server = await startTestServer();
  base = server.base;

  const fixtures: [string, string, number][] = [
    ['鸡腿', '肉禽蛋', 181],
    ['盐', '调料', 0],
    ['料酒', '调料', 66],
    ['小葱', '蔬果', 24],
    ['土豆', '蔬果', 81],
  ];
  for (const [name, category, kcal] of fixtures) {
    run(
      `INSERT INTO ingredients (name, category, kcal, protein, fat, carb, sodium, fiber)
       VALUES (?, ?, ?, 1, 1, 1, 1, 1)`,
      name,
      category,
      kcal,
    );
  }
  run(`INSERT INTO members (id, name, avatar, color) VALUES (1, '测试家人', '🙂', '#123456')`);
  run(
    `INSERT INTO dishes (name, category, spicy, tags, cook_minutes, difficulty, base_servings,
       emoji, description, steps)
     VALUES ('测试炒鸡', '荤菜', 2, '["家常"]', 30, 2, 2, '🍗', '测试用菜。', '腌制 15 分钟
大火翻炒')`,
  );
  dishId = Number(get<{ id: number }>("SELECT id FROM dishes WHERE name = '测试炒鸡'")?.id);

  for (const [name, amount, required] of [
    ['鸡腿', 180, 1],
    ['盐', 3, 0],
    ['料酒', 10, 0],
  ] as [string, number, number][]) {
    const ingredient = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', name);
    assert.ok(ingredient, `夹具食材「${name}」应该已入库`);
    run(
      "INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, unit, note, required) VALUES (?, ?, ?, 'g', NULL, ?)",
      dishId,
      ingredient.id,
      amount,
      required,
    );
  }

  for (const content of ['有点咸', '土豆没炖烂', '整体还不错，就是火候不太行']) {
    run('INSERT INTO dish_feedback (dish_id, content, member_id) VALUES (?, ?, 1)', dishId, content);
  }
  feedbackIds = all<{ id: number }>('SELECT id FROM dish_feedback WHERE dish_id = ? ORDER BY id', dishId).map(
    (row) => row.id,
  );
});

after(() => {
  server?.close();
  server = undefined;
  globalThis.fetch = realFetch;
});

describe('改菜的写入面', () => {
  it('PATCH 可编辑字段：名字 / 分类 / 辣度 / 耗时 / 份数 / 简介 / 标签 / 做法（数组也认）', async () => {
    const res = await patch(dishId, {
      category: '素菜',
      spicy: 1,
      difficulty: 3,
      minutes: 45,
      baseServings: 3,
      emoji: '🥘',
      description: '  改过的简介  ',
      tags: ['快手', '家常', '快手'],
      steps: ['切块', ' ', '炖 20 分钟'],
    });
    assert.equal(res.status, 200);
    const { dish } = (await res.json()) as {
      dish: {
        category: string;
        spicy: number;
        difficulty: number;
        cook_minutes: number;
        base_servings: number;
        emoji: string;
        description: string;
        tags: string[];
        steps: string;
      };
    };
    assert.equal(dish.category, '素菜');
    assert.equal(dish.spicy, 1);
    assert.equal(dish.difficulty, 3);
    assert.equal(dish.cook_minutes, 45);
    assert.equal(dish.base_servings, 3);
    assert.equal(dish.emoji, '🥘');
    assert.equal(dish.description, '改过的简介', '首尾空白要去掉');
    assert.deepEqual(dish.tags, ['快手', '家常'], '标签去重');
    assert.equal(dish.steps, '切块\n炖 20 分钟', '空行去掉、一行一步');
  });

  it('改名：成功改名；撞上别的菜 409；空名 / 超长 / 坏字段 400；一个字段都不传 400', async () => {
    const renamed = await patch(dishId, { name: '测试炒鸡改名版' });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { dish: { name: string } }).dish.name, '测试炒鸡改名版');

    run(`INSERT INTO dishes (name, category) VALUES ('另一个菜', '荤菜')`);
    const clash = await patch(dishId, { name: '另一个菜' });
    assert.equal(clash.status, 409);
    assert.equal(((await clash.json()) as { error: { code: string } }).error.code, 'DISH_EXISTS');

    assert.equal((await patch(dishId, { name: '   ' })).status, 400);
    assert.equal((await patch(dishId, { name: 'x'.repeat(25) })).status, 400);
    assert.equal((await patch(dishId, { category: '大菜' })).status, 400);
    assert.equal((await patch(dishId, { spicy: 9 })).status, 400);
    assert.equal((await patch(dishId, {})).status, 400);
  });

  it('PUT 整表替换：改量 / 删一行 / 加一行，落库后与提交完全一致且可重放', async () => {
    const body = {
      ingredients: [
        { name: '鸡腿', amount: 200, required: true },
        { name: '小葱', amount: 5, required: false },
        { name: '土豆', amount: 120, required: true },
      ],
    };
    const first = await putBom(dishId, body);
    assert.equal(first.status, 200);
    assert.deepEqual(
      bomNow().map((row) => [row.name, row.amount, row.required]),
      [
        ['鸡腿', 200, 1],
        ['小葱', 5, 0],
        ['土豆', 120, 1],
      ],
      '料酒被删掉、小葱与土豆是新加的',
    );

    // 幂等：重放同一份，结果一样（草稿确认失败后重试就靠这个）
    assert.equal((await putBom(dishId, body)).status, 200);
    assert.equal(bomNow().length, 3);
  });

  it('PUT 校验：空数组 400、名字对不上 400，且**回滚**——绝不留下空配料表', async () => {
    const before = bomNow();
    assert.equal((await putBom(dishId, { ingredients: [] })).status, 400);
    assert.equal((await putBom(dishId, { ingredients: [{ name: '不存在的食材', amount: 10 }] })).status, 400);
    assert.deepEqual(bomNow(), before, '校验失败必须整条回滚，原配料表原样');

    // 带 newIngredients 时可以把新食材一起建出来
    const withNew = await putBom(dishId, {
      ingredients: [
        { name: '鸡腿', amount: 200, required: true },
        { name: '香茅', amount: 10, required: false },
      ],
      newIngredients: [
        { name: '香茅', category: '蔬果', kcal: 30, protein: 1, fat: 0.5, carb: 5, sodium: 2, fiber: 1 },
      ],
    });
    assert.equal(withNew.status, 200);
    assert.ok(bomNow().some((row) => row.name === '香茅'));
  });

  it('改名与改配方都不改写历史订单（订单行存的是下单时的菜名快照）', async () => {
    const dish = get<{ category: string }>('SELECT category FROM dishes WHERE id = ?', dishId);
    assert.ok(dish);
    run(
      `INSERT INTO orders (id, member_id, meal_date, meal_type, status, headcount)
       VALUES (900, 1, '2026-01-01', 'dinner', 'done', 2)`,
    );
    run(
      `INSERT INTO order_items (order_id, dish_id, servings, dish_name, dish_emoji, dish_category, kcal_per_serving, bom)
       VALUES (900, ?, 1, '测试炒鸡', '🍗', '荤菜', 300, '[]')`,
      dishId,
    );

    assert.equal((await patch(dishId, { name: '改名之后' })).status, 200);
    const line = get<{ dish_name: string }>('SELECT dish_name FROM order_items WHERE order_id = 900');
    assert.equal(line?.dish_name, '测试炒鸡', '历史订单里的菜名是快照，不跟着改');
  });
});

describe('反馈的聚合与批量清理', () => {
  it('GET /api/dish-feedback：按菜聚合，能看到攒了多少', async () => {
    const res = await fetch(`${base}/api/dish-feedback`);
    assert.equal(res.status, 200);
    const { groups } = (await res.json()) as {
      groups: { dish_id: number; dish_name: string; feedbacks: { content: string }[] }[];
    };
    const group = groups.find((item) => item.dish_id === dishId);
    assert.ok(group, '这道菜应该在聚合里');
    assert.equal(group.feedbacks.length, 3);
    assert.equal(group.dish_name, '改名之后', '菜名用当下库里的（改过名就是新名）');
  });

  it('POST /api/dish-feedback/remove：幂等——已经删过的 id 直接跳过而不是 404', async () => {
    const res = await fetch(`${base}/api/dish-feedback/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [feedbackIds[0]] }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { removed: number }).removed, 1);

    // 重放同一批：这次一条也删不到，但仍然成功（批量处理分批/重试是正常操作）
    const again = await fetch(`${base}/api/dish-feedback/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [feedbackIds[0]] }),
    });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { removed: number }).removed, 0);

    assert.equal(
      (
        await fetch(`${base}/api/dish-feedback/remove`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: [] }),
        })
      ).status,
      400,
    );
  });
});

describe('AI 改菜草稿', () => {
  // 前面的写入面测试把配料表改来改去，这里先把草稿依赖的现状摆回来
  before(() => {
    run('DELETE FROM dish_ingredients WHERE dish_id = ?', dishId);
    for (const [name, amount, required] of [
      ['鸡腿', 180, 1],
      ['盐', 3, 0],
      ['料酒', 10, 0],
    ] as [string, number, number][]) {
      const ingredient = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', name);
      assert.ok(ingredient);
      run(
        "INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, unit, note, required) VALUES (?, ?, ?, 'g', NULL, ?)",
        dishId,
        ingredient.id,
        amount,
        required,
      );
    }
  });

  it('模型给的改动被整理成「现状 → 建议」，带上依据的反馈与连带影响', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      llmReply(
        JSON.stringify({
          changes: [
            { kind: 'amount', ingredient: '盐', amount: 2, feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
            {
              kind: 'steps',
              steps: ['腌制 15 分钟', '大火翻炒', '小火炖 25 分钟'],
              feedback_ids: [feedbackIds[2]],
              conflict: false,
              note: '',
            },
            { kind: 'remove', ingredient: '料酒', feedback_ids: [feedbackIds[2]], conflict: false, note: '' },
          ],
          unhandled: [],
          notes: '',
        }),
      );

    const res = await postRevision(dishId);
    assert.equal(res.status, 200);
    const { revision } = (await res.json()) as RevisionResponse;

    assert.doesNotMatch(lastLlmBody, /测试家人/, '成员真实姓名不应发给第三方模型');
    assert.match(lastLlmBody, /成员A/, '反馈应以角色代号标注');

    const salt = revision.changes.find((change) => change.label.includes('盐'));
    assert.ok(salt, '盐的用量改动应该在清单里');
    assert.equal(salt.before, '3g');
    assert.equal(salt.after, '2g');
    assert.equal(salt.bom?.action, 'amount');
    assert.equal(salt.bom?.amount, 2);
    assert.match(salt.sources[0].content, /土豆没炖烂/, '要带上原话，人才判断得出依据成立不成立');

    const steps = revision.changes.find((change) => change.field === 'steps');
    assert.ok(steps);
    assert.match(steps.after, /小火炖 25 分钟/);

    assert.ok(revision.changes.some((change) => change.bom?.action === 'remove'));
    assert.ok(
      revision.effects.some((effect) => effect.includes('采购')),
      '配料变了要说明采购与营养会跟着变',
    );
  });

  it('每条反馈都要有交代：模型漏掉的自动进 unhandled，绝不让线索消失', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      llmReply(
        JSON.stringify({
          changes: [
            { kind: 'amount', ingredient: '盐', amount: 2, feedback_ids: [feedbackIds[1]], conflict: true, note: '有人说咸有人说淡，取了中间值' },
          ],
          unhandled: [{ feedback_id: feedbackIds[2], reason: '只说火候不行，看不出改哪一步' }],
          notes: '',
        }),
      );

    const { revision } = (await (await postRevision(dishId)).json()) as RevisionResponse;
    assert.equal(revision.changes.length, 1);
    assert.equal(revision.changes[0].conflict, true, '矛盾标记要原样透传');
    assert.equal(revision.changes[0].note, '有人说咸有人说淡，取了中间值');

    const handled = revision.changes.flatMap((change) => change.sources.map((source) => source.id));
    const untouched = revision.unhandled.map((item) => item.feedback_id);
    const allIds = feedbackIds.slice(1); // 第一条在上一节已被删掉
    for (const id of allIds) {
      assert.ok(
        handled.includes(id) || untouched.includes(id),
        `反馈 #${id} 必须有去处：要么被某条改动覆盖，要么进 unhandled`,
      );
    }
    assert.ok(
      untouched.some((id) => id === feedbackIds[2]),
      '模型说看不出的那条要原样留在 unhandled',
    );
  });

  it('草稿里不该出现「点确认必然 400」的改动：非法值被拦下并说明', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      llmReply(
        JSON.stringify({
          changes: [
            { kind: 'field', field: 'spicy', value: 99, feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
            { kind: 'field', field: 'season_months', value: [9], feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
            { kind: 'amount', ingredient: '不存在的食材', amount: 10, feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
          ],
          unhandled: [],
          notes: '',
        }),
      );

    const body = (await (await postRevision(dishId)).json()) as RevisionResponse;
    assert.deepEqual(body.revision.changes, [], '三条都不合法，一条都不该进草稿');
    assert.ok(body.notes.length >= 3, '每条被拦下的改动都要给个说法');
    assert.ok(body.notes.some((note) => note.includes('辣度')));
    assert.ok(
      body.notes.some((note) => note.includes('season_months') || note.includes('可改范围')),
      '白名单之外的字段要明确说不在范围内',
    );
    assert.ok(
      body.revision.unhandled.some((item) => item.feedback_id === feedbackIds[1]),
      '没人用的反馈要退回 unhandled，不能被悄悄吃掉',
    );
  });

  it('没有反馈依据的改动一律丢掉；删最后一条配料会被拦下', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      llmReply(
        JSON.stringify({
          changes: [
            { kind: 'field', field: 'category', value: '汤', feedback_ids: [], conflict: false, note: '' },
            { kind: 'field', field: 'description', value: '顺手改的', feedback_ids: [999999], conflict: false, note: '' },
            { kind: 'remove', ingredient: '鸡腿', feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
          ],
          unhandled: [],
          notes: '',
        }),
      );

    // 先把配料表缩到只剩一条，制造「删掉就是空表」的局面
    assert.equal(
      (await putBom(dishId, { ingredients: [{ name: '鸡腿', amount: 180, required: true }] })).status,
      200,
    );

    const body = (await (await postRevision(dishId)).json()) as RevisionResponse;
    assert.deepEqual(body.revision.changes, []);
    assert.ok(body.notes.some((note) => note.includes('没有反馈依据')));
    assert.ok(body.notes.some((note) => note.includes('唯一的配料')));
  });

  it('同一样食材提了两条「加进去」：只留一条，别让确认时配料表重复而 400', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      llmReply(
        JSON.stringify({
          changes: [
            { kind: 'add', ingredient: '小葱', amount: 5, required: false, feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
            { kind: 'add', ingredient: '小葱', amount: 8, required: false, feedback_ids: [feedbackIds[2]], conflict: false, note: '' },
            // 「改用量」落在原配料表没有的食材上会转成加一行——同样不能与第一条 add 重复
            { kind: 'amount', ingredient: '土豆', amount: 100, feedback_ids: [feedbackIds[2]], conflict: false, note: '' },
            { kind: 'add', ingredient: '土豆', amount: 120, required: true, feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
          ],
          unhandled: [],
          notes: '',
        }),
      );

    const body = (await (await postRevision(dishId)).json()) as RevisionResponse;
    for (const name of ['小葱', '土豆']) {
      const adds = body.revision.changes.filter(
        (change) => change.bom?.action === 'add' && change.bom?.name === name,
      );
      assert.equal(adds.length, 1, `「${name}」只能留一条 add，两条会让 PUT 因配料表重复而 400`);
    }
    assert.ok(
      body.notes.some((note) => note.includes('小葱') && note.includes('忽略')),
      '被忽略的重复改动要给人一个说法',
    );
  });

  it('餐别改动进了白名单：字段与前后值都用中文标签，落库走同一条 PATCH', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      llmReply(
        JSON.stringify({
          changes: [
            { kind: 'field', field: 'meal_types', value: ['breakfast'], feedback_ids: [feedbackIds[1]], conflict: false, note: '' },
          ],
          unhandled: [],
          notes: '',
        }),
      );

    const body = (await (await postRevision(dishId)).json()) as RevisionResponse;
    const change = body.revision.changes[0];
    assert.ok(change, '餐别改动应该进草稿');
    assert.equal(change.field, 'meal_types');
    assert.equal(change.label, '餐别');
    assert.ok(String(change.before).includes('通用菜') || change.before === '（空）', `现状展示应是中文：${change.before}`);
    assert.equal(change.after, '早餐');
    assert.deepEqual(change.value, ['breakfast'], '落库值保持原始 key 数组，交给既有 PATCH 校验');

    // 真正落库一次，确认链路走得通（PATCH 的 meal_types 是既有线上契约）
    const res = await patch(dishId, { meal_types: change.value as string[] });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { dish: { meal_types: string[] } }).dish.meal_types, ['breakfast']);
  });

  it('没有反馈的菜 400、菜不存在 404、缺 key 503', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    run(`INSERT INTO dishes (name, category) VALUES ('没人反馈的菜', '素菜')`);
    const quiet = get<{ id: number }>("SELECT id FROM dishes WHERE name = '没人反馈的菜'");
    assert.equal((await postRevision(Number(quiet?.id))).status, 400);
    assert.equal((await postRevision(999999)).status, 404);

    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      assert.equal((await postRevision(dishId)).status, 503);
    } finally {
      process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});
