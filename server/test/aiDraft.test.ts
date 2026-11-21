/**
 * AI 加菜（POST /api/ai/draft）与营养来源标记。
 *
 * 这一批测的是「AI 只产草稿」这条边界内外各自该守住什么：
 *   · 草稿侧：库内已有食材必须被复用（含别名归并）、缺的进新食材并提示待复核、
 *     模型格式歪一点要自动修好而不是甩错、连菜名都没有才报错；
 *   · 落库侧：origin=ai 建出来的食材营养标 ai（后台黄标待复核），人复核后转 manual，
 *     而采购页手工建的食材不会被误标成待复核。
 *
 * 模型调用是打桩的（只拦截 api.deepseek.com，其余 fetch 原样放行给测试服务器），
 * 所以这里不依赖任何真实 key，CI 上也能跑。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { get, run } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

const realFetch = globalThis.fetch;
/** 打桩：只在被调用时构造 Response（Response 的 body 只能读一次，不能复用同一个实例） */
let llmResponder: (() => Response) | null = null;
let llmCalls = 0;
let lastLlmBody: Record<string, unknown> | null = null;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.deepseek.com')) return realFetch(input, init);
  llmCalls += 1;
  if (init?.body) lastLlmBody = JSON.parse(String(init.body)) as Record<string, unknown>;
  if (!llmResponder) return Promise.reject(new Error('测试没设置 LLM 响应'));
  return Promise.resolve(llmResponder());
}) as typeof fetch;

/** 造一个 OpenAI 风格的补全响应 */
const llmReply = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 造一个「模型输出的草稿 JSON」 */
const draftReply = (draft: Record<string, unknown>): Response => llmReply(JSON.stringify(draft));

let server: TestServer | undefined;
let base = '';

