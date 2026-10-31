import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { deleteSetting, readSetting, writeSetting } from '../services/settingsService.js';
import { DEFAULT_AWAY, lockAttendanceHistory, writeAwayWeekdays } from '../services/attendanceService.js';
import { badRequest, notFound } from '../lib/errors.js';
import { broadcast } from '../lib/sse.js';
import { createLogger } from '../lib/logger.js';
import {
  DEFAULT_CUTOFF,
  MAX_HEADCOUNT,
  SETTING_KEYS,
  SENSITIVE_SETTING_KEYS,
  SETTING_MASK,
  type MealType,
} from '../types.js';

export const settingsRouter = Router();

const log = createLogger('settings');

/** 可读写的设置项白名单：与前端 AppSettings 同源于 shared/types.ts 的 SETTING_KEYS */
const PUBLIC_KEYS = SETTING_KEYS;

const CUTOFF_KEYS = new Set(['cutoff.breakfast', 'cutoff.lunch', 'cutoff.dinner']);
const AWAY_KEYS = new Set(['away.breakfast', 'away.lunch', 'away.dinner']);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 库里没有这一行时要回给界面「实际生效」的值，而不是空串。
 * 老库升级上来时 cutoff.breakfast / away.* 都没有行，回空串会让设置页
 * 显示成「早餐截单时间空白」「一个在外吃的星期都没勾」，与实际行为不符。
 */
const KEY_FALLBACK: Record<string, string> = {
  'cutoff.breakfast': DEFAULT_CUTOFF.breakfast,
  'cutoff.lunch': DEFAULT_CUTOFF.lunch,
  'cutoff.dinner': DEFAULT_CUTOFF.dinner,
  // 与 orderService / nutritionService 的兜底值一致：没有这行时界面要看到“实际生效的 3”
  'default.headcount': '3',
  'away.breakfast': DEFAULT_AWAY.breakfast,
  'away.lunch': DEFAULT_AWAY.lunch,
  'away.dinner': DEFAULT_AWAY.dinner,
};

function readPublicSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of PUBLIC_KEYS) settings[key] = readSetting(key, KEY_FALLBACK[key] ?? '');
  // 推送 key 是长期凭据：回显一律脱敏（Bark key = 该设备推送凭据，泄露可被用来骚扰推送）
  for (const key of SENSITIVE_SETTING_KEYS) {
    if (settings[key] !== '') settings[key] = SETTING_MASK;
  }
  return settings;
}

settingsRouter.get('/', (_req, res) => {
  res.json({ settings: readPublicSettings() });
});

