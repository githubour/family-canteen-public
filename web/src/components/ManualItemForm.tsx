import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { PurchaseItem } from '../api/types';
import { Button, cn } from './ui/base';

/**
 * 手动加食材：名称 + 用量（选填）+「添加到清单」+ 已去掉项的恢复区。
 * 采购页的「手动调整」面板与大厨备料弹层的「调整」模式共用同一套交互与样式。
 * 草稿存在这里：加成功才清空，没填名称时保留原文接着改。
 */
export function ManualItemForm({
  hidden,
  onAddCustom,
  onRestore,
  className,
}: {
  hidden: PurchaseItem[];
  /** 返回是否添加成功；失败（如没填名称）时保留输入让用户接着改 */
  onAddCustom: (name: string, amountText: string) => Promise<boolean>;
  onRestore: (item: PurchaseItem) => void;
  className?: string;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');

  const submit = async () => {
    if (await onAddCustom(name, amount)) {
      setName('');
      setAmount('');
    }
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          placeholder="名称，如 小米辣"
          className="h-10 min-w-0 flex-1 rounded-xl2 border border-cream-400 bg-white px-3 text-[14px] placeholder:text-ink-200 focus:border-brand-400"
        />
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          placeholder="用量，选填"
          className="h-10 w-[104px] shrink-0 rounded-xl2 border border-cream-400 bg-white px-3 text-[14px] placeholder:text-ink-200 focus:border-brand-400"
        />
      </div>
      <Button block variant="soft" onClick={() => void submit()}>
        <Plus size={15} />
        添加到清单
      </Button>
      {hidden.length > 0 ? (
        <div className="border-t border-cream-200 pt-3">
          <p className="text-[12px] text-ink-400">已去掉 {hidden.length} 项，点一下恢复：</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hidden.map((item) => (
              <button
                key={item.ingredient_id}
                type="button"
                onClick={() => onRestore(item)}
                className="press rounded-full border border-dashed border-cream-400 bg-white px-2.5 py-1 text-[12px] text-ink-400 line-through"
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
