/**
 * HTTP 测试脚手架：起一个随机端口的真实服务（与生产同一套 createApp），
 * 供路由级测试直接打接口。使用前必须先 import './setup.js'（它负责把 DB_PATH 指到临时库）。
 *
 * 静态目录在这里一次性备好：SPA fallback 与 uploads 缓存头测试需要 web dist 存在。
 * 本文件不匹配 test/*.test.ts 的 glob，不会被当作测试文件执行。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const webRoot = mkdtempSync(join(tmpdir(), 'mealtime-web-'));
mkdirSync(join(webRoot, 'dist'));
writeFileSync(join(webRoot, 'dist', 'index.html'), '<!doctype html><title>mealtime-test</title>');
process.env.WEB_DIST = join(webRoot, 'dist');

export interface TestServer {
  /** 形如 http://127.0.0.1:53211 */
  base: string;
  close: () => void;
}

export async function startTestServer(): Promise<TestServer> {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('测试服务没拿到端口');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
