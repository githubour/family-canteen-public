import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MAX_HEADCOUNT, MEAL_TYPES, type MealType } from '../api/types';
import { groupBy } from '../lib/collection';
import { shiftDay, todayISO } from '../lib/format';

export interface CartLine {
  dishId: number;
  name: string;
  emoji: string;
  category: string;
  servings: number;
  note: string;
  /**
   * 这行菜给哪天、哪一餐吃：绝对日期 + 餐次，(日期, 餐次) 就是一张订单。
   * 存绝对值而不是「今天/明天」这种相对天数，购物车隔天再打开也不会把「明天」悄悄变成「今天」错下到别的日子。
   */
  mealDate: string;
  mealType: MealType;
}

export interface CartGroupKey {
  mealDate: string;
  mealType: MealType;
}

export interface CartGroup extends CartGroupKey {
  lines: CartLine[];
}

/** (日期, 餐次) = 一张订单：分组渲染与幂等 token 都用这个键 */
export function cartGroupKey(group: CartGroupKey): string {
  return `${group.mealDate}|${group.mealType}`;
}

/**
 * 一次提交的幂等 token + 内容指纹。
 * 只按 (日期, 餐次) 存 token 不够：失败重试前如果改了菜/份数/人数，复用旧 token 可能
 * 命中服务端原单，用户的修改就被静默吞掉。指纹不同的 token 必须丢弃、重新生成。
 */
export interface SubmitTokenRecord {
  token: string;
  fingerprint: string;
}

/** 这一组要提交的内容（不含 late：截单二次确认不改变订单内容，应复用同一 token） */
export function groupFingerprint(
  group: CartGroup,
  memberId: number,
  headcount: number,
  orderNote: string,
): string {
  const items = [...group.lines]
    .map((line) => ({ dishId: line.dishId, servings: line.servings, note: line.note.trim() }))
    .sort((a, b) => a.dishId - b.dishId || a.note.localeCompare(b.note));
  return JSON.stringify({
    memberId,
    mealDate: group.mealDate,
    mealType: group.mealType,
    headcount,
    orderNote: orderNote.trim(),
    items,
  });
}

export function reusableSubmitToken(
  record: SubmitTokenRecord | undefined,
  fingerprint: string,
): string | undefined {
  return record && record.fingerprint === fingerprint ? record.token : undefined;
}

/** 只保留仍然存在于购物车里的组 token，避免删组后留下永远不会再用的键 */
function pruneSubmitTokens(
  tokens: Record<string, SubmitTokenRecord>,
  lines: CartLine[],
): Record<string, SubmitTokenRecord> {
  const alive = new Set(lines.map((line) => cartGroupKey(line)));
  const next: Record<string, SubmitTokenRecord> = {};
  for (const [key, token] of Object.entries(tokens)) {
    if (alive.has(key)) next[key] = token;
  }
  return next;
}

/** 引用一行的最小形状：改份数 / 备注、删除、判断身份都只用这三个字段 */
type CartLineRef = Pick<CartLine, 'mealDate' | 'mealType' | 'dishId'>;

/** 一行菜的身份 = 日期 + 餐次 + 菜：同一道菜可以今天晚餐一份、明天午餐又一份，互不合并 */
export function lineKey(line: CartLineRef): string {
  return `${line.mealDate}:${line.mealType}:${line.dishId}`;
}

/** 把「今天 / 明天 / 后天」档位换算成绝对日期，落库只认绝对日期 */
export function mealDateFromOffset(day: number): string {
  return shiftDay(todayISO(), day);
}

/**
 * 新加菜的落点：显式覆盖 > 点菜目标；过期的目标日期回落到今天（别把菜下到过去）。
 * 加菜的落点与 toast 文案都从这一个函数取，保证说的和做的永远一致。
 */
export function resolveTarget(
  override: Partial<CartGroupKey> | undefined,
  target: CartGroupKey,
): CartGroupKey {
  return {
    mealDate: override?.mealDate ?? (target.mealDate >= todayISO() ? target.mealDate : todayISO()),
    mealType: override?.mealType ?? target.mealType,
  };
}

/** 购物车按「(日期, 餐次) = 一张订单」分组：日期升序，同日内按早餐 → 午餐 → 晚餐 */
export function cartGroups(lines: CartLine[]): CartGroup[] {
  const grouped = groupBy(lines, (line) => `${line.mealDate}|${line.mealType}`);
  return [...grouped.values()]
    .map((items) => ({ mealDate: items[0].mealDate, mealType: items[0].mealType, lines: items }))
    .sort(
      (a, b) =>
        a.mealDate.localeCompare(b.mealDate) || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType),
    );
}

