import { cn } from '../ui/base';
import { Field } from './Field';
import type { SettingsDraftProps } from './types';
import { SETTING_MASK } from '../../../../shared/types';

/** 通知：手机推送开关与 Bark / ServerChan 的 key（改动先进草稿，由 SettingsSheet 统一保存） */
export function NotifyTab({ value, setDraft }: SettingsDraftProps) {
  // 推送 key 服务端只回脱敏掩码：输入框显示空 + 「已配置」占位；
  // 保存只提交草稿里有改动的键，所以「看到占位但没动」不会被提交、不会误清已存 key
  const masked = (key: 'notify.barkKey' | 'notify.serverchanKey') => value(key) === SETTING_MASK;
  const clearKey = (key: 'notify.barkKey' | 'notify.serverchanKey') =>
    setDraft((previous) => ({ ...previous, [key]: '' }));

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
        className="flex w-full items-center justify-between rounded-xl2 border border-cream-300 bg-white p-3.5"
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

      <Field label="Bark Key" hint="iOS 装 Bark 后复制那串 key，或填完整的自建地址">
        <div className="flex items-center gap-2">
          <input
            value={masked('notify.barkKey') ? '' : value('notify.barkKey')}
            onChange={(event) => setDraft((previous) => ({ ...previous, 'notify.barkKey': event.target.value }))}
            placeholder={masked('notify.barkKey') ? '已配置，留空保持不变；输入新值覆盖' : '例如 aBcDeFgH123'}
            className="h-10 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[14px] placeholder:text-ink-200"
          />
          {value('notify.barkKey') !== '' && (
            <button
              type="button"
              onClick={() => clearKey('notify.barkKey')}
              className="h-10 shrink-0 rounded-xl2 border border-cream-400 px-3 text-[12px] text-ink-400"
            >
              清除
            </button>
          )}
        </div>
      </Field>

      <Field label="ServerChan Key" hint="没有 Bark 时可以换成 Server酱，微信接收">
        <div className="flex items-center gap-2">
          <input
            value={masked('notify.serverchanKey') ? '' : value('notify.serverchanKey')}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, 'notify.serverchanKey': event.target.value }))
            }
            placeholder={masked('notify.serverchanKey') ? '已配置，留空保持不变；输入新值覆盖' : 'sctp1234t...'}
            className="h-10 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[14px] placeholder:text-ink-200"
          />
          {value('notify.serverchanKey') !== '' && (
            <button
              type="button"
              onClick={() => clearKey('notify.serverchanKey')}
              className="h-10 shrink-0 rounded-xl2 border border-cream-400 px-3 text-[12px] text-ink-400"
            >
              清除
            </button>
          )}
        </div>
      </Field>
    </div>
  );
}
