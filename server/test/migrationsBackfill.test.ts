/**
 * 迁移回填的老库升级回归（审核行动项 #23）：
 * v10 步骤 / v13 emoji / v16 餐别 / v21 必有可选这四条数据回填迁移已改为参数化语句，
 * 这里模拟「老版本库 + 旧数据」直接跑 runMigrations，验证参数化后的回填行为分毫不差。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { SEED_DISHES } from '../src/db/seed/dishes.js';

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** 把 maxVersion 之前的迁移全部应用到给定的库（含参数化语句） */
function applyUpTo(db: DatabaseSync, maxVersion: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
     );`);
  for (const migration of MIGRATIONS) {
    if (migration.version > maxVersion) continue;
    if (migration.sql.trim().length > 0) db.exec(migration.sql);
    if (migration.statements) {
      for (const statement of migration.statements) {
        db.prepare(statement.sql).run(...(statement.params ?? []));
      }
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
  }
}

describe('迁移回填（老库升级）', () => {
  it('v9 老库升级：steps / emoji / meal_types 三条回填全部命中空值行', () => {
    const dish = SEED_DISHES.find(
      (item) => item.steps.length > 0 && item.mealTypes.length > 0,
    );
    assert.ok(dish, '种子数据里应有带做法与餐别的菜');

    const dir = mkdtempSync(join(tmpdir(), 'migrate-v9-'));
    const db = new DatabaseSync(join(dir, 'old.db'));
    applyUpTo(db, 9);
    // 模拟老数据：emoji 错、做法空（v9 还没有 steps/meal_types 列，随迁移补列后默认空）
    db.prepare('INSERT INTO dishes (name, emoji) VALUES (?, ?)').run(dish.name, '🍜');

    runMigrations(db);

    const row = db
      .prepare('SELECT steps, emoji, meal_types FROM dishes WHERE name = ?')
      .get(dish.name) as { steps: string; emoji: string; meal_types: string };
    assert.equal(row.steps, dish.steps.join('\n'), '做法应按种子值回填');
    assert.equal(row.emoji, dish.emoji, 'emoji 应校准为种子值');
    assert.equal(row.meal_types, JSON.stringify(dish.mealTypes), '餐别应回填种子值');
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    assert.equal(version.v, LATEST_VERSION, '应升级到最新版本');
    db.close();
  });

  it('v20 老库升级：optionals 命中的配料回填为可选（required=0），其余保持必有', () => {
    const dish = SEED_DISHES.find((item) => (item.optionals?.length ?? 0) > 0);
    assert.ok(dish, '种子数据里应有标了可选配料的菜');
    const optionals = dish.optionals ?? [];
    const requiredName = dish.ingredients.map(([name]) => name).find((name) => !optionals.includes(name));
    assert.ok(requiredName, '该菜应至少有一种必有配料');

    const dir = mkdtempSync(join(tmpdir(), 'migrate-v20-'));
    const db = new DatabaseSync(join(dir, 'old.db'));
    applyUpTo(db, 20);
    for (const name of [...optionals, requiredName]) {
      db.prepare("INSERT INTO ingredients (name) VALUES (?)").run(name);
    }
    const dishId = (
      db.prepare('INSERT INTO dishes (name) VALUES (?)').run(dish.name) as { lastInsertRowid: number }
    ).lastInsertRowid;
    const link = db.prepare(
      'INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (?, (SELECT id FROM ingredients WHERE name = ?), 100)',
    );
    for (const name of [...optionals, requiredName]) link.run(dishId, name);

    runMigrations(db);

    const rows = db
      .prepare(
        `SELECT i.name AS name, di.required AS required
           FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
          WHERE di.dish_id = ?`,
      )
      .all(dishId) as Array<{ name: string; required: number }>;
    const byName = new Map(rows.map((row) => [row.name, row.required]));
    for (const name of optionals) {
      assert.equal(byName.get(name), 0, `可选配料「${name}」应回填 required=0`);
    }
    assert.equal(byName.get(requiredName), 1, '必有配料不应被改动');
    db.close();
  });

  it('v26 老库升级：吐司并进面包，菜谱用量相加、库存与采购痕迹跟随', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-v26-'));
    const db = new DatabaseSync(join(dir, 'old.db'));
    applyUpTo(db, 25);

    db.prepare("INSERT INTO ingredients (name, category) VALUES ('面包', '粮油')").run();
    db.prepare("INSERT INTO ingredients (name, category) VALUES ('吐司', '其他')").run();
    const idOf = (name: string) =>
      (db.prepare('SELECT id FROM ingredients WHERE name = ?').get(name) as { id: number }).id;
    const breadId = idOf('面包');
    const toastId = idOf('吐司');

    // 菜 A 同时写了两种名字（合并后用量相加）；菜 B 只写了吐司（引用整体改名）
    const insertDish = db.prepare('INSERT INTO dishes (name) VALUES (?)');
    const dishA = (insertDish.run('合并测试菜A') as { lastInsertRowid: number }).lastInsertRowid;
    const dishB = (insertDish.run('合并测试菜B') as { lastInsertRowid: number }).lastInsertRowid;
    const link = db.prepare('INSERT INTO dish_ingredients (dish_id, ingredient_id, amount) VALUES (?, ?, ?)');
    link.run(dishA, breadId, 100);
    link.run(dishA, toastId, 50);
    link.run(dishB, toastId, 30);

    // 库存只登记在吐司上 → 合并后应落到面包
    db.prepare('INSERT INTO fridge_stock (ingredient_id) VALUES (?)').run(toastId);

    // 采购痕迹：同一餐两边都有（保留面包那条），另一餐只有吐司（整条挪过去）
    const state = db.prepare(
      'INSERT INTO purchase_state (meal_date, meal_type, ingredient_id, checked, note, hidden) VALUES (?, ?, ?, ?, ?, ?)',
    );
    state.run('2026-01-01', 'breakfast', breadId, 1, '原有', 0);
    state.run('2026-01-01', 'breakfast', toastId, 0, '吐司', 1);
    state.run('2026-01-02', 'dinner', toastId, 1, '只有吐司', 1);

    runMigrations(db);

    const links = db
      .prepare(
        `SELECT di.dish_id AS dish_id, di.ingredient_id AS ingredient_id, di.amount AS amount
           FROM dish_ingredients di WHERE di.dish_id IN (?, ?) ORDER BY di.dish_id`,
      )
      .all(dishA, dishB) as Array<{ dish_id: number; ingredient_id: number; amount: number }>;
    assert.equal(links.length, 2, '每道菜合并后应只剩一行面包');
    assert.deepEqual(
      links.map((row) => [row.dish_id, row.ingredient_id, row.amount]),
      [
        [dishA, breadId, 150],
        [dishB, breadId, 30],
      ],
      '菜 A 的用量应相加，菜 B 的引用应整体改名',
    );

    const stock = db.prepare('SELECT ingredient_id FROM fridge_stock ORDER BY ingredient_id').all() as Array<{
      ingredient_id: number;
    }>;
    assert.deepEqual(stock.map((row) => row.ingredient_id), [breadId], '库存应只留在面包上');

    const states = db
      .prepare(
        'SELECT meal_date, meal_type, ingredient_id, checked, note, hidden FROM purchase_state ORDER BY meal_date',
      )
      .all() as Array<{ meal_date: string; ingredient_id: number; checked: number; note: string; hidden: number }>;
    assert.deepEqual(
      states.map((row) => [row.meal_date, row.ingredient_id, row.checked, row.note, row.hidden]),
      [
        ['2026-01-01', breadId, 1, '原有', 0],
        ['2026-01-02', breadId, 1, '只有吐司', 1],
      ],
      '同餐已有面包记录时保留它，其余痕迹应挪到面包',
    );

    const names = db.prepare('SELECT name FROM ingredients ORDER BY name').all() as Array<{ name: string }>;
    assert.ok(names.some((row) => row.name === '面包'), '面包应保留');
    assert.ok(!names.some((row) => row.name === '吐司'), '吐司应删除');
    db.close();
  });
});
