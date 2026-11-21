/**
 * AI 删除食材：一句话 → 删除草稿。**不写库**，确认后才逐条走
 * DELETE /api/purchase/ingredients/:id（与采购页孤立食材删除是同一个接口、同一套守卫）。
 *
 * 分工与库存草稿一致：模型只把「用户点名要删哪样」提取成名字，
 * 能不能删由服务端查真实引用判定——被菜谱引用的食材一律保留，让人先去改菜谱。
 * 这样即使模型漏看 / 幻觉，也不会出现「一句话把菜谱配料删空」。
 */
import { all } from '../../db/index.js';
import { badRequest } from '../../lib/errors.js';
import { chatJson, llmModel } from '../../lib/llm.js';
import type { AiIngredientDraftResult, AiIngredientDraftRow } from '../../types.js';
import { loadCatalog, resolveIngredient, type CatalogItem } from './catalog.js';
import { buildUserPrompt, INGREDIENT_SYSTEM_PROMPT, MAX_PROMPT_LENGTH } from './prompts.js';
import { readNameList, readString } from './readers.js';

interface RawIngredientDraft {
  names?: unknown;
  notes?: unknown;
}

/** 引用查询结果：一行 = 这道菜用了这个食材 */
interface UsageRow {
  ingredient_id: number;
  dish_name: string;
}

/** 一句话 → 删除草稿。 */
export async function draftIngredientDelete(text: string): Promise<AiIngredientDraftResult> {
  const prompt = text.trim();
  if (prompt === '') throw badRequest('说要删掉哪样食材，例如「把沙姜删了」');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw badRequest(`描述太长了（${MAX_PROMPT_LENGTH} 字以内），说食材名就行`);
  }

  const catalog = loadCatalog();
  if (catalog.length === 0) throw badRequest('食材库是空的，没有可删的食材');

  const raw = await chatJson<RawIngredientDraft>({
    system: INGREDIENT_SYSTEM_PROMPT,
    user: buildUserPrompt(prompt, catalog),
    maxTokens: 400,
  });

  const notes: string[] = [];
  const saidNames = readNameList(raw.names);
  const modelNote = readString(raw.notes);
  if (modelNote) notes.push(modelNote);

  if (saidNames.length === 0) {
    if (notes.length === 0) notes.push('这句话里没听出要删哪样食材，点名说「删掉 XX」更准');
    return { rows: [], notes, model: llmModel() };
  }

  const byName = new Map(catalog.map((item) => [item.name, item]));
  const rows: AiIngredientDraftRow[] = [];
  const seen = new Map<number, string>();

  // 先「名字 → 库内食材」，同一食材被说了两遍（含别名）只留一行，said 记第一次的叫法
  for (const said of saidNames) {
    const matched = resolveIngredient(said, byName);
    if (!matched) {
      notes.push(`食材库里没有「${said}」，没什么可删的`);
      continue;
    }
    if (seen.has(matched.id)) continue;
    seen.set(matched.id, said);
    if (said !== matched.name) notes.push(`「${said}」按库里的「${matched.name}」处理`);
  }

  if (seen.size === 0) {
    if (notes.length === 0) notes.push('这些名字都没对上食材库，没有可删的食材');
    return { rows: [], notes, model: llmModel() };
  }

  const ids = [...seen.keys()];
  const usage = all<UsageRow>(
    `SELECT di.ingredient_id, d.name AS dish_name
       FROM dish_ingredients di
       JOIN dishes d ON d.id = di.dish_id
      WHERE di.ingredient_id IN (${ids.join(',')})`,
  );
  const usageByIngredient = new Map<number, string[]>();
  for (const row of usage) {
    const names = usageByIngredient.get(row.ingredient_id) ?? [];
    names.push(row.dish_name);
    usageByIngredient.set(row.ingredient_id, names);
  }
  const inStock = new Set(
    all<{ ingredient_id: number }>(
      `SELECT ingredient_id FROM fridge_stock WHERE ingredient_id IN (${ids.join(',')})`,
    ).map((row) => row.ingredient_id),
  );
  const byId = new Map(catalog.map((item) => [item.id, item]));

  for (const [ingredientId, said] of seen) {
    const item = byId.get(ingredientId) as CatalogItem;
    const dishNames = usageByIngredient.get(ingredientId) ?? [];
    const dishCount = dishNames.length;
    const deletable = dishCount === 0;
    rows.push({
      ingredient_id: ingredientId,
      name: item.name,
      said,
      category: item.category,
      is_pantry: item.isPantry,
      dish_count: dishCount,
      dish_names: dishNames.slice(0, 3),
      in_stock: inStock.has(ingredientId),
      deletable,
      reason: deletable
        ? `没被菜谱引用${inStock.has(ingredientId) ? '，库存登记会一起清掉' : ''}，可以删`
        : `用在「${dishNames.slice(0, 3).join('」「')}」${dishCount > 3 ? ' 等' : ''} ${dishCount} 道菜里，先从菜里去掉再删`,
    });
  }

  return { rows, notes, model: llmModel() };
}
