import { NavLink } from 'react-router-dom';
import { ClipboardList, LayoutGrid, ShoppingBasket, Soup, UtensilsCrossed } from 'lucide-react';
import { cn } from './ui/base';

const TABS = [
  { to: '/', label: '首页', icon: LayoutGrid, end: true },
  { to: '/order', label: '点菜', icon: UtensilsCrossed, end: false },
  { to: '/chef', label: '大厨', icon: Soup, end: false },
  { to: '/purchase', label: '采购', icon: ShoppingBasket, end: false },
  { to: '/admin', label: '汇总', icon: ClipboardList, end: false },
];

/**
 * 导航：
 * - 竖屏：iOS 26 标签栏式的悬浮玻璃胶囊（四周留边，内容从底下滚过），
 *   下边沿固定在安全区上方 10px，避让 Home 指示条；
 * - 横屏/平板（≥640px）：改为外壳内的左侧竖栏（sticky 满高）。
 *   它不在滚动内容上层，玻璃模糊没有东西可透、白耗 GPU，
 *   所以退回实色面板并关掉模糊与投影。
 *   手机横屏（land：高度 <500px）再收窄一点、间距压紧，5 个页签
 *   在 320pt 高的矮视口里也放得下。
 * 两种形态共用同一份 DOM，靠断点切换定位与方向。
 */
export function BottomNav() {
  return (
    <nav
      className={cn(
        'glass-float fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+10px)] z-40 flex justify-center rounded-full',
        // 左侧竖栏：吸顶满高、固定宽度、右侧分隔线；self-start 让它不被 flex 拉满而失去 sticky 空间。
        // 只重置竖屏用到的水平与底部 inset——连 top 一起重置（inset-auto）会把 top-0
        // 也抹掉，rail 就不再吸附（Tailwind 里 inset-auto 排在 top-0 之后生效）
        'lg:sticky lg:top-0 lg:inset-x-auto lg:bottom-auto lg:z-30 lg:h-screen lg:w-[84px] lg:shrink-0 lg:self-start',
        'lg:mx-0 lg:rounded-none lg:flex-col lg:justify-start lg:border-l-0 lg:border-b-0 lg:border-r lg:border-t-0 lg:bg-cream-100 lg:pb-0 lg:pt-4',
        'lg:shadow-none lg:[-webkit-backdrop-filter:none] lg:[backdrop-filter:none]',
        'land:w-[72px] land:pt-2',
      )}
    >
      {/* 竖屏把页签收在中间一段，避免散落在过宽的横条上 */}
      <div className="flex w-full max-w-[680px] items-stretch justify-around lg:max-w-none lg:flex-col lg:justify-start lg:gap-1 lg:px-2 land:gap-0.5">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }: { isActive: boolean }) =>
              cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition lg:flex-none lg:py-2.5 land:py-1',
                isActive ? 'text-brand-500' : 'text-ink-400',
              )
            }
          >
            {({ isActive }: { isActive: boolean }) => (
              <>
                <span
                  className={cn(
                    'flex h-8 w-12 items-center justify-center rounded-full transition-all duration-300',
                    isActive && 'bg-brand-50',
                  )}
                >
                  <tab.icon size={19} strokeWidth={isActive ? 2.4 : 1.9} />
                </span>
                {tab.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
