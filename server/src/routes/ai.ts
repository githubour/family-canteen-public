/**
 * AI 起草路由。
 *
 * 五个端点，**没有一个写库**：
 *   GET  /api/ai/status                 配没配 key、用哪个模型——前端据此决定要不要露出 AI 入口；
 *   POST /api/ai/route                  一句话 → 意图（dish / fridge），决定开哪个草稿面板；
 *   POST /api/ai/draft                  一句话 → 菜品草稿（确认后走 POST /api/dishes）；
 *   POST /api/ai/fridge-draft           一句话 → 库存草稿（确认后走 POST /api/fridge-stock/batch）；
 *   POST /api/ai/dish-revision-draft    { dishId } → 改菜草稿（确认后走 PATCH + PUT /api/dishes/:id）。
 *
 * 为什么不在这里顺手提供「确认」端点：写入路径只能有一条。让前端把草稿交给既有的写入接口，
 * AI 起草与手工操作就共享同一套校验、同一事务与同一套 SSE 广播，
 * 这里也就永远不需要维护第二份写入逻辑。
 */
import { Router } from 'express';
import { badRequest } from '../lib/errors.js';
import {
  aiStatus,
  draftDishFromText,
  draftDishRevision,
  draftFridgeFromText,
  routeAiText,
} from '../services/aiService.js';

export const aiRouter = Router();

/**
 * 最薄的 AI 调用限流：单进程内存计数，20 次/分钟/来源。
 * 服务本身跑在内网，这里只解决“别把模型额度打爆”；
 * 家里正常使用远低于该阈值，超限只需等一分钟。
 */
const AI_WINDOW_MS = 60_000;
const AI_MAX_PER_WINDOW = 20;
const aiBuckets = new Map<string, { startedAt: number; count: number }>();

aiRouter.use((req, res, next) => {
  if (req.method !== 'POST') {
    next();
    return;
  }
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const bucket = aiBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= AI_WINDOW_MS) {
    aiBuckets.set(key, { startedAt: now, count: 1 });
    next();
    return;
  }
  if (bucket.count >= AI_MAX_PER_WINDOW) {
    const retryAfter = Math.max(1, Math.ceil((AI_WINDOW_MS - (now - bucket.startedAt)) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: { code: 'AI_RATE_LIMITED', message: `AI 操作太频繁，请 ${retryAfter} 秒后再试` },
    });
    return;
  }
  bucket.count += 1;
  next();
});

/** 取 body.text：不是字符串就交给下面的校验去报错，route 保持薄 */
function readText(req: { body?: unknown }): string {
  const text = (req.body as { text?: unknown })?.text;
  return typeof text === 'string' ? text : '';
}

aiRouter.get('/status', (_req, res) => {
  res.json(aiStatus());
});

/** 只判意图，不产草稿：前端拿到 intent 后再调对应的 draft 端点 */
aiRouter.post('/route', async (req, res, next) => {
  try {
    res.json(await routeAiText(readText(req)));
  } catch (error) {
    next(error);
  }
});

aiRouter.post('/draft', async (req, res, next) => {
  try {
    res.json(await draftDishFromText(readText(req)));
  } catch (error) {
    next(error);
  }
});

aiRouter.post('/fridge-draft', async (req, res, next) => {
  try {
    res.json(await draftFridgeFromText(readText(req)));
  } catch (error) {
    next(error);
  }
});

/** 一句话 → 改菜草稿不需要 text：读的是这道菜的现状 + 它攒着的反馈 */
aiRouter.post('/dish-revision-draft', async (req, res, next) => {
  try {
    const dishId = Number((req.body as { dishId?: unknown })?.dishId);
    if (!Number.isInteger(dishId) || dishId <= 0) throw badRequest('dishId 要传一个正整数的菜品 id');
    res.json(await draftDishRevision(dishId));
  } catch (error) {
    next(error);
  }
});
