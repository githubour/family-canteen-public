/**
 * AI 改菜：一道菜的现状 + 它的全部待处理反馈 → 可勾选的改动草稿。**不写库**。
 *
 * 三件事必须由服务端裁决，不能信模型（见 toDraft 之外的 toRevision 注释）：
 * 合法性（借 dishService 同一份校验试跑）、落点（配料操作要能对上现状配料表）、
 * 交代（每条反馈都得有去处——被改动覆盖，或进 unhandled）。
 *
 * 确认后由前端走既有写入路径：PATCH /api/dishes/:id（字段）+ PUT /api/dishes/:id/ingredients（配料表），
 * 最后用 POST /api/dish-feedback/remove 清掉「被这次改动覆盖到」的反馈。
 * 反馈没有单独的「已处理」字段——删掉就是处理完了（表的设计如此），
 * 所以「只删被覆盖到的」这条纪律必须守住：unhandled 里的那些一条都不能删。
 */
import { all } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { chatJson, llmModel } from '../../lib/llm.js';
import { MEAL_LABEL } from '../../types.js';
import type {
  AiDishRevisionDraft,
  AiDishRevisionResult,
  AiRevisionChange,
  Dish,
  DishEditableField,
} from '../../types.js';
import { assertDishPatchValid, getDishById } from '../dishService.js';
import { loadCatalog, resolveIngredient, type CatalogItem } from './catalog.js';
import { describeError, readNumber, readString } from './readers.js';
import { buildRevisionPrompt, REVISION_SYSTEM_PROMPT } from './prompts.js';

const log = createLogger('ai');

/** 发给第三方模型的成员代号：绝不外发真实姓名。 */
function anonymousMemberLabel(index: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < alphabet.length ? `成员${alphabet[index]}` : `成员${index + 1}`;
}

/** 可以改的字段白名单：与 shared/types.ts 的 DishEditableField 一一对应 */
const DISH_EDITABLE_FIELDS: DishEditableField[] = [
  'name',
  'category',
  'spicy',
  'difficulty',
  'minutes',
  'baseServings',
  'emoji',
  'description',
  'tags',
  'steps',
  'meal_types',
];

interface RawRevisionChange {
  kind?: unknown;
  field?: unknown;
  value?: unknown;
  steps?: unknown;
  ingredient?: unknown;
  amount?: unknown;
  required?: unknown;
  feedback_ids?: unknown;
  conflict?: unknown;
  note?: unknown;
}

interface RawRevision {
  changes?: unknown;
  unhandled?: unknown;
  notes?: unknown;
}

/** 餐别的展示文案：空数组 = 通用菜（三餐都能点） */
function mealTypeLabels(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((meal) => MEAL_LABEL[meal as keyof typeof MEAL_LABEL] ?? String(meal)).join('、') || '通用菜';
}

/** 字段的中文标签与「从菜品上取现值」的映射：改菜卡片上要显示「辣度 2 → 1」 */
const FIELD_META: Record<DishEditableField, { label: string; read: (dish: Dish) => unknown }> = {
  name: { label: '菜名', read: (dish) => dish.name },
  category: { label: '分类', read: (dish) => dish.category },
  spicy: { label: '辣度', read: (dish) => dish.spicy },
  difficulty: { label: '难度', read: (dish) => dish.difficulty },
  minutes: { label: '耗时（分钟）', read: (dish) => dish.cook_minutes },
  baseServings: { label: '基准份数', read: (dish) => dish.base_servings },
  emoji: { label: '图标', read: (dish) => dish.emoji },
  description: { label: '简介', read: (dish) => dish.description ?? '' },
  tags: { label: '标签', read: (dish) => dish.tags },
  steps: { label: '做法', read: (dish) => dish.steps },
  meal_types: { label: '餐别', read: (dish) => mealTypeLabels(dish.meal_types) },
};

/** 值的展示文案：数组拼成「、」，空值给一个明确说法而不是留白 */
function displayValue(field: DishEditableField, value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '（空）';
  const text = value === null || value === undefined ? '' : String(value);
  return text === '' ? (field === 'steps' || field === 'description' || field === 'tags' ? '（空）' : text) : text;
}

