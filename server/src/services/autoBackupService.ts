/**
 * 应用内的每日一致性快照。
 *
 * 为什么需要它：
 * NAS 上的通用备份是「整目录 rsync」，在应用运行期间直接拷贝
 * SQLite 文件时，db / -wal / -shm 三个文件来自不同瞬间，可能得到撕裂状态。
 * 与其在 NAS 侧为这个应用写一段专用脚本，不如让应用自己按日产出 VACUUM INTO 快照
 * 放进 data/auto-backup/——通用的整目录备份自然会把这份「一致副本」一起带走。
 *
 * 快照是「数据库 + 实拍图」成对的：
 *   mealtime-YYYYMMDD.db       数据（VACUUM INTO，自洽副本）
 *   mealtime-YYYYMMDD.uploads/ uploads/ 的镜像（菜品实拍图）
 * 只恢复 db 会得到一堆破图链接，所以两者必须一起还原（见 README「恢复数据」）。
 * 图片复制是异步的：家里几十张图虽然不大，也没必要卡住点菜请求。
 *
 * 这样应用走到哪都自带数据安全保证，NAS 侧保持零专用配置。
 *
 * 可用环境变量：
 *   BACKUP_ENABLED=false            关闭自动快照
 *   BACKUP_KEEP_DAYS=30             本地保留天数
 *   BACKUP_STARTUP_DELAY_MS=60000   启动后延迟多久做首次快照（测试时可调小）
 */
import { cp } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb, resolveDbPath, uploadsDir } from '../db/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('auto-backup');

const KEEP_DAYS = Math.max(Number(process.env.BACKUP_KEEP_DAYS ?? 30) || 30, 1);
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = Math.max(Number(process.env.BACKUP_STARTUP_DELAY_MS ?? 60_000) || 0, 0);
const PREFIX = 'mealtime-';
/** 图片镜像目录的后缀：mealtime-YYYYMMDD.uploads */
const UPLOADS_SUFFIX = '.uploads';

function snapshotDir(): string {
  return join(dirname(resolveDbPath()), 'auto-backup');
}

function dayStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 删掉超过保留期的快照（db 文件与图片目录一起轮转） */
function prune(dir: string): number {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(PREFIX)) continue;
    const isDb = name.endsWith('.db');
    const isUploads = name.endsWith(UPLOADS_SUFFIX);
    if (!isDb && !isUploads) continue;
    const path = join(dir, name);
    if (statSync(path).mtimeMs >= cutoff) continue;
    if (isUploads) rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
    removed += 1;
  }
  return removed;
}

/** 把 uploads 目录镜像到快照旁边；已存在（当天备份过）就跳过 */
async function snapshotUploads(target: string): Promise<boolean> {
  const src = uploadsDir();
  if (!existsSync(src) || existsSync(target)) return false;
  await cp(src, target, { recursive: true });
  log.info(`实拍图目录已随快照备份：${target}`);
  return true;
}

interface AutoBackupResult {
  /** 数据库快照文件；null = 当天已有 */
  file: string | null;
  /** 图片镜像目录；null = 没有图片可备或当天已有 */
  uploads: string | null;
  skipped: boolean;
  pruned: number;
}

/**
 * 生成当天的一致性快照。同一天重复调用会跳过——VACUUM INTO 要求目标文件不存在，
 * 这个约束正好天然保证了「每天一份」的幂等性（图片镜像同理用存在性判断）。
 */
function runAutoBackup(): AutoBackupResult {
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });
  const stamp = dayStamp();
  const target = join(dir, `${PREFIX}${stamp}.db`);
  const uploadsTarget = join(dir, `${PREFIX}${stamp}${UPLOADS_SUFFIX}`);

  let file: string | null = null;
  if (!existsSync(target)) {
    // VACUUM INTO 会在一个读事务里写到新文件，得到的是自洽的完整副本
    getDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    file = target;
    log.info(`一致性快照已生成：${target}`);
  }

  // 图片异步入账：失败只记日志，数据库快照已经落盘，不影响主流程，也不影响点菜
  const uploadsPending = existsSync(uploadsDir()) && !existsSync(uploadsTarget);
  if (uploadsPending) {
    void snapshotUploads(uploadsTarget).catch((error: unknown) => {
      log.error('实拍图备份失败（数据库快照已生成，可稍后重试）', error);
    });
  }

  // 无论今天是否已经快照过，都要把 WAL 合并回主库。
  // WAL 模式下主库文件可能长期是个「空壳」，数据全在 -wal 里——
  // 万一有人（或某个脚本）只拷了 mealtime.db，拿到的是一个连表都没有的文件。
  // 做过检查点后，主库自身就是完整可用的。
  // 注意别把这一步放进上面的 if 里，否则当天已有快照时永远不会执行。
  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const pruned = prune(dir);
  return { file, uploads: uploadsPending ? uploadsTarget : null, skipped: file === null, pruned };
}

/** 启动后延迟执行一次，之后每 6 小时检查（跨天时补上当天那份） */
export function startAutoBackup(): void {
  if (process.env.BACKUP_ENABLED === 'false') {
    log.info('自动快照已通过 BACKUP_ENABLED=false 关闭');
    return;
  }

  const safeRun = () => {
    try {
      const result = runAutoBackup();
      if (result.pruned > 0) log.info(`轮转清理 ${result.pruned} 份超过 ${KEEP_DAYS} 天的快照`);
    } catch (error) {
      // 快照失败绝不能影响点菜下单
      log.error('快照失败（已忽略，不影响服务）', error);
    }
  };

  setTimeout(safeRun, STARTUP_DELAY_MS).unref();
  setInterval(safeRun, CHECK_INTERVAL_MS).unref();
  log.info(`自动快照已启用：保留 ${KEEP_DAYS} 天 -> ${snapshotDir()}`);
}
