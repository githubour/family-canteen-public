import type { CSSProperties } from 'react';
import { Check, Plus, X } from 'lucide-react';
import type { Member } from '../api/types';
import { memberTheme } from '../lib/memberTheme';
import { cn } from './ui/base';

/**
 * 头像选人：免密码的身份区分方式。
 * 每个人常驻自己的主题色描圈（未选中淡色圈），选中升级：回弹跳动 + 实色描圈涟漪 +
 * 对勾角标延迟小弹跳 + 名字变配色药丸——隔着半米也能认出谁、看清现在记在谁名下；
 * 不再额外弹 toast——状态变化就发生在指尖位置，浮层提示反而显得隔了一层。
 * manageMode：进入「管理」态，点头像不再切换身份，而是露出右上角的 ✕ 用于移除家人。
 * currentId/onSelect 可选：家人管理面板只展示名单、不承担选身份，此时点头像无动作。
 */
export function MemberPicker({
  members,
  currentId,
  onSelect,
  onCreate,
  compact,
  manageMode = false,
  onRemove,
}: {
  members: Member[];
  currentId?: number | null;
  onSelect?: (member: Member) => void;
  onCreate?: () => void;
  compact?: boolean;
  manageMode?: boolean;
  onRemove?: (member: Member) => void;
}) {
  const removable = manageMode && Boolean(onRemove);
  const remove = (member: Member) => onRemove?.(member);

  return (
    <div className={cn('no-scrollbar flex gap-3 overflow-x-auto', compact ? 'pb-1' : 'pb-2')}>
      {members.map((member, index) => {
        const active = member.id === currentId;
        const { accent, badge } = memberTheme(member);

        return (
          <div key={member.id} className="relative shrink-0">
            <button
              type="button"
              data-autofocus={!removable && index === 0 ? true : undefined}
              onClick={() => (removable ? remove(member) : onSelect?.(member))}
              className="press group flex flex-col items-center gap-1.5 outline-hidden"
            >
              <span
                className={cn(
                  // 键盘焦点环走内描边：外描边会被这行横向滚动容器裁掉一半
                  'relative flex items-center justify-center rounded-full border-2 bg-white text-2xl transition-all group-focus-visible:inset-ring-2 group-focus-visible:inset-ring-brand-400',
                  compact ? 'h-12 w-12' : 'h-16 w-16',
                  active ? 'border-transparent shadow-float' : 'border-cream-300',
                  active && !removable && 'animate-select-pop',
                  removable && 'border-dashed border-alert/50 opacity-90',
                )}
                style={
                  active
                    ? ({
                        backgroundColor: `${accent}22`,
                        borderColor: accent,
                        '--select-ring': `${accent}66`,
                      } as CSSProperties)
                    : removable
                      ? undefined
                      : // 未选中也常驻个人主题色描圈（淡色），首次进弹层就能认出谁是谁；
                        // 选中后升级为实色圈 + 淡色底 + 对勾 + 名字药丸，层级依然分明
                        { borderColor: `${accent}66` }
                }
              >
                {member.avatar}
                {active && !removable ? (
                  <span
                    className="animate-pop absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full text-white [animation-delay:130ms]"
                    style={{ backgroundColor: accent }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  'text-[12px] leading-4',
                  active && !removable
                    ? 'rounded-full px-2 py-0.5 font-semibold'
                    : 'text-ink-400',
                )}
                style={
                  active && !removable ? badge : undefined
                }
              >
                {member.name}
              </span>
            </button>

            {removable ? (
              <button
                type="button"
                aria-label={`移除 ${member.name}`}
                onClick={() => remove(member)}
                className="press outline-hidden focus-visible:inset-ring-2 focus-visible:inset-ring-brand-400 absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-alert text-white shadow-card"
              >
                <X size={13} strokeWidth={3.2} />
              </button>
            ) : null}
          </div>
        );
      })}

      {onCreate && !manageMode ? (
        <button
          type="button"
          onClick={onCreate}
          className="press group flex shrink-0 flex-col items-center gap-1.5 outline-hidden"
        >
          <span
            className={cn(
              'flex items-center justify-center rounded-full border-2 border-dashed border-cream-400 bg-white/60 text-ink-400 group-focus-visible:inset-ring-2 group-focus-visible:inset-ring-brand-400',
              compact ? 'h-12 w-12' : 'h-16 w-16',
            )}
          >
            <Plus size={20} />
          </span>
          <span className="text-[12px] text-ink-400">添加</span>
        </button>
      ) : null}
    </div>
  );
}
