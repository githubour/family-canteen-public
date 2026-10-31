import { useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { api } from '../api/client';
import { useServerEvents } from '../api/sse';
import { MEAL_LABEL, type NutritionReport } from '../api/types';
import { NutritionRing, ReferenceBar } from './NutritionGauge';
import { EmptyState, ErrorState, Skeleton } from './ui/feedback';
import { cn } from './ui/base';
import { DaySwitcher } from './ui/DaySwitcher';
import { useAsync } from '../hooks/useAsync';
import { todayISO } from '../lib/format';

const ADVICE_STYLE = {
  good: { icon: CheckCircle2, className: 'bg-fresh/10 text-fresh', title: 'text-fresh' },
  info: { icon: Info, className: 'bg-cool/10 text-cool', title: 'text-cool' },
  warn: { icon: AlertTriangle, className: 'bg-warn/15 text-[#B45309]', title: 'text-[#B45309]' },
} as const;

const PIE_COLORS = ['#FF6B35', '#FFB347', '#16A34A', '#2563EB', '#F472B6', '#F59E0B', '#9C948C'];

export function NutritionPanel() {
  const [date, setDate] = useState(todayISO());
  const query = useAsync(() => api.nutrition.report(date), [date]);
  const report: NutritionReport | null = query.data?.report ?? null;

  // 订单变化会改人均摄入；在外吃规则/默认人数变化也要重新折算
  useServerEvents({
    'order:created': query.reload,
    'order:updated': query.reload,
    'order:deleted': query.reload,
    'settings:updated': query.reload,
  });

  // 参照区间由后端按在家餐次折算过，这里直接取来用，避免和上面写死的数字打架
  const energyRef = report?.references.find((item) => item.label === '能量') ?? null;
  const awayMeals = report?.meals.filter((meal) => !meal.at_home) ?? [];

  return (
    <div className="space-y-4 px-4 pt-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
      <DaySwitcher date={date} onChange={setDate} className="lg:col-span-2" />

      {query.error ? (
        <div className="lg:col-span-2">
          <ErrorState title="营养报告没加载出来" description={query.error} onRetry={query.reload} />
        </div>
      ) : query.loading || !report ? (
        <div className="space-y-3 lg:col-span-2">
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : report.dish_count === 0 ? (
        <div className="lg:col-span-2">
          <EmptyState emoji="🥗" title="这一天还没有点菜" description="有订单后这里会自动算出人均营养摄入。" />
        </div>
      ) : (
        <>
          <section className="card p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[15px] font-semibold">家里人均营养摄入</p>
                <p className="text-[11px] text-ink-400">
                  {report.headcount} 人 · {report.dish_count} 道菜 · 脂肪供能比 {report.fat_energy_ratio}%
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {report.meals.map((meal) => (
                <span
                  key={meal.meal_type}
                  className={cn('chip', meal.at_home ? 'bg-fresh/10 text-fresh' : 'bg-cream-200 text-ink-400')}
                >
                  {MEAL_LABEL[meal.meal_type]}
                  {meal.at_home ? '在家' : '在外'}
                </span>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-around">
              <NutritionRing
                value={report.per_capita.kcal}
                max={energyRef ? energyRef.max : 2000}
                label="热量"
                unit="kcal"
                caption={energyRef ? `参考 ${energyRef.min}~${energyRef.max}` : undefined}
              />
              <div className="space-y-1.5 text-[12px]">
                <Row label="蛋白质" value={`${report.per_capita.protein} g`} />
                <Row label="脂肪" value={`${report.per_capita.fat} g`} />
                <Row label="碳水" value={`${report.per_capita.carb} g`} />
                <Row label="膳食纤维" value={`${report.per_capita.fiber} g`} />
                <Row label="食盐" value={`${report.salt_gram} g`} />
              </div>
            </div>
          </section>

          <section className="card p-4">
            <p className="mb-1 text-[15px] font-semibold">对照《中国居民膳食指南》</p>
            <p className="mb-2 text-[11px] leading-4 text-ink-400">
              {awayMeals.length > 0
                ? `这一天有 ${awayMeals.length} 餐在外吃（${awayMeals
                    .map((meal) => MEAL_LABEL[meal.meal_type])
                    .join('、')}），推荐区间已按在家的 ${report.home_meals} 餐等比折算，绿色区落在里面即为达标`
                : '绿色区是推荐区间，落在里面即为达标'}
            </p>
            <div className="divide-y divide-cream-200">
              {report.references.map((reference) => (
                <ReferenceBar key={reference.label} reference={reference} />
              ))}
            </div>
          </section>

          <section className="card p-4">
            <p className="mb-3 text-[15px] font-semibold">今日建议</p>
            <div className="space-y-2.5">
              {report.advice.map((item) => {
                const style = ADVICE_STYLE[item.level];
                return (
                  <div key={item.id} className="flex gap-2.5 rounded-xl2 bg-cream-100 p-3">
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', style.className)}>
                      <style.icon size={15} />
                    </span>
                    <div className="min-w-0">
                      <p className={cn('text-[13px] font-semibold', style.title)}>{item.title}</p>
                      <p className="mt-0.5 text-[12px] leading-5 text-ink-600">{item.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 rounded-xl2 bg-cream-200/70 px-3 py-2 text-[11px] leading-5 text-ink-400">
              以上基于预置食材营养数据与点单份数估算，仅供参考，不构成医疗或营养处方建议。
            </p>
          </section>

          <section className="card p-4">
            <p className="mb-1 text-[15px] font-semibold">热量来源分布</p>
            <p className="mb-2 text-[11px] text-ink-400">人均口径，按食材类别拆分</p>
            <div className="flex items-center gap-4">
              <div className="h-36 w-36 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={report.by_category}
                      dataKey="kcal"
                      nameKey="category"
                      innerRadius={38}
                      outerRadius={62}
                      paddingAngle={3}
                      stroke="none"
                    >
                      {report.by_category.map((entry, index) => (
                        <Cell key={entry.category} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => [`${value} kcal`, '人均热量']}
                      contentStyle={{ borderRadius: 14, border: '1px solid #F5EDE6', fontSize: 12 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="flex-1 space-y-1.5">
                {report.by_category.slice(0, 6).map((entry, index) => (
                  <li key={entry.category} className="flex items-center gap-2 text-[12px]">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}
                    />
                    <span className="flex-1">{entry.category}</span>
                    <span className="tabular-nums text-ink-400">{entry.kcal} kcal</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-ink-400">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
