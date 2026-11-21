/**
 * 前端纯函数测试：日期/星期换算、截单倒计时与月份文案。
 * 这些函数决定「今天 / 明天」档位落到哪个绝对日期、截单是否已过，
 * 算错会静默把菜下到错的日期或被截单挡住，所以用固定日期把边界钉住。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  cutoffCountdown,
  cutoffMinutes,
  dayOffsetLabel,
  formatDateCN,
  formatWeekday,
  monthsSummary,
  parseWeekdays,
  relativeDateTime,
  relativeDayLabel,
  shiftDay,
  snoozeMonthKey,
  stringifyWeekdays,
  todayISO,
  weekdayOf,
} from '../src/lib/format';

describe('format：脏日期展示兜底', () => {
  it('非法日期不渲染 NaN月NaN日 / undefined 星期', () => {
    assert.equal(formatDateCN('2026-13-99'), '2026-13-99');
    assert.equal(formatWeekday('2026-13-99'), '');
    assert.equal(weekdayOf('2026-13-99'), -1);
    assert.equal(relativeDayLabel('2026-13-99'), '2026-13-99');
  });
});

describe('format：星期集合解析', () => {
  it('解析正常集合', () => {
    assert.deepEqual(parseWeekdays('1,2,3,4,5'), [1, 2, 3, 4, 5]);
  });

  it("空串解析为 []（不能因 Number('') === 0 混进周日）", () => {
    assert.deepEqual(parseWeekdays(''), []);
    assert.deepEqual(parseWeekdays(null), []);
    assert.deepEqual(parseWeekdays(undefined), []);
  });

  it('单独的 0 是合法的周日', () => {
    assert.deepEqual(parseWeekdays('0'), [0]);
  });

  it('过滤越界值与非数字，容忍空格', () => {
    assert.deepEqual(parseWeekdays(' 3 , 7 ,x, 1 '), [3, 1]);
    assert.deepEqual(parseWeekdays('abc'), []);
  });

  it('序列化去重并升序', () => {
    assert.equal(stringifyWeekdays([5, 1, 5, 0]), '0,1,5');
    assert.equal(stringifyWeekdays([]), '');
  });
});

describe('format：日期换算', () => {
  it('weekdayOf 与 JS getDay() 一致（0 = 周日）', () => {
    assert.equal(weekdayOf('2026-01-01'), 4);
    assert.equal(weekdayOf('2026-02-01'), 0);
  });

  it('todayISO 返回本地日期（跨零点不错位）', () => {
    assert.equal(todayISO(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
    assert.equal(todayISO(new Date(2026, 0, 5, 0, 10)), '2026-01-05');
  });

  it('shiftDay 跨月、跨年、闰年均正确', () => {
    assert.equal(shiftDay('2026-01-31', 1), '2026-02-01');
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
    assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
  });

  it('dayOffsetLabel 说人话', () => {
    assert.equal(dayOffsetLabel(0), '今天');
    assert.equal(dayOffsetLabel(1), '明天');
    assert.equal(dayOffsetLabel(2), '后天');
    assert.equal(dayOffsetLabel(5), '5 天后');
  });

  it('relativeDateTime 相对今天的读法', () => {
    const today = todayISO();
    assert.equal(relativeDateTime(`${today} 11:04:00`), '今天 11:04');
    assert.equal(relativeDateTime(`${shiftDay(today, -1)} 07:05:59`), '昨天 07:05');
  });

  it('snoozeMonthKey：短歇顺延到下个月，长歇落在目标月', () => {
    const now = new Date(2026, 9, 14);
    assert.equal(snoozeMonthKey(7, now), '2026-11');
    assert.equal(snoozeMonthKey(60, now), '2026-12');
    assert.equal(snoozeMonthKey(90, now), '2027-01');
  });

  it('monthsSummary：连续区间收拢，零散逐个列', () => {
    assert.equal(monthsSummary([]), '全年');
    assert.equal(monthsSummary([9, 10, 11]), '9-11 月');
    assert.equal(monthsSummary([3, 4, 12]), '3-4 月、12 月');
    assert.equal(monthsSummary([1, 3, 5]), '1 月、3 月、5 月');
    assert.equal(monthsSummary([10, 8, 9]), '8-10 月');
  });
});

describe('format：截单', () => {
  it('cutoffMinutes 解析 HH:MM，坏值兜底为 0 点', () => {
    assert.equal(cutoffMinutes('11:30'), 690);
    assert.equal(cutoffMinutes('00:00'), 0);
    assert.equal(cutoffMinutes('x'), 0);
  });

  it('cutoffCountdown：未到点显示剩余，到点/过点标记 passed', () => {
    const cutoff = '11:30';
    assert.deepEqual(cutoffCountdown(cutoff, new Date(2026, 0, 5, 11, 0)), {
      passed: false,
      text: '距截单还有 30 分钟',
      minutesLeft: 30,
    });
    assert.equal(cutoffCountdown(cutoff, new Date(2026, 0, 5, 10, 30)).text, '距截单还有 1 小时 0 分');
    assert.equal(cutoffCountdown(cutoff, new Date(2026, 0, 5, 11, 30)).passed, true);
    assert.equal(cutoffCountdown(cutoff, new Date(2026, 0, 5, 12, 0)).passed, true);
  });
});
