/**
 * 菜品服务：把 dishes + dish_ingredients + ingredients 组装成完整的领域对象，
 * 并在装载时直接算好「每人份营养」，供点菜页展示与营养汇总复用。
 */
import { all, get, run, transaction } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parseJson, parseStringArray } from '../lib/json.js';
import { DISH_CATEGORIES, MEAL_TYPES, normalizeMealTypes } from '../types.js';
import type {
  Dish,
  DishIngredient,
  DishRow,
  MealType,
  NutritionFacts,
  NutritionSource,
} from '../types.js';
import { round } from '../lib/units.js';
import { expandSearchTerms } from '../lib/synonyms.js';

interface BomRow {
  dish_id: number;
  ingredient_id: number;
  amount: number;
  unit: string;
  note: string | null;
  name: string;
  category: string;
  is_pantry: number;
  required: number;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
}

export const EMPTY_NUTRITION: NutritionFacts = {
  kcal: 0,
  protein: 0,
  fat: 0,
  carb: 0,
  sodium: 0,
  fiber: 0,
};

export function addNutrition(a: NutritionFacts, b: NutritionFacts): NutritionFacts {
  return {
    kcal: a.kcal + b.kcal,
    protein: a.protein + b.protein,
    fat: a.fat + b.fat,
    carb: a.carb + b.carb,
    sodium: a.sodium + b.sodium,
    fiber: a.fiber + b.fiber,
  };
}

export function scaleNutrition(nutrition: NutritionFacts, factor: number): NutritionFacts {
  return {
    kcal: nutrition.kcal * factor,
    protein: nutrition.protein * factor,
    fat: nutrition.fat * factor,
    carb: nutrition.carb * factor,
    sodium: nutrition.sodium * factor,
    fiber: nutrition.fiber * factor,
  };
}

export function roundNutrition(nutrition: NutritionFacts): NutritionFacts {
  return {
    kcal: round(nutrition.kcal, 0),
    protein: round(nutrition.protein, 1),
    fat: round(nutrition.fat, 1),
    carb: round(nutrition.carb, 1),
    sodium: round(nutrition.sodium, 0),
    fiber: round(nutrition.fiber, 1),
  };
}

/** 由 BOM 计算每人份营养 */
function nutritionFromBom(bom: DishIngredient[], facts: NutritionFacts[]): NutritionFacts {
  let total = { ...EMPTY_NUTRITION };
  bom.forEach((item, index) => {
    const fact = facts[index];
    if (!fact) return;
    total = addNutrition(total, scaleNutrition(fact, item.amount / 100));
  });
  return roundNutrition(total);
}

/** season_months 存的是 JSON 月份数组；解析时顺带清洗（去重、限定 1-12、升序） */
function parseSeasonMonths(raw: string): number[] {
  const parsed = parseJson<unknown>(raw, null);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort(
    (a, b) => a - b,
  );
}

/** meal_types 存的是 JSON 餐别数组；解析时清洗为合法的 MealType 子集（按固定顺序） */
function parseMealTypes(raw: string): MealType[] {
  return normalizeMealTypes(parseJson<unknown>(raw, undefined)) ?? [];
}

/** 批量取配料行（含食材名与每 100g 营养）：菜品装配与下单快照共用，避免 N+1 查询 */
function loadBomRows(dishIds: number[]): Map<number, BomRow[]> {
  const grouped = new Map<number, BomRow[]>();
  if (dishIds.length === 0) return grouped;

  const placeholders = dishIds.map(() => '?').join(',');
  const bomRows = all<BomRow>(
    `SELECT di.dish_id, di.ingredient_id, di.amount, di.unit, di.note, di.required,
            i.name, i.category, i.is_pantry,
            i.kcal, i.protein, i.fat, i.carb, i.sodium, i.fiber
       FROM dish_ingredients di
       JOIN ingredients i ON i.id = di.ingredient_id
      WHERE di.dish_id IN (${placeholders})
      ORDER BY di.id`,
    ...dishIds,
  );

  for (const row of bomRows) {
    const list = grouped.get(row.dish_id);
    if (list) list.push(row);
    else grouped.set(row.dish_id, [row]);
  }
  return grouped;
}

/** BomRow → 前端配料结构（is_pantry / required 转布尔）；装配与下单快照共用，列增删只改这一处 */
function toDishIngredients(bom: BomRow[]): DishIngredient[] {
  return bom.map((item) => ({
    ingredient_id: item.ingredient_id,
    name: item.name,
    category: item.category,
    amount: item.amount,
    unit: item.unit,
    note: item.note,
    is_pantry: item.is_pantry === 1,
    required: item.required !== 0,
  }));
}

