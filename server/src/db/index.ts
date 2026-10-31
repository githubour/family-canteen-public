/**
 * 数据层：直接使用 Node 内置的 node:sqlite（DatabaseSync）。
 * 相比 better-sqlite3 的优势是零原生依赖、无需编译，同时保留同步 API 的简洁性。
 * 连接为进程内单例，开启 WAL 以支持并发读、降低写阻塞。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runMigrations } from './migrations.js';
import { createLogger } from '../lib/logger.js';
import { REPO_ROOT, resolveFromServerRoot } from '../lib/paths.js';

// 时区兜底：截单时间、歇菜月份、季节菜、自动备份日期与 SQLite 的 datetime('now','localtime')
// 全都按进程本地时间算。正常入口会先执行 env.ts（加载 .env 后再兜底 Asia/Shanghai）；
// 这里再兜一次，防止测试或其他直接 import 的脚本绕过入口时落到 UTC。
if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai';

const log = createLogger('db');

let instance: DatabaseSync | null = null;
/** 是否有事务正在进行：node:sqlite 不支持嵌套 BEGIN，transaction() 靠它把嵌套挡在前面 */
let inTransaction = false;

const DEFAULT_DB_PATH = resolve(REPO_ROOT, 'data', 'mealtime.db');

export function resolveDbPath(): string {
  const raw = (process.env.DB_PATH ?? '').trim();
  return raw ? resolveFromServerRoot(raw) : DEFAULT_DB_PATH;
}

/**
 * 上传文件根目录：跟着数据库文件走（<db 目录>/uploads）。
 * NAS 部署用卷映射挂的就是 data/ 目录，这样换库路径时上传文件不用单独迁移。
 */
export function uploadsDir(): string {
  return resolve(dirname(resolveDbPath()), 'uploads');
}

export function getDb(): DatabaseSync {
  if (instance) return instance;

  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(db);

  instance = db;
  log.info(`数据库就绪：${path}`);
  return db;
}

/**
 * 关闭连接。**必须在进程退出前调用**：WAL 模式下只有「最后一个连接干净关闭」
 * 时 SQLite 才会把 WAL 合并回主库。若直接 process.exit()，未合并的写入就只存在
 * 于 `-wal` 里——它成了唯一副本，之后任何对它的操作（例如换库时顺手 rm）都是数据丢失。
 */
export function closeDb(): void {
  if (!instance) return;
  const db = instance;
  instance = null;
  inTransaction = false;
  // 语句缓存跟随连接：close 后语句全部失效，必须一并清掉，否则下次 getDb 会拿到悬空引用
  stmtCache.clear();
  try {
    db.close();
  } catch (error) {
    log.warn(`关闭数据库连接失败：${String(error)}`);
  }
}

/** 参数绑定：node:sqlite 不接受 boolean，统一在入口转成 0/1 */
type SqlParam = string | number | null | Uint8Array;

/**
 * prepared statement 进程级缓存：node:sqlite 每次 prepare 都要重新解析与编译 SQL，
 * 热点语句复用能省掉这一步。key 是 SQL 文本。
 * 注意 dishService 等处存在按输入长度拼接的 `IN (?,?,…)` 动态语句，占位符个数
 * 不同就会产生不同 key——所以设条目上限，超限时整体清空重建：静态语句很快回填，
 * 缓存占用始终有界，不会随菜品数无界增长。
 */
const STMT_CACHE_LIMIT = 250;
const stmtCache = new Map<string, StatementSync>();

function prepareCached(sql: string): StatementSync {
  let statement = stmtCache.get(sql);
  if (!statement) {
    if (stmtCache.size >= STMT_CACHE_LIMIT) stmtCache.clear();
    statement = getDb().prepare(sql);
    stmtCache.set(sql, statement);
  }
  return statement;
}

export function all<T>(sql: string, ...params: SqlParam[]): T[] {
  return prepareCached(sql).all(...params) as unknown as T[];
}

export function get<T>(sql: string, ...params: SqlParam[]): T | undefined {
  const row = prepareCached(sql).get(...params);
  return row === undefined ? undefined : (row as unknown as T);
}

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export function run(sql: string, ...params: SqlParam[]): RunResult {
  const result = prepareCached(sql).run(...params) as { changes: number | bigint; lastInsertRowid: number | bigint };
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

/**
 * 事务包装：同步 API，回调内异常自动回滚。
 *
 * 用 BEGIN IMMEDIATE 而不是默认的 deferred：默认只有第一次写才去抢写锁，
 * 一旦同一份库被第二个进程碰过（部署切换时的旧容器、外部 sqlite3、备份脚本），
 * 读→写升级会直接撞 SQLITE_BUSY，busy_timeout 也不总能救回来。这里一开始就取写锁。
 * 嵌套调用直接报错：node:sqlite 不支持嵌套 BEGIN，静默走 SAVEPOINT 会把外层的回滚语义搞乱，
 * 宁可现在就炸出来，也别等到某天数据只写了一半。
 */
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  if (inTransaction) throw new Error('不支持嵌套事务：请把多段写入合到同一个 transaction() 里');
  db.exec('BEGIN IMMEDIATE');
  inTransaction = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    inTransaction = false;
  }
}
