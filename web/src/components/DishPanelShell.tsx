import type { ReactNode } from 'react';
import { cn } from './ui/base';

/**
 * 菜品编辑面板的统一外壳：圆角卡片 + 「图标 + 标题 + 右侧状态徽章」一行头。
 * 菜品设置里的一排面板（实拍图 / 显示安排 / 餐别 / 做法 / 配料）共用，
 * 保证间距、字号、徽章位置不再各写各的。
 */
export function DishPanelShell({
  icon,
  title,
  badge,
  badgeClass,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  badgeClass?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl2 border border-cream-300 bg-white p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold">
          {icon}
          {title}
        </p>
        {badge ? (
          <span className={cn('rounded-full px-2 py-0.5 text-[11px]', badgeClass)}>{badge}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