/**
 * 把模型输出整理成可勾选的改动清单。
 *
 * 三件事必须由服务端裁决，不能信模型：
 *   1. **合法性**：字段改动借用 dishService 的同一份校验试跑一遍（assertDishPatchValid），
 *      过不了的不进草稿——草稿上不该出现「点确认必然 400」的改动；
 *   2. **落点**：配料表的操作要能在现状配料表里对上（add 的不能已存在、remove/amount 的必须已存在）；
 *   3. **交代**：每条反馈都得有去处——被某条改动覆盖，或进 unhandled。
 *      模型漏掉的自动补进 unhandled，保证界面上不会「这条反馈去哪了」。
 */
function toRevision(
  raw: RawRevision,
  dish: Dish,
  feedbacks: { id: number; content: string; member_name: string | null }[],
  catalog: CatalogItem[],
): { changes: AiRevisionChange[]; unhandled: AiDishRevisionDraft['unhandled']; notes: string[]; effects: string[] } {
  const notes: string[] = [];
  const byName = new Map(catalog.map((item) => [item.name, item]));
  const feedbackById = new Map(feedbacks.map((item) => [item.id, item.content]));
  const bomById = new Map(dish.ingredients.map((item) => [item.ingredient_id, item]));
  // 这一批里已经「加进去」的食材：再来一条 add（或落空转成加一行的 amount）会让
  // 最终配料表出现同名两行，PUT 整表替换必然 400——草稿上就不能让这种组合成立
  const addedIds = new Set<number>();
  const usedFeedback = new Set<number>();
  const unhandled: AiDishRevisionDraft['unhandled'] = [];
  const unhandledIds = new Set<number>();

  const readSources = (value: unknown): { id: number; content: string }[] => {
    const ids = (Array.isArray(value) ? value : [])
      .map((item) => Number(item))
      .filter((id) => feedbackById.has(id));
    const unique = [...new Set(ids)];
    // 记录「这条反馈被用到了」：只有被真正落进改动清单的才算数，见下面每处的 usedFeedback.add
    return unique.map((id) => ({ id, content: feedbackById.get(id) as string }));
  };

  const changes: AiRevisionChange[] = [];
  const rawChanges = Array.isArray(raw.changes) ? raw.changes : [];
  let index = 0;

  for (const entry of rawChanges) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as RawRevisionChange;
    const kind = readString(item.kind);
    const sources = readSources(item.feedback_ids);
    if (sources.length === 0) {
      // 没有依据的改动一律丢掉：这条规则挡的是「模型顺手优化别的地方」
      notes.push(`模型提了一条没有反馈依据的改动，已忽略（${kind || '未知类型'}）`);
      continue;
    }
    const conflict = item.conflict === true;
    const note = readString(item.note);

    const commit = (change: Omit<AiRevisionChange, 'id' | 'sources' | 'conflict' | 'note'>) => {
      index += 1;
      changes.push({ ...change, id: `c${index}`, sources, conflict, note });
      for (const source of sources) usedFeedback.add(source.id);
    };

    if (kind === 'field' || kind === 'steps') {
      const field = (kind === 'steps' ? 'steps' : readString(item.field)) as DishEditableField;
      if (!DISH_EDITABLE_FIELDS.includes(field)) {
        notes.push(`模型想改「${field || '未知字段'}」，但那个字段不在可改范围内，已忽略`);
        continue;
      }
      // steps 走自己的键（数组），其余走 value
      const value: unknown = kind === 'steps' ? item.steps : item.value;
      const normalized = field === 'steps' && Array.isArray(value) ? (value as string[]) : value;
      try {
        assertDishPatchValid(dish.id, { [field]: normalized });
      } catch (error) {
        notes.push(`「${FIELD_META[field].label}」的改法不合法（${describeError(error)}），已忽略这条`);
        continue;
      }
      const before = FIELD_META[field].read(dish);
      const after =
        field === 'steps'
          ? Array.isArray(normalized)
            ? normalized.join('\n')
            : normalized
          : field === 'meal_types'
            ? mealTypeLabels(normalized)
            : normalized;
      if (displayValue(field, before) === displayValue(field, after)) continue; // 没变化就不占一行
      commit({
        label: FIELD_META[field].label,
        before: Array.isArray(before) ? before.join('、') : String(before ?? ''),
        after: displayValue(field, after),
        field,
        value: normalized,
      });
      continue;
    }

    if (kind === 'add' || kind === 'remove' || kind === 'amount') {
      const said = readString(item.ingredient);
      const matched = resolveIngredient(said, byName);
      if (!matched) {
        notes.push(`配料表里没有对应「${said}」的食材，这条改动已忽略`);
        continue;
      }
      const existing = bomById.get(matched.id);
      const amountRaw = readNumber(item.amount);
      const amount = amountRaw === null ? null : Math.round(amountRaw);

      if (kind === 'remove') {
        if (!existing) {
          notes.push(`「${matched.name}」本来就不在这道菜的配料表里，删不了`);
          continue;
        }
        if (dish.ingredients.length === 1) {
          notes.push(`「${matched.name}」是这道菜唯一的配料，删掉会变成空配料表（配料表至少保留一条）`);
          continue;
        }
        commit({
          label: `删掉配料：${matched.name}`,
          before: `${existing.amount}g`,
          after: '（移除）',
          bom: { action: 'remove', ingredient_id: matched.id, name: matched.name },
        });
        continue;
      }

      if (amount === null || amount <= 0 || amount > 5000) {
        notes.push(`「${matched.name}」的用量没给对（需要 0~5000 克），这条改动已忽略`);
        continue;
      }

      if (kind === 'amount') {
        if (!existing) {
          // 不在配料表里却要「改用量」——当成「加一行」更合理，这里明确说出来
          if (addedIds.has(matched.id)) {
            notes.push(`「${matched.name}」已经有了一条「加进去」的改动，这条重复的已忽略`);
            continue;
          }
          notes.push(`「${matched.name}」原本不在配料表里，模型说改成 ${amount}g，已按「加一行」处理`);
          addedIds.add(matched.id);
          commit({
            label: `加一样配料：${matched.name}`,
            before: '（没有）',
            after: `${amount}g`,
            bom: { action: 'add', ingredient_id: matched.id, name: matched.name, amount, required: item.required === true },
          });
          continue;
        }
        if (existing.amount === amount) continue;
        commit({
          label: `${matched.name}（用量）`,
          before: `${existing.amount}g`,
          after: `${amount}g`,
          bom: { action: 'amount', ingredient_id: matched.id, name: matched.name, amount },
        });
        continue;
      }

      // kind === 'add'
      if (existing) {
        if (existing.amount === amount) continue;
        notes.push(`「${matched.name}」已经在配料表里，已按「改用量」处理`);
        commit({
          label: `${matched.name}（用量）`,
          before: `${existing.amount}g`,
          after: `${amount}g`,
          bom: { action: 'amount', ingredient_id: matched.id, name: matched.name, amount },
        });
        continue;
      }
      if (addedIds.has(matched.id)) {
        notes.push(`模型对「${matched.name}」提了两条「加进去」的改动，已忽略后一条`);
        continue;
      }
      addedIds.add(matched.id);
      commit({
        label: `加一样配料：${matched.name}`,
        before: '（没有）',
        after: `${amount}g${item.required === true ? ' 必有' : ' 可选'}`,
        bom: {
          action: 'add',
          ingredient_id: matched.id,
          name: matched.name,
          amount,
          required: item.required === true,
        },
      });
      continue;
    }

    notes.push(`模型给了一种不认识的改动类型（${kind || '空'}），已忽略`);
  }

  // 模型自己说「看不出要改什么」的，先收下
  for (const entry of Array.isArray(raw.unhandled) ? raw.unhandled : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as { feedback_id?: unknown; reason?: unknown };
    const id = Number(item.feedback_id);
    const content = feedbackById.get(id);
    // 已经被某条改动引用过的反馈不再列入 unhandled：否则它既在改动里、又留在池里，
    // 前端按「被覆盖到」删除时会把这条已处理的反馈也一起删掉
    if (content === undefined || unhandledIds.has(id) || usedFeedback.has(id)) continue;
    unhandledIds.add(id);
    unhandled.push({ feedback_id: id, content, reason: readString(item.reason) || '看不出要改什么' });
  }

  // 兜底交代：模型既没给改动、也没说看不出的，一律补进 unhandled——
  // 「这条反馈去哪了」不能变成一个悬念，留着不动是最安全的处置。
  // 措辞保持中性（不写「模型没有提到」）：改动被丢弃（重复/非法）时模型其实提到了，
  // 只是没落成改动，这里无法区分，别给一句不实的原因。
  for (const feedback of feedbacks) {
    if (usedFeedback.has(feedback.id) || unhandledIds.has(feedback.id)) continue;
    unhandledIds.add(feedback.id);
    unhandled.push({ feedback_id: feedback.id, content: feedback.content, reason: '这次没有对应的改动，先留在池里' });
  }

  const modelNote = readString(raw.notes);
  if (modelNote) notes.push(modelNote);

  return { changes, unhandled, notes, effects: revisionEffects(changes) };
}

