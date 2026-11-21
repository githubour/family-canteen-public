import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface IdentityState {
  /** 点菜人：下单时记在订单上的身份 */
  memberId: number | null;
  /** 大厨：操作大厨看板的人，接单备料时把这单的做菜记录记在他头上 */
  chefId: number | null;
  select: (id: number) => void;
  clear: () => void;
  selectChef: (id: number) => void;
  clearChef: () => void;
}

/**
 * 选头像即登录：只把成员 id 记在本地，不做密码与鉴权。
 *
 * 身份跟着**浏览器会话**走（sessionStorage）：iPad 这类共用设备上，
 * 如果身份永久保留，下一个人打开 App 不选就直接沿用上一个人的，
 * 订单悄悄记错人。每次打开都重新认一次人，切后台回来不用重选。
 *
 * 点菜人与大厨是**两个独立的身份**：同一个人完全可以既点菜又下厨，
 * 所以这里不做任何互斥，两个选择互不影响。
 */
export const useIdentity = create<IdentityState>()(
  persist(
    (set) => ({
      memberId: null,
      chefId: null,

      select: (id) => set({ memberId: id }),
      clear: () => set({ memberId: null }),

      selectChef: (id) => set({ chefId: id }),
      clearChef: () => set({ chefId: null }),
    }),
    // 存 sessionStorage 而不是 localStorage：一次「打开 App」认一次人就够了
    { name: 'mealtime-identity', storage: createJSONStorage(() => sessionStorage) },
  ),
);
