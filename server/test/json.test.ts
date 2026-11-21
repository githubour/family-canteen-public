/**
 * 宽松 JSON 解析（lib/json.ts）：库里的 JSON 文本可能因历史 bug 或手工改库而损坏，
 * 坏值必须退化成 fallback —— 一条脏数据不能让整个列表接口 500。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseJson, parseStringArray } from '../src/lib/json.js';

describe('parseJson', () => {
  it('正常 JSON 原样解析', () => {
    assert.deepEqual(parseJson<number[]>('[1,2]', []), [1, 2]);
    assert.deepEqual(parseJson('{"a":1}', {}), { a: 1 });
  });

  it('空值与坏 JSON 都退化成 fallback', () => {
    assert.deepEqual(parseJson(null, ['fb']), ['fb']);
    assert.deepEqual(parseJson(undefined, ['fb']), ['fb']);
    assert.deepEqual(parseJson('', ['fb']), ['fb']);
    assert.deepEqual(parseJson('{oops', ['fb']), ['fb']);
    assert.deepEqual(parseJson('{"a":', 'fb'), 'fb');
  });

  it('合法的 null / 数字不会被当成坏值', () => {
    assert.equal(parseJson('null', 'fb'), null);
    assert.equal(parseJson('3', 'fb'), 3);
  });
});

describe('parseStringArray', () => {
  it('数组里只保留字符串，其余项直接滤掉', () => {
    assert.deepEqual(parseStringArray('["a",1,"b",null,{"c":1}]'), ['a', 'b']);
  });

  it('非数组与坏值退化成空数组', () => {
    assert.deepEqual(parseStringArray('{"a":1}'), []);
    assert.deepEqual(parseStringArray('oops'), []);
    assert.deepEqual(parseStringArray(null), []);
    assert.deepEqual(parseStringArray('"单字符串"'), []);
  });
});
