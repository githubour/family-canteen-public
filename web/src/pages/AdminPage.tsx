import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings2 } from 'lucide-react';
import { api } from '../api/client';
import { useServerEvents } from '../api/sse';
import { DishRequestPanel } from '../components/DishRequestPanel';
import { MemberAdminPanel } from '../components/MemberAdminPanel';
import { NutritionPanel } from '../components/NutritionPanel';
import { OverviewPanel } from '../components/OverviewPanel';
import { PageHeader } from '../components/PageHeader';
import { SettingsSheet } from '../components/SettingsSheet';
import { cn } from '../components/ui/base';
import { ErrorState } from '../components/ui/feedback';
import { useAsync } from '../hooks/useAsync';

type Tab = 'overview' | 'nutrition' | 'requests' | 'family';
const TAB_KEYS: Tab[] = ['overview', 'nutrition', 'requests', 'family'];

export function AdminPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // URL 参数一次性消费：外部跳转用 ?tab=… 直达指定页签，消费完立刻清掉——
  // 之后切页签、刷新都不会再被旧参数牵着走
  const [tab, setTab] = useState<Tab>(() => {
    const fromUrl = searchParams.get('tab');
    return fromUrl && (TAB_KEYS as string[]).includes(fromUrl) ? (fromUrl as Tab) : 'overview';
  });
  useEffect(() => {
    if (searchParams.toString() !== '') setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 家人提的新菜：页签上要显示条数，所以在这里取一次，面板复用同一份数据
  const requests = useAsync(() => api.dishRequests.list(), []);
  useServerEvents({ 'dish-request:updated': requests.reload });

  const requestCount = requests.data?.requests.length ?? 0;
  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: 'overview', label: '汇总' },
    { key: 'nutrition', label: '营养' },
    { key: 'requests', label: '新菜', badge: requestCount },
    { key: 'family', label: '家人' },
  ];

  return (
    <div className="pb-28 lg:pb-8">
      <PageHeader
        title="后台汇总"
        subtitle="每天点了什么 · 吃得怎么样"
        action={
          <button
            type="button"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
            className="press flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink-600 shadow-card"
          >
            <Settings2 size={16} />
          </button>
        }
      />

      <div className="px-4 pt-3">
        <div className="flex gap-1 rounded-full bg-cream-200/80 p-1 lg:max-w-sm">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                // whitespace-nowrap：页签文案在窄屏上不能折成两行
                'press flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-full py-1.5 text-[13px] transition',
                tab === item.key ? 'bg-white font-semibold text-brand-600 shadow-card' : 'font-medium text-ink-600',
              )}
            >
              {item.label}
              {item.badge ? (
                <span
                  className={cn(
                    'min-w-[18px] rounded-full px-1 text-[10px] leading-[18px]',
                    tab === item.key ? 'bg-brand-500 text-white' : 'bg-cream-400 text-ink-600',
                  )}
                >
                  {item.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' ? <OverviewPanel /> : null}
      {tab === 'nutrition' ? <NutritionPanel /> : null}
      {tab === 'requests' ? (
        requests.error && !requests.data ? (
          <div className="px-4 pt-3">
            <ErrorState title="新菜建议没加载出来" description={requests.error} onRetry={requests.reload} />
          </div>
        ) : (
          <DishRequestPanel
            requests={requests.data?.requests ?? []}
            loading={requests.loading}
            onReload={requests.reload}
          />
        )
      ) : null}
      {tab === 'family' ? <MemberAdminPanel /> : null}

      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
