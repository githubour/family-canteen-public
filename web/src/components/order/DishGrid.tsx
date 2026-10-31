import { Lightbulb } from 'lucide-react';
import type { Dish } from '../../api/types';
import type { DishStockInfo } from '../../hooks/useDishStockInfo';
import { DishCard } from '../DishCard';
import { Button } from '../ui/base';
import { CardSkeleton, EmptyState, ErrorState } from '../ui/feedback';

/**
 * 菜品网格，把「骨架屏 / 空态 / 网格 + 提个新菜」三态收口在一处。
 * 注意骨架屏只在还没有任何数据时铺（移除菜品、下架恢复这类重刷走后台刷新，
 * 旧列表保持挂载——换成骨架屏会把几千像素高的网格塌成几排，滚动位置直接被顶回页顶）。
 */
export function DishGrid({
  loading,
  total,
  dishes,
  keyword,
  servingsOf,
  ingredientHits,
  stockInfo,
  onAdd,
  onOpen,
  onRequestDish,
  onShowAll,
  error,
  onRetry,
}: {
  /** 首次进页，还没有任何数据 */
  loading: boolean;
  /** 服务端返回的条数（空态判定用它，而不是「只看免买」过滤后的条数） */
  total: number;
  dishes: Dish[];
  keyword: string;
  servingsOf: Map<number, number>;
  ingredientHits: Map<number, string[]>;
  stockInfo: Map<number, DishStockInfo>;
  onAdd: (dish: Dish) => void;
  onOpen: (dish: Dish) => void;
  onRequestDish: (name: string) => void;
  onShowAll: () => void;
  /** 加载失败且没有旧数据可展示时，给出重试入口而不是「没找到这道菜」 */
  error?: string | null;
  onRetry?: () => void;
}) {
  // 错误优先于骨架：首次加载失败时 loading 也可能仍为 true，
  // 若先渲染骨架，用户会永远看不到原因与重试入口。
  if (error && total === 0) {
    return <ErrorState title="菜单没加载出来" description={error} onRetry={onRetry} />;
  }

  if (loading) return <CardSkeleton count={6} />;

  if (total === 0) {
    return (
      <EmptyState
        emoji="🔍"
        title="没找到这道菜"
        description="换个关键词试试，或者把它提给菜单，等统一加入。"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {keyword.trim() ? (
              <Button onClick={() => onRequestDish(keyword.trim())}>提交「{keyword.trim()}」</Button>
            ) : null}
            <Button variant="soft" onClick={onShowAll}>
              查看全部
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
        {dishes.map((dish) => (
          <DishCard
            key={dish.id}
            dish={dish}
            servings={servingsOf.get(dish.id)}
            ingredientHits={ingredientHits.get(dish.id)}
            stockInfo={stockInfo.get(dish.id)}
            onAdd={() => onAdd(dish)}
            onOpen={() => onOpen(dish)}
          />
        ))}
      </div>
      {/* 常驻入口：搜不到时也能直接提，不用先搜一遍 */}
      <button
        type="button"
        onClick={() => onRequestDish('')}
        className="press mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl2 border border-dashed border-cream-400 bg-white/60 py-3 text-[13px] font-medium text-ink-600"
      >
        <Lightbulb size={15} className="text-brand-500" />
        想吃菜单里没有的？提个新菜
      </button>
    </>
  );
}