settingsRouter.patch('/', (req, res) => {
  const body = req.body ?? {};
  const updated: string[] = [];
  // 先完整校验、收集写入动作，再一次性事务落库。
  // 原来的逐键「校验一个写一个」在混提合法+非法值时会出现：接口返回 400，但前面的键已经改了，
  // 而且没有广播——界面显示失败、数据库却变了。
  const writes: Array<() => void> = [];
  let touchesAway = false;

  for (const key of PUBLIC_KEYS) {
    if (body[key] === undefined) continue;

    // 敏感键收到掩码串 = 前端把脱敏回显原样传回来了，语义是「保持不变」；
    // 真想改就传新值，想清除传空串（notifyService 对空串按未配置处理）
    if ((SENSITIVE_SETTING_KEYS as readonly string[]).includes(key) && String(body[key]) === SETTING_MASK) {
      continue;
    }

    if (CUTOFF_KEYS.has(key)) {
      // 截单时间必须是 HH:mm。时间控件清空会传空串：视为「恢复默认」，
      // 删掉这行让读取端回默认值——存空串的话 nowHHmm() > '' 恒成立，该餐次会永远「已过截单」。
      const value = String(body[key]);
      if (value !== '' && !TIME_PATTERN.test(value)) {
        throw badRequest(`「${key}」需要是 HH:mm 格式的时间，如 10:30`);
      }
      writes.push(() => (value === '' ? deleteSetting(key) : writeSetting(key, value)));
      updated.push(key);
      continue;
    }

    if (AWAY_KEYS.has(key)) {
      // 星期集合：空串 = 全不勾；其余只能是 0~6 的组合（0 = 周日），统一去重排序后落库
      const raw = String(body[key]);
      const parts = raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (parts.some((part) => !/^[0-6]$/.test(part))) {
        throw badRequest(`「${key}」只能是 0~6 的星期组合（0 = 周日）`);
      }
      const weekdays = parts.map(Number);
      writes.push(() => writeAwayWeekdays(key.slice(5) as MealType, weekdays));
      touchesAway = true;
      updated.push(key);
      continue;
    }

    if (key === 'default.headcount') {
      // 人数会直接参与营养人均换算，NaN / 负数 / 超大值都不能落库
      const value = Number(body[key]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_HEADCOUNT) {
        throw badRequest(`「默认人数」需要是 1~${MAX_HEADCOUNT} 的整数`);
      }
      writes.push(() => writeSetting(key, String(value)));
      updated.push(key);
      continue;
    }

    const value = String(body[key]);
    writes.push(() => writeSetting(key, value));
    updated.push(key);
  }

  if (updated.length === 0) throw badRequest('没有可更新的设置项');

  // 改「默认在外吃」规则前，先把今天之前那些还没落库的考勤判定按**当前**规则固化下来；
  // 否则它们一直是现算的，规则一改，过去几个月的在家/在外（以及营养页的折算区间）会集体变脸。
  // 必须放在全部校验通过之后：非法请求不应该产生任何写副作用。
  if (touchesAway) {
    const locked = lockAttendanceHistory();
    if (locked > 0) {
      // 固化不改「结论」，只是把它们从「现算」变成「落库」，所以无需刷新界面；
      // 记一条日志便于将来排查「为什么这天口径和规则对不上」
      log.info(`改在外吃规则前，固化了 ${locked} 条历史考勤判定`);
    }
  }

  transaction(() => {
    for (const write of writes) write();
  });
  broadcast('settings:updated', { keys: updated });
  res.json({ settings: readPublicSettings(), updated });
});

settingsRouter.get('/ingredients', (_req, res) => {
  const ingredients = all(
    `SELECT id, name, category, unit, buy_unit, buy_factor, is_pantry, price_per_100g,
            kcal, protein, fat, carb, sodium, fiber, nutrition_source
       FROM ingredients ORDER BY category, name`,
  );
  res.json({ ingredients });
});

settingsRouter.patch('/ingredients/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = get<{ id: number; is_pantry: number; price_per_100g: number | null; nutrition_source: string }>(
    'SELECT id, is_pantry, price_per_100g, nutrition_source FROM ingredients WHERE id = ?',
    id,
  );
  if (!row) throw notFound('食材不存在');

  const body = req.body ?? {};
  // 复核动作只允许在 ai / manual 之间切：seed 是预置数据（《中国食物成分表》口径），
  // 不该被页面误标成别的来源，否则「待复核」这个信号就失去意义了
  const nextSource = body.nutrition_source;
  if (nextSource !== undefined && nextSource !== 'ai' && nextSource !== 'manual') {
    throw badRequest("nutrition_source 只能是 'ai'（待复核）或 'manual'（已复核）");
  }

  // 价格会直接乘用量进采购预估，空串/缺省 = 不填，其余必须是不小于 0 的有限数字
  let nextPrice: number | null = row.price_per_100g;
  if (body.price_per_100g !== undefined) {
    if (body.price_per_100g === null || body.price_per_100g === '') {
      nextPrice = null;
    } else {
      const price = Number(body.price_per_100g);
      if (!Number.isFinite(price) || price < 0) throw badRequest('价格需要是不小于 0 的数字');
      nextPrice = price;
    }
  }

  run(
    'UPDATE ingredients SET is_pantry = ?, price_per_100g = ?, nutrition_source = ? WHERE id = ?',
    body.is_pantry === undefined ? row.is_pantry : body.is_pantry ? 1 : 0,
    nextPrice,
    nextSource ?? row.nutrition_source,
    id,
  );
  broadcast('dish:updated', { ingredientId: id });
  res.json({ ok: true });
});
