/**
 * 采购服务：把当日订单按菜品配料表（BOM）展开，聚合成可执行的采购清单。
 *
 * 关键设计：
 * - 清单不落库、每次实时聚合，只把人工痕迹（勾选 / 改量 / 备注 / 「这餐不要」）存进
 *   purchase_state，手动添加的条目存 purchase_custom，
 *   这样订单变动后清单立刻同步，不会出现「重新生成后勾选丢失」的老问题。
 * - 常备调料不参与采购任务，单独成组返回，前端默认折叠。
 * - 同名食材跨菜合并，单位换算集中在 lib/units.ts。
 */
import { all, get, run, transaction } from '../db/index.js';
import { parseBomSnapshot } from '../lib/bom.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { formatBuyAmount, round } from '../lib/units.js';
import { broadcast } from '../lib/sse.js';
import {
  MEAL_LABEL,
  MEAL_TYPES,
  type MealType,
  type OrphanIngredient,
  type PurchaseItem,
  type PurchaseList,
  type PurchaseScope,
} from '../types.js';

interface AggregatedRow {
  ingredient_id: number;
  name: string;
  category: string;
  unit: string;
  buy_unit: string;
  buy_factor: number;
  is_pantry: number;
  price_per_100g: number | null;
  amount: number;
  dish_names: string | null;
  /** 今天引用它的菜里，只要有一道把它当必有就是 1；全是可选才是 0（→ 可跳过的采购项） */
  required_max: number;
}

interface StateRow {
  ingredient_id: number;
  checked: number;
  override_amount: number | null;
  note: string | null;
  hidden: number;
}

interface CustomRow {
  id: number;
  name: string;
  amount_text: string;
  checked: number;
}

/** 手动条目在分类分组里单独成组，排在系统算出的分组后面 */
const CUSTOM_CATEGORY = '手动添加';

/** 来源菜名的分隔符：菜名允许逗号，只能用不可能出现在菜名里的控制符（SQL 侧用 char(31)） */
const DISH_NAME_SEPARATOR = '\u001f';

/** 孤立食材：食材库里没被任何菜品引用的条目（含常备调料），提醒家人及时建菜谱用起来 */
export function listOrphanIngredients(): OrphanIngredient[] {
  return all<{ id: number; name: string; category: string; is_pantry: number }>(
    `SELECT i.id, i.name, i.category, i.is_pantry
       FROM ingredients i
      WHERE NOT EXISTS (SELECT 1 FROM dish_ingredients di WHERE di.ingredient_id = i.id)
      ORDER BY i.category, i.name`,
  ).map((row) => ({ id: row.id, name: row.name, category: row.category, is_pantry: row.is_pantry !== 0 }));
}

/** 手动补入食材库：采购时发现库里没有的食材先建进来（营养值默认 0，后台可补）。
 *  新食材没有任何菜品引用，会立刻出现在「孤立食材」提醒里，建菜谱时就能选到。 */
