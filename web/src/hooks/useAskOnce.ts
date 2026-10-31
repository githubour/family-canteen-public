import { useEffect, useRef } from 'react';

/**
 * 条件成立时触发一次、之后不再触发（本次挂载内）。
 * 用途：共用设备上「家人名单加载完、还没认人」时自动弹一次选人——
 * 订单不能记到上一个人头上，但也不该反复打扰，换人走页面上的入口。
 */
export function useAskOnce(active: boolean, ask: () => void): void {
  const askedRef = useRef(false);
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => {
    if (askedRef.current || !active) return;
    askedRef.current = true;
    askRef.current();
  }, [active]);
}
