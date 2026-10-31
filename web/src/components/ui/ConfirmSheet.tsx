import type { ReactNode } from 'react';
import { Button } from './base';
import { Sheet } from './feedback';

/**
 * 危险操作的统一二次确认层：一句摘要 + 警示文案 + 「先留着 / 确认」两个按钮。
 * 删除类操作（删订单、删菜、删家人…）共用同一套结构与文案节奏，
 * 避免每处各写一遍、按钮叫法还不一致。
 */
export function ConfirmSheet({
  open,
  title,
  summary,
  warning,
  cancelLabel = '先留着',
  confirmLabel = '确认',
  busy = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  /** 被操作对象的摘要卡（头像 / 名称 / 关键信息） */
  summary?: ReactNode;
  /** 讲清后果：删了会怎样、能不能撤销 */
  warning?: ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="pb-6">
        {summary}
        {warning ? (
          <p className="mt-3 rounded-xl2 bg-warn/10 px-3 py-2 text-[11px] leading-5 text-[#8A4B00]">{warning}</p>
        ) : null}
        <div className="mt-4 flex gap-2">
          <Button variant="outline" block onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant="danger" block disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
