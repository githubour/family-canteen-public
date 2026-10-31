import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  DISH_CATEGORIES,
  MEAL_LABEL,
  MEAL_TYPES,
  type AiDishDraft,
  type AiDraftIngredient,
  type MealType,
  type NutritionFacts,
} from '../../api/types';
import { Button, ChoiceChip, Stepper, cn } from '../ui/base';
import { Field } from '../settings/Field';

/** 新食材要填的六项（每 100g 可食部口径，与食材库一致） */
const NUTRITION_FIELDS: { key: keyof NutritionFacts; label: string }[] = [
  { key: 'kcal', label: '热量 kcal' },
  { key: 'protein', label: '蛋白质 g' },
  { key: 'fat', label: '脂肪 g' },
  { key: 'carb', label: '碳水 g' },
  { key: 'sodium', label: '钠 mg' },
  { key: 'fiber', label: '纤维 g' },
];

const EMPTY_NUTRITION: NutritionFacts = { kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 0, fiber: 0 };

function blankRow(): AiDraftIngredient {
  return {
    name: '',
    amount: 100,
    required: true,
    is_new: true,
    matched_name: null,
    category: '其他',
    nutrition: null,
  };
}

type TextMap = Record<string, string>;

/** 新食材的营养是否填齐：六项都要有值，缺一项就不许入库（对应「不许填 0 糊弄」那条铁律） */
function nutritionFilled(row: AiDraftIngredient, index: number, text: TextMap): boolean {
  return NUTRITION_FIELDS.every(({ key }) => {
    const typed = text[`${index}:${key}`];
    if (typed !== undefined) return typed.trim() !== '' && Number.isFinite(Number(typed));
    return row.nutrition !== null;
  });
}

/**
 * AI 草稿卡片：草稿在上屏那一刻起就只是「一份可以随便改的初稿」。
 *
 * 这里刻意逐项可编辑而不是只读预览——模型的活只占七分，剩下三分靠人对着自家口味调；
 * 而「确认入库」走的是与手工加菜同一个 POST /api/dishes，所以卡片里改了什么就落什么。
 *
 * 改动一律走 onChange 的**函数式更新**（previous => next）而不是传整份新草稿：
 * 一次 tick 里连着改六个营养输入框时，闭包里的 draft 还是旧的，传整份新草稿会互相覆盖
 * （人工敲键盘看不出来，粘贴或自动填充就会丢字段）。
 */
