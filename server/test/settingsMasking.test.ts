/**
 * 设置接口的敏感键脱敏（2026-10-20 安全修复）：
 * Bark / ServerChan 的 key 是长期推送凭据，GET /api/settings 只回掩码占位；
 * PATCH 收到掩码串 = 「保持不变」（跳过不写），传新值 = 覆盖，传空串 = 显式清除。
 * 用例把这些语义钉住，防止将来改设置路由时把真实 key 又回显出去。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';
import { SETTING_MASK } from '../src/types.js';

let server: TestServer | undefined;
let base = '';

function readStoredKey(key: string): string {
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

describe('设置敏感键脱敏', () => {
  it('GET：已配置的推送 key 只回掩码，未配置回空串', async () => {
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('notify.barkKey', 'aBcDeFgH123456');
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('notify.serverchanKey', '');

    const response = await fetch(`${base}/api/settings`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { settings: Record<string, string> };
    assert.equal(body.settings['notify.barkKey'], SETTING_MASK);
    assert.equal(body.settings['notify.serverchanKey'], '');
    // 非敏感键不受影响
    assert.ok(Object.keys(body.settings).includes('cutoff.breakfast'));
  });

  it('PATCH：掩码串 = 跳过不写（与其他键混提时 key 保持原值）', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'notify.barkKey': SETTING_MASK, 'cutoff.lunch': '11:00' }),
    });
    assert.equal(response.status, 200);
    // 掩码被当作「保持不变」跳过，库里 key 原封不动；同请求的其它键正常生效
    assert.equal(readStoredKey('notify.barkKey'), 'aBcDeFgH123456');
    assert.equal(readStoredKey('cutoff.lunch'), '11:00');
  });

  it('PATCH：只传掩码串（无可更新键）→ 400「没有可更新的设置项」', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'notify.barkKey': SETTING_MASK }),
    });
    assert.equal(response.status, 400);
    assert.equal(readStoredKey('notify.barkKey'), 'aBcDeFgH123456');
  });

  it('PATCH：传新值 = 覆盖，且响应里仍只回掩码', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'notify.barkKey': 'NewKey987654321' }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { settings: Record<string, string> };
    assert.equal(body.settings['notify.barkKey'], SETTING_MASK);
    assert.equal(readStoredKey('notify.barkKey'), 'NewKey987654321');
  });

  it('PATCH：传空串 = 显式清除（未配置后 GET 回空串）', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'notify.barkKey': '' }),
    });
    assert.equal(response.status, 200);
    assert.equal(readStoredKey('notify.barkKey'), '');

    const check = await fetch(`${base}/api/settings`);
    const body = (await check.json()) as { settings: Record<string, string> };
    assert.equal(body.settings['notify.barkKey'], '');
  });
});
