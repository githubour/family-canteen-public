/**
 * 前后端共用的领域类型与常量（单一事实来源）。
 *
 * 为什么放在仓库根：这些类型同时描述服务端出参和前端消费的形状，任何一侧加字段都必须两边同步。
 * 以前 `server/src/types.ts` 与 `web/src/api/types.ts` 各存一份，已经漂移过（web 侧的 Dish/Member
 * 少了 `created_at`、Order 少了 `client_token`），所以统一到这里，让编译器替我们盯着。
 *
 * 命名约定：以 Row 结尾的是数据库原始行（snake_case、0/1 布尔、JSON 字符串），只存在于
 * `server/src/types.ts`；本文件放的是两端共用的领域对象（camelCase、真实布尔、已反序列化）。
 */

/* --------------------------------- 基础枚举 -------------------------------- */

export type MealType = 'breakfast' | 'lunch' | 'dinner';
export type OrderStatus = 'pending' | 'cooking' | 'done' | 'cancelled';
export type MemberRole = 'diner' | 'chef' | 'admin';

/** 一天的餐次顺序，多处统计（备料、看板、营养折算）都按这个顺序展开 */
export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner'];
export const ORDER_STATUSES: OrderStatus[] = ['pending', 'cooking', 'done', 'cancelled'];

/** 每一餐的人数上限：设置、购物车与下单校验共用同一份，避免 UI 12 / 服务端 20 的口径漂移 */
export const MAX_HEADCOUNT = 20;

/** 日期格式（只校验形状；真实日历合法性用 isValidISODate）。仅本文件内部使用 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 严格校验 YYYY-MM-DD：正则之外再用 UTC 回读年月日，拦掉 2026-13-99 / 2026-02-30 这类脏日期。
 * 用 UTC 是为了不受运行环境时区影响；输入本身不带时区。
 */
export function isValidISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const MEAL_LABEL: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
};

/** 各餐次的默认截单时间，设置里没配时用它 */
export const DEFAULT_CUTOFF: Record<MealType, string> = {
  breakfast: '08:00',
  lunch: '10:30',
  dinner: '16:30',
};

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '待接单',
  cooking: '备料中',
  done: '已完成',
  cancelled: '已取消',
};

/** 菜品分类白名单（前后端共用，不含「全部」——那是前端筛选概念） */
export const DISH_CATEGORIES = ['荤菜', '素菜', '汤', '主食', '饮品', '点心'] as const;

/* ---------------------------------- 成员 ---------------------------------- */

export interface Member {
  id: number;
  name: string;
  avatar: string;
  color: string;
  role: MemberRole;
  /** 忌口标签（库里是逗号分隔字符串，出参已反序列化成数组） */
  dislikes: string[];
  sort_order: number;
  created_at: string;
}

/** 订单/新菜建议/菜品反馈上携带的成员摘要：只带展示要的 4 个字段，避免到处拖整个 Member */
export type MemberBrief = Pick<Member, 'id' | 'name' | 'avatar' | 'color'>;

/* -------------------------------- 食材 / 营养 ------------------------------- */

/** 每 100g 可食部营养（对齐《中国食物成分表》口径） */
export interface NutritionFacts {
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
}

/* ---------------------------------- 菜品 ---------------------------------- */

export interface DishIngredient {
  ingredient_id: number;
  name: string;
  category: string;
  amount: number;
  unit: string;
  note: string | null;
  is_pantry: boolean;
  /** true = 必有（缺了这道菜不成立）；false = 可选（缺了只是口味打折，照样能做） */
  required: boolean;
}

export interface Dish {
  id: number;
  name: string;
  category: string;
  spicy: number;
  tags: string[];
  cook_minutes: number;
  difficulty: number;
  base_servings: number;
  emoji: string;
  description: string | null;
  is_fried: boolean;
  active: boolean;
  created_at: string;
  /** 季节窗口（月份数组，如 [9,10,11] = 只在 9-11 月出现）；空数组 = 全年显示 */
  season_months: number[];
  /** 「歇菜」到哪个月（YYYY-MM），到那个月自动回来；空串 = 没有歇菜 */
  hide_until: string;
  /** 做法步骤：一行一步的文本（空串 = 还没写），前端按行渲染成编号列表 */
  steps: string;
  /** 实拍图静态路径（/uploads/dishes/…），空串 = 没传图、展示层回退 emoji */
  image_url: string;
  /** 适用的餐别（已清洗：去重、按 MEAL_TYPES 顺序）；空数组 = 通用菜（不区分餐别） */
  meal_types: MealType[];
  ingredients: DishIngredient[];
  nutrition: NutritionFacts;
}

