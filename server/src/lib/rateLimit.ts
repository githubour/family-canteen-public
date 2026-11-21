/**
 * 按来源 IP 的固定窗口限流（单进程内存计数）。
 *
 * 只解决「别把模型 / 语音额度打爆」，不是安全边界：家里正常使用远低于阈值。
 * 桶表刻意放在模块级共享：AI 与语音两条路由要合计 20 次/分钟，
 * 各建一张表就会变成各算各的 20 次。
 */
import type { NextFunction, Request, Response } from 'express';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

const buckets = new Map<string, { startedAt: number; count: number }>();

export interface RateLimitCopy {
  /** 业务码，前端可据此区分是哪条接口被限 */
  code: string;
  /** retryAfter 是建议等待的秒数 */
  message: (retryAfter: number) => string;
}

/** 只拦 POST；GET /status 之类的读接口不走计数 */
export function createIpRateLimit(copy: RateLimitCopy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
      // 窗口过期即回收：Map 按来源 IP 建键，TRUST_PROXY=1 时 X-Forwarded-For 可伪造，
      // 不清理会让长驻进程随请求量单调增长。
      for (const [oldKey, oldBucket] of buckets) {
        if (now - oldBucket.startedAt >= WINDOW_MS) buckets.delete(oldKey);
      }
      buckets.set(key, { startedAt: now, count: 1 });
      next();
      return;
    }
    if (bucket.count >= MAX_PER_WINDOW) {
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.startedAt)) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: { code: copy.code, message: copy.message(retryAfter) },
      });
      return;
    }
    bucket.count += 1;
    next();
  };
}