export function AiDishDraftCard({
  draft,
  notes,
  model,
  knownIngredients,
  onChange,
  onDiscard,
  onConfirm,
  confirming,
}: {
  draft: AiDishDraft;
  notes: string[];
  model: string;
  /** 库里已有的食材名 → 分类：手工改配料名时用它判断是「复用已有」还是「新建」 */
  knownIngredients: Map<string, string>;
  onChange: (updater: (previous: AiDishDraft) => AiDishDraft) => void;
  onDiscard: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const [stepsText, setStepsText] = useState(draft.steps.join('\n'));
  const [tagsText, setTagsText] = useState(draft.tags.join('、'));
  const [nutritionText, setNutritionText] = useState<TextMap>({});

  const update = (next: Partial<AiDishDraft>) => onChange((previous) => ({ ...previous, ...next }));

  const patchRow = (index: number, next: Partial<AiDraftIngredient>) =>
    onChange((previous) => ({
      ...previous,
      ingredients: previous.ingredients.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }));

  /**
   * 改配料名时同步判断：刚好等于库里某个食材名就转成「复用已有」，
   * 否则当成新食材——不这么做的话，把已有食材填进「新食材」栏会连营养一起覆盖成刚填的数。
   */
  const setRowName = (index: number, name: string) => {
    const trimmed = name.trim();
    const category = knownIngredients.get(trimmed);
    if (category !== undefined) {
      patchRow(index, { name: trimmed, is_new: false, matched_name: trimmed, category, nutrition: null });
    } else {
      patchRow(index, { name, is_new: true, matched_name: null });
    }
  };

  const setNutrition = (index: number, key: keyof NutritionFacts, raw: string) => {
    setNutritionText((previous) => ({ ...previous, [`${index}:${key}`]: raw }));
    const parsed = raw.trim() === '' ? 0 : Number(raw);
    onChange((previous) => ({
      ...previous,
      ingredients: previous.ingredients.map((row, i) =>
        i === index
          ? { ...row, nutrition: { ...(row.nutrition ?? EMPTY_NUTRITION), [key]: Number.isFinite(parsed) ? parsed : 0 } }
          : row,
      ),
    }));
  };

  // 名称为空的行是「加了一条还没填完」的半成品：提交时会被丢掉（见 lib/aiDraft），
  // 所以它也不该拦住「确认入库」——不能因为一条空白行就要求填六项营养
  const namedRows = draft.ingredients.filter((row) => row.name.trim() !== '');
  const missing = draft.ingredients
    .map((row, index) => ({ row, index }))
    .filter((item) => item.row.is_new && item.row.name.trim() !== '')
    .filter((item) => !nutritionFilled(item.row, item.index, nutritionText));
  const categoryMissing = draft.category === '';
  const noIngredients = namedRows.length === 0;
  // 以下几项对齐 POST /api/dishes 的服务端校验：宁可把按钮灰掉并说原因，
  // 也不要让「确认入库」必然 400（提交的报错只在 toast 里闪一下，改起来没抓手）
  const trimmedName = draft.name.trim();
  const nameBad = trimmedName === '' || trimmedName.length > 24;
  const minutesBad = !Number.isInteger(draft.minutes) || draft.minutes < 1 || draft.minutes > 600;
  const amountBad = namedRows.some((row) => !Number.isFinite(row.amount) || row.amount < 1 || row.amount > 5000);
  // 提交时配料按「matched_name ?? name」送出去，重名判断也用这个口径
  const submittedNames = namedRows.map((row) => (row.matched_name ?? row.name).trim());
  const duplicateBad = submittedNames.some((name, index) => submittedNames.indexOf(name) !== index);
  const tagsBad = draft.tags.some((tag) => tag.length > 12);
  const blocked =
    missing.length > 0 ||
    categoryMissing ||
    noIngredients ||
    nameBad ||
    minutesBad ||
    amountBad ||
    duplicateBad ||
    tagsBad;
  const blockReason = noIngredients
    ? '至少要有一条配料'
    : nameBad
      ? '菜名需要是 1~24 个字'
      : categoryMissing
        ? '先选一个分类'
        : minutesBad
          ? '耗时需要在 1~600 分钟之间'
          : amountBad
            ? '有配料的用量不在 1~5000 克之间'
            : duplicateBad
              ? '配料里有重名的行，合并或删掉一条'
              : tagsBad
                ? '每个标签要在 12 字以内'
                : `补齐「${missing.map((item) => item.row.name || '新食材').join('、')}」的六项营养后才能入库`;

  return (
    <section className="space-y-3">
      {notes.length > 0 ? (
        <div className="rounded-xl2 bg-warn/12 px-3 py-2.5">
          <p className="text-[12px] font-semibold text-[#B45309]">模型给的初稿有几点要留意</p>
          <ul className="mt-1 space-y-0.5">
            {notes.map((note) => (
              <li key={note} className="text-[11px] leading-5 text-[#B45309]">
                · {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Field label="菜名" hint={`由 ${model} 起草，随便改`}>
        <div className="flex gap-2">
          <input
            value={draft.emoji}
            onChange={(event) => update({ emoji: event.target.value })}
            aria-label="图标"
            maxLength={8}
            className="h-10 w-14 shrink-0 rounded-xl2 border border-cream-400 bg-white text-center text-[18px]"
          />
          <input
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
            maxLength={24}
            aria-label="菜名"
            className="h-10 min-w-0 flex-1 rounded-xl2 border border-cream-400 bg-white px-3 text-[15px]"
          />
        </div>
      </Field>

      <Field label="分类" hint={categoryMissing ? '模型没给出合法分类，必须自己选一个' : undefined}>
        <div className="flex flex-wrap gap-1.5">
          {DISH_CATEGORIES.map((category) => (
            <ChoiceChip key={category} active={draft.category === category} onClick={() => update({ category })}>
              {category}
            </ChoiceChip>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Field label="耗时（分钟）">
          <input
            type="number"
            min={1}
            max={600}
            value={draft.minutes}
            onChange={(event) => update({ minutes: Number(event.target.value) || 1 })}
            className="h-10 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[15px] tabular-nums"
          />
        </Field>
        <Field label="基准份数">
          <Stepper value={draft.baseServings} min={1} max={20} onChange={(baseServings) => update({ baseServings })} />
        </Field>
        <Field label="难度">
          <div className="flex gap-1.5">
            {[1, 2, 3].map((level) => (
              <ChoiceChip key={level} active={draft.difficulty === level} onClick={() => update({ difficulty: level })}>
                {'★'.repeat(level)}
              </ChoiceChip>
            ))}
          </div>
        </Field>
        <Field label="辣度">
          <div className="flex gap-1.5">
            {[0, 1, 2, 3].map((level) => (
              <ChoiceChip key={level} active={draft.spicy === level} onClick={() => update({ spicy: level })}>
                {level === 0 ? '不辣' : '🌶'.repeat(level)}
              </ChoiceChip>
            ))}
          </div>
        </Field>
      </div>

      <Field label="标签" hint="用「、」或逗号分隔，最多 8 个">
        <input
          value={tagsText}
          onChange={(event) => {
            setTagsText(event.target.value);
            update({
              tags: event.target.value
                .split(/[、,，]/)
                .map((tag) => tag.trim())
                .filter((tag) => tag !== '')
                .slice(0, 8),
            });
          }}
          className="h-10 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[15px]"
        />
      </Field>

      <Field label="简介">
        <input
          value={draft.description}
          maxLength={120}
          onChange={(event) => update({ description: event.target.value })}
          className="h-10 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[15px]"
        />
      </Field>

      <Field label="餐别" hint="都不选 = 通用菜（三餐都能点）">
        <div className="flex gap-1.5">
          {MEAL_TYPES.map((meal: MealType) => {
            const on = draft.mealTypes.includes(meal);
            return (
              <ChoiceChip
                key={meal}
                active={on}
                onClick={() =>
                  onChange((previous) => ({
                    ...previous,
                    mealTypes: on ? previous.mealTypes.filter((item) => item !== meal) : [...previous.mealTypes, meal],
                  }))
                }
              >
                {MEAL_LABEL[meal]}
              </ChoiceChip>
            );
          })}
        </div>
      </Field>

      <Field label="做法" hint="一行一步，大厨在备料弹层里点菜名就能看">
        <textarea
          value={stepsText}
          rows={5}
          onChange={(event) => {
            setStepsText(event.target.value);
            update({ steps: event.target.value.split('\n') });
          }}
          className="w-full rounded-xl2 border border-cream-400 bg-white p-3 text-[14px] leading-6"
        />
      </Field>

      <div className="rounded-xl2 border border-cream-300 bg-white p-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[14px] font-semibold">配料（每人份）</p>
          <p className="text-[11px] text-ink-400">
            {draft.kcal_per_serving === null
              ? '还没有配料'
              : draft.nutrition_complete
                ? `每人份约 ${draft.kcal_per_serving} kcal`
                : `每人份约 ${draft.kcal_per_serving} kcal（只算了库里已有的食材）`}
          </p>
        </div>
        <p className="mb-3 mt-0.5 text-[11px] leading-4 text-ink-400">
          「必有」缺了这道菜不成立，点菜页按它排序；「可选」缺了只是口味打折，跳过照样能做。
        </p>

        <div className="space-y-2">
          {draft.ingredients.map((row, index) => (
            // key 只用下标：用 row.name 会让每次改字都重建整行，输入框失焦、中文输入法断词
            <div key={index} className="rounded-xl2 border border-cream-300 bg-cream-100/60 p-2.5">
              <div className="flex items-center gap-2">
                <input
                  value={row.name}
                  onChange={(event) => setRowName(index, event.target.value)}
                  placeholder="食材名"
                  maxLength={20}
                  className="h-9 min-w-0 flex-1 rounded-xl2 border border-cream-400 bg-white px-2.5 text-[14px]"
                />
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={row.amount}
                  onChange={(event) => patchRow(index, { amount: Number(event.target.value) || 1 })}
                  className="h-9 w-16 rounded-xl2 border border-cream-400 bg-white px-2 text-right text-[14px] tabular-nums"
                />
                <span className="text-[12px] text-ink-400">g</span>
                <ChoiceChip
                  active={row.required}
                  className="shrink-0"
                  onClick={() => patchRow(index, { required: !row.required })}
                >
                  {row.required ? '必有' : '可选'}
                </ChoiceChip>
                <button
                  type="button"
                  aria-label="删掉这条配料"
                  onClick={() =>
                    onChange((previous) => ({
                      ...previous,
                      ingredients: previous.ingredients.filter((_, i) => i !== index),
                    }))
                  }
                  className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {row.is_new ? (
                <div
                  className={cn(
                    'mt-2 rounded-xl2 p-2.5',
                    row.nutrition_source === 'seed' ? 'bg-fresh/10' : 'bg-warn/12',
                  )}
                >
                  <p
                    className={cn(
                      'text-[11px] leading-4',
                      row.nutrition_source === 'seed' ? 'text-fresh' : 'text-[#B45309]',
                    )}
                  >
                    {row.nutrition_source === 'seed'
                      ? `食材库里没有「${row.name || '这个食材'}」，营养已按《中国食物成分表》参考表填好——成分表口径、不需要复核，想改也可以直接改。`
                      : `食材库里没有「${row.name || '这个食材'}」，要连每 100g 营养一起登记。这六项无论是 AI 填的还是你填的，入库后都会在食材页标「待复核」——营养页要跟膳食指南对照，这种数字值得多看一眼。`}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3">
                    {NUTRITION_FIELDS.map(({ key, label }) => (
                      <label key={key} className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-ink-400">{label}</span>
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={nutritionText[`${index}:${key}`] ?? (row.nutrition ? String(row.nutrition[key]) : '')}
                          onChange={(event) => setNutrition(index, key, event.target.value)}
                          className="h-9 w-full rounded-xl2 border border-cream-400 bg-white px-2 text-right text-[14px] tabular-nums"
                        />
                      </label>
                    ))}
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-ink-400">分类</span>
                      <input
                        value={row.category}
                        onChange={(event) => patchRow(index, { category: event.target.value })}
                        maxLength={10}
                        className="h-9 w-full rounded-xl2 border border-cream-400 bg-white px-2 text-[14px]"
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-ink-400">
                  {row.matched_name && row.matched_name !== row.name
                    ? `已对上库里的「${row.matched_name}」· ${row.category}`
                    : `食材库里已有 · ${row.category}`}
                </p>
              )}
            </div>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => onChange((previous) => ({ ...previous, ingredients: [...previous.ingredients, blankRow()] }))}
        >
          <Plus size={14} /> 加一条配料
        </Button>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" block disabled={confirming} onClick={onDiscard}>
          取消
        </Button>
        <Button block disabled={confirming || blocked} onClick={onConfirm} className={cn(blocked && 'opacity-50')}>
          {confirming ? '入库中…' : '确认入库'}
        </Button>
      </div>

      {blocked ? (
        <p className="text-center text-[11px] leading-4 text-ink-400">{blockReason}</p>
      ) : (
        <p className="text-center text-[11px] leading-4 text-ink-400">
          入库走的是「加菜」同一条接口，菜单会实时刷新
        </p>
      )}
    </section>
  );
}
