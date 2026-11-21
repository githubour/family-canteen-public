import { useCallback, useEffect, useState } from 'react';
import { subscribeSseReconnect } from '../api/sse';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (data: T | null) => void;
}

/**
 * 极简数据加载 Hook：处理 loading / error / 手动重载。
 * 依赖数组变化或调用 reload() 时重新拉取；卸载后丢弃结果，避免竞态。
 *
 * 依赖按「值的序列化」比较（不是引用）：调用方即使传对象 / 数组字面量，
 * 也不会因为每次渲染生成的新引用而无限重拉。deps 里只应放可序列化的原始值。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  const depsKey = JSON.stringify(deps);

  // SSE 断线重连后补拉一次：断线期间的事件已经漏掉，不能等下次手动操作才更新
  useEffect(() => subscribeSseReconnect(reload), [reload]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        console.error('[useAsync] 加载失败', err);
        setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, tick]);

  return { data, loading, error, reload, setData };
}
