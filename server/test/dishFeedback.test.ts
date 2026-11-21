/**
 * 菜品反馈接口（routes/dishFeedback）：
 * 记名 / 匿名提交、内容清洗、提交人被移除后的兜底展示、删除与 404。
 * 提交人的装配走 lib/memberRef 的 LEFT JOIN + 兜底（'已移除的家人' / 🙂 / #FF6B35），
 * 这里的用例把这个约定钉住——改兜底值就必须同步改测试与前端预期。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { run, getDb } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

interface FeedbackBody {
  id: number;
  dish_id: number;
  content: string;
  member_id: number | null;
  member: { id: number; name: string; avatar: string; color: string } | null;
}

let server: TestServer | undefined;
let base = '';

before(async () => {
  server = await startTestServer();
  base = server.base;
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (101, '反馈测试菜', '🍳', '荤菜')`);
  run(`INSERT INTO members (id, name, avatar, color) VALUES (101, '测试家人', '🙂', '#123456')`);
  run(`INSERT INTO members (id, name, avatar, color) VALUES (102, '要走的人', '👋', '#654321')`);
});

after(() => {
  server?.close();
  server = undefined;
});

const post = (body: unknown) =>
  fetch(`${base}/api/dish-feedback/101`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('菜品反馈接口', () => {
  it('新菜没有反馈时返回空列表', async () => {
    const res = await fetch(`${base}/api/dish-feedback/101`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { feedbacks: unknown[] }).feedbacks, []);
  });

  it('记名提交：内容去掉首尾空白，成员信息原样带出', async () => {
    const res = await post({ content: '  有点咸，下次少放盐  ', memberId: 101 });
    assert.equal(res.status, 201);
    const { feedback } = (await res.json()) as { feedback: FeedbackBody };
    assert.equal(feedback.content, '有点咸，下次少放盐');
    assert.equal(feedback.member_id, 101);
    assert.deepEqual(feedback.member, { id: 101, name: '测试家人', avatar: '🙂', color: '#123456' });
  });

  it('匿名提交：member 为 null', async () => {
    const res = await post({ content: '随手记一条' });
    assert.equal(res.status, 201);
    const { feedback } = (await res.json()) as { feedback: FeedbackBody };
    assert.equal(feedback.member_id, null);
    assert.equal(feedback.member, null);
  });

  it('提交人不存在时当匿名处理，不会挂到幽灵成员上', async () => {
    const res = await post({ content: '来自不存在的成员', memberId: 9999 });
    assert.equal(res.status, 201);
    const { feedback } = (await res.json()) as { feedback: FeedbackBody };
    assert.equal(feedback.member_id, null);
    assert.equal(feedback.member, null);
  });

  it('空内容 400；不存在的菜 404', async () => {
    assert.equal((await post({ content: '   ' })).status, 400);
    const missing = await fetch(`${base}/api/dish-feedback/999`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '菜不存在' }),
    });
    assert.equal(missing.status, 404);
  });

  it('提交人被 API 移除后：反馈仍在，但归到匿名', async () => {
    // member_id 是 ON DELETE SET NULL：正常删成员会级联置空，行本身留下
    const created = (await (await post({ content: '这位家人马上要走了', memberId: 102 })).json()) as {
      feedback: FeedbackBody;
    };
    // 102 号没有历史订单，删得掉（有订单的成员服务端会拒绝）
    const removed = await fetch(`${base}/api/members/102`, { method: 'DELETE' });
    assert.equal(removed.status, 200);

    const res = await fetch(`${base}/api/dish-feedback/101`);
    const { feedbacks } = (await res.json()) as { feedbacks: FeedbackBody[] };
    const kept = feedbacks.find((item) => item.id === created.feedback.id);
    assert.ok(kept, '成员被删后反馈本身必须还在');
    assert.equal(kept.member_id, null);
    assert.equal(kept.member, null);
  });

  it('手工改库留下悬挂 member_id 时：显示「已移除的家人」兜底', async () => {
    // README 支持用 sqlite3 直连改库，而 CLI 默认不开外键——删成员不会级联置空，
    // 会留下指向已不存在成员的 member_id，兜底文案就是为这种行准备的
    const created = (await (await post({ content: '改库后成了孤儿引用', memberId: 101 })).json()) as {
      feedback: FeedbackBody;
    };
    const db = getDb();
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      run('DELETE FROM members WHERE id = ?', 101);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    const { feedbacks } = (await (await fetch(`${base}/api/dish-feedback/101`)).json()) as {
      feedbacks: FeedbackBody[];
    };
    const orphan = feedbacks.find((item) => item.id === created.feedback.id);
    assert.ok(orphan);
    assert.equal(orphan.member_id, 101);
    assert.deepEqual(orphan.member, { id: 101, name: '已移除的家人', avatar: '🙂', color: '#FF6B35' });
  });

  it('列表按时间正序（同一秒内按 id 兜底）', async () => {
    const res = await fetch(`${base}/api/dish-feedback/101`);
    const { feedbacks } = (await res.json()) as { feedbacks: FeedbackBody[] };
    const ids = feedbacks.map((item) => item.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.ok(ids.length >= 4);
  });

  it('删除：删掉后列表少一条，重复删 / 删别的菜下的反馈都 404', async () => {
    const before = ((await (await fetch(`${base}/api/dish-feedback/101`)).json()) as {
      feedbacks: FeedbackBody[];
    }).feedbacks;
    const target = before[0];

    const removed = await fetch(`${base}/api/dish-feedback/101/${target.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });

    const after = ((await (await fetch(`${base}/api/dish-feedback/101`)).json()) as {
      feedbacks: FeedbackBody[];
    }).feedbacks;
    assert.equal(after.length, before.length - 1);
    assert.equal(after.some((item) => item.id === target.id), false);

    const again = await fetch(`${base}/api/dish-feedback/101/${target.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
    // dish_id 不匹配同样 404：不能借别的菜的路由删掉这条
    const wrongDish = await fetch(`${base}/api/dish-feedback/999/${before[1].id}`, { method: 'DELETE' });
    assert.equal(wrongDish.status, 404);
  });
});
