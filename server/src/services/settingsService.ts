/**
 * 设置读写：settings 表的唯一入口。
 *
 * 单独成模块而不是挂在某个业务服务上：截单时间、默认人数、在外吃规则、通知 key
 * 都是横切配置，订单 / 考勤 / 营养 / 通知四个服务都要读，谁都不该成为别人的依赖。
 */
import { get, run } from '../db/index.js';
import { DEFAULT_CUTOFF, type MealType } from '../types.js';

export function readSetting(key: string, fallback = ''): string {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? fallback;
}

export function writeSetting(key: string, value: string): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

/** 删掉设置行，读取端自然回各自的默认值——用于「清空即恢复默认」的设置项 */
export function deleteSetting(key: string): void {
  run('DELETE FROM settings WHERE key = ?', key);
}

export function getCutoff(mealType: MealType): string {
  return readSetting(`cutoff.${mealType}`, DEFAULT_CUTOFF[mealType]);
}
