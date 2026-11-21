/**
 * AI 草稿 → 建菜入参的转换。
 *
 * 这里锁的是一个曾经写错、而且**不会报错**的地方：新食材必须**同时**出现在
 * `ingredients`（完整配料表）与 `newIngredients`（待新建清单）里。
 * 只放进 newIngredients 的话，服务端会把食材建好、配料表却一行都不写，
 * 菜是建出来了，只是缺了主料——这类错静默且难查，所以单独拿测试钉住。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { toCreatePayload } from '../src/lib/aiDraft';
import type { AiDishDraft } from '../src/api/types';

function draftFixture(overrides: Partial<AiDishDraft> = {}): AiDishDraft {
  return {
    name: ' 沙姜鸡 ',
    category: '荤菜',
    spicy: 1,
    tags: ['家常'],
    minutes: 30,
    difficulty: 2,
    baseServings: 2,
    emoji: '🍗',
    description: '沙姜香气的广式家常鸡。',
    steps: [' 腌 15 分钟 ', '', '   ', '焖 10 分钟'],
    mealTypes: ['lunch', 'dinner'],
    ingredients: [
      {
        name: '鸡腿',
        amount: 180,
        required: true,
        is_new: false,
        matched_name: '鸡腿',
        category: '肉禽蛋',
        nutrition: null,
      },
    ],
    kcal_per_serving: 326,
    nutrition_complete: true,
    ...overrides,
  };
}

const newRow = {
  name: '沙姜',
  amount: 15,
  required: true,
  is_new: true,
  matched_name: null,
  category: '蔬果',
  nutrition: { kcal: 42, protein: 1.1, fat: 0.2, carb: 8, sodium: 3, fiber: 0.4 },
};

describe('AI 草稿 → 建菜入参', () => {
  it('新食材同时在 ingredients 与 newIngredients 里（配料表不能少行）', () => {
    const payload = toCreatePayload(draftFixture({ ingredients: [...draftFixture().ingredients, newRow] }));

    assert.deepEqual(
      payload.ingredients.map((row) => row.name),
      ['鸡腿', '沙姜'],
      'ingredients 是完整配料表，新食材也必须在这里——否则这道菜的配料表会缺行',
    );
    assert.deepEqual(
      payload.newIngredients?.map((row) => row.name),
      ['沙姜'],
      'newIngredients 只放库里没有的',
    );
    assert.equal(payload.newIngredients?.[0].kcal, 42);
    assert.equal(payload.newIngredients?.[0].category, '蔬果');
  });

  it('命中的别名用库里的规范名（模型说菠萝，库里叫凤梨）', () => {
    const payload = toCreatePayload(
      draftFixture({
        ingredients: [
          {
            name: '菠萝',
            amount: 80,
            required: true,
            is_new: false,
            matched_name: '凤梨',
            category: '蔬果',
            nutrition: null,
          },
        ],
      }),
    );

    assert.deepEqual(payload.ingredients, [{ name: '凤梨', amount: 80, required: true }]);
    assert.equal(payload.newIngredients?.length, 0);
  });

  it('来源标 ai（新食材营养因此会在食材页标待复核）', () => {
    assert.equal(toCreatePayload(draftFixture()).origin, 'ai');
  });

  it('命中参考表的新食材带 nutritionSource=seed（不挂待复核），没命中的不带你', () => {
    const payload = toCreatePayload(
      draftFixture({
        ingredients: [
          ...draftFixture().ingredients,
          { ...newRow, nutrition_source: 'seed' },
          { ...newRow, name: '奇香粉', nutrition_source: undefined },
        ],
      }),
    );
    const byName = new Map((payload.newIngredients ?? []).map((row) => [row.name, row]));
    assert.equal(byName.get('沙姜')?.nutritionSource, 'seed');
    assert.equal(byName.get('奇香粉')?.nutritionSource, undefined, '没命中参考表的不带，服务端按 origin=ai 处理');
  });

  it('做法与菜名做清洗：去掉空行、首尾空格', () => {
    const payload = toCreatePayload(draftFixture());
    assert.equal(payload.name, '沙姜鸡');
    assert.deepEqual(payload.steps, ['腌 15 分钟', '焖 10 分钟']);
  });

  it('名称空着的新增行直接丢掉，不当成食材送出去', () => {
    const payload = toCreatePayload(
      draftFixture({
        ingredients: [
          ...draftFixture().ingredients,
          { ...newRow, name: '   ', nutrition: null },
        ],
      }),
    );

    assert.deepEqual(payload.ingredients.map((row) => row.name), ['鸡腿']);
    assert.equal(payload.newIngredients?.length, 0);
  });

  it('新食材营养没填齐时抛错，绝不把 0 当营养送进去', () => {
    assert.throws(
      () =>
        toCreatePayload(draftFixture({ ingredients: [...draftFixture().ingredients, { ...newRow, nutrition: null }] })),
      /沙姜/,
    );
  });
});