export function createIngredient(name: string, category: string, isPantry: boolean): OrphanIngredient {
  const trimmed = name.trim();
  if (!trimmed) throw badRequest('先写食材名称');
  if (trimmed.length > 20) throw badRequest('食材名称太长了（20 字以内）');
  const trimmedCategory = category.trim();
  if (!trimmedCategory || trimmedCategory.length > 10) throw badRequest('分类不对');
  if (get('SELECT id FROM ingredients WHERE name = ?', trimmed)) {
    throw badRequest(`食材库里已经有「${trimmed}」了`);
  }
  // 手工建的食材营养还是空的（页面上那六项填 0），来源标记为 manual：
  // 「待复核」这个信号专门留给 AI 填的数字，别让一条空营养行混进去
  run(
    "INSERT INTO ingredients (name, category, is_pantry, nutrition_source) VALUES (?, ?, ?, 'manual')",
    trimmed,
    trimmedCategory,
    isPantry ? 1 : 0,
  );
  return { id: Number(get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', trimmed)!.id), name: trimmed, category: trimmedCategory, is_pantry: isPantry };
}

/**
 * 从食材库删掉一条「孤立食材」（加错了、不打算用了）。
 * 只在没有任何菜品引用它时才允许删——用到菜谱里的会破坏菜的配料表，得先从菜里去掉；
 * 删除前顺手清掉它在采购清单里留下的勾选 / 改量痕迹（purchase_state 对 ingredients
 * 没有级联删除），否则会留下指向已删食材的孤儿行、把后续写库撞在外键上。
 * fridge_stock 是 ON DELETE CASCADE，登记过的库存随食材一起消失。返回刷新后的孤立清单。
 */
export function deleteIngredient(id: number): OrphanIngredient[] {
  const row = get<{ id: number; name: string }>('SELECT id, name FROM ingredients WHERE id = ?', id);
  if (!row) throw notFound('食材不存在');

  const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM dish_ingredients WHERE ingredient_id = ?', id);
  if (Number(used?.c ?? 0) > 0) {
    throw conflict('INGREDIENT_IN_USE', `「${row.name}」已经用在菜谱里了，先从菜里去掉再删`);
  }

  // 登记过库存的话，fridge_stock 会跟着级联删掉，得让别端把库存横幅一起刷掉
  const hadStock = Boolean(get('SELECT ingredient_id FROM fridge_stock WHERE ingredient_id = ?', id));
  transaction(() => {
    run('DELETE FROM purchase_state WHERE ingredient_id = ?', id);
    run('DELETE FROM ingredients WHERE id = ?', id);
  });
  if (hadStock) broadcast('fridge:updated', { ingredientId: id });
  return listOrphanIngredients();
}

/**
 * 采购聚合：同一餐次里「还在菜谱上的菜」按最新配方算（今天买菜要对得上现在的菜谱），
 * 菜品被彻底删除或压根没录配料的订单行，回退到下单那一刻的 BOM 快照，两边按食材合并。
 */
function aggregateIngredientUsage(mealDate: string, mealType: MealType): AggregatedRow[] {
  const current = all<AggregatedRow>(
    `SELECT i.id AS ingredient_id, i.name, i.category, i.unit, i.buy_unit, i.buy_factor,
            i.is_pantry, i.price_per_100g,
            SUM(di.amount * oi.servings) AS amount,
            -- 任一菜把它当必有（1）→ 必买；全是可选（0）→ 可跳过
            MAX(di.required) AS required_max,
            -- 优先用订单行上的快照菜名；万一这行没快照（老数据/外部导入），回退到菜品表的现名。
            -- 分隔符用 char(31) 而不是默认逗号：菜名本身允许逗号，重复菜名留给下游 Set 去重
            GROUP_CONCAT(COALESCE(NULLIF(oi.dish_name, ''), d.name), char(31)) AS dish_names
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN dish_ingredients di ON di.dish_id = oi.dish_id
       JOIN ingredients i ON i.id = di.ingredient_id
       LEFT JOIN dishes d ON d.id = oi.dish_id
      WHERE o.meal_date = ? AND o.meal_type = ? AND o.status != 'cancelled'
      GROUP BY i.id`,
    mealDate,
    mealType,
  );
  const merged = new Map<number, AggregatedRow>(current.map((row) => [row.ingredient_id, row]));

  const fallbackRows = all<{ dish_name: string; servings: number; bom: string }>(
    `SELECT oi.dish_name, oi.servings, oi.bom
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.meal_date = ? AND o.meal_type = ? AND o.status != 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM dish_ingredients di WHERE di.dish_id = oi.dish_id)`,
    mealDate,
    mealType,
  );
  if (fallbackRows.length === 0) return sortAggregated(merged);

  const snapshotItems: { ingredient_id: number; dish_name: string; amount: number; name: string; category: string; unit: string; is_pantry: number; required: number }[] = [];
  for (const order of fallbackRows) {
    for (const item of parseBomSnapshot(order.bom)) {
      snapshotItems.push({
        ingredient_id: item.ingredient_id,
        dish_name: order.dish_name,
        amount: item.amount * order.servings,
        name: item.name,
        category: item.category,
        unit: item.unit,
        is_pantry: item.is_pantry,
        // 老快照没有 required：按必有处理，宁可不漏买
        required: item.required ?? 1,
      });
    }
  }
  if (snapshotItems.length === 0) return sortAggregated(merged);

  // 快照不给换算单位与价格，能对上食材库的（食材还在）就用现状值，对不上的按基准单位展示
  const ids = Array.from(new Set(snapshotItems.map((item) => item.ingredient_id)));
  const liveRows = all<{
    id: number;
    name: string;
    category: string;
    unit: string;
    buy_unit: string;
    buy_factor: number;
    is_pantry: number;
    price_per_100g: number | null;
  }>(
    `SELECT id, name, category, unit, buy_unit, buy_factor, is_pantry, price_per_100g
       FROM ingredients WHERE id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  const liveMap = new Map(liveRows.map((row) => [row.id, row]));

  for (const item of snapshotItems) {
    const live = liveMap.get(item.ingredient_id);
    const existing = merged.get(item.ingredient_id);
    if (existing) {
      existing.amount += item.amount;
      existing.dish_names = existing.dish_names
        ? `${existing.dish_names}${DISH_NAME_SEPARATOR}${item.dish_name}`
        : item.dish_name;
      existing.required_max = Math.max(existing.required_max, item.required);
      continue;
    }
    merged.set(item.ingredient_id, {
      ingredient_id: item.ingredient_id,
      name: live?.name ?? item.name,
      category: live?.category ?? item.category,
      unit: live?.unit ?? item.unit,
      buy_unit: live?.buy_unit ?? item.unit,
      buy_factor: live?.buy_factor ?? 1,
      is_pantry: live?.is_pantry ?? item.is_pantry,
      price_per_100g: live?.price_per_100g ?? null,
      amount: item.amount,
      dish_names: item.dish_name,
      required_max: item.required,
    });
  }
  return sortAggregated(merged);
}

/** 分类 + 名称排序，口径与 SQL 里的 ORDER BY category, name 一致（按码点比较，别换成 localeCompare） */
function byCategoryName(a: { category: string; name: string }, b: { category: string; name: string }): number {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

/** 按分类 + 名称排序（与 SQL 口径一致，比较器共用 byCategoryName） */
function sortAggregated(rows: Map<number, AggregatedRow>): AggregatedRow[] {
  return Array.from(rows.values()).sort(byCategoryName);
}

/* ------------------------------ 清单条目构造 ------------------------------ */

/** 自动条目的公共字段来源：按餐聚合行与 day 折叠桶（的 row）都是这个形状 */
interface AutoItemSource {
  ingredient_id: number;
  name: string;
  category: string;
  unit: string;
  buy_unit: string;
  buy_factor: number;
  is_pantry: number;
  price_per_100g: number | null;
  required_max: number;
}

/** from_dishes 的来源字符串可能带重复菜名（快照兜底那条路径是拼接出来的），统一去重 */
function dedupeDishNames(joined: string | null): string[] {
  return joined ? Array.from(new Set(joined.split(DISH_NAME_SEPARATOR).filter(Boolean))) : [];
}

/**
 * 构造「系统算出」的清单条目：按餐视图与 day 视图只在 view 的取值上不同，
 * 20+ 个字段的映射收在这里一份，避免两处平行实现各自漂移。
 */
function makeAutoItem(
  source: AutoItemSource,
  view: {
    /** 有效量：改过量就用改过的量 */
    amount: number;
    checked: boolean;
    note: string | null;
    overridden: boolean;
    dishes: string[];
    /** 这一条出现在哪些餐：按餐视图恒为 [mealType]，day 视图是当天几餐的合集 */
    meals: MealType[];
  },
): PurchaseItem {
  return {
    ingredient_id: source.ingredient_id,
    name: source.name,
    category: source.category,
    amount: round(view.amount, 1),
    unit: source.unit,
    buy_unit: source.buy_unit,
    buy_factor: source.buy_factor,
    amount_text: formatBuyAmount(view.amount, source.buy_unit, source.buy_factor),
    is_pantry: source.is_pantry === 1,
    checked: view.checked,
    note: view.note,
    overridden: view.overridden,
    from_dishes: view.dishes,
    price: source.price_per_100g,
    is_custom: false,
    custom_id: null,
    meals: view.meals,
    // 今天引用它的菜里没一道把它当必有 → 只是可选的加购项，默认不算必买
    is_optional: source.required_max === 0,
  };
}

/** 构造手动添加的条目：不对应配料表食材，一律算必买，买不买由用户自己决定 */
function makeCustomItem(id: number, name: string, amountText: string, checked: boolean, meals: MealType[]): PurchaseItem {
  return {
    ingredient_id: null,
    name,
    category: CUSTOM_CATEGORY,
    amount: 0,
    unit: '',
    buy_unit: '',
    buy_factor: 1,
    amount_text: amountText,
    is_pantry: false,
    checked,
    note: null,
    overridden: false,
    from_dishes: [],
    price: null,
    is_custom: true,
    custom_id: id,
    meals,
    is_optional: false,
  };
}

/** 清单组装：隐藏过滤 + 必买/可选/常备分栏 + 成本合计。按餐与 day 共用同一套口径 */
function assembleList(args: {
  mealDate: string;
  mealType: PurchaseScope;
  autoItems: PurchaseItem[];
  hiddenIds: Set<number>;
  customItems: PurchaseItem[];
  generatedFrom: number;
}): PurchaseList {
  const visible = args.autoItems.filter((item) => !args.hiddenIds.has(item.ingredient_id as number));
  const hidden = args.autoItems.filter((item) => args.hiddenIds.has(item.ingredient_id as number));
  const items: PurchaseItem[] = [...visible, ...args.customItems];

  // 必买 / 可选加购分两栏：可选的是「今天引用它的菜都把它当可选」的食材，跳过不影响做出菜
  const toBuy = items.filter((item) => !item.is_pantry && !item.is_optional);
  const optional = items.filter((item) => !item.is_pantry && item.is_optional);
  const pantry = items.filter((item) => item.is_pantry);
  const estimated = toBuy.reduce((sum, item) => sum + (item.price ?? 0) * (item.amount / 100), 0);

  return {
    meal_date: args.mealDate,
    meal_type: args.mealType,
    generated_from: args.generatedFrom,
    to_buy: toBuy,
    pantry,
    optional,
    hidden,
    total: toBuy.length,
    checked_count: toBuy.filter((item) => item.checked).length,
    estimated_cost: round(estimated, 1),
  };
}

/** 某餐的手动条目（勾选 / 删除都按行操作，这里只读） */
function readCustomRows(mealDate: string, mealType: MealType): CustomRow[] {
  return all<CustomRow>(
    'SELECT id, name, amount_text, checked FROM purchase_custom WHERE meal_date = ? AND meal_type = ? ORDER BY id',
    mealDate,
    mealType,
  );
}

export function buildPurchaseList(
  mealDate: string,
  mealType: MealType,
  rows: AggregatedRow[] = aggregateIngredientUsage(mealDate, mealType),
): PurchaseList {
  const states = readStateMap(mealDate, mealType);
  const hiddenIds = new Set(
    Array.from(states.values())
      .filter((state) => state.hidden === 1)
      .map((state) => state.ingredient_id),
  );

  const autoItems = rows.map((row) => {
    const state = states.get(row.ingredient_id);
    const overridden = state?.override_amount != null;
    return makeAutoItem(row, {
      amount: overridden ? Number(state?.override_amount) : row.amount,
      checked: state?.checked === 1,
      note: state?.note ?? null,
      overridden,
      dishes: dedupeDishNames(row.dish_names),
      // 按餐视图恒为当前这一餐；跨餐合并只出现在 day 口径（见 buildDayPurchaseList）
      meals: [mealType],
    });
  });
  const customItems = readCustomRows(mealDate, mealType).map((row) =>
    makeCustomItem(row.id, row.name, row.amount_text, row.checked === 1, []),
  );

  const orderCount = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM orders WHERE meal_date = ? AND meal_type = ? AND status != 'cancelled'`,
    mealDate,
    mealType,
  );

  return assembleList({
    mealDate,
    mealType,
    autoItems,
    hiddenIds,
    customItems,
    generatedFrom: Number(orderCount?.c ?? 0),
  });
}

/* ---------------------------- 采购清单：day 口径 ---------------------------- */

/** 某餐的状态行（勾选 / 改量 / 备注 / 隐藏），day 口径要逐餐读 */
function readStateMap(mealDate: string, mealType: MealType): Map<number, StateRow> {
  const rows = all<StateRow>(
    'SELECT ingredient_id, checked, override_amount, note, hidden FROM purchase_state WHERE meal_date = ? AND meal_type = ?',
    mealDate,
    mealType,
  );
  return new Map(rows.map((row) => [row.ingredient_id, row]));
}

interface DayBucketDetail {
  mealType: MealType;
  /** 这一餐的有效量：改过量就用改过的量 */
  amount: number;
}

interface DayBucket {
  row: AggregatedRow;
  /** 各餐有效量之和 */
  amount: number;
  meals: MealType[];
  /** 各餐有效量明细：改量分摊 / 隐藏扇出直接用它，不必为找一行再把三餐重新聚合一遍 */
  details: DayBucketDetail[];
  /** 交集语义：出现的每一餐都勾了才算买好（缺状态行 = 没勾） */
  checked: boolean;
  /** 每一餐都被「今天不要」才从 day 清单消失 */
  hidden: boolean;
  overridden: boolean;
  note: string | null;
  dishes: Set<string>;
  /** 各餐 required_max 取最大：任一顿把它当必有，这一天就得买 */
  required_max: number;
}

/**
 * day 折叠桶：三餐各聚合一次，按食材折叠成一行（不另写 SQL，复用按餐的聚合与 BOM 快照兜底）。
 *
 * 合并的语义刻意做成「交叉语义 + 扇出写」：
 * - 数量 = 各餐**有效量**相加（改过量就用改过的，分摊写之后天然等于用户输入的总量）；
 * - 勾选 = 每一餐都勾（交集）；隐藏 = 每一餐都藏。这样点一下 day 的勾，大厨页三餐备料同时就绪。
 * 状态仍然只存在各餐自己的 purchase_state 行里，不引入新表、不新增状态空间。
 *
 * 聚合只依赖订单与配料表（与 purchase_state 无关），同一次请求里算一次、
 * 写前分摊与写后重建清单共用同一份（agg 参数）；purchase_state 仍在函数内现读，
 * 收尾重建时反映的正是刚写入的状态。
 */
type DayAggregation = Map<MealType, AggregatedRow[]>;

/** 当天三餐各自的聚合结果：一次请求内复用，避免「day 改量」把三餐聚合跑两遍 */
function aggregateDay(mealDate: string): DayAggregation {
  const agg: DayAggregation = new Map();
  for (const mealType of MEAL_TYPES) {
    agg.set(mealType, aggregateIngredientUsage(mealDate, mealType));
  }
  return agg;
}

function computeDayBuckets(mealDate: string, agg: DayAggregation): Map<number, DayBucket> {
  const buckets = new Map<number, DayBucket>();

  for (const mealType of MEAL_TYPES) {
    const rows = agg.get(mealType) ?? [];
    const states = readStateMap(mealDate, mealType);
    for (const row of rows) {
      const state = states.get(row.ingredient_id);
      const effective = state?.override_amount != null ? Number(state.override_amount) : row.amount;
      const bucket = buckets.get(row.ingredient_id) ?? {
        row,
        amount: 0,
        meals: [],
        details: [],
        checked: true,
        hidden: true,
        overridden: false,
        note: null,
        dishes: new Set<string>(),
        required_max: 0,
      };
      bucket.amount += effective;
      bucket.required_max = Math.max(bucket.required_max, row.required_max);
      bucket.meals.push(mealType);
      bucket.details.push({ mealType, amount: effective });
      bucket.checked = bucket.checked && state?.checked === 1;
      bucket.hidden = bucket.hidden && state?.hidden === 1;
      bucket.overridden = bucket.overridden || state?.override_amount != null;
      if (!bucket.note && state?.note) bucket.note = state.note;
      for (const dish of row.dish_names?.split(DISH_NAME_SEPARATOR) ?? []) if (dish) bucket.dishes.add(dish);
      buckets.set(row.ingredient_id, bucket);
    }
  }
  return buckets;
}

/** 这个食材今天出现在哪几餐、各餐有效量（改过量用改过的）；找不到 = 今天的清单里没有它。
 *  只查这一个食材的状态行，不再为找它把三餐整体重新聚合 */
function dayMealDetails(mealDate: string, agg: DayAggregation, ingredientId: number): DayBucketDetail[] {
  const details: DayBucketDetail[] = [];
  for (const mealType of MEAL_TYPES) {
    const row = agg.get(mealType)?.find((item) => item.ingredient_id === ingredientId);
    if (!row) continue;
    const state = get<StateRow>(
      'SELECT ingredient_id, checked, override_amount, note, hidden FROM purchase_state WHERE meal_date = ? AND meal_type = ? AND ingredient_id = ?',
      mealDate,
      mealType,
      ingredientId,
    );
    details.push({ mealType, amount: state?.override_amount != null ? Number(state.override_amount) : row.amount });
  }
  return details;
}

export function buildDayPurchaseList(mealDate: string, agg: DayAggregation = aggregateDay(mealDate)): PurchaseList {
  const buckets = computeDayBuckets(mealDate, agg);
  const autoItems: PurchaseItem[] = [];
  const hiddenIds = new Set<number>();
  for (const bucket of Array.from(buckets.values()).sort((a, b) => byCategoryName(a.row, b.row))) {
    if (bucket.hidden) hiddenIds.add(bucket.row.ingredient_id);
    autoItems.push(
      makeAutoItem(bucket.row, {
        amount: bucket.amount,
        checked: bucket.checked,
        note: bucket.note,
        overridden: bucket.overridden,
        dishes: Array.from(bucket.dishes),
        meals: bucket.meals,
      }),
    );
  }

  // 手动条目按名称折叠：day 添加时是三餐各插一行同名，这里合成一行（id 最小的那行做 key）
  const customRows = all<CustomRow>(
    'SELECT id, name, amount_text, checked FROM purchase_custom WHERE meal_date = ? ORDER BY id',
    mealDate,
  );
  const customBuckets = new Map<string, { id: number; amountText: string; checked: boolean }>();
  for (const row of customRows) {
    const existing = customBuckets.get(row.name);
    if (!existing) {
      customBuckets.set(row.name, { id: row.id, amountText: row.amount_text, checked: row.checked === 1 });
      continue;
    }
    existing.checked = existing.checked && row.checked === 1;
    if (!existing.amountText && row.amount_text) existing.amountText = row.amount_text;
  }
  const customItems = Array.from(customBuckets.entries()).map(([name, entry]) =>
    makeCustomItem(entry.id, name, entry.amountText, entry.checked, []),
  );

  const orderCount = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM orders WHERE meal_date = ? AND status != 'cancelled'`,
    mealDate,
  );

  return assembleList({
    mealDate,
    mealType: 'day',
    autoItems,
    hiddenIds,
    customItems,
    generatedFrom: Number(orderCount?.c ?? 0),
  });
}

interface PurchaseStatePatch {
  checked?: number;
  overrideAmount?: number | null;
  note?: string | null;
  hidden?: number;
}

/**
 * 单行 upsert：未指定的字段沿用旧值；day 的勾选 / 改量 / 备注 / 隐藏都复用它。
 * 一条语句表达 patch 语义（原来是 SELECT + UPSERT 两条）：checked / hidden 的值只会是
 * 0/1，「未传」用 NULL 占位（COALESCE 回落旧值）；override_amount / note 显式传 null
 * 是有含义的（清空），各配一个 0/1 标志位区分「未传」与「传 null」。
 */
function upsertPurchaseState(
  mealDate: string,
  mealType: MealType,
  ingredientId: number,
  patch: PurchaseStatePatch,
): void {
  run(
    `INSERT INTO purchase_state (meal_date, meal_type, ingredient_id, checked, override_amount, note, hidden, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(meal_date, meal_type, ingredient_id)
     DO UPDATE SET checked = COALESCE(?, purchase_state.checked),
                   override_amount = CASE WHEN ? THEN ? ELSE purchase_state.override_amount END,
                   note = CASE WHEN ? THEN ? ELSE purchase_state.note END,
                   hidden = COALESCE(?, purchase_state.hidden),
                   updated_at = datetime('now','localtime')`,
    mealDate,
    mealType,
    ingredientId,
    patch.checked ?? 0,
    patch.overrideAmount ?? null,
    patch.note ?? null,
    patch.hidden ?? 0,
    patch.checked === undefined ? null : patch.checked,
    patch.overrideAmount === undefined ? 0 : 1,
    patch.overrideAmount ?? null,
    patch.note === undefined ? 0 : 1,
    patch.note ?? null,
    patch.hidden === undefined ? null : patch.hidden,
  );
}

interface DayPurchaseStateInput {
  mealDate: string;
  ingredientId: number;
  checked?: boolean;
  overrideAmount?: number | null;
  note?: string | null;
}

/** 写操作的统一收尾：重建清单 → 广播更新 → 返回新清单。
 *  reuse 复用同一次请求已算好的聚合（聚合只依赖订单与配料表，写入不影响它），
 *  purchase_state 仍在重建时现读，返回的清单反映刚写入的状态 */
function finish(
  mealDate: string,
  mealType: PurchaseScope,
  reuse?: { day?: DayAggregation; rows?: AggregatedRow[] },
): PurchaseList {
  const list =
    mealType === 'day'
      ? buildDayPurchaseList(mealDate, reuse?.day)
      : buildPurchaseList(mealDate, mealType, reuse?.rows);
  broadcast('purchase:updated', { mealDate, mealType });
  return list;
}

/**
 * day 改状态：结果扇出到「该食材当天出现的每一餐」。
 * 改量按各餐原始量的占比分摊（最后一餐吃舍入误差，保证各餐之和 = 用户输入的当日总量），
 * 这样大厨页各餐备料弹层里的数字仍然说得通。
 */
export function setDayPurchaseState(input: DayPurchaseStateInput): PurchaseList {
  const agg = aggregateDay(input.mealDate);
  const meals = dayMealDetails(input.mealDate, agg, input.ingredientId);
  if (meals.length === 0) throw notFound('今天的清单里没有这个食材');

  const target = input.overrideAmount;
  if (target !== undefined && target !== null && (!Number.isFinite(target) || target <= 0 || target > 100_000)) {
    throw badRequest('数量要大于 0 且不超过 100000');
  }

  transaction(() => {
    if (target === null) {
      for (const meal of meals) {
        upsertPurchaseState(input.mealDate, meal.mealType, input.ingredientId, { overrideAmount: null });
      }
    } else if (typeof target === 'number') {
      const total = meals.reduce((sum, meal) => sum + meal.amount, 0);
      let remaining = target;
      meals.forEach((meal, index) => {
        const isLast = index === meals.length - 1;
        // 各餐原始量全为 0 的极端情况：全记第一餐，别除以 0
        const share = total > 0 ? round(target * (meal.amount / total), 1) : index === 0 ? target : 0;
        const value = isLast ? round(remaining, 1) : share;
        remaining -= value;
        upsertPurchaseState(input.mealDate, meal.mealType, input.ingredientId, { overrideAmount: value });
      });
    }
    if (input.checked !== undefined) {
      for (const meal of meals) {
        upsertPurchaseState(input.mealDate, meal.mealType, input.ingredientId, { checked: input.checked ? 1 : 0 });
      }
    }
    if (input.note !== undefined) {
      for (const meal of meals) {
        upsertPurchaseState(input.mealDate, meal.mealType, input.ingredientId, { note: input.note });
      }
    }
  });

  return finish(input.mealDate, 'day', { day: agg });
}

/** day 的「今天不要」：每一餐都打上隐藏标记（可恢复）；大厨页单独藏一餐时，其余餐照常显示 */
export function setDayPurchaseHidden(mealDate: string, ingredientId: number, hidden: boolean): PurchaseList {
  const agg = aggregateDay(mealDate);
  const meals = dayMealDetails(mealDate, agg, ingredientId);
  if (meals.length === 0) throw notFound('今天的清单里没有这个食材');

  transaction(() => {
    for (const meal of meals) {
      upsertPurchaseState(mealDate, meal.mealType, ingredientId, { hidden: hidden ? 1 : 0 });
    }
  });
  return finish(mealDate, 'day', { day: agg });
}

/** day 补一样食材：三餐各插一行同名（该餐已有同名就跳过），day 视图按名称折叠成一行 */
export function addDayPurchaseCustom(mealDate: string, name: string, amountText: string): PurchaseList {
  transaction(() => {
    for (const mealType of MEAL_TYPES) {
      const exists = get<{ id: number }>(
        'SELECT id FROM purchase_custom WHERE meal_date = ? AND meal_type = ? AND name = ?',
        mealDate,
        mealType,
        name,
      );
      if (exists) continue;
      run(
        'INSERT INTO purchase_custom (meal_date, meal_type, name, amount_text) VALUES (?, ?, ?, ?)',
        mealDate,
        mealType,
        name,
        amountText,
      );
    }
  });
  return finish(mealDate, 'day');
}

/** day 勾选/取消手动条目：当天三餐所有同名行一起改 */
export function setDayPurchaseCustomState(mealDate: string, name: string, checked: boolean): PurchaseList {
  run('UPDATE purchase_custom SET checked = ? WHERE meal_date = ? AND name = ?', checked ? 1 : 0, mealDate, name);
  return finish(mealDate, 'day');
}

/** day 删除手动条目：当天三餐所有同名行一起删 */
export function removeDayPurchaseCustom(mealDate: string, name: string): PurchaseList {
  run('DELETE FROM purchase_custom WHERE meal_date = ? AND name = ?', mealDate, name);
  return finish(mealDate, 'day');
}

interface PurchaseStateInput {
  mealDate: string;
  mealType: MealType;
  ingredientId: number;
  checked?: boolean;
  overrideAmount?: number | null;
  note?: string | null;
}

export function setPurchaseState(input: PurchaseStateInput): PurchaseList {
  const target = input.overrideAmount;
  if (target !== undefined && target !== null && (!Number.isFinite(target) || target <= 0 || target > 100_000)) {
    throw badRequest('数量要大于 0 且不超过 100000');
  }
  // patch 语义与 day 口径共用同一份 upsert：未传的字段沿用旧值，hidden 原样保留
  transaction(() => {
    upsertPurchaseState(input.mealDate, input.mealType, input.ingredientId, {
      checked: input.checked === undefined ? undefined : input.checked ? 1 : 0,
      overrideAmount: input.overrideAmount,
      note: input.note,
    });
  });

  return finish(input.mealDate, input.mealType);
}

/** 「这一餐不要」：把系统算出的某个食材从本餐清单里去掉（只打标记，重置可恢复） */
export function setPurchaseHidden(
  mealDate: string,
  mealType: MealType,
  ingredientId: number,
  hidden: boolean,
): PurchaseList {
  if (hidden) {
    // 已有的勾选 / 改量 / 备注原样保留，恢复后还在（upsert 的 patch 语义天然满足）
    upsertPurchaseState(mealDate, mealType, ingredientId, { hidden: 1 });
  } else {
    // 恢复：没打过标记的行本来就可见，UPDATE 不到也无妨
    run(
      `UPDATE purchase_state SET hidden = 0, updated_at = datetime('now','localtime')
        WHERE meal_date = ? AND meal_type = ? AND ingredient_id = ?`,
      mealDate,
      mealType,
      ingredientId,
    );
  }
  return finish(mealDate, mealType);
}

/** 手动添加一个系统没算到的食材（用量为自由文案，不做单位换算） */
export function addPurchaseCustom(mealDate: string, mealType: MealType, name: string, amountText: string): PurchaseList {
  run(
    `INSERT INTO purchase_custom (meal_date, meal_type, name, amount_text) VALUES (?, ?, ?, ?)`,
    mealDate,
    mealType,
    name,
    amountText,
  );
  return finish(mealDate, mealType);
}

/** 手动条目的勾选 / 取消，与自动条目的勾选同一份进度 */
export function setPurchaseCustomState(mealDate: string, mealType: MealType, customId: number, checked: boolean): PurchaseList {
  run(
    'UPDATE purchase_custom SET checked = ? WHERE id = ? AND meal_date = ? AND meal_type = ?',
    checked ? 1 : 0,
    customId,
    mealDate,
    mealType,
  );
  return finish(mealDate, mealType);
}

export function removePurchaseCustom(mealDate: string, mealType: MealType, customId: number): PurchaseList {
  run('DELETE FROM purchase_custom WHERE id = ? AND meal_date = ? AND meal_type = ?', customId, mealDate, mealType);
  return finish(mealDate, mealType);
}

/** 回到系统原样：勾选 / 改量 / 备注 / 隐藏标记 / 手动条目一并清掉（不开事务，便于 day 循环三餐） */
function clearPurchaseState(mealDate: string, mealType: MealType): void {
  run('DELETE FROM purchase_state WHERE meal_date = ? AND meal_type = ?', mealDate, mealType);
  run('DELETE FROM purchase_custom WHERE meal_date = ? AND meal_type = ?', mealDate, mealType);
}

export function resetPurchaseState(mealDate: string, mealType: MealType): PurchaseList {
  transaction(() => clearPurchaseState(mealDate, mealType));
  return finish(mealDate, mealType);
}

/** day 版「恢复数量」：当天三餐的状态与手动条目一起清掉 */
export function resetDayPurchaseState(mealDate: string): PurchaseList {
  transaction(() => {
    for (const mealType of MEAL_TYPES) clearPurchaseState(mealDate, mealType);
  });
  return finish(mealDate, 'day');
}

/** 一键导出纯文本，方便直接粘贴到微信 */
export function buildPurchaseText(list: PurchaseList): string {
  const lines: string[] = [];
  // day 口径是「今天买什么」，标题不带餐别词（省得每周报一次早午晚三次买菜）
  const scopeLabel = list.meal_type === 'day' ? '' : MEAL_LABEL[list.meal_type];
  lines.push(`【${list.meal_date} ${scopeLabel}采购清单】`);
  lines.push(`共 ${list.total} 项，来自 ${list.generated_from} 份点单`);
  lines.push('');

  const groups = new Map<string, PurchaseItem[]>();
  for (const item of list.to_buy) {
    const bucket = groups.get(item.category) ?? [];
    bucket.push(item);
    groups.set(item.category, bucket);
  }
  for (const [category, items] of groups) {
    lines.push(`◆ ${category}`);
    for (const item of items) {
      lines.push(`  ${item.checked ? '✔' : '□'} ${item.name}  ${item.amount_text}${item.note ? `（${item.note}）` : ''}`);
    }
    lines.push('');
  }

  // 可选加购单独一段：这些是「今天引用它的菜都把它当可选」的食材，不买也能把菜做出来
  if (list.optional.length > 0) {
    lines.push('◆ 可选加购（不买也能做出今天的菜）');
    for (const item of list.optional) {
      lines.push(`  ${item.checked ? '✔' : '□'} ${item.name}  ${item.amount_text}`);
    }
    lines.push('');
  }

  if (list.pantry.length > 0) {
    lines.push('◆ 常备调料（家里通常已有）');
    lines.push(`  ${list.pantry.map((item) => item.name).join('、')}`);
  }
  return lines.join('\n').trim();
}

/** 批量勾选的内部实现：不开事务、不广播，方便 day 口径在一段事务里循环三餐。
 *  勾选是一条 INSERT..SELECT 批量落库：冲突行只改 checked（改量 / 备注 / 隐藏原样保留），
 *  新行按未传字段的默认值插入，与单行 upsert 的 patch 语义完全一致 */
function applyBatchChecked(mealDate: string, mealType: MealType, checked: boolean, rows?: AggregatedRow[]): void {
  const list = buildPurchaseList(mealDate, mealType, rows);
  const ids = list.to_buy.map((item) => item.ingredient_id).filter((id): id is number => id != null);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    run(
      `INSERT INTO purchase_state (meal_date, meal_type, ingredient_id, checked, override_amount, note, hidden, updated_at)
       SELECT ?, ?, i.id, ?, NULL, NULL, 0, datetime('now','localtime')
         FROM ingredients i
        WHERE i.id IN (${placeholders})
        ON CONFLICT(meal_date, meal_type, ingredient_id)
        DO UPDATE SET checked = excluded.checked, updated_at = datetime('now','localtime')`,
      mealDate,
      mealType,
      checked ? 1 : 0,
      ...ids,
    );
  }
  run('UPDATE purchase_custom SET checked = ? WHERE meal_date = ? AND meal_type = ?', checked ? 1 : 0, mealDate, mealType);
}

export function batchSetChecked(mealDate: string, mealType: MealType, checked: boolean): PurchaseList {
  const rows = aggregateIngredientUsage(mealDate, mealType);
  transaction(() => applyBatchChecked(mealDate, mealType, checked, rows));
  return finish(mealDate, mealType, { rows });
}

/** day 版批量勾选：三餐各自跑一遍，一次事务写完 */
export function batchSetDayChecked(mealDate: string, checked: boolean): PurchaseList {
  const agg = aggregateDay(mealDate);
  transaction(() => {
    for (const mealType of MEAL_TYPES) applyBatchChecked(mealDate, mealType, checked, agg.get(mealType) ?? []);
  });
  return finish(mealDate, 'day', { day: agg });
}