const postDraft = (body: unknown) =>
  fetch(`${base}/api/ai/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const postDish = (body: unknown) =>
  fetch(`${base}/api/dishes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface DraftResponse {
  draft: {
    name: string;
    category: string;
    spicy: number;
    difficulty: number;
    minutes: number;
    emoji: string;
    tags: string[];
    steps: string[];
    mealTypes: string[];
    kcal_per_serving: number | null;
    nutrition_complete: boolean;
    ingredients: {
      name: string;
      amount: number;
      required: boolean;
      is_new: boolean;
      matched_name: string | null;
      category: string;
      nutrition: Record<string, number> | null;
      nutrition_source?: 'seed' | 'ai';
    }[];
  };
  notes: string[];
  model: string;
}

before(async () => {
  server = await startTestServer();
  base = server.base;
  // 库内已有食材：
  //   凤梨 / 生姜 用来验证别名归并（模型会说「菠萝」）
  //   鸡腿 / 鸡翅 / 鸡胸肉 同属「鸡肉」组，用来验证多候选时按公共前缀取舍
  const fixtures: [string, string, number][] = [
    ['凤梨', '蔬果', 44],
    ['生姜', '蔬果', 46],
    ['鸡腿', '肉禽蛋', 181],
    ['鸡翅', '肉禽蛋', 194],
    ['鸡胸肉', '肉禽蛋', 133],
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
});

after(() => {
  server?.close();
  server = undefined;
  globalThis.fetch = realFetch;
});

describe('AI 加菜草稿（POST /api/ai/draft）', () => {
  it('没配 key 时整体关闭：status.enabled=false，草稿接口回 503', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const status = (await (await fetch(`${base}/api/ai/status`)).json()) as { enabled: boolean };
      assert.equal(status.enabled, false);

      const res = await postDraft({ text: '加个小炒肉' });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'AI_UNAVAILABLE');
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = saved;
    }
  });

  it('描述为空或超长直接 400，不会白白调用一次模型', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const before = llmCalls;

    assert.equal((await postDraft({ text: '   ' })).status, 400);
    assert.equal((await postDraft({ text: 'x'.repeat(201) })).status, 400);
    assert.equal((await postDraft({ text: 123 })).status, 400);

    assert.equal(llmCalls, before, '前置校验拦下的请求不该打到模型');
  });

  it('库内已有食材被复用（含别名归并），缺的进新食材并提示待复核', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-菠萝咕咾肉',
        category: '荤菜',
        spicy: 1,
        tags: ['家常', '酸甜'],
        minutes: 30,
        difficulty: 2,
        baseServings: 2,
        emoji: '🍍',
        description: '菠萝配肉，酸甜下饭。',
        steps: ['肉切块腌 15 分钟', '菠萝切块', '下锅翻炒收汁'],
        mealTypes: ['lunch', 'dinner'],
        ingredients: [
          { name: '鸡腿', amount: 150, required: true },
          { name: '菠萝', amount: 80, required: true },
          { name: 'AI-沙姜', amount: 15, required: false },
        ],
        newIngredients: [
          {
            name: 'AI-沙姜',
            category: '蔬果',
            buyUnit: 'g',
            buyFactor: 1,
            isPantry: false,
            kcal: 42,
            protein: 1.1,
            fat: 0.2,
            carb: 8,
            sodium: 3,
            fiber: 0.4,
            price: 1.5,
          },
        ],
      });

    const res = await postDraft({ text: '加个菠萝咕咾肉' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as DraftResponse;
    assert.equal(body.draft.name, 'AI-菠萝咕咾肉');
    assert.equal(body.draft.category, '荤菜');
    assert.equal(body.model, 'deepseek-flash');

    const byName = new Map(body.draft.ingredients.map((row) => [row.name, row]));
    // 库内命中：直接用库里的名字，不带营养（营养以库里的为唯一来源）
    assert.equal(byName.get('鸡腿')?.is_new, false);
    assert.equal(byName.get('鸡腿')?.matched_name, '鸡腿');
    assert.equal(byName.get('鸡腿')?.nutrition, null);
    // 别名归并：模型说「菠萝」，库里叫「凤梨」
    assert.equal(byName.get('凤梨')?.is_new, false);
    assert.equal(byName.get('凤梨')?.matched_name, '凤梨');
    assert.ok(
      body.notes.some((note) => note.includes('菠萝') && note.includes('凤梨')),
      '别名归并要给人一句说明',
    );
    // 库里没有的进新食材，营养照原样留着，并明确提示要复核
    assert.equal(byName.get('AI-沙姜')?.is_new, true);
    assert.equal(byName.get('AI-沙姜')?.matched_name, null);
    assert.equal(byName.get('AI-沙姜')?.nutrition?.kcal, 42);
    assert.ok(
      body.notes.some((note) => note.includes('待复核')),
      'AI 填的营养必须提示复核',
    );

    // 热量预览只算库内已有食材：150g 鸡腿(181) + 80g 凤梨(44) = 306.7 → 307
    assert.equal(body.draft.kcal_per_serving, 307);
    assert.equal(body.draft.nutrition_complete, false, '含新食材时预览不完整');

    // 提示词要满足 DeepSeek JSON Output 的硬要求（含 "json" 字样与输出样例），
    // 并且真的把食材清单注入了上下文——否则「优先复用已有食材」根本无从谈起
    const messages = (lastLlmBody?.messages ?? []) as { role: string; content: string }[];
    assert.equal(lastLlmBody?.model, 'deepseek-flash');
    assert.deepEqual(lastLlmBody?.response_format, { type: 'json_object' });
    assert.match(messages[0]?.content ?? '', /json/i);
    assert.match(messages[1]?.content ?? '', /已有食材清单/);
    assert.match(messages[1]?.content ?? '', /凤梨\(蔬果\)/);
    assert.match(messages[1]?.content ?? '', /加个菠萝咕咾肉/);
  });

  it('别名归并只认整词：「沙姜」不会被并成「生姜」（真实访问踩到的坑）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-沙姜鸡',
        category: '荤菜',
        ingredients: [
          { name: '鸡腿', amount: 180, required: true },
          { name: '沙姜', amount: 15, required: true },
        ],
        newIngredients: [
          { name: '沙姜', category: '蔬果', kcal: 42, protein: 1.1, fat: 0.2, carb: 8, sodium: 3, fiber: 0.4 },
        ],
      });

    const res = await postDraft({ text: '加个小炒肉' });
    assert.equal(res.status, 200);
    const { draft } = (await res.json()) as DraftResponse;
    const shajiang = draft.ingredients.find((row) => row.name === '沙姜');

    // 沙姜与生姜是两种食材：并错了采购清单会买错东西，AI 填的营养也会被丢掉
    assert.ok(shajiang, '「沙姜」必须原样保留，不能变成「生姜」');
    assert.equal(shajiang.is_new, true);
    assert.equal(shajiang.matched_name, null);
    assert.equal(shajiang.nutrition?.kcal, 42);
    assert.equal(
      draft.ingredients.some((row) => row.matched_name === '生姜'),
      false,
      '「沙姜」包含「姜」不等于就是生姜——搜索可以这么联想，身份归并不行',
    );
  });

  it('别名组里有多个候选时按公共前缀取最像的（鸡胸 → 鸡胸肉，而不是鸡翅）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-鸡胸菜',
        category: '荤菜',
        ingredients: [{ name: '鸡胸', amount: 150, required: true }],
      });

    const res = await postDraft({ text: '加个鸡胸菜' });
    assert.equal(res.status, 200);
    const { draft } = (await res.json()) as DraftResponse;
    assert.equal(draft.ingredients[0].matched_name, '鸡胸肉');
  });

  it('模型格式歪一点自动修好：辣度越界、非法分类留空、同名配料合并', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-修整测试菜',
        category: '大菜',
        spicy: 9,
        difficulty: '2',
        minutes: 9999,
        emoji: '',
        ingredients: [
          { name: '鸡腿', amount: 100, required: true },
          { name: '鸡腿', amount: 50, required: false },
        ],
      });

    const res = await postDraft({ text: '加个测试菜' });
    assert.equal(res.status, 200);
    const { draft, notes } = (await res.json()) as DraftResponse;

    assert.equal(draft.spicy, 3, '辣度收到 0~3');
    assert.equal(draft.difficulty, 2, '字符串数字要认下来');
    assert.equal(draft.minutes, 600, '耗时收到上限');
    assert.equal(draft.emoji, '🍽️', 'emoji 缺省回退');
    assert.equal(draft.category, '', '分类给错就留空，让人在卡片上选（不能瞎猜）');
    assert.ok(notes.some((note) => note.includes('分类')));
    assert.equal(draft.ingredients.length, 1, '同名配料要合并成一行');
    assert.equal(draft.ingredients[0].amount, 150, '合并后用量相加');
    assert.equal(draft.ingredients[0].required, true, '合并时必有优先');
  });

  it('连菜名都没有才报 502（换种说法就能成功，与 503 分开）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => draftReply({ category: '荤菜', ingredients: [{ name: '鸡腿', amount: 100 }] });

    const res = await postDraft({ text: '加个没名字的菜' });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'AI_BAD_OUTPUT');
  });

  it('空 content 是 JSON Output 的已知毛病：重试一次能救回来', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    let attempt = 0;
    llmResponder = () => {
      attempt += 1;
      return attempt === 1
        ? llmReply('')
        : draftReply({ name: 'AI-重试菜', category: '素菜', ingredients: [{ name: '鸡腿', amount: 100 }] });
    };

    const res = await postDraft({ text: '加个重试菜' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as DraftResponse).draft.name, 'AI-重试菜');
    assert.equal(attempt, 2);
  });

  it('同名配料合并后超上限要收住：不能让「确认入库」必然 400', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-大用量菜',
        category: '荤菜',
        ingredients: [
          { name: '鸡腿', amount: 3000, required: true },
          { name: '鸡腿', amount: 3000, required: true },
        ],
      });

    const res = await postDraft({ text: '加个大用量菜' });
    assert.equal(res.status, 200);
    const { draft, notes } = (await res.json()) as DraftResponse;
    assert.equal(draft.ingredients.length, 1, '同名配料合并成一行');
    assert.ok(draft.ingredients[0].amount <= 5000, '合并后的用量不能超过服务端上限 5000g');
    assert.ok(notes.some((note) => note.includes('鸡腿')), '收到上限要给一句说明');
  });

  it('新食材的分类超长：按「其他」落草稿并说明，而不是让确认时 400', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-长分类菜',
        category: '荤菜',
        ingredients: [{ name: 'AI-香草', amount: 5, required: false }],
        newIngredients: [
          { name: 'AI-香草', category: '这是一个超过十个字的分类', kcal: 42, protein: 1.1, fat: 0.2, carb: 8, sodium: 3, fiber: 0.4 },
        ],
      });

    const res = await postDraft({ text: '加个长分类菜' });
    assert.equal(res.status, 200);
    const { draft, notes } = (await res.json()) as DraftResponse;
    const row = draft.ingredients.find((item) => item.name === 'AI-香草');
    assert.ok(row);
    assert.equal(row.category, '其他', '超长分类要兜成「其他」，分类在卡片上还能改');
    assert.ok(notes.some((note) => note.includes('AI-香草')), '兜底要给一句说明');
  });

  it('新食材命中《成分表》参考表：营养以表为准（模型给错的数被覆盖），不再挂待复核', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-蚝油生菜',
        category: '素菜',
        ingredients: [
          { name: '生菜', amount: 150, required: true },
          { name: '蚝油', amount: 10, required: true },
        ],
        newIngredients: [
          // 模型故意给离谱的数：参考表命中后应被覆盖成表里的值
          { name: '蚝油', category: '调料', kcal: 999, protein: 99, fat: 99, carb: 99, sodium: 99, fiber: 99 },
        ],
      });

    const res = await postDraft({ text: '加个蚝油生菜' });
    assert.equal(res.status, 200);
    const { draft, notes } = (await res.json()) as DraftResponse;
    const oyster = draft.ingredients.find((row) => row.name === '蚝油');
    assert.ok(oyster, '蚝油应作为新食材出现在草稿里');
    assert.equal(oyster.nutrition?.kcal, 114, '营养被参考表覆盖（蚝油 114 kcal）');
    assert.equal(oyster.nutrition?.sodium, 2600);
    assert.equal((oyster as { nutrition_source?: string }).nutrition_source, 'seed', '命中参考表的行标 seed，不挂待复核');
    assert.ok(
      notes.some((note) => note.includes('蚝油') && note.includes('参考表')),
      '命中要给人一句说明',
    );
    assert.ok(
      !notes.some((note) => note.includes('待复核')),
      '参考表命中的不算「AI 填的」，不该出现待复核提示',
    );
  });

  it('参考表没覆盖的新食材：沿用模型估的数并标待复核（老路不变）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () =>
      draftReply({
        name: 'AI-沙姜鸡二号',
        category: '荤菜',
        ingredients: [{ name: '某某奇香料', amount: 5, required: false }],
        newIngredients: [
          { name: '某某奇香料', category: '调料', kcal: 50, protein: 1, fat: 0.5, carb: 9, sodium: 5, fiber: 1 },
        ],
      });

    const res = await postDraft({ text: '加个奇香料菜' });
    const { draft, notes } = (await res.json()) as DraftResponse;
    const row = draft.ingredients.find((item) => item.name === '某某奇香料');
    assert.ok(row);
    assert.equal(row.nutrition?.kcal, 50, '参考表没有它，模型给的数原样保留');
    assert.ok(notes.some((note) => note.includes('待复核')));
  });

  it('提示词里带上了营养参考表：模型能照抄、服务端还有兜底', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => draftReply({ name: 'AI-任意', category: '荤菜', ingredients: [{ name: '鸡腿', amount: 100 }] });

    await postDraft({ text: '加个任意菜' });
    const messages = (lastLlmBody?.messages ?? []) as { role: string; content: string }[];
    assert.match(messages[1]?.content ?? '', /营养参考表/);
    assert.match(messages[1]?.content ?? '', /蚝油：kcal 114/);
  });

  it('模型服务挂了：503（而不是 500 把栈暴露出去）', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => llmReply(JSON.stringify({ error: { message: 'insufficient balance' } }), 402);

    const res = await postDraft({ text: '加个任意菜' });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'AI_UNAVAILABLE');
    // 上游的错误说明要带出来，否则「余额不足」会被误当成「模型抽风」，排查方向完全错
    assert.match(body.error.message, /insufficient balance/);
  });
});

