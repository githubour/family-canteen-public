import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AppSettings, Dish } from '../api/types';
import { Button, ChoiceChip } from './ui/base';
import { ConfirmSheet } from './ui/ConfirmSheet';
import { Sheet } from './ui/feedback';
import { toast } from './ui/toast';
import { BasicTab } from './settings/BasicTab';
import { DishesTab } from './settings/DishesTab';
import { IngredientsTab } from './settings/IngredientsTab';
import { NotifyTab } from './settings/NotifyTab';
import { runAction } from '../lib/runAction';
import { useDestructiveConfirm } from '../hooks/useDestructiveConfirm';
import { useAppStore } from '../store/app';

type Tab = 'basic' | 'notify' | 'ingredients' | 'dishes';

const TABS: { key: Tab; label: string }[] = [
  { key: 'basic', label: '基本' },
  { key: 'notify', label: '通知' },
  { key: 'ingredients', label: '食材与常备' },
  { key: 'dishes', label: '菜品' },
];

/**
 * 设置抽屉：只负责页签切换、草稿提交与「彻底删除菜品」的确认层，具体页签各在自己的文件里。
 * 草稿 state 留在这里：基本 / 通知两个页签共用一个保存按钮，切页签不能丢未保存的改动；
 * 页签内容随开关挂载 / 卸载，所以每次打开都是新拉的数据、本地乐观改动自然清零。
 */
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const [tab, setTab] = useState<Tab>('basic');
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const [saving, setSaving] = useState(false);
  // 待「彻底删除」的菜（null = 确认层关闭）与提交中状态
  const [pendingDelete, setPendingDelete] = useState<Dish | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 删除成功后给菜品页签换个 key 让它重挂：重新拉数 + 丢掉本地覆盖，比手工清各份状态可靠
  const [dishesVersion, setDishesVersion] = useState(0);
  // 有未保存改动时关闭抽屉先确认，避免截单时间/星期规则填一半被误触遮罩清空
  const [discardOpen, setDiscardOpen] = useState(false);
  // 破坏性操作（彻底删菜 / 保存设置）的二次确认层
  const { runDestructive, confirmSheet } = useDestructiveConfirm();

  useEffect(() => {
    if (!open) return;
    setDraft({});
    setPendingDelete(null);
    setDiscardOpen(false);
  }, [open]);

  const value = <K extends keyof AppSettings>(key: K): string =>
    (draft[key] ?? settings?.[key] ?? '') as string;

  const save = async () => {
    setSaving(true);
    try {
      await runAction(async () => {
        await runDestructive({
          title: '保存设置',
          warning: '设置影响全家人（截单时间 / 在外吃规则会固化历史口径等），保存前会再确认一次。',
          run: async () => {
            const result = await api.settings.update(draft);
            setSettings(result.settings);
            setDraft({});
            toast('设置已保存', 'success');
          },
        });
      }, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // 彻底删除：不可撤销，所以走二次确认。历史订单不受影响（下单时的快照在订单行上），
  // 所以这里只看服务端返回的影响条数给个说明，不再有「被点过就不许删」的限制。
  const removeDish = async () => {
    const dish = pendingDelete;
    if (!dish) return;
    setDeleting(true);
    try {
      await runAction(
        async () => {
          await runDestructive({
            title: '彻底删除菜品',
            warning: `「${dish.name}」将被物理删除（含配料关联与实拍图），不可撤销；历史订单不受影响。`,
            run: async () => {
              const result = await api.dishes.remove(dish.id);
              setPendingDelete(null);
              setDishesVersion((version) => version + 1);
              toast(
                result.kept_orders > 0
                  ? `已删除「${dish.name}」，${result.kept_orders} 条历史订单保持原样`
                  : `已彻底删除「${dish.name}」`,
                'success',
              );
            },
          });
        },
        '删除失败',
        // 失败也要收起确认层，否则弹层会卡住
        () => setPendingDelete(null),
      );
    } finally {
      setDeleting(false);
    }
  };

  const dirty = Object.keys(draft).length > 0;

  const requestClose = () => {
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  return (
    <>
      <Sheet open={open} onClose={requestClose} title="设置" maxHeight="88vh">
        <div className="pb-6">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {TABS.map((item) => (
              <ChoiceChip key={item.key} active={tab === item.key} onClick={() => setTab(item.key)}>
                {item.label}
              </ChoiceChip>
            ))}
          </div>

          {tab === 'basic' ? <BasicTab value={value} setDraft={setDraft} /> : null}
          {tab === 'notify' ? <NotifyTab value={value} setDraft={setDraft} /> : null}
          {tab === 'ingredients' ? <IngredientsTab /> : null}
          {tab === 'dishes' ? <DishesTab key={dishesVersion} onRequestDelete={setPendingDelete} /> : null}

          {tab === 'basic' || tab === 'notify' ? (
            <Button
              block
              size="lg"
              className="mt-4"
              // 没有改动时禁用：后端对空提交会回 400「没有可更新的设置项」，别让用户白挨一条报错
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : dirty ? '保存设置' : '保存设置（无改动）'}
            </Button>
          ) : null}
        </div>
      </Sheet>

      {/* 彻底删除确认：与主抽屉并列渲染，不能嵌进主抽屉——
          主抽屉面板带 transform（弹出动画），嵌在里面的 fixed 层会以它为包含块，位置就不对了 */}
      <ConfirmSheet
        open={discardOpen}
        title="放弃未保存的设置？"
        confirmLabel="放弃改动"
        cancelLabel="继续编辑"
        warning="截单时间、默认人数、星期规则或推送 Key 的改动还没保存，关闭后会丢失。"
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          setDraft({});
          onClose();
        }}
      />

      <Sheet open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)} title="彻底删除这道菜">
        {pendingDelete ? (
          <div className="pb-6">
            <div className="flex items-center gap-3 rounded-xl2 bg-cream-100 p-3">
              <span className="text-2xl">{pendingDelete.emoji}</span>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{pendingDelete.name}</p>
                <p className="text-[11px] text-ink-400">
                  {pendingDelete.category} · {pendingDelete.cook_minutes} 分钟 · 每人份{' '}
                  {pendingDelete.nutrition.kcal} kcal
                </p>
              </div>
            </div>
            <p className="mt-3 rounded-xl2 bg-alert/10 px-3 py-2 text-[11px] leading-5 text-alert">
              删除会把菜品连同配料表一起从数据库抹掉，不可撤销，跟「下架」不是一回事。
              历史订单不受影响：之前点过的记录里，菜名、份量与营养都按下单时的快照保留。
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" block onClick={() => setPendingDelete(null)}>
                先不删
              </Button>
              <Button variant="danger" block disabled={deleting} onClick={() => void removeDish()}>
                {deleting ? '删除中…' : '彻底删除'}
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
      {confirmSheet}
    </>
  );
}
