/**
 * 顺序迁移脚本。
 * 不引入 ORM 与迁移框架：数据规模不支持，顺序执行的 SQL + schema_version 表足够。
 * 建表类迁移用 IF NOT EXISTS 保证可重入；数据修正 / ADD COLUMN 类没有幂等写法，
 * 单次执行由版本表 + 每条迁移自身的事务保证（跑过就不再跑，失败整体回滚）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../lib/logger.js';
// 只引种子数据模块（纯数据、无数据库依赖）：v10 一次性把预置做法回填进已存在的库。
import { SEED_DISHES } from './seed/dishes.js';

const log = createLogger('db:migrate');

interface Migration {
  version: number;
  name: string;
  /** 无参数的迁移（DDL / 静态 SQL）整段 exec。 */
  sql: string;
  /**
   * 带值的迁移改为参数化语句列表（prepare + run 绑定参数）。
   * 审核行动项 #23：此前用 sqlLiteral 手工转义拼接，种子数据虽是静态文本、
   * 没有注入面，但这种写法一旦被后来者复制到用户输入路径就是 SQL 注入——
   * 模板必须从源头消灭。
   */
  // 参数类型跟 node:sqlite 的绑定值保持一致（null/number/bigint/string/Uint8Array）
  statements?: Array<{ sql: string; params?: (null | number | bigint | string | Uint8Array)[] }>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init-core-tables',
    sql: `
      -- 家庭成员
      CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '🙂',
        color TEXT NOT NULL DEFAULT '#FF6B35',
        role TEXT NOT NULL DEFAULT 'diner',
        dislikes TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- 食材主数据：营养值均为「每 100g 可食部」
      CREATE TABLE IF NOT EXISTS ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT '其他',
        unit TEXT NOT NULL DEFAULT 'g',
        buy_unit TEXT NOT NULL DEFAULT 'g',
        buy_factor REAL NOT NULL DEFAULT 1,
        is_pantry INTEGER NOT NULL DEFAULT 0,
        kcal REAL NOT NULL DEFAULT 0,
        protein REAL NOT NULL DEFAULT 0,
        fat REAL NOT NULL DEFAULT 0,
        carb REAL NOT NULL DEFAULT 0,
        sodium REAL NOT NULL DEFAULT 0,
        fiber REAL NOT NULL DEFAULT 0,
        -- 参考单价，单位：元 / 100g，用于采购清单成本估算
        price_per_100g REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- 菜品主数据
      CREATE TABLE IF NOT EXISTS dishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT '荤菜',
        spicy INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        cook_minutes INTEGER NOT NULL DEFAULT 20,
        difficulty INTEGER NOT NULL DEFAULT 1,
        base_servings INTEGER NOT NULL DEFAULT 2,
        emoji TEXT NOT NULL DEFAULT '🍽️',
        description TEXT,
        is_fried INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      -- 菜品配料表（BOM）：amount 为「每人份」用量，单位为食材基准单位
      CREATE TABLE IF NOT EXISTS dish_ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
        ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
        amount REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT 'g',
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dish_ingredients_dish ON dish_ingredients(dish_id);
      CREATE INDEX IF NOT EXISTS idx_dish_ingredients_ingredient ON dish_ingredients(ingredient_id);

      -- 订单：一次提交 = 一条订单，归属某位成员与某个餐次
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        meal_date TEXT NOT NULL,
        meal_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        headcount INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_orders_meal ON orders(meal_date, meal_type);
      CREATE INDEX IF NOT EXISTS idx_orders_member ON orders(member_id);

      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        dish_id INTEGER NOT NULL REFERENCES dishes(id),
        servings INTEGER NOT NULL DEFAULT 1,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_items_dish ON order_items(dish_id);

      -- 采购勾选状态：清单本身每次实时聚合，只持久化人工痕迹，避免重新生成时丢失
      CREATE TABLE IF NOT EXISTS purchase_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_date TEXT NOT NULL,
        meal_type TEXT NOT NULL,
        ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
        checked INTEGER NOT NULL DEFAULT 0,
        override_amount REAL,
        note TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(meal_date, meal_type, ingredient_id)
      );

      -- 运行期配置
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  // 注意：这里没有 v2（版本号刻意留空缺）。原 v2 是一条「按成员姓名订正头像」的一次性
  // 数据修正——姓名属于家庭数据、不该写进代码，所以整条移除。迁移器按 MAX(version) 判断
  // 是否已应用（见 runMigrations），不要求版本号连续，缺号没有任何影响；
  // 已经跑过它的库不受影响，全新库少执行一条只对特定住家数据有意义的数据修正。
  {
    // 新菜建议：家人只提菜名（可选备注），先攒在这里，
    // 由开发者统一补上配料表与营养后再加入 dishes，所以这里不存任何菜品属性。
    version: 3,
    name: 'create-dish-requests',
    sql: `
      CREATE TABLE IF NOT EXISTS dish_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        note TEXT,
        -- 提交人可能被移除，这里置空即可，建议本身要保留下来
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_dish_requests_created ON dish_requests(created_at);
    `,
  },
  {
    // 做菜记录：大厨点「接单备料」时开一条（同时快照这份订单的份数与菜数），
    // 点「做好了」时结算 finished_at 与 minutes。
    // 单独建表而不是往 orders 上加字段，是为了支持「重新开做」——那种情况会再开一条记录，
    // 加字段的话第二次会覆盖掉第一次的耗时。
    version: 4,
    name: 'create-cook-logs',
    sql: `
      CREATE TABLE IF NOT EXISTS cook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        -- 做菜的人可能被移除，记录本身要留下（统计里归到「未记名」）
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        meal_date TEXT NOT NULL,
        meal_type TEXT NOT NULL,
        dishes INTEGER NOT NULL DEFAULT 0,
        servings INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        finished_at TEXT,
        minutes REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_cook_logs_member ON cook_logs(member_id);
      CREATE INDEX IF NOT EXISTS idx_cook_logs_date ON cook_logs(meal_date);
      CREATE INDEX IF NOT EXISTS idx_cook_logs_order ON cook_logs(order_id);
    `,
  },
  {
    // 用餐考勤：记「某天某餐是在家吃还是在外吃」。
    // 「在外吃」不是没吃，只是不知道吃了什么——与其编一个热量，不如把这类餐次
    // 从家里的人均统计里排除，并在界面上明确标出来。
    // 这里只存「和默认规则不一样」的那些天，日常靠设置里的星期规则自动推导。
    version: 5,
    name: 'create-meal-attendance',
    sql: `
      CREATE TABLE IF NOT EXISTS meal_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_date TEXT NOT NULL,
        meal_type TEXT NOT NULL,
        at_home INTEGER NOT NULL,
        note TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(meal_date, meal_type)
      );
      CREATE INDEX IF NOT EXISTS idx_meal_attendance_date ON meal_attendance(meal_date);
    `,
  },
  {
    // 做菜记录补充「这单菜的总卡路里」：接单备料时随菜数、份数一起快照进记录，
    // 之后改配料表不追溯改历史。老记录按迁移时刻的订单明细 × 配料表回填一次。
    // 注意 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS 写法——单次执行由 schema_version
    // 版本表 + 迁移事务保证，跑过就不会再跑。
    version: 6,
    name: 'add-cook-logs-kcal',
    sql: `
      ALTER TABLE cook_logs ADD COLUMN kcal REAL NOT NULL DEFAULT 0;
      UPDATE cook_logs SET kcal = COALESCE((
        SELECT SUM(oi.servings * per_dish.kcal_per_serving)
          FROM order_items oi
          JOIN (
            SELECT di.dish_id, SUM(di.amount * i.kcal) / 100.0 AS kcal_per_serving
              FROM dish_ingredients di
              JOIN ingredients i ON i.id = di.ingredient_id
             GROUP BY di.dish_id
          ) per_dish ON per_dish.dish_id = oi.dish_id
         WHERE oi.order_id = cook_logs.order_id
      ), 0);
    `,
  },
  {
    // 菜品显示安排（与「下架 active」互补的软性机制）：
    // - season_months 季节窗口：JSON 月份数组（如 [9,10,11] = 只在 9-11 月出现），
    //   空数组 = 全年显示。每年循环，不需要重复设置。
    // - hide_until 「歇菜」到哪个月（YYYY-MM）：吃腻了先藏一阵，到那个月自然回来。
    // 两者都只影响默认菜单（点菜页 / 随机 / 配一桌），includeInactive 的管理列表不受限；
    // 历史订单与营养汇总不受影响。
    version: 7,
    name: 'add-dish-visibility',
    sql: `
      ALTER TABLE dishes ADD COLUMN season_months TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE dishes ADD COLUMN hide_until TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // 大厨严选：大厨根据冰箱里的剩菜/时令圈几道菜推荐给点菜的人。
    // 一次提交 = 一条记录（整体替换旧的），到 until 当天仍有效、次日自动过期，
    // 所以表里不删旧记录也没关系——查询永远只取「最近一条未过期」的。
    version: 8,
    name: 'create-chef-picks',
    sql: `
      CREATE TABLE IF NOT EXISTS chef_picks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dish_ids TEXT NOT NULL DEFAULT '[]',
        note TEXT,
        until TEXT NOT NULL,
        -- 推荐人可能被移除，严选本身照常展示
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `,
  },
  {
    // 采购清单手动调整（与实时聚合互补的人工痕迹）：
    // - purchase_state.hidden 「这一餐不要」：清单每次由订单重新聚合，隐藏某个自动条目
    //   只能给这一餐打标记，所以放进 purchase_state（同一份人工痕迹，重置时一起清掉）。
    // - purchase_custom 手动添加的条目：不属于任何配料表（ingredient 无从谈起），
    //   用量直接存用户输入的文案，不做单位换算。
    // 两者都只影响当前 meal_date + meal_type 的清单，不动菜品配料表。
    version: 9,
    name: 'add-purchase-manual',
    sql: `
      ALTER TABLE purchase_state ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS purchase_custom (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_date TEXT NOT NULL,
        meal_type TEXT NOT NULL,
        name TEXT NOT NULL,
        amount_text TEXT NOT NULL DEFAULT '',
        checked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_purchase_custom_meal ON purchase_custom(meal_date, meal_type);
    `,
  },
  {
    // 菜品做法步骤：steps 存一段文本，一行一步（前端按行渲染成编号步骤）。
    // 建列之后用种子数据一次性回填：只命中 name 匹配且 steps 还是空的行，
    // 用户在后台改过 / 清空过的永远不会被覆盖；全新装的库由种子 INSERT 直接带 steps。
    // UPDATE 语句在模块加载时由 SEED_DISHES 生成，内容与 seed/dishes.ts 保持单一来源。
    version: 10,
    name: 'add-dish-steps',
    sql: `
      ALTER TABLE dishes ADD COLUMN steps TEXT NOT NULL DEFAULT '';
    `,
    statements: SEED_DISHES.filter((dish) => dish.steps.length > 0).map((dish) => ({
      sql: "UPDATE dishes SET steps = ? WHERE name = ? AND steps = ''",
      params: [dish.steps.join('\n'), dish.name],
    })),
  },
  {
    // 菜品实拍图：image_url 存静态路径（/uploads/dishes/xxx.jpg），
    // 图片本体落磁盘（<db 目录>/uploads/dishes/）而不是数据库——
    // 二进制进 SQLite 会把库和自动备份撑大几倍，文件系统才是放图的地方。
    // 没传图的菜继续用 emoji，字段为空串即「无图」。
    version: 11,
    name: 'add-dish-photo',
    sql: `
      ALTER TABLE dishes ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // 冰箱清空计划（取代 v8 的大厨严选）：不再让大厨「圈菜」，而是登记冰箱里现成的食材，
    // 点菜页据此把带库存的菜排到前面——全部用库存就能做的菜标「无需买菜」，优先消耗库存。
    // 主键即食材 id：库存本质是个集合，重复登记没有意义，INSERT OR IGNORE 天然幂等。
    // 旧的大厨严选是一次性推荐位（到 until 自动过期、随时可撤销），换功能后没有迁移价值，弃表。
    version: 12,
    name: 'fridge-stock',
    sql: `
      DROP TABLE IF EXISTS chef_picks;
      CREATE TABLE IF NOT EXISTS fridge_stock (
        ingredient_id INTEGER PRIMARY KEY REFERENCES ingredients(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `,
  },
  {
    // 预置菜 emoji 校准：早期挑的部分 emoji 与菜不贴（番茄豆腐汤用了面条 🍜、糖醋里脊用了锅 🥘 等）。
    // emoji 没有任何编辑入口（接口只改做法 / 图片 / 显示安排），按菜名统一对齐种子值不会覆盖用户改动；
    // UPDATE 由 SEED_DISHES 生成，与 seed/dishes.ts 保持单一来源，老库新库收敛到同一份。
    version: 13,
    name: 'fix-dish-emoji',
    sql: '',
    statements: SEED_DISHES.map((dish) => ({
      sql: 'UPDATE dishes SET emoji = ? WHERE name = ?',
      params: [dish.emoji, dish.name],
    })),
  },
  {
    // 菜品反馈：大厨/家人就「这一道菜」随手记的自然语言反馈（偏咸、土豆没炖烂、火候不对…），
    // 攒在库里等大模型统一读取并据此修正配方与做法，修正完再由大模型删掉对应条目。
    // 反馈挂在菜品主数据上（dish_id），与具体哪一顿无关——同一道菜跨多餐累计，
    // 这样大模型能看到长期问题，而不是某一次的偶发情况。
    version: 14,
    name: 'create-dish-feedback',
    sql: `
      CREATE TABLE IF NOT EXISTS dish_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
        -- 自然语言反馈正文，长度宽松（不像新菜建议那样只有菜名）
        content TEXT NOT NULL,
        -- 反馈人可能被移除，反馈本身要留下（归到「匿名」）
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_dish_feedback_dish ON dish_feedback(dish_id);
    `,
  },
  {
    // 餐别标签：一道菜适合早餐 / 午餐 / 晚餐中的哪几餐（JSON 字符串数组，如 ["breakfast","lunch"]），
    // 空数组 = 通用菜（不区分餐别，默认菜单照常全量显示）。
    // 只影响展示层排序：点菜页按当前餐别把本餐的菜排前面、其余垫底；
    // 「帮我配一桌 / 随机」优先从本餐别的菜里挑，挑不满再落回全菜单。
    // 历史订单、营养汇总、采购清单完全不受影响。
    version: 15,
    name: 'add-dish-meal-types',
    sql: `
      ALTER TABLE dishes ADD COLUMN meal_types TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    // 餐别标签回填：按家常饮食习惯给预置菜标上适用餐别（可多选）——热炒与汤菜归午晚、
    // 面条三餐皆宜、包子归早午、甜品点心归午晚。
    // 标签在后台「设置 → 菜品」随时可改，所以只回填仍是空的行（meal_types = '[]'），
    // 家人手动标过的永不覆盖；全新装的库由种子 INSERT 直接带标签。
    // UPDATE 由 SEED_DISHES 生成，与 seed/dishes.ts 保持单一来源。
    version: 16,
    name: 'backfill-dish-meal-types',
    sql: '',
    statements: SEED_DISHES.filter((dish) => dish.mealTypes.length > 0).map((dish) => ({
      sql: "UPDATE dishes SET meal_types = ? WHERE name = ? AND meal_types = '[]'",
      params: [JSON.stringify(dish.mealTypes), dish.name],
    })),
  },
  {
    // 订单行升级为「下单那一刻的快照」。
    //
    // 改造前 order_items 只存 dish_id，订单详情、营养报告、统计排行全靠运行时 JOIN dishes /
    // dish_ingredients 现算，于是菜品变成历史数据的依赖（不能删），改配方还会改写历史营养。
    // 现在把菜品属性 + BOM（含食材名与当时的每 100g 营养）冻结在订单行上：
    // - 历史口径（订单详情 / 营养 / 排行 / 画像）只认快照，不再看菜品表的现状；
    // - 采购清单这种「今天要买菜」的场景仍优先用最新配方，查不到配方（菜被删/没配料）时回退快照；
    // - dish_id 保留引用但改成 ON DELETE SET NULL，菜品可以真正被删掉而不破坏历史。
    // 顺带补上 UNIQUE(order_id, dish_id)：同一订单同一道菜只留一行（老数据里若有重复行则合并份数）。
    version: 17,
    name: 'order-items-snapshot',
    sql: `
      CREATE TABLE order_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        -- 菜品被彻底删除后置空；历史展示与统计改用下面的快照列
        dish_id INTEGER REFERENCES dishes(id) ON DELETE SET NULL,
        servings INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        dish_name TEXT NOT NULL DEFAULT '',
        dish_emoji TEXT NOT NULL DEFAULT '',
        dish_category TEXT NOT NULL DEFAULT '',
        dish_spicy INTEGER NOT NULL DEFAULT 0,
        dish_tags TEXT NOT NULL DEFAULT '[]',
        kcal_per_serving REAL NOT NULL DEFAULT 0,
        -- 每人份配料快照：[{ingredient_id,name,category,amount,unit,is_pantry,kcal,protein,fat,carb,sodium,fiber}]
        bom TEXT NOT NULL DEFAULT '[]',
        UNIQUE(order_id, dish_id)
      );

      INSERT INTO order_items_new
        (id, order_id, dish_id, servings, note, dish_name, dish_emoji, dish_category,
         dish_spicy, dish_tags, kcal_per_serving, bom)
      SELECT MIN(oi.id), oi.order_id, oi.dish_id, SUM(oi.servings), MAX(oi.note),
             COALESCE(MAX(d.name), ''), COALESCE(MAX(d.emoji), ''), COALESCE(MAX(d.category), ''),
             COALESCE(MAX(d.spicy), 0), COALESCE(MAX(d.tags), '[]'),
             COALESCE((SELECT SUM(di.amount * i.kcal) / 100.0
                         FROM dish_ingredients di
                         JOIN ingredients i ON i.id = di.ingredient_id
                        WHERE di.dish_id = oi.dish_id), 0),
             COALESCE((SELECT json_group_array(json_object(
                         'ingredient_id', di.ingredient_id,
                         'name', i.name,
                         'category', i.category,
                         'amount', di.amount,
                         'unit', di.unit,
                         'is_pantry', i.is_pantry,
                         'kcal', i.kcal,
                         'protein', i.protein,
                         'fat', i.fat,
                         'carb', i.carb,
                         'sodium', i.sodium,
                         'fiber', i.fiber))
                         FROM dish_ingredients di
                         JOIN ingredients i ON i.id = di.ingredient_id
                        WHERE di.dish_id = oi.dish_id), '[]')
        FROM order_items oi
        LEFT JOIN dishes d ON d.id = oi.dish_id
       GROUP BY oi.order_id, oi.dish_id;

      DROP TABLE order_items;
      ALTER TABLE order_items_new RENAME TO order_items;
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_items_dish ON order_items(dish_id);
    `,
  },
  {
    // 提交幂等：客户端每次「确认菜单」带一个随机 token，网络重试或手抖双击复用同一个，
    // 服务端撞到已有 token 就直接返回那张订单，不再新建（否则一次点菜会变成两张单，
    // 采购、备料、营养、统计全部翻倍）。
    version: 18,
    name: 'orders-client-token',
    sql: `
      ALTER TABLE orders ADD COLUMN client_token TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_token
        ON orders(client_token) WHERE client_token IS NOT NULL;
    `,
  },
  {
    // 用餐考勤的历史固化。
    //
    // 原来 meal_attendance 只存「人工改过的那几天」，其余历史日子按**当前** away.* 规则现算——
    // 于是「把周三晚餐设成在外吃」会连带改写过去所有周三的在家/在外，以及营养页按在家餐次折算的区间。
    // 现在给每行补两个字段：
    //   source：这条判定怎么来的（orders / override / rule / default）
    //   locked：1 = 系统按当时的规则固化下来的历史快照，0 = 人工覆盖
    // 老行都是人工设的覆盖值，用默认值（source='override' / locked=0）语义正好。
    version: 19,
    name: 'meal-attendance-locked',
    sql: `
      ALTER TABLE meal_attendance ADD COLUMN source TEXT NOT NULL DEFAULT 'override';
      ALTER TABLE meal_attendance ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // 必有 / 可选：给 BOM 的每一行标上「这道菜少了它还算不算数」。
    //
    // 原来只有 ingredients.is_pantry 一个正交维度（食材自身「家里常备」），缺什么料都一视同仁，
    // 于是「番茄炒蛋缺番茄」和「番茄炒蛋缺大葱」在点菜页同档，说不清哪道是真做不了。
    // 现在 required = 1 表示必有（缺了菜不成立），0 表示可选（缺了只是口味打折）——
    //   · 点菜页用「必有食材」的命中情况排序：核心齐的排前面，缺的按缺几样下沉；
    //   · 采购清单把「只有可选身份」的食材单独成组，默认不算必买。
    // 挂在关联表而非食材表：大葱在番茄炒蛋里可有可无，在葱油拌面里却是主角，同一食材身份随菜而变。
    // 默认 1 让老数据行为不变（旧口径 = 全部非调料都按必有看待）。
    version: 20,
    name: 'dish-ingredient-required',
    sql: `
      ALTER TABLE dish_ingredients ADD COLUMN required INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // 必有 / 可选回填：把种子里的 optionals 落到**已存在**的库上。
    //
    // 迁移 v20 只能让老数据全按「必有」处理（默认值 1），不重新 seed 的话点菜页
    // 就分不出「核心齐 / 可选缺」；又不能强制 seed:force——那会连同家人改过的菜单一起覆盖。
    // 所以照 v16 的做法按「菜名 + 食材名」定点回填，并且只改仍是默认值 1 的行：
    // 后台手工调过的（已经是 0）永不覆盖。全新库由种子 INSERT 直接带上 required。
    // SQL 由 SEED_DISHES 生成，与 seed/dishes.ts 保持单一来源。
    version: 21,
    name: 'backfill-dish-ingredient-required',
    sql: '',
    statements: SEED_DISHES.filter((dish) => (dish.optionals ?? []).length > 0).flatMap((dish) =>
      (dish.optionals ?? []).map((name) => ({
        sql: `UPDATE dish_ingredients SET required = 0
                WHERE required = 1
                  AND dish_id = (SELECT id FROM dishes WHERE name = ?1)
                  AND ingredient_id = (SELECT id FROM ingredients WHERE name = ?2)`,
        params: [dish.name, name],
      })),
    ),
  },
  // 同样没有 v22：原为「按成员姓名调整选人列表顺序」的一次性数据修正，理由与 v2 相同，
  // 已整条移除（版本号留空缺，无影响）。
  {
    // 做菜计时下线：只保留「谁做了这一单」这一事实，开始/结束时间与实测耗时都不再需要。
    // 原因：大厨经常忘了点「做好了」，工时本身就是脏数据（之前还专门写了一套封顶逻辑兜它）。
    // 表本身留着，做菜统计（次数 / 道数 / 份数 / 卡路里）继续用它，历史计数不受影响；
    // 只有这三列的历史值会随迁移丢弃。
    version: 23,
    name: 'drop-cook-log-timing',
    sql: `
      ALTER TABLE cook_logs DROP COLUMN started_at;
      ALTER TABLE cook_logs DROP COLUMN finished_at;
      ALTER TABLE cook_logs DROP COLUMN minutes;
    `,
  },
  {
    // 营养来源标记：AI 起草时填的营养值需要人复核，别让它悄悄混进营养报告。
    //
    // 背景：项目口径是「对齐《中国食物成分表》」，营养页还要跟膳食指南对照；而大模型填的
    // kcal / 蛋白质只能是估计值，这类错最隐蔽——热量偏高 30% 在界面上完全看不出来。
    // 所以给每条食材记下营养是怎么来的（值域见 shared/types.ts 的 NutritionSource）：
    //   seed   = 预置数据（《中国食物成分表》口径）
    //   ai     = AI 起草时填的，等价于「待复核」，后台食材页黄标提示
    //   manual = 人工确认过的（复核通过后落这个值；采购页手工新建的食材也是它）
    //
    // 老数据无法追溯来源，统一按 seed 对待——ADD COLUMN 的默认值即为此，无需额外回填。
    version: 24,
    name: 'ingredient-nutrition-source',
    sql: `
      ALTER TABLE ingredients ADD COLUMN nutrition_source TEXT NOT NULL DEFAULT 'seed';
    `,
  },
  {
    // 删除订单不再抹掉做菜记录。
    //
    // 原 cook_logs.order_id 是 ON DELETE CASCADE：大厨误删一张已完成的单，
    // “下厨次数 / 道数 / 份数 / 卡路里”会静默少一笔，而删除确认只说了订单会消失。
    // 做菜记录描述的是“谁做过这顿饭”，meal_date / member_id / 菜数份数都已快照在行上，
    // 不依赖订单继续存在。这里把外键改成 ON DELETE SET NULL：删单后记录保留，归到历史。
    // 注意 SQLite 不能直接改 FK，必须重建表；历史字段与 v23 后的结构保持一致。
    version: 25,
    name: 'cook-logs-keep-on-order-delete',
    sql: `
      CREATE TABLE cook_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        meal_date TEXT NOT NULL,
        meal_type TEXT NOT NULL,
        dishes INTEGER NOT NULL DEFAULT 0,
        servings INTEGER NOT NULL DEFAULT 0,
        kcal REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO cook_logs_new (id, order_id, member_id, meal_date, meal_type, dishes, servings, kcal, created_at)
        SELECT id, order_id, member_id, meal_date, meal_type, dishes, servings, kcal, created_at FROM cook_logs;
      DROP TABLE cook_logs;
      ALTER TABLE cook_logs_new RENAME TO cook_logs;
      CREATE INDEX IF NOT EXISTS idx_cook_logs_member ON cook_logs(member_id);
      CREATE INDEX IF NOT EXISTS idx_cook_logs_date ON cook_logs(meal_date);
      CREATE INDEX IF NOT EXISTS idx_cook_logs_order ON cook_logs(order_id);
    `,
  },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
     );`,
  );

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  const current = Number(row?.v ?? 0);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      // 先跑无参部分（DDL 等），再逐条跑参数化语句；两段在同一事务里
      if (migration.sql.trim().length > 0) {
        db.exec(migration.sql);
      }
      if (migration.statements) {
        for (const statement of migration.statements) {
          db.prepare(statement.sql).run(...(statement.params ?? []));
        }
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
      db.exec('COMMIT');
      log.info(`已应用迁移 v${migration.version} ${migration.name}`);
    } catch (error) {
      db.exec('ROLLBACK');
      log.error(`迁移 v${migration.version} 失败，已回滚`, error);
      throw error;
    }
  }
}
