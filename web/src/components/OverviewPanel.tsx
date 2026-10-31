import { useState } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api/client';
import { useServerEvents } from '../api/sse';
import type { AnalyticsOverview } from '../api/types';
import { Badge, cn } from './ui/base';
import { ErrorState, Skeleton, StatTile } from './ui/feedback';
import { useAsync } from '../hooks/useAsync';
import { dateRangeLabel, formatDateCN, formatNumber } from '../lib/format';

const PIE_COLORS = ['#FF6B35', '#FFB347', '#16A34A', '#2563EB', '#F472B6', '#F59E0B'];

/**
 * 趋势点：当天有餐次在外吃就画成空心。
 * 只在家吃晚餐的日子数值天然偏低，实心点会让人误读成「这天吃太少」。
 */
function PartialDayDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { home_meals?: number } }) {
  if (cx === undefined || cy === undefined) return null;
  const away = (payload?.home_meals ?? 3) < 3;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={away ? 3.5 : 2.5}
      fill={away ? '#FFF8F3' : '#FF6B35'}
      stroke="#FF6B35"
      strokeWidth={away ? 2 : 1}
    />
  );
}

export function OverviewPanel() {
  const [range, setRange] = useState(7);
  const query = useAsync(() => api.analytics.overview(range), [range]);
  const overview: AnalyticsOverview | null = query.data?.overview ?? null;

  // 后台汇总也可能开着看：另一端下单/完成/取消后，统计要跟着刷新
  useServerEvents({
    'order:created': query.reload,
    'order:updated': query.reload,
    'order:deleted': query.reload,
  });

  // 做菜统计：接单备料即记一笔（不要求点过「做好了」，忘了也不会漏算）
  const cookStats = overview?.cook_stats ?? [];
  const cookServings = cookStats.reduce((sum, item) => sum + item.servings, 0);
  const cookKcal = cookStats.reduce((sum, item) => sum + item.kcal, 0);

  return (
    <div className="space-y-4 px-4 pt-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
      <div className="flex gap-2 lg:col-span-2">
        {[7, 14, 30].map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setRange(days)}
            className={cn(
              'press rounded-full px-3.5 py-1.5 text-[12px] font-medium transition',
              range === days ? 'warm-gradient text-white shadow-float' : 'border border-cream-300 bg-white text-ink-600',
            )}
          >
            {dateRangeLabel(days)}
          </button>
        ))}
      </div>

      {query.error ? (
        <div className="lg:col-span-2">
          <ErrorState
            title="汇总数据没加载出来"
            description={query.error}
            onRetry={query.reload}
          />
        </div>
      ) : query.loading || !overview ? (
        <div className="space-y-3 lg:col-span-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:col-span-2 lg:grid-cols-4">
            <StatTile label="点单次数" value={overview.order_count} unit="单" />
            <StatTile label="订单份数" value={overview.serving_count} unit="份" tone="fresh" />
            <StatTile label="平均每餐" value={overview.avg_dishes_per_meal} unit="道菜" tone="cool" />
            <StatTile label="家里人均热量" value={overview.avg_kcal_per_capita} unit="kcal/天" tone="warn" />
          </div>

          <section className="card p-4 lg:col-span-2">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold">做菜统计</p>
              {cookStats.length > 0 ? (
                <p className="shrink-0 text-[11px] text-ink-400">
                  累计 {cookServings} 份 · 约 {formatNumber(cookKcal)} kcal
                </p>
              ) : null}
            </div>
            {cookStats.length === 0 ? (
              <p className="py-4 text-center text-[12px] leading-5 text-ink-400">
                还没有做菜记录。大厨在订单上点「接单备料」就会记一笔，
                这里按人统计做了多少次、多少道菜、多少卡路里。
              </p>
            ) : (
              <div className="lg:grid lg:grid-cols-2 lg:gap-2.5">
                {cookStats.map((stat) => (
                  <div
                    key={stat.member_id ?? 'unknown'}
                    className="flex items-center gap-3 rounded-xl2 bg-cream-100 p-3"
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl"
                      style={{ backgroundColor: `${stat.color}22` }}
                    >
                      {stat.avatar}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold">
                        {stat.name}
                        <span className="ml-1.5 text-[11px] font-normal text-ink-400">
                          下厨 {stat.cook_count} 次
                        </span>
                      </p>
                      <p className="truncate text-[11px] text-ink-400">
                        {stat.dishes} 道菜次 · 共 {stat.servings} 份 · 约 {formatNumber(stat.kcal)} kcal
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card p-4">
            <p className="text-[15px] font-semibold">每日家里人均热量</p>
            <p className="mb-3 text-[11px] leading-4 text-ink-400">
              只统计在家里吃的部分（近 {overview.range_days} 天：在家 {overview.home_meal_count} 餐 · 在外{' '}
              {overview.away_meal_count} 餐）；空心点 = 这天有餐次在外吃
            </p>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={overview.trend} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
                  <XAxis
                    dataKey="date"
                    tickFormatter={(value: string) => value.slice(5)}
                    tick={{ fontSize: 10, fill: '#9C948C' }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10, fill: '#9C948C' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    labelFormatter={(value) => `${formatDateCN(String(value))}`}
                    formatter={(value, name) => [value, name === 'kcal' ? '人均热量' : '菜品数']}
                    contentStyle={{ borderRadius: 14, border: '1px solid #F5EDE6', fontSize: 12 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="kcal"
                    stroke="#FF6B35"
                    strokeWidth={2.5}
                    dot={<PartialDayDot />}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="card p-4">
            <p className="mb-3 text-[15px] font-semibold">点得最多的菜</p>
            {overview.top_dishes.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-ink-400">这段时间还没有点单记录</p>
            ) : (
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={overview.top_dishes}
                    layout="vertical"
                    margin={{ top: 0, right: 16, bottom: 0, left: 8 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={78}
                      tick={{ fontSize: 11, fill: '#6B6560' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      formatter={(value) => [`${value} 份`, '点单量']}
                      contentStyle={{ borderRadius: 14, border: '1px solid #F5EDE6', fontSize: 12 }}
                    />
                    <Bar dataKey="count" radius={[0, 8, 8, 0]} barSize={13}>
                      {overview.top_dishes.map((entry, index) => (
                        // 菜被删掉后 dish_id 为空，用菜名兜底做 key
                        <Cell
                          key={entry.dish_id ?? entry.name}
                          fill={PIE_COLORS[index % PIE_COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section className="card p-4">
            <p className="mb-1 text-[15px] font-semibold">菜系结构</p>
            <p className="mb-2 text-[11px] text-ink-400">各菜系点单的比例，长期偏一边就要调一调</p>
            <div className="flex items-center gap-4">
              <div className="h-36 w-36 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={overview.category_distribution}
                      dataKey="count"
                      nameKey="category"
                      innerRadius={38}
                      outerRadius={62}
                      paddingAngle={3}
                      stroke="none"
                    >
                      {overview.category_distribution.map((entry, index) => (
                        <Cell key={entry.category} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => [`${value} 份`, '点单量']}
                      contentStyle={{ borderRadius: 14, border: '1px solid #F5EDE6', fontSize: 12 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="flex-1 space-y-1.5">
                {overview.category_distribution.map((entry, index) => (
                  <li key={entry.category} className="flex items-center gap-2 text-[12px]">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}
                    />
                    <span className="flex-1">{entry.category}</span>
                    <span className="tabular-nums text-ink-400">{entry.count} 份</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="card p-4">
            <p className="mb-3 text-[15px] font-semibold">家人的口味画像</p>
            <div className="space-y-2.5">
              {overview.member_profiles.map((profile) => (
                <div key={profile.member_id} className="flex items-center gap-3 rounded-xl2 bg-cream-100 p-3">
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-full text-xl"
                    style={{ backgroundColor: `${profile.color}22` }}
                  >
                    {profile.avatar}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold">
                      {profile.name}
                      <span className="ml-1.5 text-[11px] font-normal text-ink-400">
                        {profile.order_count} 次点单
                      </span>
                    </p>
                    <p className="truncate text-[11px] text-ink-400">
                      最爱 {profile.favorite_dish ?? '还没数据'}
                      {profile.favorite_category ? ` · 偏好${profile.favorite_category}` : ''}
                      {profile.avg_spicy > 0 ? ` · 平均辣度 ${profile.avg_spicy}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {profile.top_tags.slice(0, 2).map((tag) => (
                      <Badge key={tag} tone="brand">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
