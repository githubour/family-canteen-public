/**
 * 库存草稿 → 批量写入入参的转换，以及「库里没有」行的合并语义。
 *
 * 钉住的是「哪些行会被写出去」这条边界：只有 add / remove 两态该落库，
 * 其余状态（already / pantry / unknown / dish）是**解释性**的，它们存在的意义是让用户看懂
 * 「为什么这句话里只有两样被加进去」，或等人在行上拍板。一旦误传出去，already 会变成
 * 无意义的重复登记，unknown / dish 更糟——它们的 ingredient_id 是 null，
 * 服务端会判定为非法整批拒绝。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { actionableCount, mergeUnknownRow, toBatchPayload } from '../src/lib/aiFridge';
import type { AiFridgeCandidate, AiFridgeRow } from '../src/api/types';

const row = (over: Partial<AiFridgeRow>): AiFridgeRow => ({
  ingredient_id: 1,
  name: '番茄',
  said: '番茄',
  category: '蔬果',
  status: 'add',
  ...over,
});

const candidate = (over: Partial<AiFridgeCandidate> = {}): AiFridgeCandidate => ({
  ingredient_id: 9,
  name: '生抽',
  category: '调料',
  is_pantry: false,
  ...over,
});

describe('库存草稿 → 批量写入入参', () => {
  it('只送 add / remove，解释性状态一律不落库（dish 也不送：它是转去加菜的，不是库存的事）', () => {
    const payload = toBatchPayload([
      row({ ingredient_id: 1, status: 'add' }),
      row({ ingredient_id: 2, status: 'already' }),
      row({ ingredient_id: 3, status: 'remove' }),
      row({ ingredient_id: 4, status: 'pantry' }),
      row({ ingredient_id: null, name: '鱼腥草', status: 'unknown' }),
      row({ ingredient_id: null, name: '熟食烤鸡', status: 'dish' }),
    ]);

    assert.deepEqual(payload, { add: [1], remove: [3] });
  });

  it('id 为空的行永远不送出去（unknown 的 id 是 null，会导致整批 400）', () => {
    const payload = toBatchPayload([row({ ingredient_id: null, name: '鱼腥草', status: 'add' })]);
    assert.deepEqual(payload, { add: [], remove: [] });
  });

  it('可操作行数只算 add / remove：全被跳过时不该让用户点确认', () => {
    assert.equal(actionableCount([row({ status: 'already' }), row({ status: 'pantry' })]), 0);
    assert.equal(actionableCount([row({ status: 'add' }), row({ status: 'already' })]), 1);
  });

  it('空草稿产出空入参', () => {
    assert.deepEqual(toBatchPayload([]), { add: [], remove: [] });
  });
});

describe('「库里没有」的行按候选合并', () => {
  const unknown = row({
    ingredient_id: null,
    name: '生抽酱油',
    said: '生抽酱油',
    category: '其他',
    status: 'unknown',
    want: 'have',
    candidates: [candidate()],
  });

  it('说「有」的按候选合并后变成登记行，名字换成库里的规范名', () => {
    const merged = mergeUnknownRow(unknown, candidate());
    assert.equal(merged.status, 'add');
    assert.equal(merged.ingredient_id, 9);
    assert.equal(merged.name, '生抽');
    assert.equal(merged.said, '生抽酱油', '原话保留，行上才能解释「你说的生抽酱油=生抽」');
    assert.equal(merged.candidates, undefined, '合并完候选清掉，别再渲染一排按钮');
  });

  it('说「没有了」的合并后变成撤掉行（DELETE 幂等：本来不在库存里也等于没撤）', () => {
    const merged = mergeUnknownRow({ ...unknown, want: 'missing' }, candidate());
    assert.equal(merged.status, 'remove');
  });

  it('没说有没说缺（want 缺省）按「有」处理：宁可多登记，也不要错删', () => {
    const merged = mergeUnknownRow({ ...unknown, want: undefined }, candidate());
    assert.equal(merged.status, 'add');
  });

  it('候选是常备调料时转 pantry：只提示不用登记，不产生动作', () => {
    const merged = mergeUnknownRow(unknown, candidate({ ingredient_id: 5, name: '盐', is_pantry: true }));
    assert.equal(merged.status, 'pantry');
    assert.equal(toBatchPayload([merged]).add.includes(5), false);
  });
});
