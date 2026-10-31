import { useState } from 'react';
import { Button } from '../ui/base';
import { Sheet } from '../ui/feedback';
import { MEAL_LABEL, type PurchaseItem } from '../../api/types';

/**
 * 采购条目改数量弹层（原 PurchasePage 内嵌 Sheet 拆出）。
 *
 * 草稿态（数量 / 备注）收在弹层里：随条目挂载、关掉即弃；
 * 保存与「今天不需要」的动作仍由页面执行——它们要写回 usePrepList 的同一份数据。
 * 数值解析也在这里做完：非正数或非法输入 → null（= 恢复系统计算值）。
 */
export function AmountEditSheet({
  item,
  onClose,
  onSave,
  onHide,
}: {
  item: PurchaseItem;
  onClose: () => void;
  /** 数量已解析：留空 / 非法 / 非正数 → null（恢复系统计算值）；note 同理 */
  onSave: (amount: number | null, note: string | null) => Promise<void> | void;
  /** 「今天不需要」：页面负责删掉条目并（成功时）关掉弹层 */
  onHide: () => Promise<void> | void;
}) {
  const [amountDraft, setAmountDraft] = useState(String(item.amount));
  const [noteDraft, setNoteDraft] = useState(item.note ?? '');

  const save = () => {
    const parsed = Number(amountDraft);
    const amount = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    const note = noteDraft.trim() ? noteDraft.trim() : null;
    return onSave(amount, note);
  };

  return (
    <Sheet open onClose={onClose} title={`${item.name} · 改数量`}>
      <div className="space-y-4 pb-6">
        <div className="rounded-xl2 bg-cream-100 p-3">
          <p className="text-[12px] text-ink-400">系统按今天全部订单算出需要</p>
          <p className="text-[15px] font-semibold text-brand-600">{item.amount_text}</p>
          <p className="mt-1 text-[11px] text-ink-400">来自：{item.from_dishes.join(' · ') || '手动添加'}</p>
          {/* 跨餐条目要说清这句总量是怎么分回各餐的（各餐备料清单看到的是分摊后的量） */}
          {item.meals.length > 0 ? (
            <p className="mt-0.5 text-[11px] text-ink-400">
              用在：{item.meals.map((meal) => MEAL_LABEL[meal]).join(' · ')}
            </p>
          ) : null}
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-600">
            实际需求（克，留空则恢复系统计算值）
          </p>
          <input
            type="number"
            inputMode="decimal"
            value={amountDraft}
            onChange={(event) => setAmountDraft(event.target.value)}
            className="h-11 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[15px] tabular-nums focus:border-brand-400"
          />
          <div className="mt-2 flex gap-2">
            {[0.5, 1, 1.5, 2].map((factor) => (
              <button
                key={factor}
                type="button"
                onClick={() => setAmountDraft(String(Math.round(item.amount * factor)))}
                className="press rounded-full bg-cream-200 px-3 py-1 text-[12px] text-ink-600"
              >
                ×{factor}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-600">买菜备注</p>
          <input
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            placeholder="例如：挑嫩的、要现杀的"
            className="h-11 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[14px] placeholder:text-ink-200 focus:border-brand-400"
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            block
            onClick={() => {
              setAmountDraft('');
              setNoteDraft('');
            }}
          >
            清空
          </Button>
          <Button block onClick={() => void save()}>
            保存
          </Button>
        </div>

        {/* 这一餐不需要：从清单里去掉（手动条目直接 ×，不进这个弹层） */}
        {!item.is_custom ? (
          <div>
            <button
              type="button"
              onClick={() => void onHide()}
              className="press w-full rounded-xl2 border border-[#FF453A]/25 bg-[#FF453A]/5 py-2.5 text-[13px] font-medium text-[#FF453A]"
            >
              今天不需要「{item.name}」
            </button>
            <p className="mt-1.5 text-center text-[11px] text-ink-400">
              只影响今天，之后可在「手动调整食材」面板里点回来
            </p>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