/** BomRow → 每 100g 营养字面量（与 NutritionFacts 字段一一对应） */
function toFacts(bom: BomRow[]): NutritionFacts[] {
  return bom.map((item) => ({
    kcal: item.kcal,
    protein: item.protein,
    fat: item.fat,
    carb: item.carb,
    sodium: item.sodium,
    fiber: item.fiber,
  }));
}

/** 批量把菜品行补齐配料与营养，避免 N+1 查询 */
function hydrateDishes(rows: DishRow[]): Dish[] {
  if (rows.length === 0) return [];

  const grouped = loadBomRows(rows.map((row) => row.id));

  return rows.map((row) => {
    const bom = grouped.get(row.id) ?? [];
    const ingredients = toDishIngredients(bom);
    const facts = toFacts(bom);

    return {
      id: row.id,
      name: row.name,
      category: row.category,
      spicy: row.spicy,
      tags: parseStringArray(row.tags),
      cook_minutes: row.cook_minutes,
      difficulty: row.difficulty,
      base_servings: row.base_servings,
      emoji: row.emoji,
      description: row.description,
      is_fried: row.is_fried === 1,
      active: row.active === 1,
      created_at: row.created_at,
      season_months: parseSeasonMonths(row.season_months),
      hide_until: row.hide_until,
      meal_types: parseMealTypes(row.meal_types),
      steps: row.steps,
      image_url: row.image_url,
      ingredients,
      nutrition: nutritionFromBom(ingredients, facts),
    };
  });
}

interface DishFilter {
  category?: string;
  q?: string;
  tag?: string;
  maxMinutes?: number;
  spicy?: number;
  onlyActive?: boolean;
}

export function listDishes(filter: DishFilter = {}): Dish[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.onlyActive !== false) {
    conditions.push('active = 1');
    // 季节窗口与「歇菜」同样只在默认菜单生效：管理列表（includeInactive）要看全部，
    // 被藏起来的菜才有地方找回来。hide_until 是 YYYY-MM，字符串比较即时间先后——
    // 歇到 2026-11 意味着 11 月起重新出现。
    conditions.push(`(hide_until = '' OR hide_until <= strftime('%Y-%m', 'now', 'localtime'))`);
    conditions.push(`(
      season_months IN ('', '[]')
      OR (
        json_valid(season_months)
        AND EXISTS (
          SELECT 1 FROM json_each(dishes.season_months)
          WHERE json_each.value = CAST(strftime('%m', 'now', 'localtime') AS INTEGER)
        )
      )
    )`);
  }
  if (filter.category && filter.category !== '全部') {
    conditions.push('category = ?');
    params.push(filter.category);
  }
  if (filter.q) {
    // 除了菜名/简介/标签，同时匹配配料表里的食材名：
    // 搜「土豆」「鸡蛋」这类食材，也能找出所有用到它的菜（方便按家里现有的食材计划吃什么）。
    // 常见别名（西红柿/番茄等）由 expandSearchTerms 联想展开，每个词各自 OR 一组匹配。
    const terms = expandSearchTerms(filter.q);
    const termClause = `(name LIKE ? OR description LIKE ? OR tags LIKE ? OR EXISTS (
        SELECT 1 FROM dish_ingredients di
        JOIN ingredients i ON i.id = di.ingredient_id
       WHERE di.dish_id = dishes.id AND i.name LIKE ?
      ))`;
    conditions.push(terms.map(() => termClause).join(' OR '));
    for (const term of terms) {
      const like = `%${term}%`;
      params.push(like, like, like, like);
    }
  }
  if (typeof filter.spicy === 'number') {
    conditions.push('spicy = ?');
    params.push(filter.spicy);
  }
  if (typeof filter.maxMinutes === 'number') {
    conditions.push('cook_minutes <= ?');
    params.push(filter.maxMinutes);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all<DishRow>(
    `SELECT * FROM dishes ${where}
      ORDER BY CASE category
                 WHEN '荤菜' THEN 1 WHEN '素菜' THEN 2 WHEN '汤' THEN 3 WHEN '主食' THEN 4 WHEN '饮品' THEN 5 WHEN '点心' THEN 6 ELSE 7
               END, id`,
    ...params,
  );
  let dishes = hydrateDishes(rows);

  if (filter.tag) {
    dishes = dishes.filter((dish) => dish.tags.includes(filter.tag as string));
  }
  return dishes;
}

export function getDishById(id: number): Dish | null {
  const row = get<DishRow>('SELECT * FROM dishes WHERE id = ?', id);
  if (!row) return null;
  return hydrateDishes([row])[0] ?? null;
}

