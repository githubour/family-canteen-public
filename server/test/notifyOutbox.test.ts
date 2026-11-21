/**
 * 推送网关对接（2026-11）：
 * - 请求体只带 source=family-canteen，不带 topic/to（目标由网关按来源映射决定）；
 * - 同一订单的同一事件只发一次（订单号去重）；
 * - 网关失败时不抛错、不回落其它通道，而是落 notify_outbox(status=failed) 供设置页展示。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import {
  buildDedupeKey,
  buildGatewayPayload,
  sendNotification,
} from '../src/services/notifyService.js';

interface GatewayCall {
  title: string;
  content: string;
  level: string;
  source: string;
  dedupe_key?: string;
}

let gateway: Server;
let gatewayUrl = '';
const calls: GatewayCall[] = [];

before(async () => {
  gateway = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      calls.push(JSON.parse(raw) as GatewayCall);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deduped: false, attempts: 1, shortCode: 'selftest-1' }));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');
  gatewayUrl = `http://127.0.0.1:${address.port}/notify`;
  process.env.PUSH_GATEWAY_URL = gatewayUrl;

  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('notify.enabled', 'true')")
    .run();
});

after(() => {
  gateway.close();
  delete process.env.PUSH_GATEWAY_URL;
});

beforeEach(() => {
  calls.length = 0;
  process.env.PUSH_GATEWAY_URL = gatewayUrl;
});

function outboxRows(orderId: number): Array<{ status: string; short_code: string | null; last_error: string | null }> {
  return getDb()
    .prepare('SELECT status, short_code, last_error FROM notify_outbox WHERE order_id = ?')
    .all(orderId) as Array<{ status: string; short_code: string | null; last_error: string | null }>;
}

describe('网关请求体', () => {
  it('只带 source=family-canteen 与标题/正文/级别，不混入 topic/to', () => {
    const payload = buildGatewayPayload({
      title: '成员一 点了午餐',
      body: '🍚 米饭 × 2',
      orderId: 1,
      kind: 'created',
    });
    assert.deepEqual(payload, {
      title: '成员一 点了午餐',
      content: '🍚 米饭 × 2',
      level: 'info',
      source: 'family-canteen',
      dedupe_key: '1:created',
    });
    assert.ok(!('topic' in payload));
    assert.ok(!('to' in payload));
  });

  it('去重键 = 订单号:事件', () => {
    assert.equal(buildDedupeKey(42, 'created'), '42:created');
    assert.notEqual(buildDedupeKey(42, 'created'), buildDedupeKey(42, 'deferred'));
  });
});

describe('发送与去重', () => {
  it('成功发送：记录 sent 与 shortCode', async () => {
    await sendNotification({
      orderId: 9001,
      kind: 'created',
      title: '测试订单 9001',
      body: '一条测试推送',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, 'family-canteen');
    assert.equal(calls[0].dedupe_key, '9001:created');
    const rows = outboxRows(9001);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].short_code, 'selftest-1');
    assert.equal(rows[0].last_error, null);
  });

  it('同一订单同一事件再次触发：不重复请求网关、不新增记录', async () => {
    await sendNotification({
      orderId: 9001,
      kind: 'created',
      title: '测试订单 9001',
      body: '一条测试推送',
    });

    assert.equal(calls.length, 0);
    assert.equal(outboxRows(9001).length, 1);
  });

  it('网关不可达：不抛错，落 failed 并保留错误原因', async () => {
    process.env.PUSH_GATEWAY_URL = 'http://127.0.0.1:1/notify';
    await sendNotification({
      orderId: 9002,
      kind: 'created',
      title: '测试订单 9002',
      body: '网关不可达',
    });

    const rows = outboxRows(9002);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.ok(rows[0].last_error && rows[0].last_error.length > 0);
  });
});
