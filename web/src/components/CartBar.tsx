import { ShoppingCart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { MEAL_LABEL } from '../api/types';
import { dayLabelForDate } from '../lib/format';
import { cartGroups, useCart } from '../store/cart';

/** 底部悬浮购物车栏：强化「去结算」转化，避免用户在长列表里迷路 */
export function CartBar() {
  const lines = useCart((state) => state.lines);
  const navigate = useNavigate();

  const servings = lines.reduce((sum, line) => sum + line.servings, 0);
  if (lines.length === 0) return null;

  // 按 (日期, 餐次) 分组说清这车装的是哪几张单：今天·晚餐 2 道 · 明天·午餐 1 道
  const groups = cartGroups(lines);
  const summary = [
    ...groups
      .slice(0, 2)
      .map((group) => `${dayLabelForDate(group.mealDate)}·${MEAL_LABEL[group.mealType]} ${group.lines.length} 道`),
    groups.length > 2 ? `共 ${groups.length} 张单` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    // 竖屏时悬在玻璃胶囊底栏（10px 边距 + 67px 高）上方 6px；横屏/平板改为避开左栏。
    //
    // 左右内缩必须**对称**：lg / 横屏的左边距是给左侧图标栏让位的（栏宽 84/72 + 内容 16），
    // 右边若只留 16px，胶囊就会贴着屏幕右缘——相对屏幕整体偏右 42px（胶囊中心 414 vs 屏幕中心 372），
    // 看着就是「特别靠右」。同样的坑团队在购物车页那条提交条上踩过一次（8673b29），
    // 那条改成了 mx-auto + max-w 的居中胶囊；这里同样让两侧等宽内缩，胶囊才是视觉居中的。
    // 顺带一句：别给这层叠 .app-bar 之外再加 inset-x-*，w-full 与它一起会过度约束成负 margin。
    <div className="app-bar pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+83px)] z-40 px-4 lg:bottom-6 lg:px-[100px] land:px-[88px]">
      <button
        type="button"
        onClick={() => navigate('/cart')}
        // 超宽屏（≥ lg 且可用宽度 > 672）再收一档成居中胶囊，与购物车页那条提交条同宽同级。
        // max-w 必须加在这颗按钮上、不能加在外层容器上：外层是「全宽 + 两侧 100px 内缩」，
        // 加在容器上会让那 200px 内缩吃掉胶囊宽度（胶囊变 472 且内缩不再是视觉边距）。
        // iPad mini（可用 544 < 672）不受影响。
        className="press pointer-events-auto flex w-full items-center gap-3 rounded-full warm-gradient px-3 py-2.5 text-white shadow-float lg:mx-auto lg:max-w-2xl"
      >
        <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/25">
          <ShoppingCart size={18} />
          <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white px-1 text-[11px] font-bold text-brand-600">
            {lines.length}
          </span>
        </span>
        <span className="flex-1 text-left">
          <span className="block text-[15px] font-semibold leading-tight">
            已选 {lines.length} 道菜 · 共 {servings} 份
          </span>
          <span className="block text-[11px] opacity-90">{summary}</span>
        </span>
        <span className="rounded-full bg-white/20 px-3 py-1 text-[13px] font-medium">去结算</span>
      </button>
    </div>
  );
}
