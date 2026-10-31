import { ApiRequestError } from './errors';
import type {
  AiDishRevisionResult,
  AiDraftResult,
  AiFridgeDraftResult,
  AnalyticsOverview,
  AppSettings,
  Dish,
  DishFeedback,
  DishRequest,
  FridgeStockItem,
  IngredientRecord,
  MealSummary,
  MealType,
  Member,
  NutritionReport,
  NutritionSource,
  Order,
  OrderStatus,
  OrphanIngredient,
  PurchaseList,
  PurchaseScope,
} from './types';

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * 合并多个 AbortSignal：任一触发即整条链中断。
 * 优先用原生 AbortSignal.any（Chrome 116 / Safari 17.4 起），老 iOS 上退化为逐个监听。
 */
function linkSignals(signals: AbortSignal[]): AbortSignal {
  const anyOf = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === 'function') return anyOf(signals);
  const merged = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      merged.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => merged.abort(signal.reason), { once: true });
  }
  return merged.signal;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  // 只有带 body 的请求（POST / PATCH / PUT）才需要声明 JSON；GET / DELETE 带上它是多余的头
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // 网络请求必须有上限：Tailscale 断链/服务端卡住时 fetch 可能一直不 settle，
  // useAsync 的 loading 就永远是 true，页面看起来像“还在加载”。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 调用方也可能自带 signal（离开页面时取消请求）。之前写的是 init?.signal ?? controller.signal，
  // 一旦调用方传了 signal，超时控制器就被整个丢掉，请求又没有上限了——两个 signal 必须同时生效。
  const signal = init?.signal ? linkSignals([init.signal, controller.signal]) : controller.signal;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers,
      signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new ApiRequestError(0, 'TIMEOUT', '请求超时，请检查网络后重试');
    }
    throw new ApiRequestError(0, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试');
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 反向代理断连、网关报错页等场景会返回非 JSON 内容：
      // 统一包装成 ApiRequestError，让调用方拿到一致的错误形状而不是裸的 SyntaxError
      throw new ApiRequestError(
        response.status,
        'BAD_RESPONSE',
        response.ok ? '服务返回了无法解析的内容，请稍后重试' : `服务暂不可用（HTTP ${response.status}），请稍后重试`,
      );
    }
  }

  if (!response.ok) {
    const body = payload as ErrorBody;
    throw new ApiRequestError(
      response.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `请求失败（${response.status}）`,
      body.error?.details,
    );
  }
  return payload as T;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

function patch(body: unknown): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(body) };
}

interface CreateOrderPayload {
  memberId: number;
  mealType: MealType;
  mealDate?: string;
  headcount?: number;
  note?: string;
  late?: boolean;
  /** 幂等键：同一次「确认菜单」重试沿用同一个，服务端据此返回同一张订单而不是新建 */
  clientToken?: string;
  items: { dishId: number; servings: number; note?: string }[];
}

/** 新建菜品的入参（`POST /api/dishes`，服务端校验口径见 dishService.createDish） */
export interface CreateDishPayload {
  /**
   * 内容来源：AI 起草的传 'ai'，新建食材的营养会被标成「待复核」；
   * 手工填的缺省 'manual'。只是溯源标记，不影响校验与入库语义。
   */
  origin?: 'ai' | 'manual';
  name: string;
  category: string;
  spicy?: number;
  tags?: string[];
  minutes?: number;
  difficulty?: number;
  baseServings?: number;
  emoji?: string;
  description?: string;
  /** 一行一步；服务端会统一清理空白后拼成一段文本 */
  steps?: string[];
  mealTypes?: MealType[];
  /** 每人份用量（克）。BOM 按食材名关联，库里没有的必须同时放进 newIngredients */
  ingredients: { name: string; amount: number; required?: boolean }[];
  /** 库里没有（或营养还没补全）的食材：连每 100g 营养一起入库 */
  newIngredients?: {
    name: string;
    category?: string;
    buyUnit?: string;
    buyFactor?: number;
    isPantry?: boolean;
    kcal: number;
    protein: number;
    fat: number;
    carb: number;
    sodium: number;
    fiber: number;
    price?: number | null;
    /** 覆盖 origin 的默认来源：'seed' = 命中《成分表》参考表（不挂「待复核」），'ai' = 模型估的 */
    nutritionSource?: 'seed' | 'ai';
  }[];
}