/* ---------------------------------- 订单 ---------------------------------- */

/**
 * 订单明细行：name / emoji / category 取自下单时的快照（不是菜品表的现状），
 * dish_id 仅在菜品还在时才有值——菜被彻底删除后置空，历史仍靠快照完整呈现。
 */
export interface OrderItem {
  id: number;
  dish_id: number | null;
  name: string;
  emoji: string;
  category: string;
  servings: number;
  note: string | null;
}

export interface Order {
  id: number;
  member_id: number;
  meal_date: string;
  meal_type: MealType;
  status: OrderStatus;
  note: string | null;
  headcount: number;
  created_at: string;
  updated_at: string;
  member: MemberBrief;
  items: OrderItem[];
}

/* --------------------------------- 采购清单 -------------------------------- */

/**
 * 采购清单的展示口径：某个餐次，或「day」= 当天三餐合并（采购页默认）。
 * day 只是读写的展示口径——勾选/改量/隐藏仍然落在各餐自己的 purchase_state 上（按餐扇出），
 * 所以大厨页的备料弹层与采购页永远是同一份状态，不存在两套进度打架。
 */
export type PurchaseScope = MealType | 'day';

/** 孤立食材：入了食材库但还没被任何菜品引用——采购页提醒建菜谱用起来 */
export interface OrphanIngredient {
  id: number;
  name: string;
  category: string;
  is_pantry: boolean;
}

export interface PurchaseItem {
  /** 手动添加的条目不对应任何配料表食材，这里为 null，改用 custom_id 标识 */
  ingredient_id: number | null;
  name: string;
  category: string;
  /** 基准单位（g）下的总需求量；手动条目不做换算，恒为 0 */
  amount: number;
  unit: string;
  buy_unit: string;
  buy_factor: number;
  /** 按购买单位换算后的展示文案，如「2 个（约 100g）」「1.2 斤（约 600g）」；手动条目即用户输入 */
  amount_text: string;
  is_pantry: boolean;
  checked: boolean;
  note: string | null;
  /** 人工改量后为 true，前端高亮提示 */
  overridden: boolean;
  /** 来自哪些菜，用于溯源展示；手动条目为空，前端显示「手动添加」 */
  from_dishes: string[];
  price: number | null;
  /** 手动添加的条目（purchase_custom 表），删除走自己的端点 */
  is_custom: boolean;
  custom_id: number | null;
  /** 这一天该食材出现在哪些餐（按早午晚有序）；按餐视图恒为 [mealType]，手动条目为 [] */
  meals: MealType[];
  /** true = 只为可选身份（今天引用它的菜都把它当可选）：默认不算必买，可跳过 */
  is_optional: boolean;
}

export interface PurchaseList {
  meal_date: string;
  /** 'day' = 当天三餐合并口径 */
  meal_type: PurchaseScope;
  generated_from: number;
  /** 必买项（含手动条目）：total / checked_count / estimated_cost 都只统计这一组 */
  to_buy: PurchaseItem[];
  pantry: PurchaseItem[];
  /** 只为可选身份的食材（引用它的菜都把它当可选）：默认不必买，前端折成「可选加购」一组 */
  optional: PurchaseItem[];
  /** 被人工「这一餐不要」隐藏的自动条目：前端提供恢复入口，避免误藏找不到 */
  hidden: PurchaseItem[];
  total: number;
  checked_count: number;
  estimated_cost: number;
}

/* --------------------------------- 营养建议 -------------------------------- */

export interface NutritionReference {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  status: 'low' | 'ok' | 'high';
}

export interface NutritionAdvice {
  id: string;
  level: 'good' | 'info' | 'warn';
  title: string;
  detail: string;
}

