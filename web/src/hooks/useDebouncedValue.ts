import { useEffect, useState } from 'react';

/**
 * 防抖值：输入停下来 delay 毫秒后才把新值透出去。
 * 点菜页搜菜名/食材、采购页搜食材都用它，避免每敲一个字就发一次请求。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
