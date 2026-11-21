import { useCallback, useState } from 'react';
import { api } from '../api/client';
import type { DishFeedback } from '../api/types';

/**
 * 按菜品缓存的反馈：订单卡 / 点菜详情展开某道菜时拉一次，别处增删后只刷那一道路
 * （SSE 事件带 dishId）。加载失败静默降级——评论区空着，比整页报错好。
 */
export function useDishFeedback() {
  const [feedbacksByDish, setFeedbacksByDish] = useState<Record<number, DishFeedback[]>>({});

  const loadFeedback = useCallback(async (dishId: number) => {
    try {
      const { feedbacks } = await api.dishFeedback.list(dishId);
      setFeedbacksByDish((prev) => ({ ...prev, [dishId]: feedbacks }));
    } catch {
      // 单道菜的反馈加载失败不阻塞页面
    }
  }, []);

  return { feedbacksByDish, loadFeedback };
}
