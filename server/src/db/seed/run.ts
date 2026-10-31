/**
 * 种子导入脚本。
 * - 食材：仅在库中不存在时插入；已存在的食材一律不动（分类、单位、营养、价格可能已被用户改过）
 * - 菜品：仅在库中不存在时插入，避免覆盖用户后续的编辑
 * - 成员与设置：仅在完全为空时写入默认值
 *
 * 用法：npm run seed            （只补缺失数据，不覆盖已有数据）
 *      npm run seed:force        （强制重建菜品与配料表）
 *      npm run seed:demo         （生成最近 12 天演示订单，仅本地开发用；
 *                                 库里已有订单时会自动跳过，避免污染真实数据）
 */
import '../../env.js';
import { getDb, all, get, run, transaction } from '../index.js';
import { SEED_INGREDIENTS } from './ingredients.js';
import { SEED_DISHES } from './dishes.js';
import { buildOrderSnapshots } from '../../services/dishService.js';
import { createLogger } from '../../lib/logger.js';
import { round } from '../../lib/units.js';

const log = createLogger('seed');

const force = process.argv.includes('--force');

const DEFAULT_SETTINGS: Record<string, string> = {
  'cutoff.breakfast': '08:00',
  'cutoff.lunch': '10:30',
  'cutoff.dinner': '16:30',
  'default.headcount': '3',
  'notify.enabled': 'false',
  'notify.barkKey': '',
  'notify.serverchanKey': '',
  // 「默认在外吃」的星期集合（0=周日 … 6=周六）：工作日午餐通常在公司吃
  'away.breakfast': '',
  'away.lunch': '1,2,3,4,5',
  'away.dinner': '',
};

// 默认两位使用者，名字是**占位**：装好后在「家人」页签里改成自己的。
// 只在空库时写入（见 seedMembers），所以改这里不影响任何已建库的环境。
const DEFAULT_MEMBERS = [
  { name: '成员一', avatar: '👨‍🍳', color: '#FF6B35', role: 'admin', order: 1 },
  { name: '成员二', avatar: '👩‍🍳', color: '#F472B6', role: 'diner', order: 0 },
];

interface IdRow {
  id: number;
}

function seedSettings(): number {
  let created = 0;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = get<{ key: string }>('SELECT key FROM settings WHERE key = ?', key);
    if (!existing) {
      run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
      created += 1;
    }
  }
  return created;
}

function seedMembers(): number {
  const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM members');
  if (Number(count?.c ?? 0) > 0) return 0;
  for (const member of DEFAULT_MEMBERS) {
    run(
      `INSERT INTO members (name, avatar, color, role, dislikes, sort_order)
       VALUES (?, ?, ?, ?, '[]', ?)`,
      member.name,
      member.avatar,
      member.color,
      member.role,
      member.order,
    );
  }
  return DEFAULT_MEMBERS.length;
}

function seedIngredients(): number {
  let count = 0;
  for (const item of SEED_INGREDIENTS) {
    // 已存在的食材可能是用户手动改过分类/单位/营养/价格的，种子里没有可靠的
    // 「用户改动」标记，因此一律不覆盖；补数据只对新食材生效。
    const existing = get<IdRow>('SELECT id FROM ingredients WHERE name = ?', item.name);
    if (existing) continue;
    run(
      `INSERT INTO ingredients (name, category, buy_unit, buy_factor, is_pantry,
         kcal, protein, fat, carb, sodium, fiber, price_per_100g, nutrition_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')`,
      item.name,
      item.category,
      item.buyUnit ?? 'g',
      item.buyFactor ?? 1,
      item.pantry ? 1 : 0,
      item.kcal,
      item.protein,
      item.fat,
      item.carb,
      item.sodium,
      item.fiber,
      item.price ?? null,
    );
    count += 1;
  }
  return count;
}

