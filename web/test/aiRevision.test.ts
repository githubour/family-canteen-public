/**
 * 「现状 + 勾选的改动」→ 要提交的那份。
 *
 * 这里钉住的是改菜最容易出错的两处：
 *   · 取消勾选必须真的不生效（改动可以逐条划掉，是按 id 重算而不是提交模型给的目标状态）；
 *   · **只删被采纳的改动覆盖到的反馈**——没勾的那些对应反馈必须留在池里，
 *     否则「看不出要改什么」的线索会被一次确认悄悄清空。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildRevisionPlan, handledFeedbackIds } from '../src/lib/aiRevision';
import type { AiRevisionChange, Dish } from '../src/api/types';

function dishFixture(): Dish {
  return {
    id: 7,
    name: '沙姜鸡',
    category: '荤菜',
    spicy: 2,
    tags: ['家常'],
    cook_minutes: 30,
    difficulty: 2,
    base_servings: 2,
    emoji: '🍗',
    description: '广式家常鸡。',
    is_fried: false,
    active: true,
    created_at: '2026-10-01 10:00:00',
    season_months: [],
    hide_until: '',
    steps: '腌制 15 分钟\n大火翻炒',
    image_url: '',
    meal_types: ['dinner'],
    ingredients: [
      { ingredient_id: 11, name: '鸡腿', category: '肉禽蛋', amount: 180, unit: 'g', note: null, is_pantry: false, required: true },
      { ingredient_id: 22, name: '盐', category: '调料', amount: 3, unit: 'g', note: null, is_pantry: false, required: false },
    ],
    nutrition: { kcal: 326, protein: 29, fat: 21, carb: 2, sodium: 600, fiber: 0.4 },
  };
}

const saltDown: AiRevisionChange = {
  id: 'c1',
  label: '盐（用量）',
  before: '3g',
  after: '2g',
  bom: { action: 'amount', ingredient_id: 22, name: '盐', amount: 2 },
  sources: [{ id: 101, content: '有点咸' }],
  conflict: false,
  note: '',
};

const spicier: AiRevisionChange = {
  id: 'c2',
  label: '辣度',
  before: '2',
  after: '1',
  field: 'spicy',
  value: 1,
  sources: [{ id: 102, content: '太辣了' }],
  conflict: false,
  note: '',
};

describe('改菜草稿 → 提交内容', () => {
  it('全勾：配料表按 id 改量与追加，字段进 PATCH', () => {
    const plan = buildRevisionPlan(dishFixture(), [
      saltDown,
      spicier,
      {
        id: 'c3',
        label: '加一样配料：小葱',
        before: '（没有）',
        after: '5g 可选',
        bom: { action: 'add', ingredient_id: 33, name: '小葱', amount: 5, required: false },
        sources: [{ id: 103, content: '撒点葱花更好看' }],
        conflict: false,
        note: '',
      },
    ]);

    assert.deepEqual(plan.fields, { spicy: 1 });
    assert.deepEqual(plan.ingredients, [
      { name: '鸡腿', amount: 180, required: true },
      { name: '盐', amount: 2, required: false },
      { name: '小葱', amount: 5, required: false },
    ]);
    assert.equal(plan.bomChanged, true);
    assert.deepEqual(plan.handledFeedbackIds, [101, 102, 103]);
  });

  it('取消勾选的一条真的不生效，它对应的反馈也不清', () => {
    // 只勾了「辣度」，把「盐」那条取消了
    const plan = buildRevisionPlan(dishFixture(), [spicier]);

    assert.deepEqual(plan.fields, { spicy: 1 });
    assert.deepEqual(plan.ingredients.map((row) => row.amount), [180, 3], '盐还是原来的 3g');
    assert.equal(plan.bomChanged, false, '配料表没动就不该发 PUT');
    assert.deepEqual(plan.handledFeedbackIds, [102], '没勾的那条反馈必须留在池里');
  });

  it('删一行 / 改一行：顺序与身份都按配料表 id 走', () => {
    const plan = buildRevisionPlan(dishFixture(), [
      { ...saltDown, bom: { action: 'remove', ingredient_id: 22, name: '盐' } },
      { ...saltDown, id: 'c9', bom: { action: 'amount', ingredient_id: 11, name: '鸡腿', amount: 250 } },
    ]);

    assert.deepEqual(plan.ingredients, [{ name: '鸡腿', amount: 250, required: true }]);
    assert.equal(plan.bomChanged, true);
  });

  it('没有改动时什么都不提交', () => {
    const plan = buildRevisionPlan(dishFixture(), []);
    assert.deepEqual(plan.fields, {});
    assert.equal(plan.bomChanged, false);
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.handledFeedbackIds, []);
  });

  it('同一句反馈被多条改动引用时只删一次', () => {
    assert.deepEqual(
      handledFeedbackIds([saltDown, { ...spicier, sources: saltDown.sources }]),
      [101],
    );
  });

  it('做法这类长字段原样进 PATCH（服务端两种口径都认）', () => {
    const steps: AiRevisionChange = {
      id: 'c4',
      label: '做法',
      before: '腌制 15 分钟\n大火翻炒',
      after: '腌制 15 分钟\n大火翻炒\n小火炖 25 分钟',
      field: 'steps',
      value: ['腌制 15 分钟', '大火翻炒', '小火炖 25 分钟'],
      sources: [{ id: 103, content: '土豆没炖烂' }],
      conflict: false,
      note: '',
    };
    const plan = buildRevisionPlan(dishFixture(), [steps]);
    assert.deepEqual(plan.fields.steps, ['腌制 15 分钟', '大火翻炒', '小火炖 25 分钟']);
    assert.equal(plan.bomChanged, false);
  });
});
