/**
 * SSE 事件总线。
 * 路由层只调用 broadcast(type, payload)，不直接维护连接集合。
 * 心跳用于防止 Tailscale / 反向代理在空闲时掐断长连接。
 */
import type { Response } from 'express';
import type { SseEventType } from '../../../shared/types.js';
import { createLogger } from './logger.js';

const log = createLogger('sse');

const clients = new Set<Response>();
const HEARTBEAT_MS = 25_000;

export function addClient(res: Response): void {
  clients.add(res);
  log.debug(`新连接接入，当前 ${clients.size} 个`);
}

export function removeClient(res: Response): void {
  const removed = clients.delete(res);
  if (removed) log.debug(`连接断开，当前 ${clients.size} 个`);
}

/** 向所有在线客户端广播一条事件 */
export function broadcast(type: SseEventType, payload: unknown = {}): void {
  if (clients.size === 0) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch (error) {
      clients.delete(res);
      log.error('广播失败，已移除该连接', error);
    }
  }
}

/** 启动心跳，返回停止函数 */
export function startHeartbeat(): () => void {
  const timer = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function clientCount(): number {
  return clients.size;
}
