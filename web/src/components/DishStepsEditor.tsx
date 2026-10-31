import { useEffect, useState } from 'react';
import { BookOpen, Check } from 'lucide-react';
import { api } from '../api/client';
import type { Dish } from '../api/types';
import { DishPanelShell } from './DishPanelShell';
import { Button } from './ui/base';
import { useDishPatch } from '../hooks/useDishPatch';

/**
 * 菜品做法编辑：一行一步，存成换行分隔的文本，备料弹层里点菜名展开的就是它。
 */
export function DishStepsEditor({ dish, onUpdated }: { dish: Dish; onUpdated?: (dish: Dish) => void }) {
  const { current, busy, patch } = useDishPatch(dish, onUpdated);
  const [draft, setDraft] = useState(dish.steps);

  useEffect(() => {
    setDraft(current.steps);
  }, [current]);

  const stepCount = draft.split('\n').filter((line) => line.trim() !== '').length;
  // 服务端保存时会清理空白行，判断「有没有改动」要按清理后的结果比，避免存不了的死状态
  const normalized = draft
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
  const dirty = normalized !== current.steps;

  const save = () =>
    patch(() => api.dishes.updateSteps(current.id, normalized), {
      error: '没保存上，请重试',
      success: (next) =>
        next.steps
          ? `已保存「${current.name}」的做法，共 ${next.steps.split('\n').length} 步`
          : `已清空「${current.name}」的做法`,
    });

  return (
    <DishPanelShell
      icon={<BookOpen size={14} className="text-brand-500" />}
      title="做法步骤"
      badge={stepCount > 0 ? `${stepCount} 步` : '还没写'}
      badgeClass={stepCount > 0 ? 'bg-brand-50 text-brand-600' : 'bg-cream-200 text-ink-400'}
    >
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={6}
        placeholder={'一行一步，例如：\n五花肉切块，冷水下锅焯水\n小火炒糖色，下肉翻匀\n加开水炖 50 分钟后大火收汁'}
        className="mt-2 w-full resize-y rounded-xl2 border border-cream-400 bg-white px-3 py-2 text-[13px] leading-5 placeholder:text-ink-200 focus:border-brand-400"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[11px] leading-4 text-ink-400">
          一行一步。保存后备料弹层里点菜名就能展开看，做菜时顺手对照。
        </p>
        <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          <Check size={13} />
          保存
        </Button>
      </div>
    </DishPanelShell>
  );
}
