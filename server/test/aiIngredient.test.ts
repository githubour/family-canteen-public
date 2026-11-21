/**
 * AI 删除食材（POST /api/ai/ingredient-draft + DELETE /api/purchase/ingredients/:id）。
 *
 * 这里钉住的分工：模型只把「要删哪些名字」提取出来，能不能删由服务端查真实菜谱引用判定；
 * 被引用的食材不可删，确认时也复用既有的 DELETE 接口（守卫会再拦一次）。
 * 模型调用打桩（只拦 api.deepseek.com），不依赖真实 key。
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

const llmReply = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const draftReply = (draft: Record<string, unknown>): Response => llmReply(JSON.stringify(draft));

let server: TestServer | undefined;
let base = '';

const postDraft = (body: unknown) =>
  fetch(`${base}/api/ai/ingredient-draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const removeIngredient = (id: number) => fetch(`${base}/api/purchase/ingredients/${id}`, { method: 'DELETE' });

const ingredientId = (name: string): number => {
  const row = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', name);
  assert.ok(row, `夹具里应该有「${name}」`);
  return row.id;
};

interface IngredientDraftResponse {
  rows: {
    ingredient_id: number;
    name: string;
    said: string;
    category: string;
    is_pantry: boolean;
    dish_count: number;
    dish_names: string[];
    in_stock: boolean;
    deletable: boolean;
    reason: string;
  }[];
  notes: string[];
  model: string;
}

before(async () => {
  server = await startTestServer();
  base = server.base;

  const fixtures: [string, string, number][] = [
    ['沙姜', '调料', 30],
    ['鸡腿', '肉禽蛋', 180],
    ['鸡胸肉', '肉禽蛋', 120],
    ['番茄', '蔬果', 20],
  ];
  for (const [name, category, kcal] of fixtures) {
    run(
      `INSERT INTO ingredients (name, category, is_pantry, kcal, protein, fat, carb, sodium, fiber,
         nutrition_source)
       VALUES (?, ?, 0, ?, 1, 1, 1, 1, 1, 'seed')`,
      name,
      category,
      kcal,
    );
  }

  // 沙姜登记过库存（删除时库存随食材一起级联清掉）；鸡腿被一道菜引用
  run('INSERT INTO fridge_stock (ingredient_id) VALUES (?)', ingredientId('沙姜'));
  const dish = run(`INSERT INTO dishes (name, emoji, category, active) VALUES ('沙姜鸡', '🍗', '荤菜', 1)`);
  run('INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (?, ?, 200)', dish.lastInsertRowid, ingredientId('鸡腿'));
});

after(() => {
  server?.close();
  server = undefined;
  globalThis.fetch = realFetch;
});

describe('AI 删除食材草稿（POST /api/ai/ingredient-draft）', () => {
  it('孤立食材：可以删，并说清库存会一起清掉；确认后走既有 DELETE 接口真的删掉', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => draftReply({ names: ['沙姜'], notes: '' });

    const res = await postDraft({ text: '把沙姜从食材库删掉' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as IngredientDraftResponse;

    assert.equal(body.rows.length, 1);
    const row = body.rows[0];
    assert.equal(row.name, '沙姜');
    assert.equal(row.deletable, true);
    assert.equal(row.dish_count, 0);
    assert.equal(row.in_stock, true);
    assert.match(row.reason, /库存/);

    // 确认 = 调既有的孤立食材删除接口（不是 AI 新开一条写入口）
    const del = await removeIngredient(row.ingredient_id);
    assert.equal(del.status, 200);
    assert.equal(get('SELECT id FROM ingredients WHERE name = ?', '沙姜'), undefined);
  });

  it('被菜谱引用的食材：草稿标不可删并列出菜名；DELETE 仍被既有守卫 409 拦下', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => draftReply({ names: ['鸡腿'], notes: '' });

    const body = (await (await postDraft({ text: '把鸡腿删了' })).json()) as IngredientDraftResponse;
    const row = body.rows[0];
    assert.equal(row.name, '鸡腿');
    assert.equal(row.deletable, false);
    assert.equal(row.dish_count, 1);
    assert.deepEqual(row.dish_names, ['沙姜鸡']);
    assert.match(row.reason, /先从菜里去掉/);

    const del = await removeIngredient(row.ingredient_id);
    assert.equal(del.status, 409);
    const error = (await del.json()) as { error: { code: string } };
    assert.equal(error.error.code, 'INGREDIENT_IN_USE');
    assert.ok(get('SELECT id FROM ingredients WHERE name = ?', '鸡腿'), '被引用的食材不能在草稿阶段被删掉');
  });

  it('别名对上库里的规范名：草稿用规范名，并提示按哪个处理', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    // 用户说「西红柿」；库里只有「番茄」
    llmResponder = () => draftReply({ names: ['西红柿'], notes: '' });

    const body = (await (await postDraft({ text: '把西红柿删了' })).json()) as IngredientDraftResponse;
    const row = body.rows[0];
    assert.equal(row.name, '番茄');
    assert.equal(row.said, '西红柿');
    assert.ok(body.notes.some((note) => note.includes('番茄')), '别名归并要说清楚');
  });

  it('库里没有的名字：说明没有可删的，不凭空造行', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => draftReply({ names: ['不存在的食材'], notes: '' });

    const body = (await (await postDraft({ text: '删掉不存在的食材' })).json()) as IngredientDraftResponse;
    assert.equal(body.rows.length, 0);
    assert.ok(body.notes.some((note) => note.includes('没有')));
  });

  it('草稿阶段绝不写库：食材数量前后不变', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => draftReply({ names: ['鸡腿'], notes: '' });

    const before = all<{ id: number }>('SELECT id FROM ingredients').length;
    await postDraft({ text: '把鸡腿删了' });
    const after = all<{ id: number }>('SELECT id FROM ingredients').length;
    assert.equal(after, before);
  });
});
