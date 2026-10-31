import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { IconButton } from './ui/base';

/** 吸顶页面头：左侧返回、标题与副标题、右侧操作区 */
export function PageHeader({
  title,
  subtitle,
  back,
  action,
  transparent,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: boolean;
  action?: ReactNode;
  transparent?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <header
      className={
        transparent
          ? 'px-4 pb-2 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]'
          : // 玻璃头延伸到状态栏/灵动岛底下（原生导航栏的做法），标题行用
            // safe-area 让出岛的位置；浏览器里 inset 为 0，高度不变
            'glass-panel sticky top-0 z-30 border-b border-cream-300/60 px-4 pb-2.5 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]'
      }
    >
      <div className="flex items-center gap-2">
        {back ? (
          <IconButton aria-label="返回" onClick={() => navigate(-1)} className="shrink-0">
            <ChevronLeft size={18} />
          </IconButton>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[20px] font-semibold leading-tight">{title}</h1>
          {subtitle ? <p className="truncate text-[12px] text-ink-400">{subtitle}</p> : null}
        </div>
        {action}
      </div>
    </header>
  );
}
