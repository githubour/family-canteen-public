/**
 * 采购改量入口的边界：
 * day 口径早就拒绝 <=0，但单餐口径曾经把 -5 原样落库（页面显示“约 -5g”），
 * "abc" 则返回 200 却什么都没改。两者都属于「接口说成功、结果是错的」。
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

async function patchState(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/purchase/state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('采购状态写入校验', () => {
  const baseBody = { mealDate: '2026-10-31', mealType: 'lunch', ingredientId: 1 };

  for (const bad of [-5, 0, 'abc', 'Infinity', 100_001]) {
    it(`overrideAmount=${JSON.stringify(bad)} → 400`, async () => {
      const response = await patchState({ ...baseBody, overrideAmount: bad });
      assert.equal(response.status, 400);
    });
  }

  it('非法 mealDate → 400', async () => {
    const response = await patchState({ ...baseBody, mealDate: '2026-13-99', overrideAmount: 100 });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? '', /YYYY-MM-DD/);
  });

  it('非法 ingredientId（0/空/负数）→ 400', async () => {
    for (const id of [0, '', -1, 'abc']) {
      const response = await patchState({ ...baseBody, ingredientId: id, overrideAmount: 100 });
      assert.equal(response.status, 400);
    }
  });
});
