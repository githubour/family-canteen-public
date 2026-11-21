import { toast } from '../components/ui/toast';

/**
 * 包一层写操作（mutation）：把「调接口 → 成功收尾 → 失败弹错误 toast」这套样板收成一处。
 *
 * - `action` 里正常写代码即可：await 接口、setData、成功提示、关弹层……只有全部成功才走完；
 * - 任一步抛错都会被这里接住：先跑 `onError`（做乐观更新的回滚、收起弹层等），再弹 toast，
 *   文案优先后端给的，后端没给才用 `fallback`；
 * - 返回是否成功，调用方据此决定要不要做「失败也要执行」的收尾（如复位 loading）。
 *
 * 典型用法：
 *   const ok = await runAction(async () => {
 *     query.setData(await api.purchase.reset(date, 'day'));
 *     toast('已恢复成系统计算的数量', 'success');
 *   }, '没恢复成功，请重试');
 *
 *   // 乐观更新：失败必须撤回，否则界面在骗人
 *   await runAction(
 *     () => api.dishes.setActive(dish.id, next),
 *     '操作失败',
 *     () => setDishDraft((previous) => ({ ...previous, [dish.id]: !next })),
 *   );
 */
export async function runAction(
  action: () => Promise<unknown>,
  fallback: string,
  onError?: () => void,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    onError?.();
    toast(error instanceof Error ? error.message : fallback, 'error');
    return false;
  }
}
