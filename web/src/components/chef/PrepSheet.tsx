import { ImageDown } from 'lucide-react';
import { type MealSummary, type PurchaseItem, type PurchaseList } from '../../api/types';
import { EmptyState, Sheet } from '../ui/feedback';
import { PrepChecklist } from './PrepChecklist';
import { RecipeList } from './RecipeList';

/**
 * 合并备料弹层：上面是食材就绪清单，下面是这一餐要做的菜（对照配料与做法）。
 * 清单数据由 usePrepList 提供，操作也全部转发给它——弹层本身不碰接口。
 */
export function PrepSheet({
  open,
  onClose,
  summary,
  prep,
  adjusting,
  onToggleAdjust,
  onToggle,
  onRemove,
  onAddCustom,
  onRestore,
  expandedStepsId,
  onToggleSteps,
  onExportMenu,
}: {
  open: boolean;
  onClose: () => void;
  summary: MealSummary | null;
  prep: PurchaseList | null;
  adjusting: boolean;
  onToggleAdjust: () => void;
  onToggle: (item: PurchaseItem) => void;
  onRemove: (item: PurchaseItem) => void;
  onAddCustom: (name: string, amountText: string) => Promise<boolean>;
  onRestore: (item: PurchaseItem) => void;
  expandedStepsId: string | null;
  onToggleSteps: (rowKey: string | null) => void;
  onExportMenu: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="今日备料清单">
      <div className="pb-4">
        {summary && summary.dishes.length > 0 ? (
          <>
            {prep && (prep.total > 0 || prep.optional.length > 0 || prep.hidden.length > 0) ? (
              <PrepChecklist
                prep={prep}
                adjusting={adjusting}
                onToggleAdjust={onToggleAdjust}
                onToggle={onToggle}
                onRemove={onRemove}
                onAddCustom={onAddCustom}
                onRestore={onRestore}
              />
            ) : null}

            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">要做的菜</p>
                <p className="truncate text-[11px] text-ink-400">按份数从多到少排序，点菜名展开配料与做法</p>
              </div>
              <button
                type="button"
                onClick={onExportMenu}
                className="press flex shrink-0 items-center gap-1 rounded-full bg-brand-50 px-3 py-1.5 text-[12px] font-medium text-brand-600"
              >
                <ImageDown size={13} />
                菜单图
              </button>
            </div>
            <RecipeList dishes={summary.dishes} expandedId={expandedStepsId} onToggle={onToggleSteps} />
            <div className="mt-4 rounded-xl2 bg-warn/10 p-3 text-[12px] text-[#8A4B00]">
              建议先做炖煮类（炖菜、汤），快炒类等开饭前 15 分钟再动手。
            </div>
          </>
        ) : (
          <EmptyState emoji="🥣" title="还没有需要备料的菜" />
        )}
      </div>
    </Sheet>
  );
}
