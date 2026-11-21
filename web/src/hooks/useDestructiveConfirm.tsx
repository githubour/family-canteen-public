import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmSheet } from '../components/ui/ConfirmSheet';
import { toast } from '../components/ui/toast';

/**
 * 破坏性操作的二次确认流程。
 *
 * 用 runDestructive({ title, warning, run }) 包住动作：先弹出确认层，
 * 用户确认后才执行；失败时收起弹层并 toast 报错。
 * 组件里把解构出的 confirmSheet 渲染出来即可。
 */
export function useDestructiveConfirm() {
  const [pending, setPending] = useState<{
    title: string;
    warning?: ReactNode;
    run: () => Promise<void>;
    busy: boolean;
  } | null>(null);

  const runDestructive = useCallback(
    async (options: { title: string; warning?: ReactNode; run: () => Promise<void> }) => {
      setPending({ ...options, busy: false });
    },
    [],
  );

  const submit = useCallback(async () => {
    if (!pending) return;
    setPending({ ...pending, busy: true });
    try {
      await pending.run();
      setPending(null);
    } catch (error) {
      setPending(null);
      toast(error instanceof Error ? error.message : '操作失败，请重试', 'error');
    }
  }, [pending]);

  const confirmSheet = pending ? (
    <ConfirmSheet
      open
      title={pending.title}
      warning={pending.warning ?? '此操作不可撤销。'}
      busy={pending.busy}
      onClose={() => setPending(null)}
      onConfirm={() => void submit()}
    />
  ) : null;

  return { runDestructive, confirmSheet };
}
