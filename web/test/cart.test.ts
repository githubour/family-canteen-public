/**
 * 购物车 store 行为测试（Node 直跑 zustand store，无 DOM）。
 * 模型：(日期, 餐次) = 一张订单，行身份 = 日期 + 餐次 + 菜。
 * 关注点：加菜的落点（目标 / 覆盖 / 过期回落）、整组挪动与合并、分组排序、老数据迁移。
 */
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  cartGroups,
  lineKey,
  mealDateFromOffset,
  groupFingerprint,
  migrateCart,
  resolveTarget,
  reusableSubmitToken,
  targetOffset,
  useCart,
  type CartLine,
} from '../src/store/cart';
import { shiftDay, todayISO } from '../src/lib/format';

const dishA = { id: 1, name: '番茄炒蛋', emoji: '🍅', category: '素菜' };
const dishB = { id: 2, name: '糖醋里脊', emoji: '🥩', category: '荤菜' };

const lineOf = (mealDate: string, mealType: CartLine['mealType'], dishId: number): CartLine => ({
  dishId,
  name: `菜${dishId}`,
  emoji: '🍽️',
  category: '荤菜',
  servings: 1,
  note: '',
  mealDate,
  mealType,
});

beforeEach(() => {
  useCart.setState({
    lines: [],
    targetDate: todayISO(),
    mealType: 'dinner',
    headcount: 3,
    orderNote: '',
    submitTokens: {},
  });
});

describe('cart：行身份与落点换算', () => {
  it('lineKey = 日期 + 餐次 + 菜：任一不同就不是同一行', () => {
    const base = { mealDate: '2026-10-14', mealType: 'dinner' as const, dishId: 1 };
    assert.equal(lineKey(base), lineKey({ ...base }));
    assert.notEqual(lineKey(base), lineKey({ ...base, dishId: 2 }));
    assert.notEqual(lineKey(base), lineKey({ ...base, mealDate: '2026-10-15' }));
    assert.notEqual(lineKey(base), lineKey({ ...base, mealType: 'lunch' }));
  });

  it('mealDateFromOffset / targetOffset 互为逆运算（今天/明天/后天）', () => {
    assert.equal(mealDateFromOffset(0), todayISO());
    assert.equal(mealDateFromOffset(1), shiftDay(todayISO(), 1));
    assert.equal(targetOffset(todayISO()), 0);
    assert.equal(targetOffset(shiftDay(todayISO(), 1)), 1);
    assert.equal(targetOffset(shiftDay(todayISO(), 2)), 2);
    assert.equal(targetOffset(shiftDay(todayISO(), 5)), null);
    assert.equal(targetOffset(shiftDay(todayISO(), -1)), null);
  });

  it('resolveTarget：显式覆盖优先；过期的目标日期回落到今天', () => {
    const target = { mealDate: shiftDay(todayISO(), 1), mealType: 'lunch' as const };
    assert.deepEqual(resolveTarget(undefined, target), target);
    // 单道菜改天：只覆盖日期，餐次仍跟目标
    assert.deepEqual(resolveTarget({ mealDate: todayISO() }, target), { mealDate: todayISO(), mealType: 'lunch' });
    // 目标日期已经过去（隔天再打开）：不把菜下到昨天
    assert.deepEqual(resolveTarget(undefined, { mealDate: shiftDay(todayISO(), -1), mealType: 'dinner' }), {
      mealDate: todayISO(),
      mealType: 'dinner',
    });
  });
});