export interface NutritionReport {
  meal_date: string;
  headcount: number;
  dish_count: number;
  /** 三餐的在家/在外情况，让界面能说明「为什么这天看着吃得少」 */
  meals: MealAttendance[];
  /** 在家吃了几餐（0~3），膳食指南的参照区间按这个比例折算 */
  home_meals: number;
  totals: NutritionFacts;
  per_capita: NutritionFacts;
  salt_gram: number;
  fat_energy_ratio: number;
  vegetable_gram: number;
  meat_gram: number;
  seafood_gram: number;
  references: NutritionReference[];
  by_category: { category: string; kcal: number }[];
  advice: NutritionAdvice[];
}

/* -------------------------------- 用餐考勤 -------------------------------- */

export type AttendanceSource = 'orders' | 'override' | 'rule' | 'default';

/**
 * 某天某餐的用餐情况。
 * - orders：有订单，当然是在家吃
 * - override：这一天被单独改过（覆盖了星期规则）
 * - rule：命中「默认在外吃」的星期规则
 * - default：没有规则也没有订单，默认算在家吃
 *
 * source 说的是「当初凭什么这么判」，它不会随后续改规则而变化：
 * 过去的日子一旦判定就会被固化进 meal_attendance（locked = true），历史口径不再漂移。
 */
export interface MealAttendance {
  meal_type: MealType;
  at_home: boolean;
  source: AttendanceSource;
  order_count: number;
  /** true = 这条判定已落库固化（历史快照），不再随 away 规则变化 */
  locked: boolean;
}

/* -------------------------------- 新菜建议 -------------------------------- */

/** 家人提交的「想吃但菜单里没有」的菜，攒起来等统一加入 */
export interface DishRequest {
  id: number;
  name: string;
  note: string | null;
  /** 提交时为空则视为匿名；提交人被移除后也会变成 null */
  member_id: number | null;
  member: MemberBrief | null;
  created_at: string;
}

/* --------------------------------- 菜品反馈 -------------------------------- */

/**
 * 菜品反馈：家人/大厨就「这一道菜」随手记的自然语言反馈（偏咸、土豆没炖烂、火候不对…）。
 * 攒在库里等大模型统一读取并据此修正配方与做法，修正完后再删除对应条目。
 * 挂在菜品主数据上（dish_id），与具体哪一餐无关——同一道菜跨多餐累计，看长期问题。
 */
export interface DishFeedback {
  id: number;
  dish_id: number;
  content: string;
  /** 提交人；提交人被移除后变成 null（归到「匿名」） */
  member_id: number | null;
  member: MemberBrief | null;
  created_at: string;
}

/* ---------------------------------- 汇总 ---------------------------------- */

/**
 * 按人聚合的做菜贡献。接单备料即记一笔，不要求点过「做好了」——
 * 大厨经常忘，漏算才是错的。
 */
export interface CookStat {
  /** null 表示做菜人未记录（老数据或做菜人被移除） */
  member_id: number | null;
  name: string;
  avatar: string;
  color: string;
  /** 做菜次数 */
  cook_count: number;
  /** 累计做过的菜品道数（同一道菜做两次算两道次） */
  dishes: number;
  /** 累计做过的份数 */
  servings: number;
  /** 累计做过的菜的总卡路里（kcal，取自各条接单时的快照） */
  kcal: number;
}

export interface AnalyticsOverview {
  range_days: number;
  order_count: number;
  /** 订单行数（道次）：同一道菜被两个人点会算两条，用于“平均每餐道数” */
  dish_count: number;
  /** 真实份数：Σ order_items.servings，用于“菜品份数/采购量”口径 */
  serving_count: number;
  member_count: number;
  avg_dishes_per_meal: number;
  avg_kcal_per_capita: number;
  /** 区间内在家吃的餐次总数与在外吃的餐次总数，用于说明统计口径 */
  home_meal_count: number;
  away_meal_count: number;
  /** dish_id 可能为 null：那道菜已被彻底删除，排行按当时的菜名快照继续统计 */
  top_dishes: { dish_id: number | null; name: string; emoji: string; count: number }[];
  category_distribution: { category: string; count: number }[];
  cook_stats: CookStat[];
  member_profiles: {
    member_id: number;
    name: string;
    avatar: string;
    color: string;
    order_count: number;
    favorite_dish: string | null;
    favorite_category: string | null;
    avg_spicy: number;
    top_tags: string[];
  }[];
  /** home_meals 是当天在家吃的餐次数：小于 3 说明有餐次在外吃，趋势图上要标出来 */
  trend: { date: string; kcal: number; dishes: number; home_meals: number }[];
}

