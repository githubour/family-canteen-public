/**
 * Express 实例装配：中间件、API 路由、SPA 静态托管与统一错误处理。
 * 顺序很重要 —— API 在前、静态资源在后、SPA fallback 与错误处理收尾。
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_INFO } from './lib/buildInfo.js';
import { ApiError } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { REPO_ROOT, resolveFromServerRoot } from './lib/paths.js';
import { uploadsDir } from './db/index.js';
import { aiRouter } from './routes/ai.js';
import { analyticsRouter } from './routes/analytics.js';
import { dishRequestsRouter } from './routes/dishRequests.js';
import { dishFeedbackRouter } from './routes/dishFeedback.js';
import { fridgeStockRouter } from './routes/fridgeStock.js';
import { DISH_PHOTO_ROUTE_PATTERN, dishesRouter } from './routes/dishes.js';
import { eventsRouter } from './routes/events.js';
import { membersRouter } from './routes/members.js';
import { nutritionRouter } from './routes/nutrition.js';
import { ordersRouter } from './routes/orders.js';
import { purchaseRouter } from './routes/purchase.js';
import { settingsRouter } from './routes/settings.js';

const log = createLogger('http');

/** 从中间件错误里读 HTTP 状态：body-parser 走 http-errors，会带 status / statusCode */
function readErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // 反向代理（tailscale serve / nginx 等）部署时设 TRUST_PROXY=1（信任的代理跳数）：
  // 否则 Express 会把代理 IP 当客户端 IP，AI 接口的按 IP 限流会把一家人算成同一个来源。
  // 只在确有反代时开启：直连暴露时开启会允许伪造 XFF 绕过 per-IP 限流。
  const trustProxyRaw = (process.env.TRUST_PROXY ?? '').trim();
  if (trustProxyRaw !== '') {
    const hops = trustProxyRaw === 'true' ? 1 : Number(trustProxyRaw);
    if (Number.isInteger(hops) && hops > 0) {
      app.set('trust proxy', hops);
    } else {
      log.warn(`TRUST_PROXY=${trustProxyRaw} 不是正整数，已忽略（示例：TRUST_PROXY=1）`);
    }
  }
  // 全局 JSON 限制 1mb。唯一例外是菜品实拍图上传（路由级放宽到 10mb，见 routes/dishes.ts）：
  // body-parser 对已被消费过的请求体会直接跳过，所以这里必须先豁免这条路径——
  // 否则全局 1mb 解析器总是抢先，路由级那把「更宽的锁」永远轮不到生效。
  const parseJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => {
    if (req.method === 'POST' && DISH_PHOTO_ROUTE_PATTERN.test(req.path)) {
      next();
      return;
    }
    parseJson(req, res, next);
  });

  app.use((req, _res, next) => {
    if (req.path.startsWith('/api') && req.method !== 'GET') {
      log.debug(`${req.method} ${req.path}`);
    }
    next();
  });

  const webDist = resolveFromServerRoot(process.env.WEB_DIST ?? resolve(REPO_ROOT, 'web', 'dist'));
  const hasWeb = existsSync(webDist);

  // 健康检查带上前端挂载情况与构建信息：
  // 「只推了后端没推 web/dist」和「线上到底是哪一版」都能一眼看出来。
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      time: new Date().toISOString(),
      web: hasWeb,
      node: process.version,
      build: BUILD_INFO,
    });
  });

  app.use('/api/members', membersRouter);
  app.use('/api/dishes', dishesRouter);
  app.use('/api/fridge-stock', fridgeStockRouter);
  app.use('/api/dish-requests', dishRequestsRouter);
  app.use('/api/dish-feedback', dishFeedbackRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/purchase', purchaseRouter);
  app.use('/api/nutrition', nutritionRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/events', eventsRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  // 菜品实拍图等上传文件：文件名带版本号，配一年 immutable 强缓存也不会读到旧图
  app.use('/uploads', express.static(uploadsDir(), {
    maxAge: '365d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));

  if (hasWeb) {
    app.use(
      express.static(webDist, {
        index: false,
        maxAge: '1h',
        // Vite 产物的 /assets/* 文件名带内容 hash，可以放心给长缓存；
        // sw.js 必须走协商缓存，否则 Workbox 的自动更新会被 1 小时缓存卡住版本。
        setHeaders: (res, filePath) => {
          if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (filePath.endsWith('sw.js') || filePath.endsWith('registerSW.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    // Express 5 的 path-to-regexp v8 不再支持裸 `*` 通配路由，
    // SPA fallback 改成无路径参数的兜底中间件：未被 /api 与静态资源
    // 命中的 GET/HEAD 一律回 index.html，交给前端路由接管。
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      // /api 由上面的 JSON 404 兜住；/uploads 丢图回 404 更符合直觉
      // （回 SPA 的 HTML 会让 <img> 拿到 200 的假图片响应）。
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
        next();
        return;
      }
      res.sendFile(resolve(webDist, 'index.html'));
    });
    log.info(`已挂载前端静态资源：${webDist}`);
  } else {
    log.warn(`未找到前端产物（${webDist}），仅提供 API 服务`);
  }

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    // body-parser 等中间件错误自带 4xx 状态（如 413 entity.too.large、400 entity.parse.failed）：
    // 照原状态把它当客户端错误回，不要一律 500
    const middlewareStatus = readErrorStatus(error);
    if (middlewareStatus !== null && middlewareStatus >= 400 && middlewareStatus < 500) {
      res.status(middlewareStatus).json({
        error: {
          code: 'BAD_REQUEST',
          message: middlewareStatus === 413 ? '请求内容太大了' : '请求体格式不正确',
        },
      });
      return;
    }
    // 未处理异常只写日志，不把 SQL、文件路径或内部错误原文回给浏览器。
    // 前端需要的是「可以重试/联系维护者」，不是一条英文堆栈信息。
    log.error(`未处理异常 ${req.method} ${req.path}`, error);
    res.status(500).json({
      error: { code: 'INTERNAL', message: '服务出了点问题，请稍后再试' },
    });
  });

  return app;
}
