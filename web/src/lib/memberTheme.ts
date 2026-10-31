import type { CSSProperties } from 'react';

/**
 * 成员的「身份主题」：全应用统一——选人弹层（描圈/涟漪/对勾/名字药丸）、
 * 页头右上角的身份药丸、首页的角色卡 chip 与最近点单头像圈，都从这里取色，
 * 保证同一个人在任何位置都是同一套颜色。
 *
 * 两位固定成员的专属配色按**成员 id** 取，不按名字：名字是家庭数据，
 * 不该写死在代码里（换人、改名都会失效，也不该把个人信息带进公开的代码）。
 * id 之外的家人回退成员主题色（member.color），规则不变只是换了来源。
 *
 * 配色本身：蓝对齐调色板 --color-cool #2563EB；黑对齐 --color-ink-900 #1F1B18，
 * 金无现成 token、取与奶油暖色系同调的暖金。
 */
interface MemberTheme {
  /** 强调色：头像描圈、涟漪、对勾、头像圈的淡色底（拼透明度后缀，需裸 hex） */
  accent: string;
  /** 身份药丸的底色 + 字色（选中名字、页头右上角身份药丸、首页角色卡 chip） */
  badge: CSSProperties;
}

/** key = 成员 id（Member 与 MemberBrief 都带 id，全链路取得到） */
const MEMBER_THEMES: Record<number, MemberTheme> = {
  1: { accent: '#2563EB', badge: { backgroundColor: '#2563EB', color: '#FFFFFF' } },
  2: { accent: '#F6C453', badge: { backgroundColor: '#1F1B18', color: '#F6C453' } },
};

export function memberTheme(member: { id: number; color: string }): MemberTheme {
  return (
    MEMBER_THEMES[member.id] ?? {
      accent: member.color,
      badge: { backgroundColor: member.color, color: '#FFFFFF' },
    }
  );
}
