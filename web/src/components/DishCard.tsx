import { Clock, Flame, Plus, Refrigerator } from 'lucide-react';
import type { Dish } from '../api/types';
import type { DishStockInfo } from '../hooks/useDishStockInfo';
import { cn } from './ui/base';
import { SpicyMark } from './SpicyMark';

/** 菜品卡：以食物视觉为主角，右下角是唯一的加购动作 */
export function DishCard({
  dish,
  servings,
  onAdd,
  onOpen,
  ingredientHits,
  stockInfo,
}: {
  dish: Dish;
  servings?: number;
  onAdd: () => void;
  onOpen?: () => void;
  /** 搜索关键词命中的食材名：非空时替代左下角标签显示「含 xx」，说明这道菜为什么被搜出来 */
  ingredientHits?: string[];
  /** 冰箱清空计划：核心（必有）食材齐就能做，连可选也齐才是「一点不用买」 */
  stockInfo?: DishStockInfo;
}) {
  const canMake = stockInfo?.canMake ?? false;
  const freeAll = stockInfo?.freeAll ?? false;
  const optionalMissing = stockInfo ? stockInfo.optionalTotal - stockInfo.optionalMatched : 0;

  return (
    <article
      className={cn(
        'card animate-fade-up overflow-hidden',
        freeAll ? 'ring-2 ring-fresh/60' : canMake ? 'ring-1 ring-fresh/30' : undefined,
      )}
    >
      <button type="button" onClick={onOpen} className="relative block w-full text-left">
        <div
          className={cn(
            'relative flex h-[104px] items-center justify-center overflow-hidden',
            dish.is_fried
              ? 'bg-linear-to-br from-brand-100 to-brand-200'
              : 'bg-linear-to-br from-cream-200 to-brand-50',
          )}
        >
          {/* 有实拍图铺满整个视觉区（渐变是加载时的底色），没图的菜继续用 emoji */}
          {dish.image_url ? (
            <img
              src={dish.image_url}
              alt={dish.name}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <span className="text-[42px] drop-shadow-xs">{dish.emoji}</span>
          )}
          <span className="absolute left-2 top-2 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-medium text-ink-600">
            {dish.category}
          </span>
          {dish.cook_minutes > 0 ? (
            <span className="absolute bottom-2 left-2 flex items-center gap-0.5 rounded-full bg-white/85 px-1.5 py-0.5 text-[10px] text-ink-600">
              <Clock size={10} />
              {dish.cook_minutes}分
            </span>
          ) : null}
          {/* 徽章分两级：可选也齐 = 一点不用买；仅必有齐 = 缺的可选跳过就能做 */}
          {canMake ? (
            <span
              className={cn(
                'absolute bottom-2 right-2 flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                freeAll
                  ? 'bg-fresh text-white shadow-float'
                  : 'border border-fresh/40 bg-white/90 text-fresh shadow-card',
              )}
            >
              <Refrigerator size={10} strokeWidth={2.5} />
              {freeAll ? '无需买菜' : '能做'}
            </span>
          ) : null}
          {dish.is_fried ? (
            <span className="absolute right-2 top-2 flex items-center gap-0.5 rounded-full bg-alert/90 px-1.5 py-0.5 text-[10px] text-white">
              <Flame size={10} />
              油炸
            </span>
          ) : null}
        </div>
      </button>

      <div className="p-2.5">
        <div className="flex items-start justify-between gap-1">
          {/* 菜名也能打开详情：点名字看做法/营养是最自然的入口，不能只有图片可点 */}
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <h3 className="line-clamp-1 text-[14px] font-semibold leading-5">{dish.name}</h3>
          </button>
          <SpicyMark spicy={dish.spicy} />
        </div>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-ink-400">
          {dish.nutrition.kcal} kcal · 蛋白 {dish.nutrition.protein}g
        </p>

        <div className="mt-2 flex items-center justify-between">
          {ingredientHits && ingredientHits.length > 0 ? (
            <span className="truncate text-[11px] font-medium text-brand-600">
              含 {ingredientHits.slice(0, 2).join('、')}
              {ingredientHits.length > 2 ? ' 等' : ''}
            </span>
          ) : canMake ? (
            <span className="truncate text-[11px] font-medium text-fresh">
              {freeAll ? '库存全齐' : `可选缺 ${optionalMissing} 样`}
            </span>
          ) : stockInfo ? (
            <span className="truncate text-[11px] font-medium text-alert">缺 {stockInfo.requiredMissing} 样核心料</span>
          ) : (
            <span className="truncate text-[11px] text-ink-400">{dish.tags[0] ?? '家常菜'}</span>
          )}
          <button
            type="button"
            onClick={onAdd}
            aria-label={`添加 ${dish.name}`}
            className={cn(
              'press flex h-7 items-center gap-0.5 rounded-full px-2.5 text-[12px] font-medium',
              servings ? 'bg-brand-500 text-white' : 'warm-gradient text-white shadow-float',
            )}
          >
            <Plus size={13} strokeWidth={3} />
            {servings ? `已选 ${servings}` : '加入'}
          </button>
        </div>
      </div>
    </article>
  );
}
