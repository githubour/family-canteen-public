import { useMemo, useState } from 'react';
import { ChevronDown, Copy, ImageDown, Plus, RotateCcw, Store, X } from 'lucide-react';
import { api } from '../api/client';
import type { OrphanIngredient, PurchaseItem } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { FridgeStockSheet } from '../components/FridgeStockSheet';
import { ManualItemForm } from '../components/ManualItemForm';
import { PurchaseRow } from '../components/PurchaseRow';
import { AddIngredientSheet } from '../components/purchase/AddIngredientSheet';
import { AmountEditSheet } from '../components/purchase/AmountEditSheet';
import { OrphanDeleteSheet } from '../components/purchase/OrphanDeleteSheet';
import { Button, cn } from '../components/ui/base';
import { ConfirmSheet } from '../components/ui/ConfirmSheet';
import { EmptyState, ErrorState, Progress, Skeleton } from '../components/ui/feedback';
import { DaySwitcher } from '../components/ui/DaySwitcher';
import { toast } from '../components/ui/toast';
import { useAsync } from '../hooks/useAsync';
import { usePrepList } from '../hooks/usePrepList';
import { useServerEvents } from '../api/sse';
import { groupBy } from '../lib/collection';
import { relativeDayLabel, todayISO } from '../lib/format';
import { buildPoster, copyText, downloadPoster } from '../lib/poster';
import { runAction } from '../lib/runAction';