function seedDishes(): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;
  const missing: string[] = [];

  for (const dish of SEED_DISHES) {
    const existing = get<IdRow>('SELECT id FROM dishes WHERE name = ?', dish.name);
    if (existing && !force) {
      skipped += 1;
      continue;
    }

    const dishId =
      existing?.id ??
      run(
        `INSERT INTO dishes (name, category, spicy, tags, cook_minutes, difficulty, base_servings, emoji, description, is_fried, steps, meal_types)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        dish.name,
        dish.category,
        dish.spicy,
        JSON.stringify(dish.tags),
        dish.minutes,
        dish.difficulty,
        dish.baseServings,
        dish.emoji,
        dish.description,
        dish.fried ? 1 : 0,
        // 一行一步，按换行拼成一段文本，迁移 v10 对已存在的库做同样的回填
        dish.steps.join('\n'),
        // 餐别标签（可多选），迁移 v16 对已存在的库按菜名回填
        JSON.stringify(dish.mealTypes),
      ).lastInsertRowid;

    run('DELETE FROM dish_ingredients WHERE dish_id = ?', dishId);

    // 可选食材在种子声明里用 optionals 列出（缺了照样能做），没列出来的一律按必有落库
    const optionalNames = new Set(dish.optionals ?? []);
    for (const [name, amount] of dish.ingredients) {
      const ingredient = get<IdRow>('SELECT id FROM ingredients WHERE name = ?', name);
      if (!ingredient) {
        missing.push(`${dish.name} → ${name}`);
        continue;
      }
      run(
        'INSERT INTO dish_ingredients (dish_id, ingredient_id, amount, unit, note, required) VALUES (?, ?, ?, ?, NULL, ?)',
        dishId,
        ingredient.id,
        amount,
        'g',
        optionalNames.has(name) ? 0 : 1,
      );
    }

    if (existing) skipped += 1;
    else inserted += 1;
  }

  if (missing.length > 0) {
    log.warn(`以下配料在食材表中缺失，已跳过：\n  - ${missing.join('\n  - ')}`);
  }
  return { inserted, skipped };
}

export function seedIfEmpty(): void {
  getDb();
  const dishCount = get<{ c: number }>('SELECT COUNT(*) AS c FROM dishes');
  if (Number(dishCount?.c ?? 0) > 0) return;
  log.info('检测到空数据库，自动导入预置数据');
  seedAll();
}

export function seedAll(): void {
  getDb();
  transaction(() => {
    const settings = seedSettings();
    const members = seedMembers();
    const ingredients = seedIngredients();
    const dishes = seedDishes();
    log.info(
      `种子完成：新增成员 ${members}、食材 ${ingredients}、菜品 ${dishes.inserted}（跳过 ${dishes.skipped}）、设置 ${settings}`,
    );

    const stats = get<{ d: number; i: number; b: number }>(
      `SELECT (SELECT COUNT(*) FROM dishes) AS d,
              (SELECT COUNT(*) FROM ingredients) AS i,
              (SELECT COUNT(*) FROM dish_ingredients) AS b`,
    );
    log.info(`当前库内：菜品 ${stats?.d ?? 0} 道、食材 ${stats?.i ?? 0} 种、配料条目 ${stats?.b ?? 0} 条`);
  });
}

/** 生成最近 N 天的演示订单，用于验证汇总与营养趋势图表 */
function seedDemoOrders(days: number): number {
  getDb();

  // 护栏：演示数据只给本地开发用，重复执行会静默累积假订单。
  // 更不能误在生产库上跑——那会污染真实点单记录，所以只要有订单就整体跳过。
  const existing = get<{ c: number }>('SELECT COUNT(*) AS c FROM orders');
  const existingCount = Number(existing?.c ?? 0);
  if (existingCount > 0) {
    log.warn(`库里已有 ${existingCount} 条订单，跳过演示数据生成（避免污染真实记录）`);
    return 0;
  }

  const members = all<{ id: number }>('SELECT id FROM members ORDER BY sort_order');
  const dishes = all<{ id: number; category: string }>('SELECT id, category FROM dishes WHERE active = 1');
  if (members.length === 0 || dishes.length === 0) return 0;

  const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
  const today = new Date();
  let created = 0;

  transaction(() => {
    for (let offset = days; offset >= 1; offset -= 1) {
      const date = new Date(today.getTime() - offset * 86400_000);
      const mealDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      for (const mealType of ['lunch', 'dinner'] as const) {
        const orderCount = 1 + Math.floor(Math.random() * 2);
        for (let index = 0; index < orderCount; index += 1) {
          const member = pick(members);
          // 在售菜可能被删得只剩一两道：每单道数不能超过池子，否则下面的 while 永远凑不满
          const size = Math.min(2 + Math.floor(Math.random() * 3), dishes.length);
          const chosen = new Set<number>();
          const items: { dishId: number; servings: number }[] = [];
          while (chosen.size < size) {
            const dish = pick(dishes);
            if (chosen.has(dish.id)) continue;
            chosen.add(dish.id);
            items.push({ dishId: dish.id, servings: dish.category === '汤' ? 1 : 1 + Math.floor(Math.random() * 2) });
          }
          const orderId = run(
            `INSERT INTO orders (member_id, meal_date, meal_type, status, note, headcount, created_at, updated_at)
             VALUES (?, ?, ?, 'done', NULL, ?, datetime('now','localtime'), datetime('now','localtime'))`,
            member.id,
            mealDate,
            mealType,
            3 + Math.floor(Math.random() * 2),
          ).lastInsertRowid;
          // 演示订单要跟真实下单一样带上「下单快照」（菜名/营养/BOM）：v17 之后历史口径只认快照，
          // 直接插空快照的话采购来源、营养与统计都会是空的。
          // 这里不能走 createOrder()——它禁止给过去的日期补单，而演示数据正是过去 12 天。
          const snapshots = buildOrderSnapshots(items.map((item) => item.dishId));
          for (const item of items) {
            const snapshot = snapshots.get(item.dishId);
            run(
              `INSERT INTO order_items
                 (order_id, dish_id, servings, note, dish_name, dish_emoji, dish_category,
                  dish_spicy, dish_tags, kcal_per_serving, bom)
               VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
              orderId,
              item.dishId,
              item.servings,
              snapshot?.dish_name ?? '',
              snapshot?.dish_emoji ?? '',
              snapshot?.dish_category ?? '',
              snapshot?.dish_spicy ?? 0,
              snapshot?.dish_tags ?? '[]',
              snapshot?.kcal_per_serving ?? 0,
              snapshot?.bom ?? '[]',
            );
          }
          // 做菜记录也补一笔（口径同 orderService.syncCookLog：接单备料即记）——
          // 汇总页的做菜统计在演示数据下也看得到效果
          const totalServings = items.reduce((sum, item) => sum + item.servings, 0);
          const totalKcal = items.reduce(
            (sum, item) => sum + item.servings * (snapshots.get(item.dishId)?.kcal_per_serving ?? 0),
            0,
          );
          run(
            `INSERT INTO cook_logs (order_id, member_id, meal_date, meal_type, dishes, servings, kcal)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            orderId,
            member.id,
            mealDate,
            mealType,
            items.length,
            totalServings,
            round(totalKcal, 1),
          );
          created += 1;
        }
      }
    }
  });

  log.info(`已生成 ${created} 条演示订单（最近 ${days} 天）`);
  return created;
}

// 直接执行（npm run seed）或以 seed bundle 运行（NAS 容器里 node seed/seed.cjs）时才导入；
// server.cjs 的路径不含 'seed'，不会误触发
const invokedDirectly = process.argv[1]?.includes('seed');
if (invokedDirectly) {
  seedAll();
  if (process.argv.includes('--demo')) seedDemoOrders(Number(process.argv[process.argv.length - 1]) || 12);
  const sample = all<{ name: string }>('SELECT name FROM dishes ORDER BY id LIMIT 5');
  log.info(`示例菜品：${sample.map((row) => row.name).join('、')}`);
}
