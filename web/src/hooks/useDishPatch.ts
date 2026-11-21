import { useEffect, useState } from 'react';
import type { Dish } from '../api/types';
import { toast } from '../components/ui/toast';
import { runAction } from '../lib/runAction';

/**
 * 菜品编辑面板的公共状态机：面板自己持有一份 PATCH 返回的最新菜品
 * （父列表晚一拍刷新也不影响展示），patch 期间 busy 供禁用面板内的操作。
 * success 返回 null 表示不弹成功提示（例如配料必选连点太吵）。
 */
export function useDishPatch(dish: Dish, onUpdated?: (dish: Dish) => void) {
  const [current, setCurrent] = useState(dish);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCurrent(dish);
  }, [dish]);

  const patch = async (
    action: () => Promise<{ dish: Dish }>,
    options: { error?: string; success?: (dish: Dish) => string | null } = {},
  ): Promise<boolean> => {
    setBusy(true);
    try {
      return await runAction(async () => {
        const result = await action();
        setCurrent(result.dish);
        onUpdated?.(result.dish);
        const message = options.success?.(result.dish);
        if (message) toast(message, 'success');
      }, options.error ?? '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return { current, busy, patch };
}
