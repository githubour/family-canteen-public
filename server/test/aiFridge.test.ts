/**
 * AI 登记库存（POST /api/ai/fridge-draft + POST /api/fridge-stock/batch）。
 *
 * 这里钉住的核心是「谁负责判定」：模型只把「提到了哪些食材、分别是有的还是没的」提取出来，
 * 「哪些已经在库存里、哪些是常备调料、哪些库里根本没有」全部由服务端查真实数据判定。
 * 所以第一个用例就是需求原话：库存里已有土豆和鸡蛋时，说一句话只应该把西红柿（=库里的番茄）加进去。
 *
 * 模型调用打桩（只拦 api.deepseek.com，其余 fetch 放行给测试服务器），不依赖真实 key。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { all, get, run } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

const realFetch = globalThis.fetch;
let llmResponder: (() => Response) | null = null;

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.deepseek.com')) return realFetch(input, init);
  if (!llmResponder) return Promise.reject(new Error('测试没设置 LLM 响应'));
  return Promise.resolve(llmResponder());
}) as typeof fetch;

const llmReply = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 造一份模型输出 */
const fridgeReply = (draft: Record<string, unknown>): Response => llmReply(JSON.stringify(draft));

let server: TestServer | undefined;
let base = '';

const postFridgeDraft = (body: unknown) =>
  fetch(`${base}/api/ai/fridge-draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const postBatch = (body: unknown) =>
  fetch(`${base}/api/fridge-stock/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const stockIds = () =>
  new Set(
    all<{ ingredient_id: number }>('SELECT ingredient_id FROM fridge_stock').map((row) => row.ingredient_id),
  );

const ingredientId = (name: string): number => {
  const row = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', name);
  assert.ok(row, `夹具里应该有「${name}」`);
  return row.id;
};

interface FridgeResponse {
  rows: {
    ingredient_id: number | null;
    name: string;
    said: string;
    category: string;
    status: 'add' | 'remove' | 'already' | 'pantry' | 'unknown' | 'dish' | 'make_pantry';
    want?: 'have' | 'missing';
    candidates?: { ingredient_id: number; name: string; category: string; is_pantry: boolean }[];
    pantry_intent?: boolean;
    in_stock?: boolean;
  }[];
  notes: string[];
  model: string;
}

before(async () => {
  server = await startTestServer();
  base = server.base;
  // 夹具：番茄（模型会说「西红柿」）、土豆、鸡蛋、盐（常备调料）、生抽（给疑似候选用）
  const fixtures: [string, string, number, number][] = [
    ['番茄', '蔬果', 20, 0],
    ['土豆', '蔬果', 81, 0],
    ['鸡蛋', '肉禽蛋', 144, 0],
    ['盐', '调料', 0, 1],
    ['生抽', '调料', 60, 0],
  ];
  for (const [name, category, kcal, pantry] of fixtures) {
    run(
      `INSERT INTO ingredients (name, category, is_pantry, kcal, protein, fat, carb, sodium, fiber,
         nutrition_source)
       VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 'seed')`,
      name,
      category,
      pantry,
      kcal,
    );
  }
  // 库存现状：土豆与鸡蛋已经在里面了
  run('INSERT INTO fridge_stock (ingredient_id) VALUES (?)', ingredientId('土豆'));
  run('INSERT INTO fridge_stock (ingredient_id) VALUES (?)', ingredientId('鸡蛋'));
});

after(() => {
  server?.close();
  server = undefined;
  globalThis.fetch = realFetch;
});

describe('AI 登记库存草稿（POST /api/ai/fridge-draft）', () => {
  it('需求原场景：库存已有土豆和鸡蛋时，只把西红柿（库里的番茄）列为要登记', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: ['西红柿', '土豆', '鸡蛋', '番茄'], missing: [], notes: '' });

    const res = await postFridgeDraft({ text: '我现在的食材有西红柿、土豆、鸡蛋、番茄' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as FridgeResponse;

    const byName = new Map(body.rows.map((row) => [row.name, row]));
    assert.equal(body.rows.length, 3, '西红柿与番茄是同一样，必须合并成一行');

    // 唯一要动作的就是番茄
    assert.equal(byName.get('番茄')?.status, 'add');
    assert.equal(byName.get('番茄')?.said, '西红柿', '记下用户原话里的叫法，便于解释为什么变成番茄');
    assert.equal(byName.get('番茄')?.ingredient_id, ingredientId('番茄'));
    // 已经在库存里的两样要「露面但不重复登记」——用户才能看懂这句话为什么只加了一样
    assert.equal(byName.get('土豆')?.status, 'already');
    assert.equal(byName.get('鸡蛋')?.status, 'already');

    assert.ok(
      body.notes.some((note) => note.includes('西红柿') && note.includes('番茄')),
      '别名归并要给人一句说明',
    );
  });

  it('常备调料不登记：盐只提示「不用登记」，不进待登记清单', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: ['盐', '番茄'], missing: [], notes: '' });

    const res = await postFridgeDraft({ text: '我有盐和番茄' });
    const body = (await res.json()) as FridgeResponse;
    assert.equal(body.rows.find((row) => row.name === '盐')?.status, 'pantry');
    assert.equal(body.rows.find((row) => row.name === '番茄')?.status, 'add');
  });

  it('食材库里没有的：列为跳过并指路，绝不悄悄丢掉', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: ['鱼腥草'], missing: [], dishes: [], notes: '' });

    const res = await postFridgeDraft({ text: '我有鱼腥草' });
    const body = (await res.json()) as FridgeResponse;
    const row = body.rows.find((item) => item.name === '鱼腥草');
    assert.equal(row?.status, 'unknown');
    assert.equal(row?.ingredient_id, null);
    assert.equal(row?.want, 'have', '记下用户说它是「有」，前端建库后按原意接着登记');
    assert.deepEqual(row?.candidates, [], '库里没有长得像的，不给候选');
    assert.ok(body.notes.some((note) => note.includes('鱼腥草')));
  });

  it('疑似候选：库里没有「生抽酱油」时把「生抽」摆出来让人拍板', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: ['生抽酱油'], missing: [], dishes: [], notes: '' });

    const res = await postFridgeDraft({ text: '我有生抽酱油' });
    const body = (await res.json()) as FridgeResponse;
    const row = body.rows.find((item) => item.name === '生抽酱油');
    assert.equal(row?.status, 'unknown');
    assert.deepEqual(
      row?.candidates?.map((candidate) => candidate.name),
      ['生抽'],
      '候选是服务端按名字重合算的建议，不是归并——拍板在人',
    );
    assert.equal(row?.candidates?.[0].ingredient_id, ingredientId('生抽'));
  });

  it('净菜识别成菜品：给「去加菜」行而不是跳过', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      fridgeReply({ have: ['番茄'], missing: [], dishes: ['熟食烤鸡'], notes: '' });

    const res = await postFridgeDraft({ text: '我有番茄，还买了个熟食烤鸡' });
    const body = (await res.json()) as FridgeResponse;
    const dish = body.rows.find((item) => item.name === '熟食烤鸡');
    assert.equal(dish?.status, 'dish', '净菜不是食材，库存登记不了，但要给一行让「去加菜」有落点');
    assert.equal(dish?.ingredient_id, null);
    assert.equal(dish?.want, 'have');
    assert.equal(body.rows.find((item) => item.name === '番茄')?.status, 'add');
    assert.ok(body.notes.some((note) => note.includes('熟食烤鸡') && note.includes('加菜')));
  });

  it('只出现在 dishes 里、没进 have / missing 的名字也有一行（默认当「有」）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: [], missing: [], dishes: ['熟食烤鸡'], notes: '' });

    const res = await postFridgeDraft({ text: '买了个熟食烤鸡' });
    const body = (await res.json()) as FridgeResponse;
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].status, 'dish');
    assert.equal(body.rows[0].want, 'have');
  });

  it('模型把同一个名字既放进 have 又放进 dishes：按菜品处理，只留一行', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: ['熟食烤鸡'], missing: [], dishes: ['熟食烤鸡'], notes: '' });

    const res = await postFridgeDraft({ text: '我有个熟食烤鸡' });
    const body = (await res.json()) as FridgeResponse;
    assert.equal(body.rows.filter((item) => item.name === '熟食烤鸡').length, 1);
    assert.equal(body.rows[0].status, 'dish');
  });

  it('说「设为常备」：不再变成加库存，而是给「设常备」行（含是否已在库存）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    // 土豆在夹具里不是常备、且已在库存：这是最典型的「设常备」对象
    llmResponder = () => fridgeReply({ have: ['番茄'], missing: [], dishes: [], pantry: ['土豆'], notes: '' });

    const res = await postFridgeDraft({ text: '我有番茄，对了把土豆设为常备吧' });
    const body = (await res.json()) as FridgeResponse;
    const potato = body.rows.find((row) => row.name === '土豆');
    assert.equal(potato?.status, 'make_pantry', '「设为常备」是改食材属性，不是库存动作');
    assert.equal(potato?.ingredient_id, ingredientId('土豆'));
    assert.equal(potato?.in_stock, true, '在库存里的要标出来：确认时顺手撤掉（常备不需要登记）');
    assert.equal(body.rows.find((row) => row.name === '番茄')?.status, 'add');
  });

  it('pantry 与 have 撞名：只留「设常备」一行，不会同时又加库存', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: ['土豆'], missing: [], dishes: [], pantry: ['土豆'], notes: '' });

    const res = await postFridgeDraft({ text: '把土豆设为常备' });
    const body = (await res.json()) as FridgeResponse;
    const potatoRows = body.rows.filter((row) => row.name === '土豆');
    assert.equal(potatoRows.length, 1);
    assert.equal(potatoRows[0].status, 'make_pantry');
  });

  it('本来就是常备的：提示不用再设；库里没有的：建为食材时直接建成常备', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: [], missing: [], dishes: [], pantry: ['盐', '藤椒油'], notes: '' });

    const res = await postFridgeDraft({ text: '盐和藤椒油都设为常备' });
    const body = (await res.json()) as FridgeResponse;
    assert.equal(body.rows.find((row) => row.name === '盐')?.status, 'pantry');
    assert.ok(body.notes.some((note) => note.includes('本来就是常备')));
    const unknown = body.rows.find((row) => row.name === '藤椒油');
    assert.equal(unknown?.status, 'unknown');
    assert.equal(unknown?.pantry_intent, true, '带着常备意图，前端「建为食材」会直接建成常备');
  });

  it('说「没有了」才撤掉，而且只撤真的在库存里的那样', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: [], missing: ['鸡蛋', '番茄'], notes: '' });

    const res = await postFridgeDraft({ text: '鸡蛋用完了' });
    const body = (await res.json()) as FridgeResponse;
    const byName = new Map(body.rows.map((row) => [row.name, row]));

    assert.equal(byName.get('鸡蛋')?.status, 'remove', '在库存里且被说「没有」→ 撤掉');
    assert.equal(byName.has('番茄'), false, '本来就不在库存里，说「没有」无事可做，不必占一行');
  });

  it('自相矛盾（既说有又说没）按「有」处理并说明，避免错删', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: ['鸡蛋'], missing: ['鸡蛋'], notes: '' });

    const res = await postFridgeDraft({ text: '鸡蛋还有一些，哦不，没了' });
    const body = (await res.json()) as FridgeResponse;
    assert.equal(body.rows.find((row) => row.name === '鸡蛋')?.status, 'already');
    assert.ok(body.notes.some((note) => note.includes('按「有」处理')));
  });

  it('整体清空只作为提示，不会变成逐条删除', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => fridgeReply({ have: [], missing: [], notes: '用户说冰箱空了，请用清空按钮' });

    const res = await postFridgeDraft({ text: '冰箱都空了' });
    const body = (await res.json()) as FridgeResponse;
    assert.deepEqual(body.rows, [], '这不是逐条删除的场合：清空有专门按钮');
    assert.ok(body.notes.some((note) => note.includes('清空')));
  });

  it('空描述 400、没配 key 503', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    assert.equal((await postFridgeDraft({ text: '  ' })).status, 400);

    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      assert.equal((await postFridgeDraft({ text: '我有番茄' })).status, 503);
    } finally {
      process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});

