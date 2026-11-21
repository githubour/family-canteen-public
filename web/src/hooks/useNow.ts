import { useEffect, useState } from 'react';
import { todayISO } from '../lib/format';

/**
 * 每 30 秒返回一次新的“现在”，驱动截单倒计时与“已截单”状态。
 *
 * 为什么需要它：`cutoffCountdown()` 是渲染时的快照，页面一直开着时倒计时会冻在
 * 第一次渲染的数字上（30 分钟前显示“还剩 5 分钟”，过了截单还显示能点）。
 * 页面切到后台时暂停定时器，回到前台立即补一次，既准确又不白耗电。
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(new Date());
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      tick();
      timer = setInterval(tick, intervalMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);

  return now;
}

/**
 * 「今天」的日期，粒度是“到下一个零点才变”。
 *
 * 页面级只需要日期的地方（页头标题、按天拉汇总）用它，别用 useNow：
 * useNow 每 30 秒 setState 一次，挂在页面顶层就是每 30 秒整页重渲染。
 * 这里只在跨过零点那一刻才写入新日期，平时零渲染——设备睡过零点的话，
 * 唤醒时过期的定时器会立刻补触发，日期不会停在昨天。
 */
export function useToday(): string {
  const [today, setToday] = useState(() => todayISO());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      // 定时到下一个零点（+1s 缓冲，别跟日期翻转抢跑），到点换新日期再排下一天
      timer = setTimeout(() => {
        setToday(todayISO());
        schedule();
      }, nextMidnight.getTime() - now.getTime() + 1_000);
    };
    schedule();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return today;
}
