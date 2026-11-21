import type { Member } from '../api/types';
import { MemberPicker } from './MemberPicker';
import { Sheet } from './ui/feedback';

/**
 * 「今天谁来点菜」选人弹层：共用设备上必须一眼看清现在记在谁名下。
 * 身份按会话记忆，进页没认过人时页面会自动弹一次（可关掉先逛菜单）。
 * 大厨页的「今天谁做菜」是内联卡片、不走弹层，所以这里只管点菜人这一态。
 */
export function IdentityPickerSheet({
  open,
  onClose,
  members,
  currentId,
  onSelect,
  title = '今天谁来点菜',
  description = '菜单会记在这位家人名下；换人点菜时先点一下头像。要添加或管理家人，去「看汇总」页的「家人」页签。',
}: {
  open: boolean;
  onClose: () => void;
  members: Member[];
  currentId: number | null;
  onSelect: (member: Member) => void;
  title?: string;
  description?: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="pb-6">
        <p className="mb-3 text-[12px] leading-5 text-ink-400">{description}</p>
        <MemberPicker members={members} currentId={currentId} onSelect={onSelect} />
      </div>
    </Sheet>
  );
}