describe('cart：加菜合行', () => {
  it('默认落到点菜目标（今天·晚餐）', () => {
    useCart.getState().add(dishA, 2);
    const lines = useCart.getState().lines;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].mealDate, todayISO());
    assert.equal(lines[0].mealType, 'dinner');
    assert.equal(lines[0].servings, 2);
  });

  it('详情弹层覆盖日期：落到明天，餐次仍跟目标', () => {
    useCart.setState({ mealType: 'lunch' });
    useCart.getState().add(dishA, 1, { mealDate: shiftDay(todayISO(), 1) });
    assert.equal(useCart.getState().lines[0].mealDate, shiftDay(todayISO(), 1));
    assert.equal(useCart.getState().lines[0].mealType, 'lunch');
  });

  it('过期的目标日期不会把菜下到过去', () => {
    useCart.setState({ targetDate: shiftDay(todayISO(), -1) });
    useCart.getState().add(dishA, 1);
    assert.equal(useCart.getState().lines[0].mealDate, todayISO());
  });

  it('同日同餐同菜合行相加；跨天或跨餐各成一行', () => {
    const add = useCart.getState().add;
    add(dishA, 1);
    add(dishA, 2);
    assert.equal(useCart.getState().lines.length, 1);
    assert.equal(useCart.getState().lines[0].servings, 3);

    add(dishA, 1, { mealDate: shiftDay(todayISO(), 1) });
    add(dishA, 1, { mealType: 'lunch' });
    assert.equal(useCart.getState().lines.length, 3);
  });

  it('合行时份数封顶 20', () => {
    useCart.getState().add(dishA, 18);
    useCart.getState().add(dishA, 5);
    assert.equal(useCart.getState().lines[0].servings, 20);
  });
});

describe('cart：改份数 / 备注 / 删除（按行定位）', () => {
  it('setServings 只改目标行，封顶 20；减到 0 删除', () => {
    const add = useCart.getState().add;
    add(dishA, 1);
    add(dishB, 1, { mealType: 'lunch' });
    const target = useCart.getState().lines.find((line) => line.dishId === dishB.id)!;

    useCart.getState().setServings(target, 30);
    const after = useCart.getState().lines;
    assert.equal(after.find((line) => line.dishId === dishB.id)?.servings, 20);
    assert.equal(after.find((line) => line.dishId === dishA.id)?.servings, 1);

    useCart.getState().setServings(target, 0);
    assert.equal(useCart.getState().lines.some((line) => line.dishId === dishB.id), false);
    assert.equal(useCart.getState().lines.length, 1);
  });

  it('同日不同餐的两行互不串改（备注 / 删除）', () => {
    const add = useCart.getState().add;
    add(dishA, 1); // 今天·晚餐
    add(dishA, 1, { mealType: 'lunch' }); // 今天·午餐
    const dinner = useCart.getState().lines.find((line) => line.mealType === 'dinner')!;

    useCart.getState().setLineNote(dinner, '少放辣');
    const lines = useCart.getState().lines;
    assert.equal(lines.find((line) => line.mealType === 'dinner')?.note, '少放辣');
    assert.equal(lines.find((line) => line.mealType === 'lunch')?.note, '');

    useCart.getState().remove(dinner);
    assert.equal(useCart.getState().lines.length, 1);
    assert.equal(useCart.getState().lines[0].mealType, 'lunch');
  });
});

describe('cart：整组挪动', () => {
  it('整组挪到另一餐，其它组不动', () => {
    const add = useCart.getState().add;
    add(dishA, 1); // 今天·晚餐
    add(dishB, 1); // 今天·晚餐
    add(dishA, 1, { mealDate: shiftDay(todayISO(), 1) }); // 明天·晚餐

    useCart.getState().moveGroup(
      { mealDate: todayISO(), mealType: 'dinner' },
      { mealDate: todayISO(), mealType: 'lunch' },
    );
    const lines = useCart.getState().lines;
    assert.equal(lines.filter((line) => line.mealType === 'lunch').length, 2);
    assert.equal(lines.filter((line) => line.mealDate === shiftDay(todayISO(), 1)).length, 1);
  });

  it('挪过去撞上同名菜合并份数，封顶 20', () => {
    const add = useCart.getState().add;
    add(dishA, 5, { mealType: 'lunch' });
    add(dishA, 18);
    useCart.getState().moveGroup(
      { mealDate: todayISO(), mealType: 'dinner' },
      { mealDate: todayISO(), mealType: 'lunch' },
    );
    const lines = useCart.getState().lines;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].servings, 20);
  });

  it('空组与原地挪都不改数据', () => {
    useCart.getState().add(dishA, 1);
    const before = useCart.getState().lines;
    useCart.getState().moveGroup(
      { mealDate: shiftDay(todayISO(), 2), mealType: 'breakfast' },
      { mealDate: todayISO(), mealType: 'dinner' },
    );
    useCart.getState().moveGroup(
      { mealDate: todayISO(), mealType: 'dinner' },
      { mealDate: todayISO(), mealType: 'dinner' },
    );
    assert.deepEqual(useCart.getState().lines, before);
  });
});

