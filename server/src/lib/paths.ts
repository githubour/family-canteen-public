/**
 * 路径解析：统一从入口脚本位置推导项目根目录，不依赖 process.cwd()。
 *
 * 原因：早先按 cwd 解析默认路径，换个目录启动就会静默新建一个空数据库、
 * 或找不到前端产物。这里集中处理，并兼容两种运行方式：
 *   - 开发：tsx 直跑 server/src/index.ts
 *   - 生产：node 直跑 esbuild 打包出的 server/dist/server.cjs
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function findUp(startDir: string, marker: string, maxDepth = 6): string {
  let dir = startDir;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/** server 包目录（含 package.json） */
export const SERVER_ROOT = findUp(dirname(process.argv[1] ?? process.cwd()), 'package.json');

/** 仓库根目录：server 的上一级 */
export const REPO_ROOT = resolve(SERVER_ROOT, '..');

/** 相对路径按 server 包目录解析，绝对路径原样返回 */
export function resolveFromServerRoot(target: string): string {
  return isAbsolute(target) ? target : resolve(SERVER_ROOT, target);
}
