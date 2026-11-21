/**
 * AI 起草路由。
 *
 * 六个端点，**没有一个写库**：
 *   GET  /api/ai/status                 配没配 key、用哪个模型——前端据此决定要不要露出 AI 入口；
 *   POST /api/ai/route                  一句话 → 意图（dish / fridge / ingredient），决定开哪个草稿面板；
 *   POST /api/ai/draft                  一句话 → 菜品草稿（确认后走 POST /api/dishes）；
 *   POST /api/ai/fridge-draft           一句话 → 库存草稿（确认后走 POST /api/fridge-stock/batch）；
 *   POST /api/ai/ingredient-draft       一句话 → 删除食材草稿（确认后走 DELETE /api/purchase/ingredients/:id）；
 *   POST /api/ai/dish-revision-draft    { dishId } → 改菜草稿（确认后走 PATCH + PUT /api/dishes/:id）。
 *
 * 为什么不在这里顺手提供「确认」端点：写入路径只能有一条。让前端把草稿交给既有的写入接口，
 * AI 起草与手工操作就共享同一套校验、同一事务与同一套 SSE 广播，
 * 这里也就永远不需要维护第二份写入逻辑。
 */
import { Router } from 'express';
import { badRequest } from '../lib/errors.js';
import { createIpRateLimit } from '../lib/rateLimit.js';
import {
  aiStatus,
  draftDishFromText,
  draftDishRevision,
  draftFridgeFromText,
  draftIngredientDelete,
  routeAiText,
} from '../services/aiService.js';

export const aiRouter = Router();

/**
 * 最薄的 AI 调用限流：单进程内存计数，20 次/分钟/来源。
 * 服务本身跑在内网，这里只解决“别把模型额度打爆”；
 * 家里正常使用远低于该阈值，超限只需等一分钟。
 *
 * 桶与语音转写共用（见 lib/rateLimit.ts）：两条接口合计 20 次/分钟。
 */
aiRouter.use(
  createIpRateLimit({
    code: 'AI_RATE_LIMITED',
    message: (retryAfter) => `AI 操作太频繁，请 ${retryAfter} 秒后再试`,
  }),
);

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

/** 删除食材也只产草稿：能不能删由服务端查引用判定，确认后仍走既有的 DELETE 接口 */
aiRouter.post('/ingredient-draft', async (req, res, next) => {
  try {
    res.json(await draftIngredientDelete(readText(req)));
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
