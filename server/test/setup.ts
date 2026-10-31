/**
 * 测试环境装配：必须是每个测试文件的首个 import。
 *
 * 在业务模块求值前把 DB_PATH 指向临时目录（绝对路径，resolveFromServerRoot
 * 原样放行），node:sqlite 单例首次 getDb() 时会自动建库并跑完整迁移；
 * WEB_DIST 由 app 测试自建静态目录后自行覆盖。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'mealtime-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

export const TEMP_DIR = tempDir;

/** 未来（不含今天）第 n 天中星期六的日期串：避开默认「工作日午餐在外」规则，考勤口径恒为三餐在家 */
export function nextSaturday(): string {
  const base = new Date();
  for (let i = 1; i < 15; i += 1) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    if (d.getDay() === 6) {
      const offsetMs = d.getTimezoneOffset() * 60 * 1000;
      return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);
    }
  }
  throw new Error('未找到星期六');
}
