import { useCallback } from 'react';
import { api } from '../api/client';
import type { PurchaseItem, PurchaseScope } from '../api/types';
import { toast } from '../components/ui/toast';
import { runAction } from '../lib/runAction';
import { useAsync } from './useAsync';

/**
 * 一份备料/采购清单：勾选、去掉、恢复、补手动食材都收在这里。
 * 「大厨页 · 合并备料」按餐取（传真实餐别），「采购页」按天取（传 'day' = 三餐合并）——
 * 服务端本来就是同一份状态：采购页勾过「买好」的，备料清单里直接就绪。
 *
 * 只认 useAsync 里的数据：本地另存一份快照会一直遮住 SSE 推来的别端勾选，
 * 所以每个操作的结果都通过 setData 写回同一份数据；采购页的改量 / 批量勾选 /
 * 重置还要用 setData 自己叠在他上面。
 *
 * 所有操作返回是否成功：调用方要靠它决定「关不关弹层 / 清不清输入框」。
 */
export function usePrepList(date: string, mealType: PurchaseScope) {
  const query = useAsync(() => api.purchase.get(date, mealType), [date, mealType]);
  const { setData } = query;

  /** 勾掉/取消一样食材的就绪状态：与「采购」页的「买好了」是同一份状态 */
  const toggle = useCallback(
    (item: PurchaseItem) =>
      runAction(async () => {
        // 手动条目没有 ingredient_id，走自己的端点；
        // day 口径按名称扇出（三餐的同名行一起改），按餐口径仍用 customId
        const result = item.is_custom
          ? await api.purchase.setCustomState({
              mealDate: date,
              mealType,
              ...(mealType === 'day' ? { name: item.name } : { customId: item.custom_id as number }),
              checked: !item.checked,
            })
          : await api.purchase.setState({
              mealDate: date,
              mealType,
              ingredientId: item.ingredient_id as number,
              checked: !item.checked,
            });
        setData(result);
      }, '没勾上，请重试'),
    [date, mealType, setData],
  );

  /** 备料时发现某样本餐用不上：系统算出的条目隐藏（可恢复），手动条目直接删掉 */
  const removeItem = useCallback(
    (item: PurchaseItem) =>
      runAction(async () => {
        const result = item.is_custom
          ? await api.purchase.removeCustom({
              mealDate: date,
              mealType,
              ...(mealType === 'day' ? { name: item.name } : { customId: item.custom_id as number }),
            })
          : await api.purchase.setHidden({
              mealDate: date,
              mealType,
              ingredientId: item.ingredient_id as number,
              hidden: true,
            });
        setData(result);
        toast(
          item.is_custom
            ? `已移除 ${item.name}`
            : mealType === 'day'
              ? `今天不买「${item.name}」了`
              : `已把「${item.name}」从这一餐去掉`,
          'success',
        );
      }, '没去掉，请重试'),
    [date, mealType, setData],
  );

  /** 恢复上一步去掉的自动条目 */
  const restore = useCallback(
    (item: PurchaseItem) =>
      runAction(async () => {
        const result = await api.purchase.setHidden({
          mealDate: date,
          mealType,
          ingredientId: item.ingredient_id as number,
          hidden: false,
        });
        setData(result);
        toast(`已恢复 ${item.name}`, 'success');
      }, '没恢复，请重试'),
    [date, mealType, setData],
  );

  /** 补一样系统没算到的食材（amountText 是自由文案，如「3 根」，可不填）；名称为空返回 false，让表单保留输入 */
  const addCustom = useCallback(
    async (name: string, amountText: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        toast('先填一下食材名称', 'error');
        return false;
      }
      return runAction(async () => {
        const result = await api.purchase.addCustom({
          mealDate: date,
          mealType,
          name: trimmed,
          amountText: amountText.trim(),
        });
        setData(result);
        toast(`已添加 ${trimmed}`, 'success');
      }, '没加上，请重试');
    },
    [date, mealType, setData],
  );

  return {
    /** 这一餐的清单，null = 还没加载出来或还没生成 */
    list: query.data?.list ?? null,
    loading: query.loading,
    error: query.error,
    reload: query.reload,
    setData,
    toggle,
    removeItem,
    restore,
    addCustom,
  };
}
