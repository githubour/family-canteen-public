import type { PurchaseItem, PurchaseList } from '../../api/types';
import { Progress } from '../ui/feedback';
import { ChoiceChip } from '../ui/base';
import { ManualItemForm } from '../ManualItemForm';
import { PrepItemRow } from './PrepItemRow';

/**
 * 食材准备 checklist：勾了 = 这样本食材到位。勾选状态与「采购」页同源，
 * 那边点过「买好」的，这里直接就绪（服务端是同一份数据）。
 * 「调整」模式下去掉系统多算的、补上没算到的，可随时恢复。
 */
export function PrepChecklist({
  prep,
  adjusting,
  onToggleAdjust,
  onToggle,
  onRemove,
  onAddCustom,
  onRestore,
}: {
  prep: PurchaseList;
  adjusting: boolean;
  onToggleAdjust: () => void;
  onToggle: (item: PurchaseItem) => void;
  onRemove: (item: PurchaseItem) => void;
  onAddCustom: (name: string, amountText: string) => Promise<boolean>;
  onRestore: (item: PurchaseItem) => void;
}) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold">食材准备</p>
        <div className="flex items-center gap-2">
          <p className="text-[12px] tabular-nums text-ink-400">
            已就绪 {prep.checked_count}/{prep.total}
          </p>
          <ChoiceChip active={adjusting} size="sm" activeClassName="bg-brand-500 text-white" onClick={onToggleAdjust}>
            {adjusting ? '完成' : '调整'}
          </ChoiceChip>
        </div>
      </div>
      <Progress value={prep.checked_count} max={prep.total} />
      <div className="mt-2.5 space-y-1.5">
        {prep.to_buy.map((item) => (
          <PrepItemRow
            key={item.is_custom ? `c${item.custom_id}` : item.ingredient_id}
            item={item}
            adjusting={adjusting}
            onToggle={() => void onToggle(item)}
            onRemove={() => void onRemove(item)}
          />
        ))}
      </div>

      {/* 可选加购：今天引用它的菜都把它当可选，没有也能做出所有的菜 */}
      {prep.optional.length > 0 ? (
        <div className="mt-2.5">
          <p className="mb-1.5 text-[11px] text-ink-400">
            可选加购 {prep.optional.length} 样 · 家里没有也能做出今天的菜
          </p>
          <div className="space-y-1.5">
            {prep.optional.map((item) => (
              <PrepItemRow
                key={item.ingredient_id}
                item={item}
                adjusting={adjusting}
                onToggle={() => void onToggle(item)}
                onRemove={() => void onRemove(item)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {adjusting ? (
        <div className="mt-2.5 rounded-xl2 bg-cream-100 p-3">
          <ManualItemForm hidden={prep.hidden} onAddCustom={onAddCustom} onRestore={onRestore} />
          <p className="mt-2 text-[11px] leading-4 text-ink-400">
            只影响这一餐的清单，不动菜的配料表；采购页同步可见。
          </p>
        </div>
      ) : null}

      {prep.pantry.length > 0 ? (
        <p className="mt-2 rounded-xl2 bg-cream-100 px-3 py-2 text-[11px] leading-4 text-ink-400">
          另有常备 {prep.pantry.length} 种（{prep.pantry
            .slice(0, 6)
            .map((item) => item.name)
            .join('、')}
          {prep.pantry.length > 6 ? '…' : ''}），家里都有，不算在清单里。
        </p>
      ) : null}
      <p className="mt-1.5 text-[11px] text-ink-400">
        勾选与「采购」页实时同步：那边勾过「买好」的，这里直接显示就绪；要改数量或备注去采购页。
        {prep.hidden.length > 0 && !adjusting ? `已去掉 ${prep.hidden.length} 项，点「调整」可恢复。` : ''}
      </p>
    </div>
  );
}