export function getDishesByIds(ids: number[]): Map<number, Dish> {
  if (ids.length === 0) return new Map();
  const unique = Array.from(new Set(ids));
  const placeholders = unique.map(() => '?').join(',');
  const rows = all<DishRow>(`SELECT * FROM dishes WHERE id IN (${placeholders})`, ...unique);
  return new Map(hydrateDishes(rows).map((dish) => [dish.id, dish]));
}

/* --------------------------------- 新建菜品 -------------------------------- */

/** BOM 条目：按食材名关联，调用方（脚本 / 定时任务 / 未来的管理界面）不需要先查两侧库的 id */
interface CreateBomEntry {
  name: string;
  amount: number;
  required: boolean;
}

/**
 * 库里没有（或营养还没补全）的食材：连带每 100g 营养一起入库。
 * 同名行已存在时不报错，而是用这里的数值补全——与容器启动时 seed 对食材的
 * 更新语义一致（采购页手动建的零营养行就是靠这条路补上的）。
 */
interface UpsertIngredientEntry {
  name: string;
  category: string;
  buyUnit: string;
  buyFactor: number;
  isPantry: boolean;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
  price: number | null;
  /** 这批营养是谁给的：AI 起草的标 ai（后台食材页提示待复核），其余标 manual */
  nutritionSource: NutritionSource;
}

/** 读可选整数：缺省用 fallback，给了就必须是 [min, max] 内的整数 */
function readOptionalInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  message: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(message);
  }
  return value;
}

/** 读可选非负数：营养六项与 price 共用（price 允许 null 表示「不估价」） */
function readOptionalNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw badRequest(message);
  return value;
}

/* ------------------------------ 可复用的写入件 ------------------------------ */
// 建菜（createDish）与改配料表（replaceDishIngredients）共用同一套解析与写入，
// 免得「加菜的校验」和「改菜的校验」各写一套然后慢慢漂移。

/** 解析配料表入参：名字按食材名关联，用量是每人份克数 */
function readBom(input: unknown): CreateBomEntry[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw badRequest('ingredients 至少要有一条配料');
  }
  const bom: CreateBomEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || name.length > 20) throw badRequest('配料名需要是 1~20 个字符');
    if (seen.has(name)) throw badRequest(`配料里出现重复的「${name}」`);
    if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount) || entry.amount <= 0 || entry.amount > 5000) {
      throw badRequest(`「${name}」的 amount 需要是 0~5000 克之间的每人份用量`);
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      throw badRequest(`「${name}」的 required 需要是布尔值`);
    }
    seen.add(name);
    bom.push({ name, amount: entry.amount, required: entry.required !== false });
  }
  return bom;
}

/** 解析「库里没有 / 营养还没补全」的食材：连每 100g 营养一起入库 */
function readNewIngredients(input: unknown, nutritionSource: NutritionSource): UpsertIngredientEntry[] {
  if (input !== undefined && !Array.isArray(input)) throw badRequest('newIngredients 需要是对象数组');
  const entries: UpsertIngredientEntry[] = [];
  for (const raw of (input as unknown[] | undefined) ?? []) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || name.length > 20) throw badRequest('newIngredients 的食材名需要是 1~20 个字符');
    const category = entry.category === undefined ? '其他' : String(entry.category).trim();
    if (!category || category.length > 10) throw badRequest(`「${name}」的分类不对（10 字以内）`);
    const buyUnit = entry.buyUnit === undefined ? 'g' : String(entry.buyUnit).trim();
    if (!buyUnit || buyUnit.length > 10) throw badRequest(`「${name}」的购买单位不对（10 字以内）`);
    const buyFactor = entry.buyFactor === undefined ? 1 : entry.buyFactor;
    if (typeof buyFactor !== 'number' || !Number.isFinite(buyFactor) || buyFactor <= 0 || buyFactor > 100000) {
      throw badRequest(`「${name}」的 buyFactor 需要是正数`);
    }
    if (entry.isPantry !== undefined && typeof entry.isPantry !== 'boolean') {
      throw badRequest(`「${name}」的 isPantry 需要是布尔值`);
    }
    if (entry.price !== undefined && entry.price !== null) {
      if (typeof entry.price !== 'number' || !Number.isFinite(entry.price) || entry.price < 0) {
        throw badRequest(`「${name}」的 price 需要是非负数或 null`);
      }
    }
    const nutritionMessage = `「${name}」的六项营养（kcal/protein/fat/carb/sodium/fiber）都需要是非负数`;
    // AI 加菜可按食材覆盖来源：命中《成分表》参考表的行标 seed（不挂「待复核」），缺省沿用调用方的
    let entrySource = nutritionSource;
    if (entry.nutritionSource !== undefined) {
      if (entry.nutritionSource === 'seed' || entry.nutritionSource === 'ai') entrySource = entry.nutritionSource;
      else throw badRequest(`「${name}」的 nutritionSource 只能是 'seed' 或 'ai'`);
    }
    entries.push({
      name,
      category,
      buyUnit,
      buyFactor,
      isPantry: entry.isPantry === true,
      kcal: readOptionalNumber(entry.kcal, nutritionMessage),
      protein: readOptionalNumber(entry.protein, nutritionMessage),
      fat: readOptionalNumber(entry.fat, nutritionMessage),
      carb: readOptionalNumber(entry.carb, nutritionMessage),
      sodium: readOptionalNumber(entry.sodium, nutritionMessage),
      fiber: readOptionalNumber(entry.fiber, nutritionMessage),
      price: typeof entry.price === 'number' ? entry.price : null,
      nutritionSource: entrySource,
    });
  }
  return entries;
}