describe('AI 营养来源标记', () => {
  it('origin=ai 建菜：新食材标 ai（待复核）；缺省 origin 标 manual', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';

    const ai = await postDish({
      origin: 'ai',
      name: 'AI-沙姜鸡',
      category: '荤菜',
      ingredients: [{ name: 'AI-沙姜', amount: 15, required: true }],
      newIngredients: [
        { name: 'AI-沙姜', category: '蔬果', kcal: 42, protein: 1.1, fat: 0.2, carb: 8, sodium: 3, fiber: 0.4 },
      ],
    });
    assert.equal(ai.status, 201);

    const manual = await postDish({
      name: 'AI-手工菜',
      category: '荤菜',
      ingredients: [{ name: 'AI-手工香料', amount: 10, required: true }],
      newIngredients: [
        { name: 'AI-手工香料', category: '调料', kcal: 100, protein: 1, fat: 1, carb: 1, sodium: 1, fiber: 1 },
      ],
    });
    assert.equal(manual.status, 201);

    const aiRow = get<{ nutrition_source: string }>(
      "SELECT nutrition_source FROM ingredients WHERE name = 'AI-沙姜'",
    );
    assert.equal(aiRow?.nutrition_source, 'ai');
    const manualRow = get<{ nutrition_source: string }>(
      "SELECT nutrition_source FROM ingredients WHERE name = 'AI-手工香料'",
    );
    assert.equal(manualRow?.nutrition_source, 'manual');

    // 非法 origin 直接拦下，别让它悄悄落到 manual 上
    const bad = await postDish({
      name: 'AI-坏来源',
      category: '荤菜',
      origin: 'robot',
      ingredients: [{ name: '鸡腿', amount: 10 }],
    });
    assert.equal(bad.status, 400);
  });

  it('复核：ai → manual 生效，且 seed 不能从页面被误设', async () => {
    const row = get<{ id: number }>("SELECT id FROM ingredients WHERE name = 'AI-沙姜'");
    assert.ok(row);

    const reviewed = await fetch(`${base}/api/settings/ingredients/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nutrition_source: 'manual' }),
    });
    assert.equal(reviewed.status, 200);
    assert.equal(
      get<{ nutrition_source: string }>('SELECT nutrition_source FROM ingredients WHERE id = ?', row.id)
        ?.nutrition_source,
      'manual',
    );

    const rejected = await fetch(`${base}/api/settings/ingredients/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nutrition_source: 'seed' }),
    });
    assert.equal(rejected.status, 400);
  });

  it('采购页手工建的食材标 manual，不混进「待复核」', async () => {
    const res = await fetch(`${base}/api/purchase/ingredients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'AI-手写食材', category: '蔬果', is_pantry: false }),
    });
    assert.equal(res.status, 201);
    assert.equal(
      get<{ nutrition_source: string }>("SELECT nutrition_source FROM ingredients WHERE name = 'AI-手写食材'")
        ?.nutrition_source,
      'manual',
    );
  });
});
