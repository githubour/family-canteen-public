/**
 * 新菜建议接口（routes/dishRequests）：
 * 提交 / 重复与撞菜单的拦截 / 清空与单条删除 / 提交人被移除后的兜底展示。
 * 与菜品反馈共用 lib/memberRef 的成员装配约定（'已移除的家人' / 🙂 / #FF6B35）。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { run, getDb } from '../src/db/index.js';
import { startTestServer, type TestServer } from './testServer.js';

interface RequestBody {
  id: number;
  name: string;
  note: string | null;
  member_id: number | null;
  member: { id: number; name: string; avatar: string; color: string } | null;
}

let server: TestServer | undefined;
let base = '';

before(async () => {
  server = await startTestServer();
  base = server.base;
  // 菜单里已有的菜：撞名的新菜建议要被拦下并引导去点菜
  run(`INSERT INTO dishes (id, name, emoji, category) VALUES (101, '糖醋里脊', '🍖', '荤菜')`);
  run(`INSERT INTO members (id, name, avatar, color) VALUES (101, '测试家人', '🙂', '#123456')`);
  run(`INSERT INTO members (id, name, avatar, color) VALUES (102, '要走的人', '👋', '#654321')`);
});

after(() => {
  server?.close();
  server = undefined;
});

const post = (body: unknown) =>
  fetch(`${base}/api/dish-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const list = async () =>
  ((await (await fetch(`${base}/api/dish-requests`)).json()) as { requests: RequestBody[] }).requests;

describe('新菜建议接口', () => {
  it('空清单起步；提交后带出提交人与备注（菜名去空白）', async () => {
    assert.deepEqual(await list(), []);

    const res = await post({ name: '  孜然牛肉  ', note: ' 要辣一点 ', memberId: 101 });
    assert.equal(res.status, 201);
    const { request } = (await res.json()) as { request: RequestBody };
    assert.equal(request.name, '孜然牛肉');
    assert.equal(request.note, '要辣一点');
    assert.deepEqual(request.member, { id: 101, name: '测试家人', avatar: '🙂', color: '#123456' });

    const rows = await list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '孜然牛肉');
  });

  it('重复提交与菜单里已有的菜都 409，分别给不同错误码', async () => {
    const duplicated = await post({ name: '孜然牛肉' });
    assert.equal(duplicated.status, 409);
    assert.equal(((await duplicated.json()) as { error: { code: string } }).error.code, 'REQUEST_EXISTS');

    const existing = await post({ name: '糖醋里脊' });
    assert.equal(existing.status, 409);
    assert.equal(((await existing.json()) as { error: { code: string } }).error.code, 'DISH_EXISTS');
  });

  it('空名 400；不带 memberId 视为匿名', async () => {
    assert.equal((await post({ name: '   ' })).status, 400);

    const res = await post({ name: '可乐鸡翅' });
    assert.equal(res.status, 201);
    const { request } = (await res.json()) as { request: RequestBody };
    assert.equal(request.member_id, null);
    assert.equal(request.member, null);
  });

  it('提交人被 API 移除后：建议仍在，但归到匿名', async () => {
    // member_id 是 ON DELETE SET NULL：正常删成员会级联置空，行本身留下
    const created = (await (await post({ name: '鱼香茄子', memberId: 102 })).json()) as { request: RequestBody };
    const removed = await fetch(`${base}/api/members/102`, { method: 'DELETE' });
    assert.equal(removed.status, 200);

    const kept = (await list()).find((item) => item.id === created.request.id);
    assert.ok(kept, '成员被删后建议本身必须还在');
    assert.equal(kept.member_id, null);
    assert.equal(kept.member, null);
  });

  it('手工改库留下悬挂 member_id 时：显示「已移除的家人」兜底', async () => {
    // README 支持用 sqlite3 直连改库，而 CLI 默认不开外键——删成员不会级联置空，
    // 会留下指向已不存在成员的 member_id，兜底文案就是为这种行准备的
    const created = (await (await post({ name: '凉拌木耳', memberId: 101 })).json()) as { request: RequestBody };
    const db = getDb();
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      run('DELETE FROM members WHERE id = ?', 101);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    const orphan = (await list()).find((item) => item.id === created.request.id);
    assert.ok(orphan);
    assert.equal(orphan.member_id, 101);
    assert.deepEqual(orphan.member, { id: 101, name: '已移除的家人', avatar: '🙂', color: '#FF6B35' });
  });

  it('单条删除；清空返回删除条数', async () => {
    const rows = await list();
    const target = rows.find((item) => item.name === '可乐鸡翅');
    assert.ok(target);

    const removed = await fetch(`${base}/api/dish-requests/${target.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal((await list()).some((item) => item.id === target.id), false);
    // 已经删掉的不存在了
    assert.equal((await fetch(`${base}/api/dish-requests/${target.id}`, { method: 'DELETE' })).status, 404);

    const remaining = await list();
    const cleared = await fetch(`${base}/api/dish-requests`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { ok: true, removed: remaining.length });
    assert.deepEqual(await list(), []);
  });
});
