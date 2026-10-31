import { BookOpen } from 'lucide-react';
import type { MealSummary } from '../api/types';
import { cn } from './ui/base';

/** 菜谱摘要里一道菜的形状：菜品汇总（配料/做法/份数），订单条目里只有菜名没有这些 */
export type SummaryDish = MealSummary['dishes'][number];

/**
 * 菜谱展开内容：每人份配料 chips + 编号步骤。
 * 菜谱卡的菜名行（DishRecipeRow）和大厨页订单卡里点菜名的下拉共用，
 * 只负责展示，展开开关由使用方保管。
 * 配料里「可选」的（required = false）用虚框弱化：备料时不用为它们专门跑一趟。
 */
export function DishRecipeDetail({ dish }: { dish: SummaryDish }) {
  const stepLines = dish.steps.split('\n').filter((line) => line.trim() !== '');

  return (
    <div className="px-3.5 py-3">
      {dish.ingredients.length > 0 ? (
        <>
          <p className="mb-1.5 text-[12px] font-semibold text-ink-600">
            配料 · 每人份（这餐 {dish.servings} 份）
          </p>
          <div className="flex flex-wrap gap-1.5">
            {dish.ingredients.map((item) => (
              <span
                key={item.name}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[12px]',
                  item.required
                    ? 'bg-cream-100 text-ink-600'
                    : 'border border-dashed border-cream-400 bg-white/60 text-ink-400',
                )}
              >
                {item.name} {item.amount}g
                {item.is_pantry ? (
                  <span className="ml-1 text-[10px] text-ink-400">常备</span>
                ) : !item.required ? (
                  <span className="ml-1 text-[10px]">可选</span>
                ) : null}
              </span>
            ))}
          </div>
        </>
      ) : null}

      {stepLines.length > 0 ? (
        <>
          <p className="mb-2 mt-3 flex items-center gap-1.5 text-[12px] font-semibold text-ink-600">
            <BookOpen size={13} className="text-brand-500" />
            做法 · {stepLines.length} 步
          </p>
          <ol className="space-y-2">
            {stepLines.map((line, index) => (
              <li key={index} className="flex gap-2.5">
                <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-600">
                  {index + 1}
                </span>
                <span className="text-[13px] leading-5 text-ink-600">{line}</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
