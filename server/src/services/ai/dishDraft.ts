/**
 * AI 加菜：一句话 → 菜品草稿。**不写库**（设计原则见 services/aiService.ts 模块注释），
 * 人点确认后才走 POST /api/dishes。
 *
 * 归一化（toDraft）只做「清洗与归类」不做「拒绝」：模型格式歪一点都修好并在 notes 里说清，
 * 只有连菜名都没有才值得报错。
 */
import { get } from '../../db/index.js';
import { badRequest } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { chatJson, llmModel } from '../../lib/llm.js';
import { round } from '../../lib/units.js';
import { DISH_CATEGORIES, normalizeMealTypes } from '../../types.js';
import type {
  AiDraftIngredient,
  AiDraftResult,
  AiDishDraft,
  MealType,
  NutritionFacts,
} from '../../types.js';
import { loadCatalog, REFERENCE_ITEMS, resolveIngredient, type CatalogItem } from './catalog.js';
import { badOutput, clampInt, readNumber, readNutrition, readString, toStringArray } from './readers.js';
import { buildDishUserPrompt, DRAFT_SYSTEM_PROMPT, MAX_PROMPT_LENGTH } from './prompts.js';

const log = createLogger('ai');

/** 配料行数上限：防模型长篇大论，也防草稿卡片长到没法用 */
const MAX_DRAFT_INGREDIENTS = 30;

interface RawDraft {
  name?: unknown;
  category?: unknown;
  spicy?: unknown;
  tags?: unknown;
  minutes?: unknown;
  difficulty?: unknown;
  baseServings?: unknown;
  emoji?: unknown;
  description?: unknown;
  steps?: unknown;
  mealTypes?: unknown;
  ingredients?: unknown;
  newIngredients?: unknown;
}

/**
 * 把模型输出整理成可直接上屏的草稿。
 *
 * 这里只做「清洗与归类」，不做「拒绝」：模型格式歪一点（辣度给了 5、分类写了个不存在的词）
 * 都不该让用户白等一次调用，能修的修好并在 notes 里说清；只有连菜名都没有才值得报错。
 * 分类是唯一的例外——给错分类会直接影响点菜页与配一桌，所以宁可留空让人在卡片上选。
 */
