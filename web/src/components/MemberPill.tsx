import type { Member } from '../api/types';
import { memberTheme } from '../lib/memberTheme';
import { cn } from './ui/base';

/**
 * 页头右上角的「身份药丸」：点菜页记「谁在点菜」、大厨页记「谁在掌勺」。
 * 没选人时高亮引导，点开选人弹层；选中后常驻个人主题色。两页共用同一个
 * 实现，改样式只改这一处，不会再漂移。
 */
export function MemberPill({
  member,
  placeholder,
  onClick,
}: {
  member: Member | null;
  placeholder: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'press flex h-9 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium shadow-card',
        member ? 'font-semibold' : 'bg-brand-500 text-white',
      )}
      style={member ? memberTheme(member).badge : undefined}
    >
      {member ? (
        <>
          <span className="text-[14px] leading-none">{member.avatar}</span>
          <span className="max-w-14 truncate">{member.name}</span>
        </>
      ) : (
        placeholder
      )}
    </button>
  );
}
