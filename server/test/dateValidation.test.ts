/**
 * 读接口的日期边界：形如 2026-13-99 的值以前会穿过正则，
 * 营养服务 new Date() 直接 500（Invalid time value）。
 * 现在统一走 isValidISODate：读接口 400，不再静默回落到今天。
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

const BAD_DATE = '2026-13-99';

describe('日期参数校验', () => {
  const paths = [
    `/api/orders?date=${BAD_DATE}`,
    `/api/orders/summary?date=${BAD_DATE}`,
    `/api/nutrition?date=${BAD_DATE}`,
    `/api/purchase?date=${BAD_DATE}&mealType=day`,
  ];

  for (const path of paths) {
    it(`${path} → 400，而不是 500/静默回落`, async () => {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      assert.equal(body.error?.code, 'BAD_REQUEST');
      assert.match(body.error?.message ?? '', /YYYY-MM-DD/);
    });
  }

  it('合法的未来日期仍然正常（不误伤）', async () => {
    const response = await fetch(`${base}/api/orders?date=2026-10-31`);
    assert.equal(response.status, 200);
  });
});