/**
 * 菜品可编辑字段（PATCH /api/dishes/:id 的新增量）。
 * 注意 `steps` 服务端两种口径都认：字符串（编辑框，一行一步）与字符串数组（草稿直接给数组）。
 * 下架 / 季节窗口 / 餐别那些有各自的专用方法，不混在这里。
 */
export type DishFieldsPatch = Partial<{
  name: string;
  category: string;
  spicy: number;
  difficulty: number;
  minutes: number;
  baseServings: number;
  emoji: string;
  description: string;
  tags: string[];
  steps: string | string[];
  meal_types: MealType[];
}>;

/** 配料表整表提交：`newIngredients` 与建菜同一套语义（库里没有的连营养一起建） */
export interface DishIngredientsPayload {
  ingredients: { name: string; amount: number; required?: boolean }[];
  newIngredients?: {
    name: string;
    category?: string;
    buyUnit?: string;
    buyFactor?: number;
    isPantry?: boolean;
    kcal: number;
    protein: number;
    fat: number;
    carb: number;
    sodium: number;
    fiber: number;
    price?: number | null;
    /** 覆盖 origin 的默认来源：'seed' = 命中《成分表》参考表（不挂「待复核」），'ai' = 模型估的 */
    nutritionSource?: 'seed' | 'ai';
  }[];
}

