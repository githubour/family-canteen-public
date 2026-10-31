import { Check, Minus } from 'lucide-react';
import type { PurchaseItem } from '../../api/types';
import { cn } from '../ui/base';

/** 备料清单的一行：勾选 = 这样食材到位；调整模式下右侧换成「去掉」 */
export function PrepItemRow({
  item,
  adjusting,
  onToggle,
  onRemove,
}: {
  item: PurchaseItem;
  adjusting: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl2 border px-3 py-2 transition',
        item.checked && !adjusting
          ? 'border-cream-200 bg-cream-100/60'
          : item.is_optional
            ? 'border-dashed border-cream-300 bg-white/70'
            : 'border-cream-300 bg-white',
      )}
    >
      <button
        type="button"
        disabled={adjusting}
        onClick={onToggle}
        aria-label={item.checked ? '取消就绪' : '标记已就绪'}
        className={cn(
          'press flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition',
          item.checked ? 'border-transparent bg-fresh text-white' : 'border-cream-400 bg-white',
        )}
      >
        {item.checked ? <Check size={12} strokeWidth={3} /> : null}
      </button>
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', item.checked && 'text-ink-400 line-through')}>
        {item.name}
        {item.is_custom ? (
          <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 align-middle text-[10px] text-brand-500">
            手动
          </span>
        ) : item.is_optional ? (
          <span className="ml-1.5 rounded-full bg-cream-200 px-1.5 py-0.5 align-middle text-[10px] text-ink-400">
            可选
          </span>
        ) : null}
      </span>
      <span className={cn('shrink-0 text-[12px] tabular-nums', item.checked ? 'text-ink-400' : 'text-ink-600')}>
        {item.amount_text}
      </span>
      {adjusting ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`去掉 ${item.name}`}
          className="press flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#FF453A]/10 text-[#FF453A]"
        >
          <Minus size={13} strokeWidth={3} />
        </button>
      ) : null}
    </div>
  );
}