/** 这次改动的连带影响：由服务端按改动内容算，不交给模型说（它容易漏、也容易夸大） */
function revisionEffects(changes: AiRevisionChange[]): string[] {
  const effects: string[] = [];
  if (changes.some((change) => change.bom)) {
    effects.push('配料用量变了：采购清单上的量会跟着变，营养报告也会跟着变（历史订单不受影响——存的是下单时的快照）');
  }
  if (changes.some((change) => change.field === 'name')) {
    effects.push('改名只影响今后：历史订单里仍旧显示下单时的菜名');
  }
  if (changes.some((change) => change.field === 'category')) {
    effects.push('分类会影响点菜页的筛选与「配一桌」的荤素搭配');
  }
  if (changes.some((change) => change.field === 'baseServings')) {
    effects.push('基准份数只影响配比展示，不会改变已经下过的份数');
  }
  return effects;
}

/**
 * 一道菜的现状 + 它的全部待处理反馈 → 改动草稿。**不写库**。
 */
export async function draftDishRevision(dishId: number): Promise<AiDishRevisionResult> {
  const dish = getDishById(dishId);
  if (!dish) throw notFound('菜品不存在');

  // 只取 member_id，不把成员真实姓名发给第三方模型；按反馈顺序映射成「成员A/B」。
  const rows = all<{ id: number; content: string; member_id: number | null }>(
    `SELECT f.id, f.content, f.member_id
       FROM dish_feedback f
      WHERE f.dish_id = ?
      ORDER BY f.created_at ASC, f.id ASC`,
    dishId,
  );
  if (rows.length === 0) throw badRequest('这道菜还没有反馈，没什么可改的');

  const aliasByMember = new Map<number, string>();
  const feedbacks = rows.map((row) => {
    let memberName: string | null = null;
    if (row.member_id !== null) {
      if (!aliasByMember.has(row.member_id)) {
        aliasByMember.set(row.member_id, anonymousMemberLabel(aliasByMember.size));
      }
      memberName = aliasByMember.get(row.member_id) ?? null;
    }
    return { id: row.id, content: row.content, member_name: memberName };
  });

  const catalog = loadCatalog();
  const raw = await chatJson<RawRevision>({
    system: REVISION_SYSTEM_PROMPT,
    user: buildRevisionPrompt(dish, feedbacks, catalog),
    maxTokens: 2500,
  });

  const { changes, unhandled, notes, effects } = toRevision(raw, dish, feedbacks, catalog);
  log.info(
    `AI 修订「${dish.name}」：改动 ${changes.length} 条、看不出要改的 ${unhandled.length} 条` +
      `（依据反馈 ${feedbacks.length} 条）、提示 ${notes.length} 条`,
  );
  return { revision: { dish, changes, unhandled, effects }, notes, model: llmModel() };
}
