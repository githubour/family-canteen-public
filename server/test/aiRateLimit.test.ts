/**
 * AI 调用限流：单进程 20 次/分钟/来源。
 * 这里只验证门闩本身，不依赖模型 key（无 key 时业务层会回 503，限流仍应在第 21 次先拦）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startTestServer, type TestServer } from './testServer.js';

let server: TestServer | undefined;
let base = '';

before(async () => {
  server = await startTestServer();
  base = server.base;
});

after(() => server?.close());

describe('AI 调用限流', () => {
  it('同一来源 1 分钟内第 21 次 POST → 429 + Retry-After', async () => {
    for (let i = 0; i < 20; i += 1) {
      const response = await fetch(`${base}/api/ai/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '加个番茄炒蛋' }),
      });
      // 未配置 DEEPSEEK_API_KEY 时是 503；限流层在最前面，不应是 429。
      assert.notEqual(response.status, 429);
    }
    const limited = await fetch(`${base}/api/ai/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '再加一个' }),
    });
    assert.equal(limited.status, 429);
    const body = (await limited.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'AI_RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});
