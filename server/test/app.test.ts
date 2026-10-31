/**
 * HTTP 冒烟测试（同时是 Express 5 迁移的回归测试）：
 * 健康检查、/api 404 JSON、SPA fallback（原通配路由）、uploads 强缓存头、
 * JSON 体积限制（全局 1mb 与实拍图路由的 10mb 豁免）与 4xx 错误映射。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { TEMP_DIR } from './setup.js';
import { join } from 'node:path';
import { get, run } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

describe('createApp（Express 5）', () => {
  // uploads 目录跟数据库走（<db 目录>/uploads），放一张真文件测强缓存头
  mkdirSync(join(TEMP_DIR, 'uploads'), { recursive: true });
  writeFileSync(join(TEMP_DIR, 'uploads', 'ping.png'), 'png');

  let current: TestServer | undefined;
  let base = '';

  afterEach(() => {
    current?.close();
    current = undefined;
  });

  async function start(): Promise<string> {
    current = await startTestServer();
    return current.base;
  }

  it('GET /api/health → 200 且声明已挂载前端', async () => {
    base = await start();
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; web: boolean; build: { commit: string } };
    assert.equal(body.ok, true);
    assert.equal(body.web, true);
    assert.ok(typeof body.build.commit === 'string');
  });

  it('GET /api/orders/recent → 200，空库返回空数组', async () => {
    base = await start();
    const res = await fetch(`${base}/api/orders/recent?limit=5`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { orders: unknown[] };
    assert.ok(Array.isArray(body.orders));
    assert.equal(body.orders.length, 0);
  });

  it('GET /api/none → 404 JSON（不是 SPA 的 HTML）', async () => {
    base = await start();
    const res = await fetch(`${base}/api/none`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.match(res.headers.get('content-type') ?? '', /json/);
  });

  it('GET /orders/abc → SPA fallback 回 index.html（原 app.get("*") 场景）', async () => {
    base = await start();
    const res = await fetch(`${base}/orders/abc`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /mealtime-test/);
    assert.match(res.headers.get('content-type') ?? '', /html/);
  });

  it('GET /uploads/ping.png → 200 且带一年 immutable 强缓存头', async () => {
    base = await start();
    const res = await fetch(`${base}/uploads/ping.png`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=31536000/);
  });

  it('GET /uploads/nope.png → 404（不吃 SPA fallback 回 200 的 HTML）', async () => {
    base = await start();
    const res = await fetch(`${base}/uploads/nope.png`);
    assert.equal(res.status, 404);
  });

  it('POST 超过全局 1mb 的 JSON → 413（body-parser 错误按 4xx 回，不是 500）', async () => {
    base = await start();
    const res = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(1.5 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'BAD_REQUEST');
  });

  it('菜品实拍图：>1mb（全局）但 ≤10mb（路由级）的请求能通过——豁免真实生效', async () => {
    base = await start();
    run(`INSERT INTO dishes (name, emoji, category, active) VALUES ('图测试菜', '🍲', '荤菜', 1)`);
    const dish = get<{ id: number }>('SELECT id FROM dishes WHERE name = ?', '图测试菜');
    assert.ok(dish);

    // 1.2MB 图 → base64 后约 1.6MB，超过全局 1mb；解码后 ≤ 路由的 3MB 护栏
    const imageBuffer = Buffer.alloc(1.2 * 1024 * 1024, 7);
    imageBuffer[0] = 0xff;
    imageBuffer[1] = 0xd8;
    imageBuffer[2] = 0xff;
    const image = imageBuffer.toString('base64');
    const res = await fetch(`${base}/api/dishes/${dish.id}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: `data:image/jpeg;base64,${image}` }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dish: { image_url: string } };
    assert.match(body.dish.image_url, /^\/uploads\/dishes\//);
  });

  it('菜品实拍图：内容与 MIME 不符 → 400，不落盘', async () => {
    base = await start();
    const dish = get<{ id: number }>('SELECT id FROM dishes WHERE name = ?', '图测试菜');
    assert.ok(dish);
    const fake = Buffer.from('this is not a png').toString('base64');
    const res = await fetch(`${base}/api/dishes/${dish.id}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: `data:image/png;base64,${fake}` }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'BAD_REQUEST');
  });
});