describe('库存批量写入（POST /api/fridge-stock/batch）', () => {
  it('一次事务里加与撤同时生效，返回全量清单', async () => {
    const tomato = ingredientId('番茄');
    assert.equal(stockIds().has(tomato), false);

    const res = await postBatch({ add: [tomato], remove: [ingredientId('鸡蛋')] });
    assert.equal(res.status, 200);

    const items = ((await res.json()) as { items: { name: string }[] }).items;
    assert.deepEqual(new Set(items.map((item) => item.name)), new Set(['土豆', '番茄']));
    assert.equal(stockIds().has(tomato), true);
    assert.equal(stockIds().has(ingredientId('鸡蛋')), false);
  });

  it('幂等：重放同一批结果不变，且同一 id 既加又撤时以「加」为准', async () => {
    const tomato = ingredientId('番茄');
    const potato = ingredientId('土豆');

    assert.equal((await postBatch({ add: [tomato], remove: [tomato, potato] })).status, 200);
    // 先删后插，所以最终是「有」——与提示词那条「宁可多登记一样，也不要错删」一致
    assert.equal(stockIds().has(tomato), true);
    assert.equal(stockIds().has(potato), false);

    // 草稿重试就是把同一批再发一次，结果必须一样
    const replayed = await postBatch({ add: [tomato], remove: [tomato, potato] });
    assert.equal(replayed.status, 200);
    assert.deepEqual([...stockIds()], [tomato]);
  });

  it('空操作 400；不存在的食材 id 400 而不是 500', async () => {
    assert.equal((await postBatch({ add: [], remove: [] })).status, 400);
    assert.equal((await postBatch({})).status, 400);

    const missing = await postBatch({ add: [999999] });
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'BAD_REQUEST');
  });
});
