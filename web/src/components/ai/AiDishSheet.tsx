import { Sheet } from '../ui/feedback';
import { AiDishPanel } from './AiDishPanel';

/**
 * AI 加菜弹层：库存弹层里认出净菜的「去加菜」用它；首页不再单独开这个入口，
 * 而是由 AiHelperSheet 分流后内嵌 AiDishPanel。
 *
 * 草稿跟着弹层走：关掉即弃，再开从一句话重新来；
 * seed 是外部带来的预填（如库存弹层认出净菜），只吃面板挂载那一次。
 */
export function AiDishSheet({
  open,
  onClose,
  seed = '',
}: {
  open: boolean;
  onClose: () => void;
  /** 外部带来的预填文案；换一份 seed 会重挂面板，旧草稿不残留 */
  seed?: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="AI 加菜" maxHeight="88vh">
      {/* 弹层关着时面板整体卸载，状态天然归零；key=seed 让「换一个净菜再来」也能重新预填 */}
      <AiDishPanel key={seed} initialText={seed} />
    </Sheet>
  );
}
