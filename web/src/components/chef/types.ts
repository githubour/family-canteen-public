import type { OrderStatus } from '../../api/types';

/** 大厨看板的订单筛选：'all' = 不筛，其余按订单状态 */
export type Filter = 'all' | OrderStatus;

export const FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待接单' },
  { value: 'cooking', label: '备料中' },
  { value: 'done', label: '已完成' },
];
