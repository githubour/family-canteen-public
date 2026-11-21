import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { groupBy } from '../src/lib/collection';

describe('collection：groupBy', () => {
  it('按 key 归组，保持首次出现顺序', () => {
    const items = [
      { category: '肉禽蛋', name: '五花肉' },
      { category: '蔬果', name: '番茄' },
      { category: '肉禽蛋', name: '鸡蛋' },
    ];
    const grouped = groupBy(items, (item) => item.category);
    assert.deepEqual([...grouped.keys()], ['肉禽蛋', '蔬果']);
    assert.deepEqual(grouped.get('肉禽蛋')?.map((item) => item.name), ['五花肉', '鸡蛋']);
    assert.deepEqual(grouped.get('蔬果')?.map((item) => item.name), ['番茄']);
  });

  it('空列表返回空 Map', () => {
    assert.equal(groupBy([], (item: string) => item).size, 0);
  });

  it('数字 key 也可用（如食材 id）', () => {
    const grouped = groupBy([1, 2, 1, 3], (value) => value % 2);
    assert.deepEqual([...grouped.get(1) ?? []], [1, 1, 3]);
    assert.deepEqual([...grouped.get(0) ?? []], [2]);
  });
});
