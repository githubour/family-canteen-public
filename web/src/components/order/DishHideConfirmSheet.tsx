import { EyeOff } from 'lucide-react';
import type { Dish } from '../../api/types';
import { Button } from '../ui/base';
import { Sheet } from '../ui/feedback';

/** 「家里不做这道菜」的二次确认：移除是软下架，历史订单与营养汇总不受影响 */
export function DishHideConfirmSheet({
  dish,
  onClose,
  onConfirm,
  hiding,
}: {
  /** null = 关闭 */
  dish: Dish | null;
  onClose: () => void;
  onConfirm: () => void;
  hiding: boolean;
}) {
  return (
    <Sheet open={Boolean(dish)} onClose={onClose} title="从菜单移除">
      {dish ? (
        <div className="pb-6">
          <div className="flex items-center gap-3 rounded-xl2 bg-cream-100 p-3">
            <span className="text-2xl">{dish.emoji}</span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold">{dish.name}</p>
              <p className="text-[11px] text-ink-400">
                {dish.category} · {dish.cook_minutes} 分钟 · 每人份 {dish.nutrition.kcal} kcal
              </p>
            </div>
          </div>
          <p className="mt-3 rounded-xl2 bg-warn/10 px-3 py-2 text-[11px] leading-5 text-[#8A4B00]">
            移除后它不再出现在点菜页、随机和「配一桌」里，历史订单与营养汇总不受影响。
            以后想加回来，去「后台汇总 → 右上角设置 → 菜品」里重新打开。
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" block onClick={onClose}>
              先留着
            </Button>
            <Button variant="danger" block disabled={hiding} onClick={onConfirm}>
              {hiding ? '移除中…' : '确认移除'}
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

/** 供详情弹层复用的入口按钮，避免两处各写一遍移除文案与图标 */
export function DishHideTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press mt-3 flex w-full items-center justify-center gap-1.5 py-2 text-[12px] text-ink-400"
    >
      <EyeOff size={13} />
      家里不做这道菜？从菜单移除
    </button>
  );
}