export function PurchasePage() {
  const [date, setDate] = useState(todayISO());
  const [pantryOpen, setPantryOpen] = useState(false);
  // 可选加购：只有可选身份的食材，默认折叠——不买也能做出今天的菜
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseItem | null>(null);
  // 手动调整：补上系统没算到的、去掉今天不需要的（只影响当前这一天）
  const [adjustOpen, setAdjustOpen] = useState(false);
  // 冰箱清空计划弹层开关：从采购页登记库存更顺手（原本在大厨页）
  const [fridgeOpen, setFridgeOpen] = useState(false);
  // 添加食材弹层：库里没有的食材手动补，营养值默认 0（后台可补）
  const [addOpen, setAddOpen] = useState(false);
  // 删除孤立食材：加错了的食材要能清出去，但要先确认（删掉后建菜谱也选不到了）
  const [orphanPending, setOrphanPending] = useState<OrphanIngredient | null>(null);
  // 重置整份清单会清掉勾选/改量/备注/隐藏与手动条目，属于破坏性操作，必须先确认
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // 清单数据与「勾选 / 去掉 / 恢复 / 补手动食材」都收在 usePrepList 里，大厨页的备料弹层用的是同一份。
  // 这里取 'day'（当天三餐合并）：一天通常只买一次菜，按早午晚分三次看反而啰嗦；
  // 服务端把勾选/改量/隐藏按餐扇出，所以备料弹层那边照样是逐餐就绪的。
  // 只认它返回的数据：本地另存一份快照会一直遮住它，
  // SSE 推来的别端勾选 / 新订单拆出的食材就再也显示不出来了（改量、批量勾选的结果也写回同一份）。
  const query = usePrepList(date, 'day');
  const current = query.list;
  // 冰箱清空计划：登记冰箱里现成的食材，点菜页优先消耗（与大厨页同源）
  const fridge = useAsync(() => api.fridge.list(), []);
  // 孤立食材：入了库但没被任何菜引用——提醒建菜谱，跟具体哪餐无关，进页面取一次
  const orphans = useAsync(() => api.purchase.orphans(), []);
  const orphanList = orphans.data?.ingredients ?? [];
  /** 库存格的状态小字与配色都看这个 */
  const fridgeCount = (fridge.data?.items ?? []).length;

  useServerEvents({
    'purchase:updated': query.reload,
    'order:created': query.reload,
    'order:updated': query.reload,
    'order:deleted': query.reload,
    'fridge:updated': fridge.reload,
  });

  const groups = useMemo(
    () => [...groupBy(current?.to_buy ?? [], (item) => item.category).entries()],
    [current],
  );

  const openEdit = (item: PurchaseItem) => {
    setEditing(item);
  };

  /** 数量 / 备注已由弹层解析好（null = 恢复系统计算值），这里只管写回 usePrepList 的同一份数据 */
  const saveEdit = async (item: PurchaseItem, amount: number | null, note: string | null) => {
    await runAction(async () => {
      const result = await api.purchase.setState({
        mealDate: date,
        mealType: 'day',
        // 改量弹层只对手动条目以外的行开放，这里必是系统算出的食材
        ingredientId: item.ingredient_id as number,
        overrideAmount: amount,
        note,
      });
      query.setData(result);
      setEditing(null);
      toast('已更新采购数量', 'success');
    }, '没保存上，请重试');
  };

  /** 系统算出来的食材这一餐不用：去掉并收起改量弹层（可随时恢复） */
  const hideItem = async (item: PurchaseItem) => {
    if (await query.removeItem(item)) setEditing(null);
  };

  const batchCheck = async (checked: boolean) => {
    await runAction(async () => {
      const result = await api.purchase.batchCheck(date, 'day', checked);
      query.setData(result);
      toast(checked ? '已全部标记为买好' : '已重置勾选', 'success');
    }, '没改成功，请重试');
  };

  const resetAll = async () => {
    setResetting(true);
    try {
      await runAction(async () => {
        const result = await api.purchase.reset(date, 'day');
        query.setData(result);
        setResetOpen(false);
        toast('已恢复成系统计算的数量', 'success');
      }, '没恢复成功，请重试');
    } finally {
      setResetting(false);
    }
  };

  const exportText = async () => {
    await runAction(async () => {
      const result = await api.purchase.text(date, 'day');
      const ok = await copyText(result.text);
      toast(ok ? '清单文本已复制，可直接发微信' : '复制失败，请手动选择文本', ok ? 'success' : 'error');
    }, '导出失败，请重试');
  };

  const exportImage = () => {
    if (!current || (current.total === 0 && current.optional.length === 0)) {
      toast('清单还是空的', 'error');
      return;
    }
    const optionalRows = current.optional.map(
      (item) => `${item.checked ? '☑' : '☐'} ${item.name}   ${item.amount_text}`,
    );
    const dataUrl = buildPoster({
      title: `采购清单 · ${relativeDayLabel(date)}`,
      subtitle: `共 ${current.total} 项 · 已买 ${current.checked_count} 项 · 预估 ¥${current.estimated_cost}`,
      sections: [
        ...groups.map(([category, items]) => ({
          heading: category,
          rows: items.map((item) => `${item.checked ? '☑' : '☐'} ${item.name}   ${item.amount_text}`),
        })),
        ...(optionalRows.length > 0 ? [{ heading: `可选加购 ${optionalRows.length} 项`, rows: optionalRows }] : []),
      ],
      footer:
        [
          optionalRows.length > 0 ? `可选加购 ${optionalRows.length} 项，不买也能做饭` : '',
          current.pantry.length > 0 ? `另有常备调料 ${current.pantry.length} 种，家里一般都有` : '',
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
    });
    downloadPoster(dataUrl, `采购清单-${date}.png`);
    toast('清单图已保存', 'success');
  };

  return (
    <div className="pb-28 lg:pb-8">
      <PageHeader title="采购清单" subtitle={relativeDayLabel(date)} />

      {/* 吸顶位置 = 页头高度(62px) + 灵动岛让位：页头在全面屏下会变高这么多。
          原先是「日期 + 早/午/晚」两列，现在三餐合并成一整天、只剩日期，居中限宽即可 */}
      <div className="glass-panel sticky top-[calc(env(safe-area-inset-top,0px)+62px)] z-20 px-4 py-2.5">
        <DaySwitcher date={date} onChange={setDate} className="mx-auto max-w-[420px]" />
      </div>

      {/* 工具区：库存 / 添加食材 / 孤立食材 并成一行三格（没有孤立食材时两格，不留空位） */}
      <section className="mt-3 px-4">
        <div className={cn('grid gap-2', orphanList.length > 0 ? 'grid-cols-3' : 'grid-cols-2')}>
          {/* 冰箱清空计划：登记冰箱里现成的食材，点菜页优先消耗；放采购页登记更顺手。
              没登记过时保留虚线边框，继续承担「这里可以点」的引导 */}
          <button
            type="button"
            onClick={() => setFridgeOpen(true)}
            className={cn(
              'card press flex flex-col items-center gap-1 p-3 text-center',
              fridgeCount > 0 ? 'border-fresh/30 bg-fresh/5' : 'border-dashed border-cream-400',
            )}
          >
            <span className="text-lg">🧊</span>
            <span className="text-[13px] font-semibold">库存</span>
            <span className="text-[10px] text-ink-400">
              {fridgeCount > 0 ? `已登记 ${fridgeCount} 样` : '登记冰箱现成的'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="card press flex flex-col items-center gap-1 p-3 text-center"
          >
            <span className="text-lg">➕</span>
            <span className="text-[13px] font-semibold">添加食材</span>
            <span className="text-[10px] text-ink-400">补进食材库</span>
          </button>

          {orphanList.length > 0 ? (
            <button
              type="button"
              onClick={() => setOrphansOpen((value) => !value)}
              className="card press flex flex-col items-center gap-1 p-3 text-center"
            >
              <span className="text-lg">🧩</span>
              <span className="flex items-center gap-0.5 text-[13px] font-semibold">
                孤立食材
                <ChevronDown size={12} className={cn('text-ink-400 transition', orphansOpen && 'rotate-180')} />
              </span>
              <span className="text-[10px] text-ink-400">{orphanList.length} 种没进菜谱</span>
            </button>
          ) : null}
        </div>

        {orphanList.length > 0 && orphansOpen ? (
          <div className="mt-2 rounded-xl2 border border-dashed border-brand-300 bg-brand-50/40 p-3">
            <div className="flex flex-wrap gap-1.5">
              {orphanList.map((item) => (
                <span
                  key={item.id}
                  className="flex items-center gap-1 rounded-full bg-white py-1 pl-2.5 pr-1.5 text-[12px] text-ink-600 shadow-card"
                >
                  {item.name}
                  {item.is_pantry ? <span className="text-[10px] text-ink-400">常备</span> : null}
                  {/* 加错 / 不打算用了的食材在这里清出去；确认后调服务端删除 */}
                  <button
                    type="button"
                    aria-label={`删除 ${item.name}`}
                    onClick={() => setOrphanPending(item)}
                    className="press flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream-200 text-ink-400"
                  >
                    <X size={11} strokeWidth={2.6} />
                  </button>
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-ink-400">
              到「后台汇总」用新菜建议或菜品管理把它们建进菜谱；没有菜谱的食材，采购清单也不会自动替你买它们。
              加错了的点食材上的 ✕ 删掉。
            </p>
          </div>
        ) : null}
      </section>

      {query.error && !current ? (
        <div className="px-4 pt-4">
          <ErrorState title="采购清单没加载出来" description={query.error} onRetry={query.reload} />
        </div>
      ) : query.loading && !current ? (
        <div className="space-y-2.5 px-4 pt-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : !current || (current.total === 0 && current.hidden.length === 0) ? (
        <div className="px-4 pt-4">
          <EmptyState
            emoji="🧺"
            title="这一天还没有需要买的东西"
            description="等家人点完菜，系统会自动把菜品拆成原材料，按菜市场分类列出来。"
          />
        </div>
      ) : (
        <>
          <section className="mt-3 px-4">
            <div className="card p-4">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-[13px] text-ink-400">采购进度</p>
                  <p className="mt-0.5 text-[22px] font-semibold leading-none tabular-nums">
                    {current.checked_count}
                    <span className="text-[13px] font-normal text-ink-400"> / {current.total} 项</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] text-ink-400">预估花费</p>
                  <p className="text-[16px] font-semibold text-brand-600 tabular-nums">¥{current.estimated_cost}</p>
                </div>
              </div>
              <div className="mt-3">
                <Progress value={current.checked_count} max={current.total} tone="fresh" />
              </div>
              {current.optional.length > 0 ? (
                <p className="mt-2 text-[11px] leading-4 text-ink-400">
                  另有 {current.optional.length} 项可选加购（不买也能做出今天的菜），在下面单独一栏
                </p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <Button variant="soft" size="sm" onClick={() => void batchCheck(true)}>
                  全部买好
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void batchCheck(false)}>
                  重置勾选
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>
                  <RotateCcw size={13} />
                  重置整份清单
                </Button>
              </div>
            </div>
          </section>

          <div
            className={cn(
              groups.length > 1 && 'lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-4',
            )}
          >
            {groups.map(([category, items]) => (
              <section key={category} className="mt-4 px-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <Store size={14} className="text-brand-500" />
                  <p className="text-[14px] font-semibold">{category}</p>
                  <span className="text-[11px] text-ink-400">{items.length} 项</span>
                </div>
                <div className="space-y-2">
                  {items.map((item) => (
                    <PurchaseRow
                      key={item.is_custom ? `c${item.custom_id}` : item.ingredient_id}
                      item={item}
                      onToggle={() => void query.toggle(item)}
                      onEdit={item.is_custom ? undefined : () => openEdit(item)}
                      onRemove={item.is_custom ? () => void query.removeItem(item) : undefined}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>

          {/* 手动调整：添加 / 恢复都在这一个面板里；去掉走条目自己的入口 */}
          <section className="mt-4 px-4">
            {adjustOpen ? (
              <div className="card space-y-3 p-3.5">
                <div>
                  <p className="text-[14px] font-semibold">手动调整今天</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-ink-400">
                    补上系统没算到的、或去掉不需要的，只影响今天。不需要某个系统条目时，点它的铅笔 →「今天不要」。
                  </p>
                </div>
                <ManualItemForm
                  hidden={current.hidden}
                  onAddCustom={query.addCustom}
                  onRestore={(item) => void query.restore(item)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdjustOpen(true)}
                className="press flex w-full items-center justify-center gap-1.5 rounded-xl2 border border-dashed border-cream-400 bg-white/60 py-3 text-[13px] font-medium text-ink-600"
              >
                <Plus size={15} />
                手动调整食材
                {current.hidden.length > 0 ? `（已去掉 ${current.hidden.length} 项）` : ''}
              </button>
            )}
          </section>

          {/* 可选加购：今天引用它的菜都把它当可选，跳过了照样能把菜做出来。默认折叠 */}
          {current.optional.length > 0 ? (
            <section className="mt-4 px-4">
              <button
                type="button"
                onClick={() => setOptionalOpen((value) => !value)}
                className="card press flex w-full items-center gap-2 border-dashed p-3.5 text-left"
              >
                <span className="text-lg">🍃</span>
                <div className="flex-1">
                  <p className="text-[14px] font-semibold">可选加购 {current.optional.length} 项</p>
                  <p className="text-[11px] text-ink-400">不买也能做出今天的菜，顺路想要再拿</p>
                </div>
                <ChevronDown size={16} className={cn('text-ink-400 transition', optionalOpen && 'rotate-180')} />
              </button>
              {optionalOpen ? (
                <div className="mt-2 space-y-2">
                  {current.optional.map((item) => (
                    <PurchaseRow
                      key={item.ingredient_id}
                      item={item}
                      onToggle={() => void query.toggle(item)}
                      onEdit={() => openEdit(item)}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {current.pantry.length > 0 ? (
            <section className="mt-4 px-4">
              <button
                type="button"
                onClick={() => setPantryOpen((value) => !value)}
                className="card press flex w-full items-center gap-2 p-3.5 text-left"
              >
                <span className="text-lg">🧂</span>
                <div className="flex-1">
                  <p className="text-[14px] font-semibold">常备调料 {current.pantry.length} 种</p>
                  <p className="text-[11px] text-ink-400">家里通常都有，不用专门跑一趟</p>
                </div>
                <ChevronDown size={16} className={cn('text-ink-400 transition', pantryOpen && 'rotate-180')} />
              </button>
              {pantryOpen ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {current.pantry.map((item) => (
                    <span key={item.ingredient_id} className="rounded-full bg-white px-2.5 py-1 text-[12px] text-ink-600 shadow-card">
                      {item.name} {item.amount_text}
                    </span>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="mt-5 flex gap-2 px-4">
            <Button variant="outline" block onClick={() => void exportText()}>
              <Copy size={15} />
              复制文本
            </Button>
            <Button block onClick={exportImage}>
              <ImageDown size={15} />
              存成图片
            </Button>
          </section>
        </>
      )}

      {/* 改数量弹层：数量 / 备注草稿收在弹层里，保存与「今天不需要」写回 usePrepList */}
      {editing ? (
        <AmountEditSheet
          item={editing}
          onClose={() => setEditing(null)}
          onSave={(amount, note) => saveEdit(editing, amount, note)}
          onHide={() => hideItem(editing)}
        />
      ) : null}

      {/* 添加食材：自包含表单，加完成功后刷新孤立食材 */}
      <AddIngredientSheet open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => orphans.reload()} />

      {/* 删除孤立食材确认：删完拿服务端返回的最新清单替换本地数据 */}
      {orphanPending ? (
        <OrphanDeleteSheet
          orphan={orphanPending}
          onClose={() => setOrphanPending(null)}
          onRemoved={(ingredients) => orphans.setData({ ingredients })}
        />
      ) : null}

      <FridgeStockSheet open={fridgeOpen} onClose={() => setFridgeOpen(false)} onSaved={() => fridge.reload()} />

      <ConfirmSheet
        open={resetOpen}
        title="重置整份采购清单"
        confirmLabel="确认重置"
        cancelLabel="先不重置"
        busy={resetting}
        summary={
          <div className="rounded-xl2 bg-cream-100 p-3">
            <p className="text-[15px] font-semibold">{relativeDayLabel(date)} · 全天</p>
            <p className="mt-1 text-[11px] leading-5 text-ink-400">
              当前 {current?.total ?? 0} 项必买 · {current?.optional.length ?? 0} 项可选 ·{' '}
              {current?.hidden.length ?? 0} 项已隐藏
            </p>
          </div>
        }
        warning="会清除这一天的勾选、改量、备注、隐藏标记和手动添加的食材，恢复成系统按订单算出的清单；不会改菜品配料表。"
        onClose={() => setResetOpen(false)}
        onConfirm={() => void resetAll()}
      />
    </div>
  );
}
