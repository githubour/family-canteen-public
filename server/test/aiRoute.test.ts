/**
 * AI 入口分流（POST /api/ai/route）。
 *
 * 首页只剩一个 AI 入口，加菜与登记库存靠这次判断分开。这里测的边界是：
 *   · 只判意图——不产草稿、不碰库；
 *   · 前置校验拦下的请求不消耗模型调用；
 *   · 模型给了个没听过的词时退回 dish，而不是把「一句话加菜」整个拦掉
 *     （两条流程都只产草稿，人在弹层里还能改判）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startTestServer, type TestServer } from './testServer.js';

const realFetch = globalThis.fetch;
let llmResponder: (() => Response) | null = null;
let llmCalls = 0;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.deepseek.com')) return realFetch(input, init);
  llmCalls += 1;
  if (!llmResponder) return Promise.reject(new Error('测试没设置 LLM 响应'));
  return Promise.resolve(llmResponder());
}) as typeof fetch;

/** 造一个 OpenAI 风格的补全响应 */
const llmReply = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const routeReply = (intent: unknown) => llmReply(JSON.stringify({ intent, reason: '测试给的依据' }));

let server: TestServer | undefined;
let base = '';

const postRoute = (body: unknown) =>
  fetch(`${base}/api/ai/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface RouteResponse {
  intent: 'dish' | 'fridge';
  reason: string;
  model: string;
}

before(async () => {
  server = await startTestServer();
  base = server.base;
});

after(() => {
  server?.close();
  server = undefined;
  globalThis.fetch = realFetch;
});

describe('AI 入口分流（POST /api/ai/route）', () => {
  it('没配 key 时整体关闭：503 AI_UNAVAILABLE', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const res = await postRoute({ text: '加个小炒肉' });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'AI_UNAVAILABLE');
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = saved;
    }
  });

  it('空描述 / 超长 / 非字符串直接 400，不会白白调用一次模型', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const before = llmCalls;

    assert.equal((await postRoute({ text: '   ' })).status, 400);
    assert.equal((await postRoute({ text: 'x'.repeat(201) })).status, 400);
    assert.equal((await postRoute({ text: 123 })).status, 400);

    assert.equal(llmCalls, before, '前置校验拦下的请求不该打到模型');
  });

  it('说冰箱里有什么 → fridge；说要加菜 → dish', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';

    llmResponder = () => routeReply('fridge');
    const fridge = (await (await postRoute({ text: '我有西红柿、土豆、鸡蛋' })).json()) as RouteResponse;
    assert.equal(fridge.intent, 'fridge');
    assert.equal(fridge.reason, '测试给的依据');

    llmResponder = () => routeReply('dish');
    const dish = (await (await postRoute({ text: '加个小炒肉' })).json()) as RouteResponse;
    assert.equal(dish.intent, 'dish');
  });

  it('模型给了没听过的意图就退回 dish，不把入口拦死', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => routeReply('cook');

    const res = await postRoute({ text: '随便说点什么' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as RouteResponse).intent, 'dish');
  });

  it('只判意图：库里不会因为分流多出任何东西', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    llmResponder = () => routeReply('dish');

    const before = ((await (await fetch(`${base}/api/dishes`)).json()) as { dishes: unknown[] }).dishes.length;
    await postRoute({ text: '加个小炒肉' });
    const after = ((await (await fetch(`${base}/api/dishes`)).json()) as { dishes: unknown[] }).dishes.length;
    assert.equal(after, before);
  });
});
