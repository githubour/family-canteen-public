import { useState } from 'react';
import { Copy, X } from 'lucide-react';
import { api } from '../api/client';
import type { DishRequest } from '../api/types';
import { Button } from './ui/base';
import { EmptyState, Sheet, Skeleton } from './ui/feedback';
import { toast } from './ui/toast';
import { relativeDateTime } from '../lib/format';
import { copyText } from '../lib/poster';
import { runAction } from '../lib/runAction';

/**
 * 新菜建议清单：家人提的菜名攒在这里，由开发者统一补配料后加入菜单。
 * 复制出来是一条菜名一行，方便直接粘进种子文件。
 */
export function DishRequestPanel({
  requests,
  loading,
  onReload,
}: {
  requests: DishRequest[];
  loading: boolean;
  onReload: () => void;
}) {
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const copyNames = async () => {
    const ok = await copyText(requests.map((item) => item.name).join('\n'));
    toast(ok ? `已复制 ${requests.length} 个菜名` : '复制失败，请手动选择', ok ? 'success' : 'error');
  };

  const removeOne = async (item: DishRequest) => {
    await runAction(async () => {
      await api.dishRequests.remove(item.id);
      toast(`已移除「${item.name}」`, 'success');
      onReload();
    }, '没移除掉，请重试');
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await runAction(async () => {
        const result = await api.dishRequests.clear();
        toast(`已清空 ${result.removed} 条新菜建议`, 'success');
        setClearOpen(false);
        onReload();
      }, '清空失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 px-4 pt-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
      <section className="card p-4 lg:col-span-2">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[13px] text-ink-400">待统一加入菜单</p>
            <p className="mt-0.5 text-[22px] font-semibold leading-none tabular-nums">
              {requests.length}
              <span className="text-[13px] font-normal text-ink-400"> 个菜名</span>
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="soft" size="sm" disabled={requests.length === 0} onClick={() => void copyNames()}>
              <Copy size={13} />
              复制菜名
            </Button>
            <Button variant="ghost" size="sm" disabled={requests.length === 0} onClick={() => setClearOpen(true)}>
              清空
            </Button>
          </div>
        </div>
        <p className="mt-3 rounded-xl2 bg-cream-100 px-3 py-2 text-[11px] leading-5 text-ink-400">
          这些菜还没有配料表与营养数据，所以暂时点不了。复制出来是一条一行，
          可以直接粘到菜品种子里补齐后再回来清空。
        </p>
      </section>

      {loading && requests.length === 0 ? (
        <>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </>
      ) : requests.length === 0 ? (
        <div className="lg:col-span-2">
          <EmptyState
            emoji="📝"
            title="还没有人提新菜"
            description="在点菜页搜不到想吃的，点底部的「提个新菜」把名字记下来，会汇总到这里。"
          />
        </div>
      ) : (
        requests.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-3 rounded-xl2 border border-cream-300 bg-white p-3"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
              style={{ backgroundColor: item.member ? `${item.member.color}22` : '#F5EDE6' }}
            >
              {item.member?.avatar ?? '🙂'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">{item.name}</p>
              <p className="truncate text-[11px] text-ink-400">
                {item.member ? item.member.name : '匿名'} · {relativeDateTime(item.created_at)}
                {item.note ? ` · ${item.note}` : ''}
              </p>
            </div>
            <button
              type="button"
              aria-label={`移除 ${item.name}`}
              onClick={() => void removeOne(item)}
              className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cream-200 text-ink-600"
            >
              <X size={13} />
            </button>
          </div>
        ))
      )}

      <Sheet open={clearOpen} onClose={() => setClearOpen(false)} title="清空新菜清单">
        <div className="pb-6">
          <p className="text-[14px] leading-6 text-ink-600">
            确定清空这 {requests.length} 条建议吗？一般是在它们已经加进菜单之后再做。
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" block onClick={() => setClearOpen(false)}>
              先不清
            </Button>
            <Button variant="danger" block disabled={busy} onClick={() => void clearAll()}>
              {busy ? '清空中…' : '确认清空'}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