/**
 * 食材 upsert：缺则入库、有则补全（含把零营养行修成真实值），语义与 seed 一致。
 * nutrition_source 跟着营养一起写——它描述的是「现在这组数字是谁给的」，
 * 所以不做「保护 manual 不被覆盖」：宁可多标一次待复核，也不要让 AI 的数字挂着「已复核」的招牌。
 */
function upsertIngredients(entries: UpsertIngredientEntry[]): void {
  for (const item of entries) {
    run(
      `INSERT INTO ingredients (name, category, buy_unit, buy_factor, is_pantry,
         kcal, protein, fat, carb, sodium, fiber, price_per_100g, nutrition_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         category = excluded.category, buy_unit = excluded.buy_unit, buy_factor = excluded.buy_factor,
         is_pantry = excluded.is_pantry, kcal = excluded.kcal, protein = excluded.protein,
         fat = excluded.fat, carb = excluded.carb, sodium = excluded.sodium, fiber = excluded.fiber,
         price_per_100g = excluded.price_per_100g, nutrition_source = excluded.nutrition_source`,
      item.name,
      item.category,
      item.buyUnit,
      item.buyFactor,
      item.isPantry ? 1 : 0,
      item.kcal,
      item.protein,
      item.fat,
      item.carb,
      item.sodium,
      item.fiber,
      item.price,
      item.nutritionSource,
    );
  }
}

/** 写入配料行：BOM 按食材名关联，名字必须已经在食材库里（库里没有的先放进 newIngredients） */
function insertBomRows(dishId: number, bom: CreateBomEntry[]): void {
  for (const item of bom) {
    const ingredient = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', item.name);
    if (!ingredient) {
      throw badRequest(`食材库里没有「${item.name}」，把它放进 newIngredients 就能连营养一起入库`);
    }
    run(
      'INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, unit, note, required) VALUES (?, ?, ?, ?, NULL, ?)',
      dishId,
      ingredient.id,
      item.amount,
      'g',
      item.required ? 1 : 0,
    );
  }
}

/**
 * 新建菜品——「内容即数据」的唯一入口，加菜不再改种子文件、不再手写 SQL。
 *
 * body 口径（camelCase，与 Dish 领域对象对齐）：
 *   name / category 必填；spicy(0~3) difficulty(1~3) minutes(1~600) baseServings(1~20)
 *   emoji description tags steps mealTypes 可选，默认值与种子口径一致；
 *   ingredients 必填且非空：[{ name, amount(每人份克), required? }]（默认必有）；
 *   newIngredients 可选：[{ name, category?, buyUnit?, buyFactor?, isPantry?, 营养六项, price? }]。
 *   origin 可选：传 'ai' 表示这次内容由 AI 起草——新建食材的营养会被标成 ai（待复核）；
 *   缺省按 'manual'（人自己填的）处理。它只是溯源标记，不影响任何校验与入库语义。
 *
 * 校验全在这一层做（含各种上限），路由保持薄。菜品按名查重（409 DISH_EXISTS），
 * 绝不覆盖已有菜；BOM 里出现库里没有、newIngredients 也没给的食材名，整单 400 回滚。
 */