/* --------------------------------- AI 加菜 --------------------------------- */

/**
 * 食材营养值的来源——决定它要不要人复核。
 *
 * 为什么要这个标记：项目口径是「对齐《中国食物成分表》」，营养页还要跟膳食指南对照；
 * 而大模型填的 kcal / 蛋白质只能是估计值，这类错最隐蔽（热量偏高 30% 从界面上完全看不出来）。
 * 所以每条食材记下营养的来路，AI 填的在后台食材页黄标「待复核」。
 *
 * - seed：预置数据（《中国食物成分表》口径）
 * - ai：AI 起草时填的，等价于「待复核」
 * - manual：人工确认过的（AI 那条复核通过后落成它；采购页手工新建的食材也是它）
 */
export type NutritionSource = 'seed' | 'ai' | 'manual';

/**
 * AI 草稿里的配料行：库里已匹配到的（is_new=false）与需要新建的（is_new=true）合成一张表，
 * 前端逐行可编辑。为什么不让前后端各自维护两份（ingredients / newIngredients）：
 * 草稿要给人改，改完还要按同一份规则拆回去，中间任何一份漂移都会让「确认」落库落错。
 */
export interface AiDraftIngredient {
  /** 展示用名字：库内已匹配的是库里那个规范名，新食材是模型给的名字 */
  name: string;
  /** 每人份用量（克） */
  amount: number;
  required: boolean;
  /** true = 食材库里没有，确认入库时会连营养一起新建 */
  is_new: boolean;
  /**
   * 库内匹配到的食材名。与 name 不同说明命中了别名（如「西红柿」→ 库里的「番茄」）；
   * is_new=true 时为 null。
   */
  matched_name: string | null;
  /** 分类：新食材需要，库内已有的用库里的分类（这里只作展示） */
  category: string;
  /** is_new 且模型填了营养才有值；库内已有的为 null（用库里的数据） */
  nutrition: NutritionFacts | null;
  /**
   * is_new 行的营养来路：'seed' = 命中《中国食物成分表》参考表（服务端确定性覆盖，
   * 入库不挂「待复核」）；缺省 / 'ai' = 模型估的（后台黄标待复核）。
   */
  nutrition_source?: 'seed' | 'ai';
}

/** AI 起草的菜品草稿：形状对齐 POST /api/dishes，多了给人看的拆分信息 */
export interface AiDishDraft {
  name: string;
  /** 空串 = 模型没给出合法分类，卡片里必须人工选一个才能入库 */
  category: string;
  spicy: number;
  tags: string[];
  minutes: number;
  difficulty: number;
  baseServings: number;
  emoji: string;
  description: string;
  /** 做法：一行一步（提交时由服务端拼成一段文本） */
  steps: string[];
  mealTypes: MealType[];
  ingredients: AiDraftIngredient[];
  /** 每人份热量预览：只用库里已有的食材算得出来 */
  kcal_per_serving: number | null;
  /** 预览是否完整。false = 有新食材，热量还没算全 */
  nutrition_complete: boolean;
}

/** POST /api/ai/draft 的出参：草稿 + 中文提示（重名、别名归并、营养缺失…） */
export interface AiDraftResult {
  draft: AiDishDraft;
  notes: string[];
  /** 实际使用的模型名，出问题时能一眼看出线上跑的是哪个 */
  model: string;
}

/* ------------------------------- AI 登记库存 ------------------------------- */

/**
 * 库存草稿里一行的状态——由**服务端**判定，不是模型说的。
 *
 * 这一点是这块功能的地基：模型只负责「把这句话里提到的食材名提取出来、并分清是有的还是没的」，
 * 「哪些已经在库存里了」由服务端拿真实库存对一遍。所以不存在「模型漏看了库存导致重复登记」
 * 这类问题——它压根不需要知道库存现状（因此也没把库存清单塞进提示词）。
 */
