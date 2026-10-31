import { Layers } from 'lucide-react';
import type { MealSummary, PurchaseList } from '../../api/types';

/** 备料卡只看这四个数：单餐摘要或全天合并摘要都能喂 */
type SummaryStats = Pick<MealSummary, 'dish_count' | 'total_servings' | 'order_count' | 'member_count'>;

/** 合并备料入口：要做几道菜、多少份，顺带露出食材就绪进度 */
export function PrepSummaryCard({
  summary,
  prep,
  onOpen,
}: {
  summary: SummaryStats;
  prep: PurchaseList | null;
  onOpen: () => void;
}) {
  return (
    <section className="mt-3 px-4">
      <button type="button" onClick={onOpen} className="card press flex w-full items-center gap-3 p-3.5 text-left">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl2 bg-brand-50 text-brand-600">
          <Layers size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">
            合并备料：{summary.dish_count} 道菜 / {summary.total_servings} 份
          </p>
          <p className="truncate text-[11px] text-ink-400">
            {summary.order_count} 份点单 · {summary.member_count} 位家人
            {/* 食材就绪进度一眼可见：勾选状态与「采购」页同源 */}
            {prep && prep.total > 0 ? ` · 食材就绪 ${prep.checked_count}/${prep.total}` : ''}
          </p>
        </div>
        <span className="chip bg-brand-50 text-brand-600">查看</span>
      </button>
    </section>
  );
}