export function createDish(body: unknown): Dish {
  const input = (body ?? {}) as Record<string, unknown>;

  if (input.origin !== undefined && input.origin !== 'ai' && input.origin !== 'manual') {
    throw badRequest("origin 只能是 'ai' 或 'manual'");
  }
  const nutritionSource: NutritionSource = input.origin === 'ai' ? 'ai' : 'manual';

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw badRequest('请填写菜名');
  if (name.length > 24) throw badRequest('菜名太长了（24 字以内）');
  if (get<{ id: number }>('SELECT id FROM dishes WHERE name = ?', name)) {
    throw conflict('DISH_EXISTS', `菜单里已经有「${name}」了`);
  }

  const category = typeof input.category === 'string' ? input.category.trim() : '';
  if (!(DISH_CATEGORIES as readonly string[]).includes(category)) {
    throw badRequest(`category 需要是 ${DISH_CATEGORIES.join(' / ')} 之一`);
  }

  const spicy = readOptionalInt(input.spicy, 0, 0, 3, 'spicy 是 0~3 的辣度');
  const difficulty = readOptionalInt(input.difficulty, 1, 1, 3, 'difficulty 是 1~3 的难度');
  const minutes = readOptionalInt(input.minutes, 20, 1, 600, 'minutes 是 1~600 的整数分钟');
  const baseServings = readOptionalInt(input.baseServings, 2, 1, 20, 'baseServings 是 1~20 的基准份数');

  if (input.isFried !== undefined && typeof input.isFried !== 'boolean') {
    throw badRequest('isFried 需要是布尔值');
  }
  const isFried = input.isFried === true;

  let emoji = '🍽️';
  if (input.emoji !== undefined) {
    if (typeof input.emoji !== 'string' || input.emoji.trim().length === 0 || input.emoji.length > 8) {
      throw badRequest('emoji 只能是 1~8 个字符');
    }
    emoji = input.emoji.trim();
  }

  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') throw badRequest('description 需要是文本');
    const trimmed = input.description.trim();
    if (trimmed.length > 120) throw badRequest('简介太长了（120 字以内）');
    description = trimmed || null;
  }

  if (input.tags !== undefined && !Array.isArray(input.tags)) throw badRequest('tags 需要是字符串数组');
  const rawTags = (input.tags as unknown[] | undefined) ?? [];
  if (rawTags.some((tag) => typeof tag !== 'string')) throw badRequest('tags 需要是字符串数组');
  const tags = [...new Set(rawTags.map((tag) => (tag as string).trim()))].filter((tag) => tag !== '');
  if (tags.length > 8) throw badRequest('tags 最多 8 个');
  if (tags.some((tag) => tag.length > 12)) throw badRequest('每个 tag 12 字以内');

  if (input.steps !== undefined && !Array.isArray(input.steps)) throw badRequest('steps 需要是字符串数组（一行一步）');
  const rawSteps = (input.steps as unknown[] | undefined) ?? [];
  if (rawSteps.some((step) => typeof step !== 'string')) throw badRequest('steps 需要是字符串数组（一行一步）');
  // 与 PATCH steps 同一套清洗：统一换行、去行尾空白与空行，上限防整篇菜谱粘进来
  const steps = (rawSteps as string[])
    .join('\n')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
  if (steps.length > 4000) throw badRequest('做法太长了（4000 字以内）');

  if (input.mealTypes !== undefined && !Array.isArray(input.mealTypes)) {
    throw badRequest('meal_types 需要是餐次数组，如 ["breakfast","lunch"]');
  }
  const rawMealTypes = (input.mealTypes as unknown[] | undefined) ?? [];
  if (rawMealTypes.some((meal) => !(MEAL_TYPES as string[]).includes(meal as string))) {
    throw badRequest('meal_types 只能包含 breakfast / lunch / dinner');
  }
  const mealTypes = normalizeMealTypes(rawMealTypes) ?? [];

  const bom = readBom(input.ingredients);
  const newIngredients = readNewIngredients(input.newIngredients, nutritionSource);

  const dishId = transaction(() => {
    upsertIngredients(newIngredients);

    const id = Number(
      run(
        `INSERT INTO dishes (name, category, spicy, tags, cook_minutes, difficulty, base_servings,
           emoji, description, is_fried, steps, meal_types)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name,
        category,
        spicy,
        JSON.stringify(tags),
        minutes,
        difficulty,
        baseServings,
        emoji,
        description,
        isFried ? 1 : 0,
        steps,
        JSON.stringify(mealTypes),
      ).lastInsertRowid,
    );

    insertBomRows(id, bom);
    return id;
  });

  const dish = getDishById(dishId);
  if (!dish) throw notFound('菜品不存在');
  return dish;
}

/* --------------------------------- 改菜品 --------------------------------- */

/**
 * 更新菜品属性（PATCH /api/dishes/:id 的唯一实现）。
 *
 * 与建菜对称：校验全在这一层，路由保持薄。可改的键：
 *   name（查重）/ category / spicy / difficulty / minutes / baseServings /
 *   emoji / description / tags / steps /
 *   active（软下架）/ season_months（季节窗口）/ hide_until（歇菜到某月）/ meal_types（餐别）
 * 餐别 / 季节窗口 / 歇菜到某月这三项历史上用 snake_case（与菜品响应对象一致），而请求体其余字段
 * 都是 camelCase；两套写法并存容易踩坑，这里 **camelCase（mealTypes / seasonMonths / hideUntil）
 * 与 snake_case 都接受**，落库列名仍是 snake_case（响应对象口径不变）。
 * 只处理显式传了的键，没传的一律不动；一个都没传时 400，避免「静默无操作的成功」。
 *
 * 历史口径不受影响：订单行存的是**下单那一刻**的菜名与营养快照，
 * 所以改名 / 改分类 / 改配方都不会改写过去的订单与统计。
 */
export function updateDish(id: number, body: unknown): Dish {
  const { updates, params } = buildDishUpdate(id, body);
  run(`UPDATE dishes SET ${updates.join(', ')} WHERE id = ?`, ...params, id);
  const dish = getDishById(id);
  if (!dish) throw notFound('菜品不存在');
  return dish;
}

/**
 * 只校验、不落库：把「这组改动能不能过」的判断单独暴露出来，给 AI 改菜草稿用——
 * 草稿上就不该出现一条「点确认必然 400」的改动。与 updateDish 共用同一份校验，
 * 不存在「草稿一套口径、落库另一套」的漂移。
 */
export function assertDishPatchValid(id: number, body: unknown): void {
  buildDishUpdate(id, body);
}

/** 拼出 UPDATE 语句并完成全部校验（updateDish 与草稿校验共用） */
function buildDishUpdate(id: number, body: unknown): { updates: string[]; params: (string | number | null)[] } {
  const row = get<DishRow>('SELECT * FROM dishes WHERE id = ?', id);
  if (!row) throw notFound('菜品不存在');

  const input = (body ?? {}) as Record<string, unknown>;
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  const write = (column: string, value: string | number | null) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw badRequest('菜名不能为空');
    if (name.length > 24) throw badRequest('菜名太长了（24 字以内）');
    // 名字上有 UNIQUE 索引：不拦会以 500 冒出来，这里先给一句能看懂的话
    const clash = get<{ id: number }>('SELECT id FROM dishes WHERE name = ? AND id <> ?', name, id);
    if (clash) throw conflict('DISH_EXISTS', `菜单里已经有「${name}」了`);
    write('name', name);
  }

  if (input.category !== undefined) {
    const category = typeof input.category === 'string' ? input.category.trim() : '';
    if (!(DISH_CATEGORIES as readonly string[]).includes(category)) {
      throw badRequest(`category 需要是 ${DISH_CATEGORIES.join(' / ')} 之一`);
    }
    write('category', category);
  }

  if (input.spicy !== undefined) write('spicy', readOptionalInt(input.spicy, row.spicy, 0, 3, 'spicy 是 0~3 的辣度'));
  if (input.difficulty !== undefined) {
    write('difficulty', readOptionalInt(input.difficulty, row.difficulty, 1, 3, 'difficulty 是 1~3 的难度'));
  }
  if (input.minutes !== undefined) {
    write('cook_minutes', readOptionalInt(input.minutes, row.cook_minutes, 1, 600, 'minutes 是 1~600 的整数分钟'));
  }
  if (input.baseServings !== undefined) {
    write('base_servings', readOptionalInt(input.baseServings, row.base_servings, 1, 20, 'baseServings 是 1~20 的基准份数'));
  }

  if (input.emoji !== undefined) {
    if (typeof input.emoji !== 'string' || input.emoji.trim().length === 0 || input.emoji.length > 8) {
      throw badRequest('emoji 只能是 1~8 个字符');
    }
    write('emoji', input.emoji.trim());
  }

  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== 'string') {
      throw badRequest('description 需要是文本或 null');
    }
    const trimmed = typeof input.description === 'string' ? input.description.trim() : '';
    if (trimmed.length > 120) throw badRequest('简介太长了（120 字以内）');
    write('description', trimmed || null);
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw badRequest('tags 需要是字符串数组');
    if (input.tags.some((tag) => typeof tag !== 'string')) throw badRequest('tags 需要是字符串数组');
    const tags = [...new Set((input.tags as string[]).map((tag) => tag.trim()))].filter((tag) => tag !== '');
    if (tags.length > 8) throw badRequest('tags 最多 8 个');
    if (tags.some((tag) => tag.length > 12)) throw badRequest('每个 tag 12 字以内');
    write('tags', JSON.stringify(tags));
  }

  if (input.steps !== undefined) {
    write('steps', readSteps(input.steps));
  }

  // 餐别：camelCase（mealTypes）与既有线上契约的 snake_case（meal_types）都接受
  const mealTypesInput = input.mealTypes ?? input.meal_types;
  if (mealTypesInput !== undefined) {
    if (!Array.isArray(mealTypesInput)) throw badRequest('mealTypes 需要是餐次数组，如 ["breakfast","lunch"]');
    const hasInvalid = (mealTypesInput as unknown[]).some((value) => !(MEAL_TYPES as string[]).includes(value as string));
    if (hasInvalid) throw badRequest('mealTypes 只能包含 breakfast / lunch / dinner');
    write('meal_types', JSON.stringify(normalizeMealTypes(mealTypesInput) ?? []));
  }

  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw badRequest('active 需要是布尔值（true 在售 / false 下架）');
    write('active', input.active ? 1 : 0);
  }

  const seasonMonthsInput = input.seasonMonths ?? input.season_months;
  if (seasonMonthsInput !== undefined) {
    if (!Array.isArray(seasonMonthsInput)) throw badRequest('seasonMonths 需要月份数组，如 [9,10,11]');
    const months = [...new Set(seasonMonthsInput.map(Number))]
      .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12)
      .sort((a, b) => a - b);
    write('season_months', JSON.stringify(months));
  }

  const hideUntilInput = input.hideUntil ?? input.hide_until;
  if (hideUntilInput !== undefined) {
    const value = String(hideUntilInput).trim();
    if (value !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
      throw badRequest('hideUntil 需要 YYYY-MM 格式的月份，或空串表示立即恢复');
    }
    write('hide_until', value);
  }

  if (updates.length === 0) throw badRequest('没有要更新的字段');
  return { updates, params };
}

/**
 * 做法文本清洗：一行一步。
 * 字符串（前端编辑框，一行一步）与字符串数组（建菜与 AI 草稿）两种口径都认，
 * 最终落库都是同一段文本，免得两侧各写一套清洗然后慢慢不一致。
 */
function readSteps(value: unknown): string {
  if (typeof value !== 'string' && !Array.isArray(value)) {
    throw badRequest('steps 需要是文本（一行一步）或字符串数组');
  }
  if (Array.isArray(value) && value.some((step) => typeof step !== 'string')) {
    throw badRequest('steps 需要是字符串数组（一行一步）');
  }
  const lines = (Array.isArray(value) ? (value as string[]).join('\n') : (value as string))
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const steps = lines.join('\n');
  if (steps.length > 4000) throw badRequest('做法太长了（4000 字以内）');
  return steps;
}

/**
 * 整表替换配料表（PUT /api/dishes/:id/ingredients）。
 *
 * 为什么是整表替换而不是逐行增删改：
 *   · 「改菜」的确认天生是**整份**语义（草稿上勾了几条，落地就是那份配料表），
 *     整表提交天然幂等，重放一次结果一样；
 *   · 没有任何外键指向 dish_ingredients.id（采购按 ingredient_id 聚合、备料按名字、
 *     订单行存的是下单时的 BOM 快照），所以删掉重建不影响任何已有数据。
 * 先删后插都在同一个事务里：中途出错整条回滚，不会留下一张空配料表。
 */
export function replaceDishIngredients(id: number, body: unknown): Dish {
  const row = get<DishRow>('SELECT id FROM dishes WHERE id = ?', id);
  if (!row) throw notFound('菜品不存在');

  const input = (body ?? {}) as Record<string, unknown>;
  const bom = readBom(input.ingredients);
  const newIngredients = readNewIngredients(input.newIngredients, 'manual');

  transaction(() => {
    // 先把「库里没有的」建出来，BOM 的名字才对得上
    upsertIngredients(newIngredients);
    // 名字全部解析成 id 之后再删——删完才发现少食材的话，报错也没法把行还回来（虽然会回滚，但白跑一趟）
    const resolved = bom.map((item) => {
      const ingredient = get<{ id: number }>('SELECT id FROM ingredients WHERE name = ?', item.name);
      if (!ingredient) {
        throw badRequest(`食材库里没有「${item.name}」，把它放进 newIngredients 就能连营养一起入库`);
      }
      return { ingredientId: ingredient.id, amount: item.amount, required: item.required };
    });

    run('DELETE FROM dish_ingredients WHERE dish_id = ?', id);
    for (const item of resolved) {
      run(
        'INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, unit, note, required) VALUES (?, ?, ?, ?, NULL, ?)',
        id,
        item.ingredientId,
        item.amount,
        'g',
        item.required ? 1 : 0,
      );
    }
  });

  const dish = getDishById(id);
  if (!dish) throw notFound('菜品不存在');
  return dish;
}

/**
 * 下单快照：与 order_items 的快照列一一对应。
 * 下单那一刻把菜品属性与 BOM（含食材名与其当时的每 100g 营养）冻结下来，
 * 之后无论改配方、改食材营养、甚至把菜删掉，历史订单 / 营养 / 统计都不会被改写。
 */
interface OrderItemSnapshot {
  dish_id: number;
  dish_name: string;
  dish_emoji: string;
  dish_category: string;
  dish_spicy: number;
  dish_tags: string;
  kcal_per_serving: number;
  /** BOM 快照 JSON（每人份），结构见 types.ts 的 OrderBomItem */
  bom: string;
}

/** 为若干道菜生成下单快照（菜品不存在时缺失，调用方自行报错） */
export function buildOrderSnapshots(ids: number[]): Map<number, OrderItemSnapshot> {
  if (ids.length === 0) return new Map();

  const unique = Array.from(new Set(ids));
  const placeholders = unique.map(() => '?').join(',');
  const rows = all<DishRow>(`SELECT * FROM dishes WHERE id IN (${placeholders})`, ...unique);
  const bomMap = loadBomRows(unique);

  return new Map(
    rows.map((row) => {
      const bom = bomMap.get(row.id) ?? [];
      const nutrition = nutritionFromBom(toDishIngredients(bom), toFacts(bom));

      return [
        row.id,
        {
          dish_id: row.id,
          dish_name: row.name,
          dish_emoji: row.emoji,
          dish_category: row.category,
          dish_spicy: row.spicy,
          dish_tags: row.tags,
          kcal_per_serving: nutrition.kcal,
          bom: JSON.stringify(
            bom.map((item) => ({
              ingredient_id: item.ingredient_id,
              name: item.name,
              category: item.category,
              amount: item.amount,
              unit: item.unit,
              is_pantry: item.is_pantry,
              required: item.required,
              kcal: item.kcal,
              protein: item.protein,
              fat: item.fat,
              carb: item.carb,
              sodium: item.sodium,
              fiber: item.fiber,
            })),
          ),
        } satisfies OrderItemSnapshot,
      ] as const;
    }),
  );
}

/**
 * 设置某道菜某个配料的「必有 / 可选」。
 *
 * 必有 = 缺了这道菜不成立（点菜页据此排序：核心齐的排前面、缺得越少越靠前），
 * 可选 = 缺了只是口味打折，家里没有跳过就行。
 * 标记挂在「菜品 × 食材」的关联行上，所以同一食材在不同菜里身份可以不同——
 * 大葱在番茄炒蛋里可有可无，在葱油拌面里却是主角。
 * 只影响点菜页排序、采购清单分组与备料展示；历史订单按下单时的 BOM 快照走，不受影响。
 */
export function setIngredientRequired(dishId: number, ingredientId: number, required: boolean): Dish {
  const row = get<DishRow>('SELECT * FROM dishes WHERE id = ?', dishId);
  if (!row) throw notFound('菜品不存在');

  const link = get<{ id: number }>(
    'SELECT id FROM dish_ingredients WHERE dish_id = ? AND ingredient_id = ?',
    dishId,
    ingredientId,
  );
  if (!link) throw notFound('这道菜的配料表里没有这个食材');

  run('UPDATE dish_ingredients SET required = ? WHERE id = ?', required ? 1 : 0, link.id);
  const updated = hydrateDishes([row])[0];
  if (!updated) throw notFound('菜品不存在');
  return updated;
}

/**
 * 彻底删除一道菜（物理删除，不可撤销）——录错的废菜、重复录入都随时能清。
 *
 * 历史订单不构成阻碍：order_items.dish_id 是 ON DELETE SET NULL，而下单那一刻的菜名、
 * 营养与配料已经冻结在订单行的快照列里，删掉菜品后历史订单、营养报告与统计照常出数
 * （排行榜按当时的菜名继续统计，行内 dish_id 为空）。配料表与菜品反馈带 CASCADE 一起清。
 * 返回值里的 kept_orders 只用于向用户说明「影响了几条历史订单」，不再是拒绝理由。
 */
export function deleteDish(id: number): { name: string; removed_feedback: number; kept_orders: number } {
  const row = get<DishRow>('SELECT * FROM dishes WHERE id = ?', id);
  if (!row) throw notFound('菜品不存在');

  const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM order_items WHERE dish_id = ?', id);
  const feedback = get<{ c: number }>('SELECT COUNT(*) AS c FROM dish_feedback WHERE dish_id = ?', id);
  run('DELETE FROM dishes WHERE id = ?', id);
  return {
    name: row.name,
    removed_feedback: Number(feedback?.c ?? 0),
    kept_orders: Number(used?.c ?? 0),
  };
}