describe('cart：分组排序与整车设置', () => {
  it('cartGroups 按日期升序，同日内按早餐 → 午餐 → 晚餐', () => {
    const lines = [
      lineOf(todayISO(), 'dinner', 1),
      lineOf(todayISO(), 'breakfast', 2),
      lineOf(shiftDay(todayISO(), 1), 'lunch', 3),
      lineOf(todayISO(), 'lunch', 4),
    ];
    const groups = cartGroups(lines);
    assert.deepEqual(
      groups.map((group) => `${group.mealDate}:${group.mealType}`),
      [
        `${todayISO()}:breakfast`,
        `${todayISO()}:lunch`,
        `${todayISO()}:dinner`,
        `${shiftDay(todayISO(), 1)}:lunch`,
      ],
    );
    assert.equal(groups[0].lines[0].dishId, 2);
  });

  it('人数夹在 1~20；clear 清空菜与备注但保留目标与餐次', () => {
    useCart.getState().setTargetDate(shiftDay(todayISO(), 1));
    useCart.getState().setMealType('lunch');
    useCart.getState().add(dishA, 1);
    useCart.getState().setOrderNote('周五聚餐');
    useCart.getState().setHeadcount(0);
    assert.equal(useCart.getState().headcount, 1);
    useCart.getState().setHeadcount(50);
    assert.equal(useCart.getState().headcount, 20);

    useCart.getState().clear();
    const state = useCart.getState();
    assert.deepEqual(state.lines, []);
    assert.equal(state.orderNote, '');
    assert.equal(state.mealType, 'lunch');
    assert.equal(state.targetDate, shiftDay(todayISO(), 1));
  });
});

describe('cart：提交 token 随车持久化', () => {
  it('set / release / 删组时剪枝；clear 全清', () => {
    useCart.getState().add(dishA, 1);
    const key = `${todayISO()}|dinner`;
    useCart.getState().setSubmitToken(key, 't1', 'fp1');
    assert.deepEqual(useCart.getState().submitTokens, { [key]: { token: 't1', fingerprint: 'fp1' } });

    // 组还在：保留
    useCart.getState().pruneSubmitTokens();
    assert.equal(useCart.getState().submitTokens[key].token, 't1');

    // 删掉组内最后一行：token 不应继续留着
    useCart.getState().remove({ mealDate: todayISO(), mealType: 'dinner', dishId: dishA.id });
    assert.deepEqual(useCart.getState().submitTokens, {});

    useCart.getState().add(dishA, 1);
    useCart.getState().setSubmitToken(key, 't2', 'fp2');
    useCart.getState().releaseSubmitToken(key);
    assert.deepEqual(useCart.getState().submitTokens, {});

    useCart.getState().setSubmitToken(key, 't3', 'fp3');
    useCart.getState().clear();
    assert.deepEqual(useCart.getState().submitTokens, {});
  });

  it('整组挪动会换键：旧 token 被剪掉，避免拿旧单的 token 提交新组', () => {
    useCart.getState().add(dishA, 1, { mealType: 'dinner' });
    useCart.getState().setSubmitToken(`${todayISO()}|dinner`, 't1', 'fp1');
    useCart.getState().moveGroup(
      { mealDate: todayISO(), mealType: 'dinner' },
      { mealDate: todayISO(), mealType: 'lunch' },
    );
    assert.deepEqual(useCart.getState().submitTokens, {});
  });
});

