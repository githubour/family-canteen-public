/**
 * AI 登记库存：一句话 → 库存草稿。**不写库**，确认后才走 POST /api/fridge-stock/batch。
 *
 * 核心分工：模型只做「提取名字 + 分清有 / 没」，其余全由服务端拿真实数据判定——
 *   名字 → 库内食材（resolveIngredient，与加菜同一套别名归并）
 *   是不是常备调料 / 是不是已经在库存里 → 查库
 * 所以模型不需要知道库存现状（提示词里也就没放它），自然也不会出现
 * 「模型以为没登记、其实登记过」导致的重复登记。
 */
import { all } from '../../db/index.js';
import { badRequest } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { chatJson, llmModel } from '../../lib/llm.js';
import type { AiFridgeCandidate, AiFridgeDraftResult, AiFridgeRow } from '../../types.js';
import { commonPrefixLength, loadCatalog, resolveIngredient, type CatalogItem } from './catalog.js';
import { buildUserPrompt, FRIDGE_SYSTEM_PROMPT, MAX_PROMPT_LENGTH } from './prompts.js';

const log = createLogger('ai');

interface RawFridgeDraft {
  have?: unknown;
  missing?: unknown;
  dishes?: unknown;
  pantry?: unknown;
  notes?: unknown;
}

/** 一句话里的名字统一清洗：去空白、去长度异常项、去重，最多留 40 个 */
function readNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name === '' || name.length > 20) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length >= 40) break;
  }
  return names;
}

/**
 * 「库里没有」的名字 → 疑似相同的库内食材（最多 3 个）。
 *
 * 这是**建议**，不是归并：resolveIngredient 那边宁可不认也不瞎并（身份错了会一路错到采购），
 * 而这里把「长得像」的摆到人面前让人拍板，所以口径可以放宽——双向包含（短的一边至少 2 字）
 * 与公共前缀（至少 2 字），按重合长度排序。点错一行也只是登记错一样，划掉重来就行。
 */