function toDraft(raw: RawDraft, catalog: CatalogItem[]): { draft: AiDishDraft; notes: string[] } {
  const notes: string[] = [];

  const name = readString(raw.name);
  if (name === '') throw badOutput('模型没给出菜名，换个说法再试一次（例如「加个小炒肉」）');
  if (name.length > 24) notes.push(`菜名超过 24 字，入库前请改短`);

  const rawCategory = readString(raw.category);
  const category = (DISH_CATEGORIES as readonly string[]).includes(rawCategory) ? rawCategory : '';
  if (category === '') {
    notes.push(
      rawCategory === ''
        ? '模型没给出分类，请手动选一个'
        : `「${rawCategory}」不是合法分类，请手动选一个`,
    );
  }
  // 重名与「分类是否合法」是两件无关的判断，独立检查——否则模型给错分类时，
  // 这条重名提醒会被一并吞掉，用户少了一次入库前的预警
  if (get<{ id: number }>('SELECT id FROM dishes WHERE name = ?', name)) {
    notes.push(`菜单里已经有「${name}」了，入库前请改名，或去菜品页改那道菜`);
  }

  const tags = [...new Set(toStringArray(raw.tags).map((tag) => tag.trim()))].filter((tag) => tag !== '');
  const tooLongTags = tags.filter((tag) => tag.length > 12);
  if (tooLongTags.length > 0) notes.push(`标签太长已忽略：${tooLongTags.join('、')}`);
  const keptTags = tags.filter((tag) => tag.length <= 12).slice(0, 8);

  const steps = toStringArray(raw.steps)
    .map((step) => step.trim())
    .filter((step) => step !== '');
  let stepsText = steps.join('\n');
  if (stepsText.length > 4000) {
    stepsText = stepsText.slice(0, 4000);
    notes.push('做法太长，已截断到 4000 字');
  }
  if (stepsText === '') notes.push('模型没给出做法，可以稍后在大厨页对照着补');

  const rawMealTypes = raw.mealTypes;
  const mealTypes: MealType[] = normalizeMealTypes(rawMealTypes) ?? [];
  if (Array.isArray(rawMealTypes) && rawMealTypes.length > 0 && mealTypes.length === 0) {
    notes.push('餐别没识别出来，已按「通用菜」处理');
  }

  const byName = new Map(catalog.map((item) => [item.name, item]));
  // 《成分表》参考表（加菜专用）：新食材的名字在这里对得上，营养就以表为准——
  // 模型读没读到提示词里的表都不影响结果，命中即 seed 口径、不再挂「待复核」
  const referenceByName = new Map(REFERENCE_ITEMS.map((item) => [item.name, item]));
  const rawNutrition = new Map<string, { nutrition: NutritionFacts | null; category: string }>();
  for (const entry of Array.isArray(raw.newIngredients) ? raw.newIngredients : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const entryName = readString(item.name);
    if (entryName === '') continue;
    // 分类超过 10 字会让确认入库必然 400（服务端上限）：兜成「其他」并说明，卡片上还能改
    let entryCategory = readString(item.category);
    if (entryCategory.length > 10) {
      notes.push(`「${entryName}」给的分类「${entryCategory}」太长，已按「其他」处理`);
      entryCategory = '';
    }
    rawNutrition.set(entryName, {
      nutrition: readNutrition(item),
      category: entryCategory || '其他',
    });
  }

  /** 同名配料合并（模型偶尔把一样食材写两遍）：用量相加，必有优先 */
  const merged = new Map<string, AiDraftIngredient>();
  const rawIngredients = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  if (rawIngredients.length === 0) notes.push('一道菜至少要有一条配料，请手动补上');

  for (const entry of rawIngredients) {
    if (merged.size >= MAX_DRAFT_INGREDIENTS) {
      notes.push(`配料超过 ${MAX_DRAFT_INGREDIENTS} 条，多出的已忽略`);
      break;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const rawName = readString(item.name);
    if (rawName === '') continue;
    if (rawName.length > 20) {
      notes.push(`食材名「${rawName}」超过 20 字，已忽略`);
      continue;
    }

    const amountValue = readNumber(item.amount);
    let amount = amountValue === null ? 100 : Math.round(amountValue);
    if (amountValue === null) notes.push(`「${rawName}」的用量没识别出来，已按 100g 处理`);
    else if (amount <= 0 || amount > 5000) {
      notes.push(`「${rawName}」的用量 ${amount}g 不合理，已按 100g 处理`);
      amount = 100;
    }

    const required = item.required === undefined ? true : item.required === true;
    const matched = resolveIngredient(rawName, byName);
    const key = matched ? matched.name : rawName;
    const existing = merged.get(key);
    if (existing) {
      existing.amount += amount;
      existing.required = existing.required || required;
      continue;
    }

    if (matched && matched.name !== rawName) {
      notes.push(`「${rawName}」按库里的「${matched.name}」登记`);
    }
    // 新食材的营养来路，可靠性从高到低：参考表命中（seed）> 模型估的（ai）> 没给（null，人补）
    const referenceHit = matched ? null : resolveIngredient(rawName, referenceByName);
    const pending = matched || referenceHit ? null : rawNutrition.get(rawName);
    if (!matched && referenceHit) {
      notes.push(`「${rawName}」的营养取自《中国食物成分表》参考表，不用复核`);
    } else if (!matched && !pending?.nutrition) {
      notes.push(`食材库里没有「${rawName}」，它的营养需要补齐后才能入库`);
    }

    merged.set(key, {
      name: key,
      amount,
      required,
      is_new: !matched,
      matched_name: matched ? matched.name : null,
      category: matched ? matched.category : (pending?.category ?? '其他'),
      nutrition: matched ? null : (referenceHit ? referenceHit.nutrition : (pending?.nutrition ?? null)),
      nutrition_source: matched || !referenceHit ? undefined : 'seed',
    });
  }

  const ingredients = [...merged.values()];
  // 同名合并可能把用量叠过服务端上限（两条各 3000g）：收住并说明，别让「确认入库」必然 400
  for (const row of ingredients) {
    if (row.amount > 5000) {
      notes.push(`「${row.name}」合并后的用量 ${row.amount}g 超过上限，已按 5000g 处理`);
      row.amount = 5000;
    }
  }
  const newOnes = ingredients.filter((row) => row.is_new);
  if (newOnes.length > 0) {
    // 只有「模型估的」才需要待复核；参考表命中的（nutrition_source='seed'）已经是成分表口径
    const ready = newOnes.filter((row) => row.nutrition && row.nutrition_source !== 'seed').length;
    if (ready > 0) {
      notes.push(`${ready} 种新食材的营养是 AI 填的，入库后会在食材页标「待复核」`);
    }
  }

  // 热量预览只用库里已有食材算：内含新食材时它是个偏低的估计，所以额外给一个 nutrition_complete 标记
  const known = ingredients.filter((row) => !row.is_new);
  const kcal = ingredientKcal(known, byName);
  const nutritionComplete = newOnes.length === 0;

  return {
    draft: {
      name,
      category,
      spicy: clampInt(raw.spicy, 0, 0, 3, '辣度', notes),
      tags: keptTags,
      minutes: clampInt(raw.minutes, 20, 1, 600, '耗时', notes),
      difficulty: clampInt(raw.difficulty, 1, 1, 3, '难度', notes),
      baseServings: clampInt(raw.baseServings, 2, 1, 20, '基准份数', notes),
      emoji: readString(raw.emoji).slice(0, 8) || '🍽️',
      description: readString(raw.description).slice(0, 120),
      steps: stepsText === '' ? [] : stepsText.split('\n'),
      mealTypes,
      ingredients,
      kcal_per_serving: ingredients.length === 0 ? null : round(kcal, 0),
      nutrition_complete: nutritionComplete,
    },
    notes,
  };
}

/** 每人份热量：Σ(用量/100 × 每 100g 热量)，只对库内已有食材有效 */
function ingredientKcal(rows: AiDraftIngredient[], byName: Map<string, CatalogItem>): number {
  return rows.reduce((sum, row) => {
    const item = row.matched_name ? byName.get(row.matched_name) : undefined;
    if (!item) return sum;
    return sum + (row.amount / 100) * item.nutrition.kcal;
  }, 0);
}

/**
 * 一句话 → 菜品草稿。**不写库**：调用方把结果交给前端上屏，人确认后才走 POST /api/dishes。
 */
export async function draftDishFromText(text: string): Promise<AiDraftResult> {
  const prompt = text.trim();
  if (prompt === '') throw badRequest('说一句想加的菜吧，例如「加个小炒肉」');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw badRequest(`描述太长了（${MAX_PROMPT_LENGTH} 字以内），只写菜名和口味就行`);
  }

  const catalog = loadCatalog();
  if (catalog.length === 0) throw badRequest('食材库是空的，先把基础数据补齐再用 AI 加菜');

  const raw = await chatJson<RawDraft>({
    system: DRAFT_SYSTEM_PROMPT,
    user: buildDishUserPrompt(prompt, catalog),
  });

  const { draft, notes } = toDraft(raw, catalog);
  log.info(
    `AI 起草「${draft.name}」：配料 ${draft.ingredients.length} 条（新食材 ${
      draft.ingredients.filter((row) => row.is_new).length
    } 种）、提示 ${notes.length} 条`,
  );
  return { draft, notes, model: llmModel() };
}
