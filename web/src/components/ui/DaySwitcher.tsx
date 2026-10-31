import { ChevronLeft, ChevronRight } from 'lucide-react';
import { relativeDayLabel, shiftDay, todayISO } from '../../lib/format';
import { cn } from './base';

/**
 * 「前一天 / 今天 / 后一天」三段式日期切换：采购页、大厨看板、营养面板共用。
 * 只管这三颗按钮——吸顶容器、左右栏布局由调用方自己包（各页高度与排布不同）。
 */
export function DaySwitcher({
  date,
  onChange,
  className,
}: {
  date: string;
  onChange: (date: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        aria-label="前一天"
        onClick={() => onChange(shiftDay(date, -1))}
        className="press flex h-9 w-9 items-center justify-center rounded-full border border-cream-300 bg-white text-ink-600"
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        onClick={() => onChange(todayISO())}
        className="press h-9 flex-1 rounded-full border border-cream-300 bg-white text-[13px] font-medium"
      >
        {relativeDayLabel(date)}
      </button>
      <button
        type="button"
        aria-label="后一天"
        onClick={() => onChange(shiftDay(date, 1))}
        className="press flex h-9 w-9 items-center justify-center rounded-full border border-cream-300 bg-white text-ink-600"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