type AiFridgeRowStatus =
  /** 要登记（库里能对上、当前不在库存、也不是常备调料） */
  | 'add'
  /** 要撤掉（用户明说没有 / 用完了，且它确实在库存里） */
  | 'remove'
  /** 已经在库存里了，无需动作——用户能看到「为什么这句话里只有两样被加进去」 */
  | 'already'
  /** 常备调料（盐、酱油…）：按现有设计不用登记，登记了也只会让库存变脏 */
  | 'pantry'
  /** 食材库里没有这样东西——行上带「建为食材」与疑似候选，人拍板后才转成 add / remove */
  | 'unknown'
  /** 听着是一道菜（净菜 / 半成品）：库存登记不了，行上带「去加菜」转交 AI 加菜 */
  | 'dish'
  /** 要把它标成常备调料（用户明说「设为常备」）：确认时改食材的 is_pantry，而不是加库存 */
  | 'make_pantry';

/** 「库里没有」时的疑似候选：服务端按名字重合**确定性**算出，只作建议，由人拍板 */
export interface AiFridgeCandidate {
  ingredient_id: number;
  name: string;
  category: string;
  /** 合并到常备调料时状态转 pantry（提示不用登记）而不是 add */
  is_pantry: boolean;
}

export interface AiFridgeRow {
  /** 库内食材 id；unknown / dish 时为 null */
  ingredient_id: number | null;
  /** 落库用的规范名（命中库里的那个名字）；unknown / dish 时是模型给的名字 */
  name: string;
  /** 用户原话里的叫法：与 name 不同说明命中了别名（「西红柿」→「番茄」） */
  said: string;
  category: string;
  status: AiFridgeRowStatus;
  /** unknown / dish 行：用户说它是「有」还是「没」——建库或合并后按原意接着登记 */
  want?: 'have' | 'missing';
  /** unknown 行的疑似已有食材（最多 3 个）：点一下即按那样登记 */
  candidates?: AiFridgeCandidate[];
  /** unknown 行：用户同时说了「设为常备」——「建为食材」时会直接建成常备 */
  pantry_intent?: boolean;
  /** make_pantry 行：它现在是否在库存里（在的话设常备时顺手从库存撤掉） */
  in_stock?: boolean;
}

/** POST /api/ai/fridge-draft 的出参 */
export interface AiFridgeDraftResult {
  rows: AiFridgeRow[];
  /** 中文提示：别名归并、自相矛盾（一会儿说有一会儿说没）、没说到的保持原样等 */
  notes: string[];
  model: string;
}

/* ------------------------------- AI 改菜草稿 ------------------------------- */

/**
 * AI 允许提议修改的菜品字段——**白名单**。
 * 模型只能在这几个里挑，落不了的（下架 / 季节窗口…）它碰不到：
 * 那些是人的运营决定，不该由一句反馈推导出来。
 * （餐别 meal_types 自 2026-10 起开放：反馈说「这道菜早上太腻」就该能改餐别。）
 */
export type DishEditableField =
  | 'name'
  | 'category'
  | 'spicy'
  | 'difficulty'
  | 'minutes'
  | 'baseServings'
  | 'emoji'
  | 'description'
  | 'tags'
  | 'steps'
  | 'meal_types';

/** 配料表的三种改动 */
type AiBomAction = 'add' | 'remove' | 'amount';

interface AiRevisionBomOp {
  action: AiBomAction;
  ingredient_id: number;
  name: string;
  /** amount / add 需要：每人份克数 */
  amount?: number;
  /** add 需要（缺省 true = 必有） */
  required?: boolean;
}

/**
 * 一条改动建议。前端拿它算「勾上之后这道菜变成什么样」，
 * 所以 before / after 只是给人看的，落库用 field+value / bom 这两项结构化数据。
 */