export const api = {
  members: {
    list: () => request<{ members: Member[] }>('/members'),
    create: (payload: Partial<Member>) => request<{ member: Member }>('/members', json(payload)),
    remove: (id: number) => request<{ ok: boolean }>(`/members/${id}`, { method: 'DELETE' }),
  },
  dishes: {
    list: (params: { category?: string; q?: string; tag?: string; includeInactive?: boolean } = {}) => {
      const search = new URLSearchParams();
      if (params.category && params.category !== '全部') search.set('category', params.category);
      if (params.q) search.set('q', params.q);
      if (params.tag) search.set('tag', params.tag);
      if (params.includeInactive) search.set('includeInactive', '1');
      const query = search.toString();
      return request<{
        dishes: Dish[];
        tags: string[];
        total: number;
        inactive_total: number;
        /** 实际参与匹配的搜索词（含服务端联想的别名，如「西红柿」→「番茄」），用于标注命中食材 */
        search_terms?: string[];
      }>(`/dishes${query ? `?${query}` : ''}`);
    },
    /**
     * 新建菜品——「内容即数据」的唯一入口。
     * AI 加菜也走这里（草稿确认后），所以不存在第二条写入路径：校验、事务与 SSE 广播都是同一套。
     */
    create: (payload: CreateDishPayload) => request<{ dish: Dish }>('/dishes', json(payload)),
    /** 下架 / 恢复一道菜（软下架，历史订单不受影响） */
    setActive: (id: number, active: boolean) => request<{ dish: Dish }>(`/dishes/${id}`, patch({ active })),
    /**
     * 改菜品属性：菜名（重名 409）/ 分类 / 辣度 / 难度 / 耗时 / 基准份数 /
     * 图标 / 简介 / 标签 / 做法。只提交要改的键——没传的服务端一律不动。
     */
    updateFields: (id: number, payload: DishFieldsPatch) => request<{ dish: Dish }>(`/dishes/${id}`, patch(payload)),
    /**
     * 整表替换配料表：一次提交这张菜的完整配料，能表达加一行 / 删一行 / 改用量。
     * 天然幂等（重放结果一样），所以草稿确认失败后重试是安全的。
     */
    replaceIngredients: (id: number, payload: DishIngredientsPayload) =>
      request<{ dish: Dish }>(`/dishes/${id}/ingredients`, { method: 'PUT', body: JSON.stringify(payload) }),
    /**
     * 彻底删除一道菜（物理删除，不可撤销）。
     * 历史订单不受影响：下单时的菜名 / 营养 / 配料快照已经存在订单行上。
     * 返回值里的 kept_orders 表示影响了几条历史订单，用于给用户一个提示。
     */
    remove: (id: number) =>
      request<{ ok: boolean; name: string; removed_feedback: number; kept_orders: number }>(`/dishes/${id}`, {
        method: 'DELETE',
      }),
    /** 显示安排：季节窗口 / 歇菜到某月（hide_until 传空串 = 立即恢复） */
    updateVisibility: (id: number, payload: { season_months?: number[]; hide_until?: string }) =>
      request<{ dish: Dish }>(`/dishes/${id}`, patch(payload)),
    /** 做法：一行一步的文本（保存前服务端会统一清理空白），空串 = 清空 */
    updateSteps: (id: number, steps: string) => request<{ dish: Dish }>(`/dishes/${id}`, patch({ steps })),
    /** 配料的必有 / 可选：true = 必有（缺了做不成），false = 可选（缺了照样做） */
    updateIngredientRequired: (id: number, ingredientId: number, required: boolean) =>
      request<{ dish: Dish }>(`/dishes/${id}/ingredients/${ingredientId}`, patch({ required })),
    /** 餐别标签：传清洗后的 MealType 数组，[] = 通用菜 */
    updateMealTypes: (id: number, meal_types: MealType[]) =>
      request<{ dish: Dish }>(`/dishes/${id}`, patch({ meal_types })),
    /** 实拍图：data 是本地压缩好的 data URL（服务端落盘后返回带新 image_url 的菜品） */
    uploadPhoto: (id: number, data: string) =>
      request<{ dish: Dish }>(`/dishes/${id}/photo`, json({ data }), 30_000),
    removePhoto: (id: number) => request<{ dish: Dish }>(`/dishes/${id}/photo`, { method: 'DELETE' }),
    /** mealType 影响配菜结构：早餐只配 2 样，不套「荤素汤」 */
    recommend: (headcount: number, exclude: number[] = [], mealType?: MealType) => {
      const search = new URLSearchParams({ headcount: String(headcount) });
      if (exclude.length > 0) search.set('exclude', exclude.join(','));
      if (mealType) search.set('mealType', mealType);
      return request<{
        dishes: Dish[];
        structure: { mains: number; soups: number };
        per_serving_kcal: number;
      }>(`/dishes/recommend?${search.toString()}`);
    },
    random: (count: number, category?: string, mealType?: MealType) => {
      const search = new URLSearchParams({ count: String(count) });
      if (category && category !== '全部') search.set('category', category);
      if (mealType) search.set('mealType', mealType);
      return request<{ dishes: Dish[] }>(`/dishes/random?${search.toString()}`);
    },
  },
  fridge: {
    list: () => request<{ items: FridgeStockItem[] }>('/fridge-stock'),
    /** 登记一样家里现成有的食材；重复登记幂等 */
    add: (ingredientId: number) => request<{ items: FridgeStockItem[] }>('/fridge-stock', json({ ingredientId })),
    remove: (ingredientId: number) =>
      request<{ items: FridgeStockItem[] }>(`/fridge-stock/${ingredientId}`, { method: 'DELETE' }),
    /**
     * 批量加 / 撤：一次整理是一件事，服务端包在同一事务里（要么全成要么全不成），
     * 两个动作本身都幂等，所以草稿确认失败后重试是安全的。
     */
    batch: (payload: { add: number[]; remove: number[] }) =>
      request<{ items: FridgeStockItem[] }>('/fridge-stock/batch', json(payload)),
    /** 一键清空：库存消化完，点菜页回到普通排序 */
    clear: () => request<{ items: FridgeStockItem[] }>('/fridge-stock', { method: 'DELETE' }),
  },
  dishRequests: {
    list: () => request<{ requests: DishRequest[] }>('/dish-requests'),
    create: (payload: { name: string; note?: string; memberId?: number }) =>
      request<{ request: DishRequest | null }>('/dish-requests', json(payload)),
    remove: (id: number) => request<{ ok: boolean }>(`/dish-requests/${id}`, { method: 'DELETE' }),
    clear: () => request<{ ok: boolean; removed: number }>('/dish-requests', { method: 'DELETE' }),
  },
  dishFeedback: {
    /** 某道菜的全部反馈（按时间正序） */
    list: (dishId: number) => request<{ feedbacks: DishFeedback[] }>(`/dish-feedback/${dishId}`),
    /**
     * 批量删掉「被这次改动覆盖到」的反馈。幂等：已经删过的 id 直接跳过，不是错误——
     * 一批改动分次删或失败重试都是正常操作。
     */
    removeMany: (ids: number[]) => request<{ removed: number }>('/dish-feedback/remove', json({ ids })),
    /** 提交一条自然语言反馈；memberId 不传即匿名 */
    create: (dishId: number, content: string, memberId?: number | null) =>
      request<{ feedback: DishFeedback | null }>(`/dish-feedback/${dishId}`, json({ content, memberId })),
    /** 删除一条反馈（大模型修正完配方后清掉，或人工误删） */
    remove: (dishId: number, feedbackId: number) =>
      request<{ ok: boolean }>(`/dish-feedback/${dishId}/${feedbackId}`, { method: 'DELETE' }),
  },
  orders: {
    list: (params: { date?: string; mealType?: MealType; status?: OrderStatus; limit?: number } = {}) => {
      const search = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') search.set(key, String(value));
      });
      const query = search.toString();
      return request<{ orders: Order[] }>(`/orders${query ? `?${query}` : ''}`);
    },
    summary: (date: string) => request<{ summaries: MealSummary[] }>(`/orders/summary?date=${date}`),
    /** 首页「家里最近」：服务端按 updated_at 取少量，避免拉 100 条历史 */
    recent: (limit = 5) => request<{ orders: Order[] }>(`/orders/recent?limit=${limit}`),
    create: (payload: CreateOrderPayload) => request<{ order: Order }>('/orders', json(payload)),
    /** chefId = 操作大厨看板的人，用于把这单的做菜记录记到谁头上 */
    setStatus: (id: number, status: OrderStatus, chefId?: number | null) =>
      request<{ order: Order }>(`/orders/${id}/status`, patch({ status, chefId: chefId ?? undefined })),
    /** 顺延：待接单的订单整单挪到之后的某天，mealDate 不传默认顺延一天 */
    defer: (id: number, mealDate?: string) =>
      request<{ order: Order }>(`/orders/${id}/defer`, json({ mealDate })),
    remove: (id: number) => request<{ ok: boolean }>(`/orders/${id}`, { method: 'DELETE' }),
  },
  purchase: {
    get: (date: string, mealType: PurchaseScope) =>
      request<{ list: PurchaseList }>(`/purchase?date=${date}&mealType=${mealType}`),
    orphans: () => request<{ ingredients: OrphanIngredient[] }>('/purchase/orphans'),
    addIngredient: (payload: { name: string; category: string; is_pantry: boolean }) =>
      request<{ ingredient: OrphanIngredient }>('/purchase/ingredients', json(payload)),
    /** 删掉一条孤立食材（加错了 / 不打算用了）；返回刷新后的孤立清单 */
    removeIngredient: (ingredientId: number) =>
      request<{ ingredients: OrphanIngredient[] }>(`/purchase/ingredients/${ingredientId}`, { method: 'DELETE' }),
    text: (date: string, mealType: PurchaseScope) =>
      request<{ text: string; list: PurchaseList }>(`/purchase/text?date=${date}&mealType=${mealType}`),
    setState: (payload: {
      mealDate: string;
      mealType: PurchaseScope;
      ingredientId: number;
      checked?: boolean;
      overrideAmount?: number | null;
      note?: string | null;
    }) => request<{ list: PurchaseList }>('/purchase/state', patch(payload)),
    batchCheck: (mealDate: string, mealType: PurchaseScope, checked: boolean) =>
      request<{ list: PurchaseList }>('/purchase/batch-check', json({ mealDate, mealType, checked })),
    reset: (mealDate: string, mealType: PurchaseScope) =>
      request<{ list: PurchaseList }>('/purchase/reset', json({ mealDate, mealType })),
    /** 「这一天/这一餐不要」：把系统算出的食材从清单里去掉（hidden=false 恢复） */
    setHidden: (payload: { mealDate: string; mealType: PurchaseScope; ingredientId: number; hidden: boolean }) =>
      request<{ list: PurchaseList }>('/purchase/hidden', json(payload)),
    /** 手动添加系统没算到的食材，amountText 为自由文案（如「3 根」），可不填 */
    addCustom: (payload: { mealDate: string; mealType: PurchaseScope; name: string; amountText?: string }) =>
      request<{ list: PurchaseList }>('/purchase/custom', json(payload)),
    /** day 口径传 name（三餐同名行一起改），按餐口径传 customId */
    setCustomState: (payload: {
      mealDate: string;
      mealType: PurchaseScope;
      customId?: number;
      name?: string;
      checked: boolean;
    }) => request<{ list: PurchaseList }>('/purchase/custom/state', json(payload)),
    removeCustom: (payload: { mealDate: string; mealType: PurchaseScope; customId?: number; name?: string }) =>
      request<{ list: PurchaseList }>('/purchase/custom/remove', json(payload)),
  },
  nutrition: {
    report: (date: string) => request<{ report: NutritionReport }>(`/nutrition?date=${date}`),
  },
  analytics: {
    overview: (range: number) => request<{ overview: AnalyticsOverview }>(`/analytics/overview?range=${range}`),
  },
  settings: {
    get: () => request<{ settings: AppSettings }>('/settings'),
    update: (payload: Partial<AppSettings>) =>
      request<{ settings: AppSettings; updated: string[] }>('/settings', patch(payload)),
    ingredients: () => request<{ ingredients: IngredientRecord[] }>('/settings/ingredients'),
    updateIngredient: (id: number, payload: { is_pantry?: boolean; price_per_100g?: number | null }) =>
      request<{ ok: boolean }>(`/settings/ingredients/${id}`, patch(payload)),
    /** 营养复核：把 AI 填的（'ai'）标成已复核（'manual'），或反过来重新标回待复核 */
    reviewIngredient: (id: number, nutrition_source: NutritionSource) =>
      request<{ ok: boolean }>(`/settings/ingredients/${id}`, patch({ nutrition_source })),
  },
  ai: {
    /** 配没配 key、用哪个模型：前端据此决定要不要露出 AI 入口 */
    status: () => request<{ enabled: boolean; model: string }>('/ai/status'),
    /**
     * 一句话分流：这句话该走加菜还是登记库存。
     * 只判断，不产草稿——拿到 intent 后再调 draft / fridgeDraft，两条提示词各自保持干净。
     */
    route: (text: string) =>
      request<{ intent: 'dish' | 'fridge'; reason: string; model: string }>('/ai/route', json({ text }), 60_000),
    /** 一句话 → 菜品草稿。**不写库**：确认后仍走 api.dishes.create。模型最长给 45s，前端留足 60s */
    draft: (text: string) => request<AiDraftResult>('/ai/draft', json({ text }), 60_000),
    /**
     * 一句话 → 库存草稿。**不写库**：确认后仍走 api.fridge.batch。
     * 「已经在库存里 / 是常备调料 / 库里没有」都由服务端判定，前端只负责展示与勾选。
     */
    fridgeDraft: (text: string) =>
      request<AiFridgeDraftResult>('/ai/fridge-draft', json({ text }), 60_000),
    /**
     * 改菜草稿：读这道菜的现状 + 它攒着的全部反馈，产出「现状 → 建议」的改动清单。
     * **不写库**：确认后走 updateFields + replaceIngredients，再删掉被覆盖到的反馈。
     */
    revisionDraft: (dishId: number) =>
      request<AiDishRevisionResult>('/ai/dish-revision-draft', json({ dishId }), 60_000),
  },
};
