import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { NotifyOutboxItem } from '../../api/types';
import { cn } from '../ui/base';
import type { SettingsDraftProps } from './types';

const STATUS_LABEL: Record<NotifyOutboxItem['status'], string> = {
  sent: '已发送',
  failed: '失败',
  pending: '发送中',
};

/**
 * 通知：只保留总开关。
 * 推送统一交给家里的推送网关（PushPlus），订单消息由网关按来源路由进家庭群；
 * 网关失败时消息会落在 outbox，下面「最近推送」直接显示失败原因，不再是静默降级。
 */
export function NotifyTab({ value, setDraft }: SettingsDraftProps) {
  const [items, setItems] = useState<NotifyOutboxItem[]>([]);

  useEffect(() => {
    let alive = true;
    api.settings
      .notifyOutbox()
      .then((result) => {
        if (alive) setItems(result.items);
      })
      .catch(() => {
        // 拉取失败不影响设置本身；页面只是少一块记录
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() =>
          setDraft((previous) => ({
            ...previous,
            'notify.enabled': value('notify.enabled') === 'true' ? 'false' : 'true',
          }))
        }
        className="flex w-full items-center justify-between rounded-xl2 glass-control p-3.5"
      >
        <span className="text-left">
          <span className="block text-[14px] font-semibold">新订单推送到手机</span>
          <span className="block text-[11px] text-ink-400">下单后立刻通知大厨，不用一直刷新</span>
        </span>
        <span
          className={cn(
            'relative h-7 w-12 shrink-0 rounded-full transition',
            value('notify.enabled') === 'true' ? 'bg-brand-500' : 'bg-cream-400',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-all',
              value('notify.enabled') === 'true' ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </span>
      </button>

      <p className="rounded-xl2 bg-cream-100 px-3 py-2 text-[11px] leading-5 text-ink-400">
        推送统一走家里的推送网关（PushPlus）：订单与顺延消息会发到家庭群，网关失败时会记在下面，
        不再回落到 Bark / Server酱。
      </p>

      <div className="space-y-1.5">
        <p className="px-1 text-[12px] font-semibold text-ink-400">最近推送</p>
        {items.length === 0 ? (
          <p className="px-1 text-[11px] text-ink-300">还没有推送记录</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="rounded-xl2 glass-control px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[12px] font-medium">{item.title}</span>
                <span
                  className={cn(
                    'shrink-0 text-[11px] font-semibold',
                    item.status === 'failed' ? 'text-alert' : 'text-ink-400',
                  )}
                >
                  {STATUS_LABEL[item.status]}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-ink-300">
                {item.orderId ? `#${item.orderId} · ` : ''}
                {item.createdAt}
                {item.shortCode ? ` · ${item.shortCode}` : ''}
              </p>
              {item.lastError ? (
                <p className="mt-1 break-words text-[10px] leading-4 text-alert">{item.lastError}</p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
