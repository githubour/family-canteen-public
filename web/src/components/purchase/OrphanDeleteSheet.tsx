import { useState } from 'react';
import { api } from '../../api/client';
import type { OrphanIngredient } from '../../api/types';
import { Button } from '../ui/base';
import { Sheet } from '../ui/feedback';
import { toast } from '../ui/toast';
import { runAction } from '../../lib/runAction';

/**
 * 删除孤立食材的确认弹层（原 PurchasePage 内嵌 Sheet 拆出）。
 *
 * 服务端只在没被任何菜谱引用时才放行，删除成功会返回刷新后的清单——
 * 交给 onRemoved 替换页面那份本地数据。
 */
export function OrphanDeleteSheet({
  orphan,
  onClose,
  onRemoved,
}: {
  orphan: OrphanIngredient;
  onClose: () => void;
  /** 删除成功后回调，参数是服务端返回的最新孤立食材清单 */
  onRemoved: (ingredients: OrphanIngredient[]) => void;
}) {
  const [removing, setRemoving] = useState(false);

  /** 删掉一条孤立食材：服务端只在没被任何菜谱引用时才放行，返回刷新后的清单直接替换本地数据 */
  const removeOrphan = async () => {
    setRemoving(true);
    try {
      await runAction(async () => {
        const result = await api.purchase.removeIngredient(orphan.id);
        onRemoved(result.ingredients);
        toast(`已删除「${orphan.name}」`, 'success');
        onClose();
      }, '没删掉，请重试');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="删除食材">
      <div className="pb-6">
        <div className="flex items-center gap-3 rounded-xl2 bg-cream-100 p-3">
          <span className="text-2xl">🧩</span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{orphan.name}</p>
            <p className="text-[11px] text-ink-400">
              {orphan.category}
              {orphan.is_pantry ? ' · 常备' : ''}
            </p>
          </div>
        </div>
        <p className="mt-3 rounded-xl2 bg-warn/10 px-3 py-2 text-[11px] leading-5 text-[#8A4B00]">
          删掉后它从食材库里消失，建菜谱时也选不到了（已经登记过库存的会一起清掉）。
          只是暂时不用的话，留着比删掉更稳妥。
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" block onClick={onClose}>
            先留着
          </Button>
          <Button variant="danger" block disabled={removing} onClick={() => void removeOrphan()}>
            {removing ? '删除中…' : '确认删除'}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
