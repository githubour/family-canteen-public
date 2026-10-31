import { cn } from '../ui/base';

/**
 * 冰箱清空计划的横幅，两种态：
 * - 一个都没登记：虚线引导条——不登记的话排序、能做标记这些能力对用户就是隐形的
 * - 登记过：绿色横幅，显示样数与「核心食材齐、现在能做」的菜数，右侧带「只看能做」开关
 */
export function FridgeStockBanner({
  ready,
  hasStock,
  stockCount,
  canMakeCount,
  onlyFree,
  onToggleOnlyFree,
  onRegister,
}: {
  /** fridge 请求已回来（null 时先不渲染引导条，避免闪现） */
  ready: boolean;
  hasStock: boolean;
  stockCount: number;
  /** 必有食材齐、现在就能做的菜数（可选缺了跳过即可） */
  canMakeCount: number;
  onlyFree: boolean;
  onToggleOnlyFree: () => void;
  onRegister: () => void;
}) {
  return (
    <>
      {ready && !hasStock ? (
        <button
          type="button"
          onClick={onRegister}
          className="press mb-3 mt-2.5 flex w-full items-center gap-2.5 rounded-xl2 border border-dashed border-fresh/40 bg-white/60 px-3.5 py-2.5 text-left"
        >
          <span className="text-xl">🧊</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-fresh">冰箱里有什么？登记一下</span>
            <span className="block truncate text-[11px] leading-4 text-ink-600">
              登记后，用得上库存的菜自动排到前面，先吃快放坏的。
            </span>
          </span>
          <span className="shrink-0 rounded-full bg-fresh px-2.5 py-1 text-[11px] font-medium text-white shadow-float">
            去登记
          </span>
        </button>
      ) : null}

      {hasStock ? (
        <div className="mb-3 mt-2.5 flex items-center gap-2.5 rounded-xl2 border border-fresh/30 bg-linear-to-r from-fresh/10 to-cream-100 px-3.5 py-2.5">
          <button
            type="button"
            onClick={onRegister}
            aria-label="编辑库存登记"
            className="press shrink-0 text-xl leading-none"
          >
            🧊
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-fresh">
              库存 · {stockCount} 样
              <span className="ml-1.5 font-normal text-ink-400">
                {canMakeCount > 0 ? `其中 ${canMakeCount} 道现在能做` : '还没哪道菜凑齐核心食材'}
              </span>
            </p>
            <p className="truncate text-[11px] leading-4 text-ink-600">
              核心食材齐的菜排在了前面；缺的只是可选配料，跳过就行。
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleOnlyFree}
            className={cn(
              'press shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition',
              onlyFree ? 'bg-fresh text-white shadow-float' : 'border border-fresh/40 bg-white text-fresh',
            )}
          >
            {onlyFree ? '看全部' : '只看能做'}
          </button>
        </div>
      ) : null}
    </>
  );
}
