/**
 * 分单提交的幂等 token 生命周期（CartPage.submit 的核心逻辑，抽为纯函数后可测）。
 *
 * 关键不变量：成功的组立即释放 token（调用方随后把它从购物车摘掉），失败的组保留
 * token 供重试复用——服务端按 client_token 幂等返回原单，不会把同一 (日期, 餐次)
 * 下成两张订单；已成功的组即使再往同一餐加点菜，也会拿到全新 token 建成新单，
 * 而不是被服务端当成重复提交把新菜静默吞掉。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { submitGroups, type SubmitGroup } from '../src/lib/submitGroups';

function makeGroup(key: string, calls: string[], shouldFail: () => boolean): SubmitGroup {
  return {
    key,
    submit: async (token: string) => {
      calls.push(`${key}:${token}`);
      if (shouldFail()) throw new Error(`提交 ${key} 失败`);
    },
  };
}

describe('submitGroups：分单提交幂等', () => {
  it('逐组提交；每组成功后立即释放 token，下一轮同样的分组换新 token', async () => {
    const tokens = new Map<string, string>();
    const calls: string[] = [];
    const succeeded: string[] = [];
    let seq = 0;
    const newToken = () => `t${(seq += 1)}`;

    await submitGroups(
      [makeGroup('a', calls, () => false), makeGroup('b', calls, () => false)],
      tokens,
      newToken,
      (group) => succeeded.push(group.key),
    );
    assert.deepEqual(calls, ['a:t1', 'b:t2']);
    assert.deepEqual(succeeded, ['a', 'b']);
    assert.equal(tokens.size, 0);

    // 成功后的下一车（同名分组）必须拿全新 token，否则会被服务端当成上一笔重复提交
    await submitGroups([makeGroup('a', calls, () => false)], tokens, newToken);
    assert.deepEqual(calls, ['a:t1', 'b:t2', 'a:t3']);
  });

  it('某组失败：已成功组释放 token 并被回调摘除，失败组沿用原 token 重试', async () => {
    const tokens = new Map<string, string>();
    const calls: string[] = [];
    const succeeded: string[] = [];
    let seq = 0;
    let failB = true;
    const newToken = () => `t${(seq += 1)}`;

    await assert.rejects(
      submitGroups(
        [makeGroup('a', calls, () => false), makeGroup('b', calls, () => failB)],
        tokens,
        newToken,
        (group) => succeeded.push(group.key),
      ),
    );
    assert.deepEqual(calls, ['a:t1', 'b:t2']);
    // a 已经下好、退出购物车；b 留着原 token 等重试
    assert.deepEqual(succeeded, ['a']);
    assert.deepEqual([...tokens.entries()], [['b', 't2']]);

    failB = false;
    await submitGroups([makeGroup('b', calls, () => failB)], tokens, newToken);
    assert.deepEqual(calls, ['a:t1', 'b:t2', 'b:t2']);
    assert.equal(tokens.size, 0);
  });

  it('首组就挂：后续组不提交，失败组保留 token 可安全重试', async () => {
    const tokens = new Map<string, string>();
    const calls: string[] = [];
    let seq = 0;
    let failA = true;
    const newToken = () => `t${(seq += 1)}`;

    await assert.rejects(
      submitGroups([makeGroup('a', calls, () => failA), makeGroup('b', calls, () => false)], tokens, newToken),
    );
    assert.deepEqual(calls, ['a:t1']);

    failA = false;
    await submitGroups([makeGroup('a', calls, () => failA), makeGroup('b', calls, () => false)], tokens, newToken);
    assert.deepEqual(calls, ['a:t1', 'a:t1', 'b:t2']);
  });

  it('新 token 生成即回调，页面重载后可从持久化 token 重建并复用', async () => {
    const tokens = new Map<string, string>();
    const persisted = new Map<string, string>();
    const calls: string[] = [];
    let fail = true;
    let seq = 0;
    const newToken = () => `t${(seq += 1)}`;

    await assert.rejects(
      submitGroups(
        [makeGroup('a', calls, () => fail)],
        tokens,
        newToken,
        undefined,
        (key, token) => persisted.set(key, token),
      ),
    );
    assert.deepEqual([...persisted.entries()], [['a', 't1']]);

    // 模拟页面重载：内存 token 丢失，只剩持久化的那份
    const restored = new Map(persisted);
    fail = false;
    await submitGroups([makeGroup('a', calls, () => fail)], restored, newToken);
    assert.deepEqual(calls, ['a:t1', 'a:t1']);
  });
});
