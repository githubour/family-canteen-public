import { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { api } from '../../api/client';
import { Button, ChoiceChip, cn } from '../ui/base';
import { Sheet } from '../ui/feedback';
import { toast } from '../ui/toast';
import { runAction } from '../../lib/runAction';

/** 添加食材的分类选项：与冰箱库存选择器同一套顺序，另加「调味」给常备调料用 */
const INGREDIENT_CATEGORIES = ['蔬果', '肉禽蛋', '水产', '豆制品', '干货', '粮油', '乳品', '调味', '其他'];

/**
 * 添加食材弹层（原 PurchasePage 内嵌 Sheet 拆出）。
 *
 * 自包含：表单态、提交与 toast 都在这里，页面只管开关和「加完之后刷新孤立食材」。
 * 营养值默认 0（库里没有补营养的 API），后台可补。
 */
export function AddIngredientSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** 添加成功后回调（页面用来刷新孤立食材清单） */
  onAdded: () => void;
}) {
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('其他');
  const [newPantry, setNewPantry] = useState(false);
  const [adding, setAdding] = useState(false);

  const submitIngredient = async () => {
    const name = newName.trim();
    if (!name) {
      toast('先写食材名称', 'error');
      return;
    }
    setAdding(true);
    try {
      await runAction(async () => {
        await api.purchase.addIngredient({ name, category: newCategory, is_pantry: newPantry });
        toast(`已添加「${name}」——它会出现在孤立食材里，记得建菜谱用起来`, 'success');
        onAdded();
        onClose();
        setNewName('');
        setNewCategory('其他');
        setNewPantry(false);
      }, '没加成，请重试');
    } finally {
      setAdding(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="添加食材">
      <div className="space-y-4 pb-6">
        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-600">食材名称</p>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="例如：羽衣甘蓝、球生菜"
            enterKeyHint="done"
            className="h-11 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[14px] placeholder:text-ink-200 focus:border-brand-400"
          />
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-600">分类</p>
          <div className="flex flex-wrap gap-1.5">
            {INGREDIENT_CATEGORIES.map((name) => (
              <ChoiceChip key={name} active={newCategory === name} onClick={() => setNewCategory(name)}>
                {name}
              </ChoiceChip>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setNewPantry((value) => !value)}
          className="press flex w-full items-center justify-between rounded-xl2 border border-cream-300 bg-white px-3.5 py-3 text-left"
        >
          <span>
            <span className="block text-[13px] font-medium text-ink-600">常备调料</span>
            <span className="mt-0.5 block text-[11px] text-ink-400">家里永远有，不用采购、不用登记库存</span>
          </span>
          <span
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition',
              newPantry ? 'warm-gradient border-transparent text-white' : 'border-cream-400 bg-white',
            )}
          >
            {newPantry ? <Check size={11} strokeWidth={3} /> : null}
          </span>
        </button>

        <Button block onClick={() => void submitIngredient()} disabled={adding}>
          <Plus size={15} />
          {adding ? '添加中…' : '添加到食材库'}
        </Button>

        <p className="text-center text-[11px] leading-4 text-ink-400">
          添加后会出现在「孤立食材」里，建菜谱时就能用上；营养值先按 0 计，后台可补。
        </p>
      </div>
    </Sheet>
  );
}
