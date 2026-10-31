import { useEffect, useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { api } from '../api/client';
import { AiDishSheet } from './ai/AiDishSheet';
import { AiFridgeStockPanel } from './ai/AiFridgeStockPanel';
import { Button, ChoiceChip, cn } from './ui/base';
import { Sheet } from './ui/feedback';
import { toast } from './ui/toast';
import { useAsync } from '../hooks/useAsync';
import { runAction } from '../lib/runAction';
import { useDestructiveConfirm } from '../hooks/useDestructiveConfirm';

/** 库存选择器的分类展示顺序；种子里没有的分类自动不出现 */
const CATEGORY_ORDER = ['蔬果', '肉禽蛋', '水产', '豆制品', '干货', '粮油', '乳品', '其他'];

/**
 * 冰箱清空计划编辑弹层：登记冰箱里现成的食材（常备调料不用登记）。
 * 点一下立即生效——点菜页实时把带库存的菜排到前面，全部用库存就能做的菜标「无需买菜」。
 */
export function FridgeStockSheet({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [category, setCategory] = useState<string>('全部');
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  // 清空库存的二次确认层
  const { runDestructive, confirmSheet } = useDestructiveConfirm();
  /** 净菜/半成品「去加菜」转交 AI 加菜弹层：带名字预填，叠在库存弹层之上（Sheet 支持叠层） */
  const [aiDishSeed, setAiDishSeed] = useState('');
  const [aiDishOpen, setAiDishOpen] = useState(false);

  const stock = useAsync(() => (open ? api.fridge.list() : Promise.resolve({ items: [] })), [open]);
  const ingredients = useAsync(
    () => (open ? api.settings.ingredients() : Promise.resolve({ ingredients: [] })),
    [open],
  );

  const stockIds = useMemo(
    () => new Set((stock.data?.items ?? []).map((item) => item.ingredient_id)),
    [stock.data],
  );
  // 盐、酱油这类常备调料家里永远有，登记它们没有意义，选择器里直接不出现
  const selectable = useMemo(() => {
    const list = (ingredients.data?.ingredients ?? []).filter((item) => !item.is_pantry);
    const order = new Map(CATEGORY_ORDER.map((name, index) => [name, index]));
    // 列表与分类 chips 用同一份顺序，别出现「tab 是蔬果在前、列表却乳品在前」的错位
    return list.sort(
      (a, b) =>
        (order.get(a.category) ?? CATEGORY_ORDER.length) - (order.get(b.category) ?? CATEGORY_ORDER.length) ||
        a.name.localeCompare(b.name, 'zh'),
    );
  }, [ingredients.data]);
  const categories = useMemo(() => {
    const present = new Set(selectable.map((item) => item.category));
    return [...CATEGORY_ORDER.filter((name) => present.has(name))];
  }, [selectable]);
  const visibleItems = useMemo(
    () => (category === '全部' ? selectable : selectable.filter((item) => item.category === category)),
    [selectable, category],
  );

  // 搜索：按名字在全库（除常备调料）里找，前缀命中的排前面。搜索时忽略分类筛选——
  // 搜的就是全部食材，这样搜不到才说明「库里确实没有这样东西」
  const searching = keyword.trim() !== '';
  const searchResults = useMemo(() => {
    if (!searching) return [];
    const q = keyword.trim();
    const starts = selectable.filter((item) => item.name.startsWith(q));
    const contains = selectable.filter((item) => !item.name.startsWith(q) && item.name.includes(q));
    return [...starts, ...contains];
  }, [searching, selectable, keyword]);
  const displayedItems = searching ? searchResults : visibleItems;

  // 打开时分类与搜索词都归零，上一次挑到一半的状态不带到下一次
  useEffect(() => {
    if (open) {
      setCategory('全部');
      setKeyword('');
    }
  }, [open]);

  const mutate = async (id: number, name: string, add: boolean) => {
    setBusyId(id);
    try {
      await runAction(async () => {
        // 接口返回全量清单，直接落进本地状态，界面即时反馈；SSE 的 reload 只是兜底
        const result = add ? await api.fridge.add(id) : await api.fridge.remove(id);
        stock.setData(result);
        onSaved?.();
        if (add) toast(`已登记「${name}」`, 'success');
      }, '没改成，请重试');
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    await runAction(async () => {
      await runDestructive({
        title: '清空库存登记',
        warning: '将一次性撤掉全部已登记的库存食材，点菜页会回到普通排序。此操作不可撤销。',
        run: async () => {
          const result = await api.fridge.clear();
          stock.setData(result);
          onSaved?.();
          toast('已清空库存登记', 'success');
        },
      });
    }, '清空失败，请重试');
  };

  const items = stock.data?.items ?? [];

  // 分类筛选 chips：搜索时让位给「搜到 N 样」，清空搜索后原样回来
  const categoryChips = (
    <div className="no-scrollbar flex gap-1 overflow-x-auto">
      {['全部', ...categories].map((name) => (
        <ChoiceChip
          key={name}
          active={category === name}
          size="sm"
          className="shrink-0"
          onClick={() => setCategory(name)}
        >
          {name}
        </ChoiceChip>
      ))}
    </div>
  );

  return (
    <>
      <Sheet open={open} onClose={onClose} title="库存" maxHeight="88vh">
        <div className="space-y-3.5 pb-6">
          <p className="rounded-xl2 bg-cream-100 p-3 text-[12px] leading-5 text-ink-600">
            冰箱里有什么就登记什么，点菜页会把用得上的菜排到前面——
            全部用库存就能做的菜标「无需买菜」，先做它们就不会浪费食材。
          </p>

          {/* AI 入口：没配 key 时它自己返回 null，这个弹层与以前完全一样 */}
          <AiFridgeStockPanel
            onApplied={(next) => {
              // 接口回全量清单，直接落进本地状态，界面即时反馈；SSE 的 reload 只是兜底
              stock.setData({ items: next });
              onSaved?.();
            }}
            onAddDish={(name) => {
              // 净菜 / 半成品转交 AI 加菜：带上名字预填，就地叠一层弹层直接起草（不再跳后台）
              setAiDishSeed(`加个${name}`);
              setAiDishOpen(true);
            }}
          />

          {items.length > 0 ? (
            <div className="flex items-start justify-between gap-2 rounded-xl2 border border-brand-200 bg-brand-50/60 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {items.map((item) => (
                  <button
                    key={item.ingredient_id}
                    type="button"
                    disabled={busyId === item.ingredient_id}
                    onClick={() => void mutate(item.ingredient_id, item.name, false)}
                    aria-label={`撤掉 ${item.name}`}
                    className="press flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[12px] font-medium text-brand-700 shadow-card"
                  >
                    {item.name}
                    <X size={11} className="text-ink-400" />
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void clearAll()}
                className="press shrink-0 pt-0.5 text-[12px] font-medium text-alert"
              >
                清空
              </button>
            </div>
          ) : (
            <p className="rounded-xl2 border border-dashed border-cream-400 bg-white/60 px-3 py-2 text-[12px] text-ink-400">
              还没登记库存食材，挑几样冰箱里有的吧。
            </p>
          )}

          {/* 搜索框：食材一多全靠翻分类太慢，按名字直接搜；搜索时忽略分类筛选 */}
          <div className="flex h-10 items-center gap-2 rounded-full border border-cream-300 bg-white px-3">
            <Search size={15} className="shrink-0 text-ink-200" />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜食材，如番茄、鸡翅"
              enterKeyHint="search"
              aria-label="搜索食材"
              className="h-full w-full bg-transparent text-[14px] placeholder:text-ink-200"
            />
            {keyword ? (
              <button type="button" onClick={() => setKeyword('')} aria-label="清空搜索">
                <X size={15} className="text-ink-200" />
              </button>
            ) : null}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="shrink-0 text-[13px] font-medium text-ink-600">
                挑选食材（已登记 {items.length}）
              </p>
              {searching ? (
                <p className="shrink-0 text-[11px] text-ink-400">搜到 {searchResults.length} 样</p>
              ) : (
                categoryChips
              )}
            </div>
            <div className="grid max-h-[340px] grid-cols-2 gap-1.5 overflow-y-auto">
              {displayedItems.map((item) => {
                const on = stockIds.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void mutate(item.id, item.name, !on)}
                    className={cn(
                      'press flex items-center gap-1.5 rounded-xl2 border px-2.5 py-2 text-left transition',
                      on ? 'border-brand-300 bg-brand-50/50' : 'border-cream-300 bg-white',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition',
                        on ? 'warm-gradient border-transparent text-white' : 'border-cream-400 bg-white',
                      )}
                    >
                      {on ? <Check size={10} strokeWidth={3} /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{item.name}</span>
                      <span className="block text-[10px] text-ink-400">{item.category}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {searching && searchResults.length === 0 ? (
              <p className="mt-2 text-[11px] leading-4 text-ink-400">
                没搜到「{keyword.trim()}」——食材库里没有它，或是常备调料（无需登记）。
              </p>
            ) : (
              <p className="mt-2 text-[11px] leading-4 text-ink-400">
                盐、酱油这类常备调料默认家里有，不用登记；食材库在「后台汇总 → 设置」里维护。
              </p>
            )}
          </div>

          <Button block size="lg" onClick={onClose}>
            完成
          </Button>
        </div>
      </Sheet>

      {/* 净菜转交过来的 AI 加菜：叠在库存弹层之上，关掉它回到库存继续登记 */}
      <AiDishSheet open={aiDishOpen} onClose={() => setAiDishOpen(false)} seed={aiDishSeed} />
      {confirmSheet}
    </>
  );
}
