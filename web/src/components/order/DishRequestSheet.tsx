import { Button } from '../ui/base';
import { Sheet } from '../ui/feedback';

/**
 * 「提个新菜」弹层：先记下菜名，攒在后台「新菜」里等统一加入菜单。
 * 表单状态留在页面——搜不到时要把关键词带进来预填，关掉再打开也要能接着改。
 */
export function DishRequestSheet({
  open,
  onClose,
  name,
  onNameChange,
  note,
  onNoteChange,
  submitting,
  submitterName,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  onNameChange: (name: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  submitting: boolean;
  submitterName: string | null;
  onSubmit: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="提个新菜">
      <div className="space-y-4 pb-6">
        <p className="rounded-xl2 bg-cream-100 p-3 text-[12px] leading-5 text-ink-600">
          先记下菜名，等补上配料和营养后再统一加入菜单，所以现在还不能直接点。
          攒在「后台汇总 · 新菜」里，可以看到大家都提了什么。
        </p>

        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-600">想吃什么菜</p>
          <input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            maxLength={24}
            autoFocus
            placeholder="例如：水煮肉片、酸辣土豆丝"
            className="h-11 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[15px] placeholder:text-ink-200 focus:border-brand-400"
          />
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-600">想做成什么样（可选）</p>
          <input
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            maxLength={60}
            placeholder="例如：微辣、想喝汤、少油"
            className="h-11 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[14px] placeholder:text-ink-200 focus:border-brand-400"
          />
        </div>

        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          <span>提交人：{submitterName ?? '还没选身份'}</span>
        </div>

        <Button block size="lg" disabled={submitting} onClick={onSubmit}>
          {submitting ? '提交中…' : '提交'}
        </Button>
      </div>
    </Sheet>
  );
}