interface CartState {
  lines: CartLine[];
  /**
   * 点菜目标：新加的菜落到哪一天 / 哪一餐，点菜页顶部的选择器写它。
   * 已经加进车的行记住加入时的落点，之后切目标不会带着它们走——
   * 这样「今天加两道 → 切到明天午餐再加两道」一车就能装下两天的单。
   */
  targetDate: string;
  mealType: MealType;
  headcount: number;
  orderNote: string;
  /**
   * 每组 (日期, 餐次) 的提交幂等 token + 内容指纹：跟着购物车一起持久化。
   * 只放在组件内存里的话，服务端已建单但响应丢失时，刷新/重开页面会拿新 token 重复下单；
   * 不校验指纹的话，失败后改了内容又可能拿旧 token 把修改吞掉。
   */
  submitTokens: Record<string, SubmitTokenRecord>;
  setSubmitToken: (key: string, token: string, fingerprint: string) => void;
  releaseSubmitToken: (key: string) => void;
  pruneSubmitTokens: () => void;
  /** target 覆盖目标（菜品详情弹层里单独选的日期）；不传就落到当前目标 */
  add: (dish: { id: number; name: string; emoji: string; category: string }, servings?: number, target?: Partial<CartGroupKey>) => void;
  setServings: (line: CartLineRef, servings: number) => void;
  setLineNote: (line: CartLineRef, note: string) => void;
  remove: (line: CartLineRef) => void;
  /** 整组（同一天同一餐）挪到另一天 / 另一餐；挪过去撞上同名菜时合并份数（与 add 同一套上限） */
  moveGroup: (from: CartGroupKey, to: CartGroupKey) => void;
  setTargetDate: (date: string) => void;
  setMealType: (mealType: MealType) => void;
  setHeadcount: (headcount: number) => void;
  setOrderNote: (note: string) => void;
  clear: () => void;
}

/** 只持久化购物车内容、点菜目标与未完成的提交 token */
type PersistedCart = Pick<
  CartState,
  'lines' | 'targetDate' | 'mealType' | 'headcount' | 'orderNote' | 'submitTokens'
>;

const CART_VERSION = 4;

/**
 * 老版本购物车的迁移：
 * v0 的行没有 mealDate（那时整车共用一个日期），v1 的行没有 mealType（那时整车共用一个餐次）。
 * 两份都按「旧行为等价」补齐：日期补今天，餐次补当时整车的那一份。
 */
export function migrateCart(persisted: unknown, version: number): PersistedCart {
  const state = (persisted ?? {}) as Partial<PersistedCart>;
  let lines = (state.lines ?? []) as CartLine[];
  if (version < 1) {
    lines = lines.map((line) => ({ ...line, mealDate: line.mealDate ?? todayISO() }));
  }
  if (version < 2) {
    const fallback = state.mealType ?? 'dinner';
    lines = lines.map((line) => ({ ...line, mealType: line.mealType ?? fallback }));
  }
  // v3 只存了裸 token（没有内容指纹），无法安全判断能否复用，升级 v4 时直接丢弃；
  // 最坏情况只是重试时拿新 token，多一次服务端幂等检查，不会重复建单。
  const submitTokens: Record<string, SubmitTokenRecord> = {};
  if (version >= 4 && state.submitTokens) {
    for (const [key, value] of Object.entries(state.submitTokens)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as SubmitTokenRecord).token === 'string' &&
        typeof (value as SubmitTokenRecord).fingerprint === 'string'
      ) {
        submitTokens[key] = value as SubmitTokenRecord;
      }
    }
  }
  return {
    ...state,
    lines,
    targetDate: state.targetDate ?? todayISO(),
    mealType: state.mealType ?? 'dinner',
    headcount: state.headcount ?? 3,
    orderNote: state.orderNote ?? '',
    submitTokens: pruneSubmitTokens(submitTokens, lines),
  };
}

const sameGroup = (line: CartLineRef, group: CartGroupKey): boolean =>
  line.mealDate === group.mealDate && line.mealType === group.mealType;

