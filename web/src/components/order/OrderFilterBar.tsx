import { CalendarDays, Search, Sparkles, X } from 'lucide-react';
import { DISH_FILTER_OPTIONS, MEAL_OPTIONS, type MealType } from '../../api/types';
import { dayLabelForDate } from '../../lib/format';
import { Segmented, cn } from '../ui/base';

/**
 * 点菜页的吸顶筛选条：点菜目标（哪天 + 哪一餐）、搜索框 + 配一桌、分类 chips。
 * 目标同时是菜单排序/推荐的口径与加菜的落点；单道菜的日期覆盖在菜品详情弹层里。
 * 只负责展示与回调，状态本身留在页面（它喂给列表请求、排序与购物车）。
 */
export function OrderFilterBar({
  mealType,
  onSelectMealType,
  targetDate,
  onOpenTarget,
  keyword,
  onKeywordChange,
  category,
  onSelectCategory,
  comboLoading,
  onBuildCombo,
}: {
  mealType: MealType;
  onSelectMealType: (mealType: MealType) => void;
  targetDate: string;
  /** 打开「给哪天点」弹层（弹层由页面渲染：筛选条是 backdrop-blur 元素，固定层不能嵌在里面） */
  onOpenTarget: () => void;
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  category: string;
  onSelectCategory: (category: string) => void;
  comboLoading: boolean;
  onBuildCombo: () => void;
}) {
  return (
    <>
      {/* 吸顶位置 = 页头高度(62px) + 灵动岛让位：页头在全面屏下会变高这么多 */}
      <div className="glass-panel sticky top-[calc(env(safe-area-inset-top,0px)+62px)] z-20 space-y-2.5 px-4 py-2.5 lg:grid lg:grid-cols-[auto_230px_1fr] lg:items-center lg:gap-x-3 lg:gap-y-2.5 lg:space-y-0">
        {/* 点菜目标：哪天 + 哪一餐。加菜、排序、配一桌都用这一份口径 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenTarget}
            aria-label="选择给哪天点菜"
            className="press flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-cream-300 bg-white px-3 text-[13px] font-medium text-ink-900"
          >
            <CalendarDays size={14} className="text-brand-500" />
            {dayLabelForDate(targetDate)}
          </button>
          <Segmented className="flex-1" value={mealType} onChange={onSelectMealType} options={MEAL_OPTIONS} />
        </div>

        <div className="flex items-center gap-2">
          <div className="flex h-10 flex-1 items-center gap-2 rounded-full border border-cream-300 bg-white px-3">
            <Search size={15} className="shrink-0 text-ink-200" />
            <input
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              placeholder="搜菜名或食材，如红烧、土豆"
              className="h-full w-full bg-transparent text-[14px] placeholder:text-ink-200"
            />
            {keyword ? (
              <button type="button" onClick={() => onKeywordChange('')} aria-label="清空">
                <X size={15} className="text-ink-200" />
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onBuildCombo}
            disabled={comboLoading}
            className="press flex h-10 shrink-0 items-center gap-1 rounded-full warm-gradient px-3.5 text-[12px] font-medium text-white shadow-float disabled:opacity-60"
          >
            <Sparkles size={14} />
            {comboLoading ? '配菜中' : mealType === 'breakfast' ? '配早餐' : '配一桌'}
          </button>
        </div>

        <div className="no-scrollbar flex gap-2 overflow-x-auto pb-0.5 lg:col-span-3">
          {DISH_FILTER_OPTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onSelectCategory(item)}
              className={cn(
                'press shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition',
                category === item
                  ? 'warm-gradient text-white shadow-float'
                  : 'border border-cream-300 bg-white text-ink-600',
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
