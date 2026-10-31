/**
 * 设置 PATCH 的原子性：
 * 合法键 + 非法键混提时必须整体拒绝——不能出现「接口 400，但前面的键已经写进库」，
 * 否则前端提示保存失败、其它设备也没有收到 settings:updated，数据却已经变了。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

let server: TestServer | undefined;
let base = '';

function readStored(key: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

before(async () => {
  server = await startTestServer();
  base = server.base;
});

after(() => server?.close());

describe('设置 PATCH 原子性', () => {
  it('合法截单时间 + 非法人数 → 400，且一个键都不落库', async () => {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('cutoff.dinner');
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('default.headcount');

    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'cutoff.dinner': '17:00', 'default.headcount': 'abc' }),
    });
    assert.equal(response.status, 400);
    // 两行都应该保持「没写过」的状态；读取端仍会回默认值
    assert.equal(readStored('cutoff.dinner'), '');
    assert.equal(readStored('default.headcount'), '');

    const settings = (await (await fetch(`${base}/api/settings`)).json()) as {
      settings: Record<string, string>;
    };
    assert.equal(settings.settings['cutoff.dinner'], '16:30');
    assert.equal(settings.settings['default.headcount'], '3');
  });

  it('全部合法时一次事务写入，并返回更新键', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'cutoff.dinner': '17:00', 'default.headcount': '4' }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { updated: string[] };
    assert.deepEqual(body.updated.sort(), ['cutoff.dinner', 'default.headcount']);
    assert.equal(readStored('cutoff.dinner'), '17:00');
    assert.equal(readStored('default.headcount'), '4');
  });

  it('人数上限与共享常量一致（20），越界 400', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'default.headcount': '21' }),
    });
    assert.equal(response.status, 400);
    assert.equal(readStored('default.headcount'), '4');
  });
});