export const useCart = create<CartState>()(
  persist<CartState, [], [], PersistedCart>(
    (set) => ({
      lines: [],
      targetDate: todayISO(),
      mealType: 'dinner',
      headcount: 3,
      orderNote: '',
      submitTokens: {},

      add: (dish, servings = 1, target) =>
        set((state) => {
          const at = resolveTarget(target, { mealDate: state.targetDate, mealType: state.mealType });
          const existing = state.lines.find(
            (line) => line.mealDate === at.mealDate && line.mealType === at.mealType && line.dishId === dish.id,
          );
          if (existing) {
            return {
              lines: state.lines.map((line) =>
                line.mealDate === at.mealDate && line.mealType === at.mealType && line.dishId === dish.id
                  ? { ...line, servings: Math.min(line.servings + servings, 20) }
                  : line,
              ),
            };
          }
          return {
            lines: [
              ...state.lines,
              {
                dishId: dish.id,
                name: dish.name,
                emoji: dish.emoji,
                category: dish.category,
                servings,
                note: '',
                mealDate: at.mealDate,
                mealType: at.mealType,
              },
            ],
          };
        }),

      setServings: (line, servings) =>
        set((state) => {
          const lines =
            servings <= 0
              ? state.lines.filter((item) => lineKey(item) !== lineKey(line))
              : state.lines.map((item) =>
                  lineKey(item) === lineKey(line) ? { ...item, servings: Math.min(servings, 20) } : item,
                );
          return { lines, submitTokens: pruneSubmitTokens(state.submitTokens, lines) };
        }),

      setLineNote: (line, note) =>
        set((state) => ({
          lines: state.lines.map((item) => (lineKey(item) === lineKey(line) ? { ...item, note } : item)),
        })),

      remove: (line) =>
        set((state) => {
          const lines = state.lines.filter((item) => lineKey(item) !== lineKey(line));
          return { lines, submitTokens: pruneSubmitTokens(state.submitTokens, lines) };
        }),

      moveGroup: (from, to) =>
        set((state) => {
          if (from.mealDate === to.mealDate && from.mealType === to.mealType) return {};
          const moved = state.lines.filter((line) => sameGroup(line, from));
          if (moved.length === 0) return {};
          const lines = state.lines.filter((line) => !sameGroup(line, from)).map((line) => ({ ...line }));
          for (const line of moved) {
            const next = { ...line, mealDate: to.mealDate, mealType: to.mealType };
            const existing = lines.find((item) => lineKey(item) === lineKey(next));
            if (existing) existing.servings = Math.min(existing.servings + next.servings, 20);
            else lines.push(next);
          }
          // 组换了键：旧组的 token 不能跟着走（否则服务端会把它当成另一张单的重复提交）
          return { lines, submitTokens: pruneSubmitTokens(state.submitTokens, lines) };
        }),

      setSubmitToken: (key, token, fingerprint) =>
        set((state) => ({ submitTokens: { ...state.submitTokens, [key]: { token, fingerprint } } })),

      releaseSubmitToken: (key) =>
        set((state) => {
          if (!(key in state.submitTokens)) return {};
          const submitTokens = { ...state.submitTokens };
          delete submitTokens[key];
          return { submitTokens };
        }),

      pruneSubmitTokens: () =>
        set((state) => ({ submitTokens: pruneSubmitTokens(state.submitTokens, state.lines) })),

      setTargetDate: (targetDate) => set({ targetDate }),

      setMealType: (mealType) => set({ mealType }),

      setHeadcount: (headcount) => set({ headcount: Math.min(Math.max(headcount, 1), MAX_HEADCOUNT) }),

      setOrderNote: (orderNote) => set({ orderNote }),

      clear: () => set({ lines: [], orderNote: '', submitTokens: {} }),
    }),
    {
      name: 'mealtime-cart',
      version: CART_VERSION,
      migrate: (persisted, version) => migrateCart(persisted, version),
      onRehydrateStorage: () => (state) => {
        // 目标日期是「上次点菜时的意图」：隔天再打开 App 可能已经过期，回落到今天
        if (state && state.targetDate < todayISO()) state.setTargetDate(todayISO());
        // 已经不在车里的组不应继续持有 token（例如用户失败后删了那组菜）
        state?.pruneSubmitTokens();
      },
      partialize: (state) => ({
        lines: state.lines,
        targetDate: state.targetDate,
        mealType: state.mealType,
        headcount: state.headcount,
        orderNote: state.orderNote,
        submitTokens: state.submitTokens,
      }),
    },
  ),
);

/** 目标日期的档位（0/1/2）；超出「今天/明天/后天」范围返回 null */
export function targetOffset(targetDate: string): number | null {
  const today = todayISO();
  for (const offset of [0, 1, 2]) {
    if (shiftDay(today, offset) === targetDate) return offset;
  }
  return null;
}
