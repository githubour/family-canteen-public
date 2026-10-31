// 必须是第一个 import：先加载 .env，再让 app/db 等模块读取 process.env
import './env.js';
import { createApp } from './app.js';
import { closeDb, getDb, resolveDbPath } from './db/index.js';
import { seedIfEmpty } from './db/seed/run.js';
import { startHeartbeat } from './lib/sse.js';
import { logger } from './lib/logger.js';
import { buildLabel } from './lib/buildInfo.js';
import { startAutoBackup } from './services/autoBackupService.js';

const port = Number(process.env.PORT ?? 8787);

getDb();
seedIfEmpty();
startAutoBackup();
startHeartbeat();

const app = createApp();

const server = app.listen(port, '0.0.0.0', () => {
  logger.info(`「每日吃什么」服务已启动：http://0.0.0.0:${port}`);
  logger.info(`数据库文件：${resolveDbPath()}`);
  logger.info(`构建版本：${buildLabel()}`);
});
server.keepAliveTimeout = 65_000;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`收到 ${signal}，正在关闭服务`);
    // 退出前关库：让 SQLite 把 WAL 合并回主库。缺了这步，未合并的写入就只躺在
    // `-wal` 里（唯一副本），之后动它一下就是整段数据丢失（见 closeDb 的注释）。
    const shutdown = () => {
      closeDb();
      process.exit(0);
    };
    server.close(shutdown);
    // 兜底：还有 SSE 长连接挂着时 server.close 可能迟迟不回调，3 秒后强制关库退出
    setTimeout(shutdown, 3000).unref();
  });
}