export interface AiRevisionChange {
  /** 稳定标识：前端勾选与去重用（服务端按顺序生成 c1、c2…） */
  id: string;
  /** 人话标签：「辣度」「盐（用量）」「加一样：小葱」 */
  label: string;
  /** 展示用旧值 / 新值（做法这类可能很长，前端折叠显示） */
  before: string;
  after: string;
  /** 字段改动：确认时并进 PATCH */
  field?: DishEditableField;
  value?: unknown;
  /** 配料表改动：确认时按 ingredient_id 应用到整张配料表 */
  bom?: AiRevisionBomOp;
  /** 这条改动是为回应哪几条反馈（卡片上原样列出，让人判断依据是否成立） */
  sources: { id: number; content: string }[];
  /** 模型认为这几条反馈互相矛盾（如一个说咸一个说淡），取了折中值 */
  conflict: boolean;
  /** 模型给的补充说明（矛盾时一般会写「取了中间值」这类） */
  note: string;
}

export interface AiDishRevisionDraft {
  /** 改动前的完整菜品：前端要拿它 + 勾选的改动算出最终要提交的那份 */
  dish: Dish;
  changes: AiRevisionChange[];
  /**
   * 模型明确表示「看不出要改什么」的反馈——**留在池里不动**。
   * 这是「不丢线索」的底线：不能为了每条反馈都有交代而硬编一个改动。
   */
  unhandled: { feedback_id: number; content: string; reason: string }[];
  /** 这次改动会连带影响到什么（服务端算的，不是模型说的） */
  effects: string[];
}

export interface AiDishRevisionResult {
  revision: AiDishRevisionDraft;
  notes: string[];
  model: string;
}

/* --------------------------------- 设置项 --------------------------------- */

/**
 * 运行期可配置的设置键（单一事实来源）。
 * 服务端 settings 路由的读写白名单与前端 AppSettings 的形状都从这里派生，
 * 新增一个设置项只需在下面补一行，前后端不会各自维护一份键名再慢慢漂移。
 */
export const SETTING_KEYS = [
  'cutoff.breakfast',
  'cutoff.lunch',
  'cutoff.dinner',
  'default.headcount',
  'notify.enabled',
  'notify.barkKey',
  'notify.serverchanKey',
  /** 「默认在外吃」的星期集合，如 '1,2,3,4,5'（0=周日 … 6=周六） */
  'away.breakfast',
  'away.lunch',
  'away.dinner',
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

/** 推送凭据类设置键：出参一律脱敏回显，绝不把真实 Key 回给浏览器（2026-10-20 安全修复） */
export const SENSITIVE_SETTING_KEYS = ['notify.barkKey', 'notify.serverchanKey'] as const;

/**
 * 脱敏回显串 = 「已配置」的占位，同时兼任「保持不变」哨兵：
 * GET 对已配置的敏感键回这个串；PATCH 收到这个串视为未改动、跳过不写。
 * 想真正清除 key：前端显式提交空串。
 */
export const SETTING_MASK = '******';

/** 设置的出参形状：键取自 SETTING_KEYS，值一律是字符串（布尔/数字在各自读取端解析） */
export type AppSettings = Record<SettingKey, string>;

/* --------------------------------- 实时事件 -------------------------------- */

/**
 * SSE 事件名：服务端 broadcast() 与前端 useServerEvents() 的共用契约，
 * 任何一侧拼错事件名都会在编译期暴露。
 * `ping` 只在连接建立时发一次用于探活；保活心跳走 SSE 注释帧，不占事件名。
 */
export type SseEventType =
  | 'order:created'
  | 'order:updated'
  | 'order:deleted'
  | 'purchase:updated'
  | 'member:updated'
  | 'dish:updated'
  | 'dish:deleted'
  | 'dish-request:updated'
  | 'fridge:updated'
  | 'settings:updated'
  | 'dish-feedback:updated'
  | 'ping';

/** 前端要订阅的事件清单（不含 ping——它只在建连时到达，前端无需处理） */
export const SSE_CLIENT_EVENTS: SseEventType[] = [
  'order:created',
  'order:updated',
  'order:deleted',
  'purchase:updated',
  'member:updated',
  'dish:updated',
  'dish:deleted',
  'dish-request:updated',
  'fridge:updated',
  'settings:updated',
  'dish-feedback:updated',
];
