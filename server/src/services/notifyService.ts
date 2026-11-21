/**
 * 手机推送通知：只调用统一推送网关（NAS 上 push-gateway）。
 *
 * 网关内部负责 PushPlus 的 topic/to 参数、限流、内容去重与上游重试；本层只做三件事：
 *  1. 带上 source=family-canteen，让网关按来源路由进群组；
 *  2. 按「订单号 + 事件」去重，同一订单的同类提醒只发一次；
 *  3. 把发送结果（含失败原因）落到 notify_outbox，设置页可见。
 *
 * 约束：推送失败绝不能影响下单 / 顺延主流程，所以全程不外抛；也不再回落到
 * Bark / ServerChan（2026-11 已按需求移除，只保留网关这一条通道）。
 */
import { get, run } from '../db/index.js';
import { readSetting } from './settingsService.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('notify');
/** 网关在本机/网桥；最坏情况是网关内部 3 次 × 10s 超时 + 退避（约 33s），留到 35s 再判失败 */
const GATEWAY_TIMEOUT_MS = 35_000;
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8655/notify';
const SOURCE = 'family-canteen';

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface OrderNotification {
  title: string;
  body: string;
  /** 订单号：用于去重与 outbox 追溯；没有订单号的消息按一次性事件处理 */
  orderId?: number;
  /** 事件类型（created / deferred …），与订单号一起构成去重键 */
  kind?: string;
  level?: NotifyLevel;
}

export interface GatewayPayload {
  title: string;
  content: string;
  level: NotifyLevel;
  source: string;
  /** 显式去重键：避免「同菜品同餐次」的两张不同订单被网关的正文哈希吞掉 */
  dedupe_key?: string;
}

/** 去重键：同一订单的同一事件只提醒一次 */
export function buildDedupeKey(orderId: number, kind: string): string {
  return `${orderId}:${kind}`;
}

/** 网关契约：{title, content, level, source, dedupe_key?}；不含 topic/to，目标由网关按 source 映射决定 */
export function buildGatewayPayload(message: OrderNotification): GatewayPayload {
  const payload: GatewayPayload = {
    title: message.title,
    content: message.body,
    level: message.level ?? 'info',
    source: SOURCE,
  };
  if (message.orderId) {
    payload.dedupe_key = buildDedupeKey(message.orderId, message.kind ?? 'event');
  }
  return payload;
}

function gatewayUrl(): string {
  const raw = (process.env.PUSH_GATEWAY_URL ?? '').trim();
  return raw || DEFAULT_GATEWAY_URL;
}

interface GatewayResult {
  ok: boolean;
  shortCode?: string;
  error?: string;
}

/** 发到网关；网络错误、超时、非 2xx 与 ok:false 一律按失败返回，不抛出 */
async function postToGateway(payload: GatewayPayload): Promise<GatewayResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const response = await fetch(gatewayUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: { ok?: unknown; shortCode?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // 非 JSON 响应按失败处理，原文截断进 last_error
    }
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${text.slice(0, 200)}`.trim() };
    }
    if (body.ok !== true) {
      return { ok: false, error: `网关返回未成功：${text.slice(0, 200)}` };
    }
    return { ok: true, shortCode: typeof body.shortCode === 'string' ? body.shortCode : undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `请求网关失败：${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 写一条 pending 记录并占住去重键。
 * 返回 null 表示同键已存在（之前已处理过），调用方直接跳过。
 */
function beginAttempt(message: OrderNotification): number | null {
  const kind = message.kind ?? 'event';
  const dedupeKey = message.orderId
    ? buildDedupeKey(message.orderId, kind)
    : `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const result = run(
    `INSERT OR IGNORE INTO notify_outbox (dedupe_key, order_id, kind, title, body)
     VALUES (?, ?, ?, ?, ?)`,
    dedupeKey,
    message.orderId ?? null,
    kind,
    message.title,
    message.body,
  );
  if (result.changes === 0) {
    const existing = get<{ status: string }>(
      'SELECT status FROM notify_outbox WHERE dedupe_key = ?',
      dedupeKey,
    );
    log.info(`订单 #${message.orderId ?? '-'} 的 ${kind} 通知已处理过（${existing?.status ?? 'unknown'}），跳过`);
    return null;
  }
  return result.lastInsertRowid;
}

function finishAttempt(id: number, result: GatewayResult): void {
  if (result.ok) {
    run(
      `UPDATE notify_outbox
          SET status = 'sent', channel = 'gateway', short_code = ?,
              attempts = attempts + 1, last_error = NULL,
              updated_at = datetime('now','localtime')
        WHERE id = ?`,
      result.shortCode ?? null,
      id,
    );
    log.info(`推送已发送（outbox #${id}${result.shortCode ? `，shortCode=${result.shortCode}` : ''}）`);
    return;
  }
  run(
    `UPDATE notify_outbox
        SET status = 'failed', channel = 'gateway', attempts = attempts + 1,
            last_error = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    result.error ?? '未知错误',
    id,
  );
  log.error(`推送失败，已记入 outbox #${id}：${result.error ?? '未知错误'}`);
}

/** 触发通知；未开启或已处理过同一订单事件时直接跳过。本函数不会向调用方抛错 */
export async function sendNotification(message: OrderNotification): Promise<void> {
  try {
    if (readSetting('notify.enabled').trim() !== 'true') return;

    const id = beginAttempt(message);
    if (id === null) return;

    const result = await postToGateway(buildGatewayPayload(message));
    finishAttempt(id, result);
  } catch (error) {
    // 数据库不可用等极端情况也只记日志：通知不是主流程的一部分
    log.error('推送处理异常（已忽略，不影响业务流程）', error);
  }
}
