import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { findSubstitute, groupForName } from '../src/lib/substitutes';

const GROUPS = [
  ['西红柿', '番茄'],
  ['鸡肉', '鸡翅', '鸡腿', '鸡胸'],
  ['土豆', '马铃薯', '洋芋'],
];

describe('食材替代提示', () => {
  it('组内别名可以直接对上（库存鸡肉 ↔ 缺的鸡腿）', () => {
    assert.equal(findSubstitute('鸡腿', ['鸡肉'], GROUPS), '鸡肉');
    assert.equal(findSubstitute('鸡肉', ['鸡腿'], GROUPS), '鸡腿');
  });

  it('库里的品种名带后缀也能归到组（鸡胸肉 → 鸡胸组）', () => {
    assert.equal(groupForName('鸡胸肉', GROUPS)?.[0], '鸡肉');
    assert.equal(findSubstitute('鸡腿', ['鸡胸肉'], GROUPS), '鸡胸肉');
  });

  it('不同组不瞎替代（番茄不会顶鸡腿）', () => {
    assert.equal(findSubstitute('鸡腿', ['番茄'], GROUPS), null);
  });

  it('同名不算替代（库存里就是它自己）', () => {
    assert.equal(findSubstitute('鸡腿', ['鸡腿'], GROUPS), null);
  });

  it('单字别名不参与包含匹配，避免沙姜被并进生姜', () => {
    assert.equal(groupForName('沙姜', [['姜', '生姜']]), null);
  });
});