function suggestCandidates(said: string, catalog: CatalogItem[]): AiFridgeCandidate[] {
  if (said.length < 2) return [];
  const scored = catalog
    .map((item) => {
      let score = 0;
      if (item.name.length >= 2 && (item.name.includes(said) || said.includes(item.name))) {
        score = Math.min(said.length, item.name.length);
      }
      const prefix = commonPrefixLength(said, item.name);
      if (prefix >= 2) score = Math.max(score, prefix);
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);
  return scored.slice(0, 3).map(({ item }) => ({
    ingredient_id: item.id,
    name: item.name,
    category: item.category,
    is_pantry: item.isPantry,
  }));
}

/**
 * 一句话 → 库存草稿。**不写库**，确认后才走 POST /api/fridge-stock/batch。
 */
export async function draftFridgeFromText(text: string): Promise<AiFridgeDraftResult> {
  const prompt = text.trim();
  if (prompt === '') throw badRequest('说一句冰箱里有什么吧，例如「我有西红柿、土豆、鸡蛋」');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw badRequest(`描述太长了（${MAX_PROMPT_LENGTH} 字以内），只列食材名就行`);
  }

  const catalog = loadCatalog();
  if (catalog.length === 0) throw badRequest('食材库是空的，先把基础数据补齐再用 AI 登记库存');

  const raw = await chatJson<RawFridgeDraft>({
    system: FRIDGE_SYSTEM_PROMPT,
    user: buildUserPrompt(prompt, catalog),
    maxTokens: 1200,
  });

  const notes: string[] = [];
  const byName = new Map(catalog.map((item) => [item.name, item]));
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const inStock = new Set(
    all<{ ingredient_id: number }>('SELECT ingredient_id FROM fridge_stock').map((row) => row.ingredient_id),
  );

  /**
   * 先收集、再判定（两阶段）。
   * 一阶段只做「名字 → 库内食材」，顺带把同一食材的多次提及（含别名）合并成一条并记下
   * 用户都说了它是「有」还是「没」；二阶段才拿真实库存判定状态。
   * 这样处理「既说有又说没」时与提及顺序无关，不会因为先处理 have 而漏掉那句提示。
   *
   * 对不上库的名字也不再是死胡同：听着是菜（净菜 / 半成品）的给「去加菜」，
   * 是食材的给「建为食材」与疑似已有食材的候选——都由人拍板，这里只负责把选项摆出来。
   */
  const pending = new Map<number, { said: string; wants: Set<'have' | 'missing'> }>();
  const unknown: AiFridgeRow[] = [];
  const mentioned = new Set<string>();
  const dishNames = new Set(readNameList(raw.dishes));
  const pantryNames = new Set(readNameList(raw.pantry));

  const collect = (said: string, want: 'have' | 'missing') => {
    // 「设为常备」的名字不走库存通道（加了也只是白加），留给下面的常备循环单独成行
    if (pantryNames.has(said)) return;
    mentioned.add(said);
    const matched = resolveIngredient(said, byName);
    if (!matched) {
      // 库里没有 → 登记不了。同一句话里说了两遍也只留一行
      if (unknown.some((row) => row.name === said)) return;
      if (dishNames.has(said)) {
        unknown.push({ ingredient_id: null, name: said, said, category: '菜品', status: 'dish', want });
        notes.push(`「${said}」听着是一道菜（净菜 / 半成品），库存登记不了——下面可以拿它去加菜`);
        return;
      }
      const candidates = suggestCandidates(said, catalog);
      unknown.push({
        ingredient_id: null,
        name: said,
        said,
        category: '其他',
        status: 'unknown',
        want,
        candidates,
      });
      notes.push(
        candidates.length > 0
          ? `食材库里没有「${said}」——建为食材，或和下面疑似的已有食材对上`
          : `食材库里没有「${said}」——下面可以建为食材`,
      );
      return;
    }
    if (matched.name !== said) {
      const note = `「${said}」按库里的「${matched.name}」登记`;
      if (!notes.includes(note)) notes.push(note);
    }
    const entry = pending.get(matched.id);
    if (entry) entry.wants.add(want);
    else pending.set(matched.id, { said, wants: new Set([want]) });
  };

  for (const said of readNameList(raw.have)) collect(said, 'have');
  for (const said of readNameList(raw.missing)) collect(said, 'missing');
  // 只被归到 dishes、没进 have / missing 的名字（如「买了个熟食烤鸡」）也要有一行：
  // 用户提到了它，默认当「有」——拍板去加菜是人的事，但至少得让这一行出现在草稿上
  for (const said of dishNames) {
    if (!mentioned.has(said)) collect(said, 'have');
  }
  // 「设为常备」是改食材属性（is_pantry），不是库存动作：单独成行，确认时由前端调
  // PATCH /api/settings/ingredients/:id 设常备；它若已在库存里则顺手撤掉（常备不需要登记）
  for (const said of pantryNames) {
    const matched = resolveIngredient(said, byName);
    if (!matched) {
      if (unknown.some((row) => row.name === said)) continue;
      unknown.push({
        ingredient_id: null,
        name: said,
        said,
        category: '其他',
        status: 'unknown',
        pantry_intent: true,
        candidates: suggestCandidates(said, catalog),
      });
      notes.push(`食材库里没有「${said}」——下面「建为食材」会直接把它建成常备`);
      continue;
    }
    if (matched.isPantry) {
      unknown.push({ ingredient_id: matched.id, name: matched.name, said, category: matched.category, status: 'pantry' });
      notes.push(`「${matched.name}」本来就是常备，不用再设`);
      continue;
    }
    unknown.push({
      ingredient_id: matched.id,
      name: matched.name,
      said,
      category: matched.category,
      status: 'make_pantry',
      in_stock: inStock.has(matched.id),
    });
  }

  const rows: AiFridgeRow[] = [];
  for (const [id, entry] of pending) {
    const item = byId.get(id);
    if (!item) continue;
    // 既说有又说没（含跨别名）时按「有」处理：宁可多登记一样，也不要错删
    const conflicting = entry.wants.size > 1;
    const staysInStock = conflicting || entry.wants.has('have');

    let status: AiFridgeRow['status'] | null;
    if (item.isPantry) status = 'pantry';
    else if (staysInStock) status = inStock.has(id) ? 'already' : 'add';
    // 本来就不在库存里，说「没有」也无事可做，不必占一行
    else status = inStock.has(id) ? 'remove' : null;

    if (status === null) continue;
    if (conflicting) notes.push(`「${item.name}」你既说了有一会儿又说没有，按「有」处理`);
    rows.push({ ingredient_id: id, name: item.name, said: entry.said, category: item.category, status });
  }
  rows.push(...unknown);

  const modelNote = typeof raw.notes === 'string' ? raw.notes.trim() : '';
  if (modelNote) notes.push(modelNote);

  // 一行都没有时要说清是「没提取出来」还是「本来就没有要改的」：
  // 模型给了解释（例如「冰箱都空了，请用清空按钮」）就听它的，别再叠一句让人误解的兜底话
  if (rows.length === 0 && modelNote === '') {
    notes.push('这句话里没有能对应上的食材，换个说法再试（例如「我有西红柿、鸡蛋、土豆」）');
  }

  log.info(
    `AI 整理库存：要登记 ${rows.filter((row) => row.status === 'add').length} 样、要撤掉 ${
      rows.filter((row) => row.status === 'remove').length
    } 样（已在库存 ${rows.filter((row) => row.status === 'already').length} 样）、提示 ${notes.length} 条`,
  );
  return { rows, notes, model: llmModel() };
}