describe('cart：提交内容指纹', () => {
  const group = {
    mealDate: todayISO(),
    mealType: 'dinner' as const,
    lines: [lineOf(todayISO(), 'dinner', 1)],
  };

  it('内容一致才复用 token；改份数 / 人数 / 备注都会让指纹变化', () => {
    const fp = groupFingerprint(group, 1, 3, '');
    assert.equal(reusableSubmitToken({ token: 't1', fingerprint: fp }, fp), 't1');
    assert.equal(reusableSubmitToken({ token: 't1', fingerprint: fp }, `${fp}-changed`), undefined);

    assert.notEqual(groupFingerprint({ ...group, lines: [{ ...group.lines[0], servings: 2 }] }, 1, 3, ''), fp);
    assert.notEqual(groupFingerprint(group, 1, 4, ''), fp);
    assert.notEqual(groupFingerprint(group, 1, 3, '少盐'), fp);
  });

  it('行顺序不影响指纹；菜或备注变化会变化', () => {
    const two = {
      ...group,
      lines: [lineOf(todayISO(), 'dinner', 1), lineOf(todayISO(), 'dinner', 2)],
    };
    const reversed = { ...two, lines: [...two.lines].reverse() };
    assert.equal(groupFingerprint(two, 1, 3, ''), groupFingerprint(reversed, 1, 3, ''));

    const noted = { ...two, lines: two.lines.map((line) => ({ ...line, note: '少辣' })) };
    assert.notEqual(groupFingerprint(two, 1, 3, ''), groupFingerprint(noted, 1, 3, ''));
  });
});

describe('cart：老数据迁移', () => {
  it('v0（整车共用一个日期）的行补上今天；v1（整车共用一个餐次）补上当时的餐次', () => {
    const migrated = migrateCart(
      {
        lines: [{ dishId: 1, name: '旧菜', emoji: '🍳', category: '荤菜', servings: 2, note: '' }],
        mealType: 'lunch',
        headcount: 4,
        orderNote: '老备注',
      },
      0,
    );
    assert.equal(migrated.lines[0].mealDate, todayISO());
    assert.equal(migrated.lines[0].mealType, 'lunch');
    assert.equal(migrated.targetDate, todayISO());
    assert.equal(migrated.headcount, 4);
    assert.equal(migrated.orderNote, '老备注');
  });

  it('v1 升 v2：只有日期没有餐次的行补上整车餐次；整体缺字段兜底', () => {
    const v1Line = { ...lineOf(todayISO(), 'dinner', 1), mealType: undefined as unknown as CartLine['mealType'] };
    const migrated = migrateCart({ lines: [v1Line], mealType: 'lunch' }, 1);
    assert.equal(migrated.lines[0].mealDate, todayISO());
    assert.equal(migrated.lines[0].mealType, 'lunch');

    const empty = migrateCart(undefined, 0);
    assert.deepEqual(empty.lines, []);
    assert.equal(empty.mealType, 'dinner');
    assert.equal(empty.headcount, 3);
    assert.equal(empty.targetDate, todayISO());
  });

  it('v2/v3 老 token 没有指纹，升级 v4 时丢弃；v4 的 token 只保留仍在车里的组', () => {
    const line = lineOf(todayISO(), 'dinner', 1);
    const upgraded = migrateCart({ lines: [line], submitTokens: { stale: 't-old' } }, 3);
    assert.deepEqual(upgraded.submitTokens, {});

    const key = `${todayISO()}|dinner`;
    const kept = migrateCart(
      {
        lines: [line],
        submitTokens: {
          [key]: { token: 't-keep', fingerprint: 'fp-keep' },
          [`${shiftDay(todayISO(), 1)}|lunch`]: { token: 't-drop', fingerprint: 'fp-drop' },
        },
      },
      4,
    );
    assert.deepEqual(kept.submitTokens, { [key]: { token: 't-keep', fingerprint: 'fp-keep' } });
  });
});
