import { useEffect, useRef } from 'react';
import { SSE_CLIENT_EVENTS, type SseEventType } from '../../../shared/types';

type SseHandlers = Partial<Record<SseEventType, (payload: Record<string, unknown>) => void>>;

type HandlersRef = { current: SseHandlers };

/**
 * 全局唯一一条 EventSource：所有 useServerEvents 通过订阅注册表挂在同一连接上。
 * 此前每个组件各开一条（App 常驻 + 当前页面 = 每标签页两条），而浏览器对同源长连接
 * 有额度（HTTP/1.1 下 6 条、跨标签页共享），多开标签页会把普通请求的连接挤掉。
 */
const subscribers = new Set<HandlersRef>();
let source: EventSource | null = null;

/**
 * 重连回调：断线期间发生的事件是收不到的，重连后必须让页面主动补拉一次，
 * 否则会一直停在旧数据上直到手动刷新。首次连接不算「重连」，不触发。
 */
const reconnectListeners = new Set<() => void>();
let connectedOnce = false;

export function subscribeSseReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}

function dispatch(type: SseEventType, event: MessageEvent<string>): void {
  if (subscribers.size === 0) return;
  let payload: Record<string, unknown> = {};
  if (event.data) {
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      console.warn(`[sse] ${type} 事件不是合法 JSON，已忽略`);
      return;
    }
  }
  for (const ref of subscribers) ref.current[type]?.(payload);
}

function ensureSource(): void {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  for (const type of SSE_CLIENT_EVENTS) {
    source.addEventListener(type, (event) => dispatch(type, event as MessageEvent<string>));
  }
  source.onopen = () => {
    if (!connectedOnce) {
      connectedOnce = true;
      return;
    }
    // 重连成功：补给断线期间漏掉的事件
    for (const listener of reconnectListeners) listener();
  };
  source.onerror = () => {
    // 浏览器会自动重连，这里只保留日志便于排查 Tailscale 断链
    console.warn('[sse] 连接中断，等待自动重连');
  };
}

/** 最后一个订阅者离开时关掉连接；下次有人订阅再懒建 */
function releaseIfIdle(): void {
  if (subscribers.size > 0 || !source) return;
  source.close();
  source = null;
}

/**
 * 订阅服务端 SSE 事件：注册进共享连接，按事件类型分发；断线由浏览器自动重连。
 * handlers 用 ref 保存，调用方每次渲染重建 handlers 对象不影响连接。
 */
export function useServerEvents(handlers: SseHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    subscribers.add(handlersRef);
    ensureSource();
    return () => {
      subscribers.delete(handlersRef);
      releaseIfIdle();
    };
  }, []);
}
