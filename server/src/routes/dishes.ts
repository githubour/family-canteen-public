import express, { Router } from 'express';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { get, run, uploadsDir } from '../db/index.js';
import {
  createDish,
  deleteDish,
  getDishById,
  listDishes,
  replaceDishIngredients,
  setIngredientRequired,
  updateDish,
} from '../services/dishService.js';
import { badRequest, notFound } from '../lib/errors.js';
import { broadcast } from '../lib/sse.js';
import { expandSearchTerms } from '../lib/synonyms.js';
import { MEAL_TYPES, type Dish, type DishRow, type MealType } from '../types.js';

export const dishesRouter = Router();

/**
 * 实拍图上传路径的正则：app.ts 的全局 JSON 解析器要对它豁免，让路由级 10mb 解析真正生效。
 * 放在这里导出给 app.ts 用，路径一旦变化正则跟着改，两边不会各写一份然后悄悄失配。
 */
export const DISH_PHOTO_ROUTE_PATTERN = /^\/api\/dishes\/\d+\/photo$/;

/** 菜品实拍图目录：<db 目录>/uploads/dishes，跟数据库走 */
const dishPhotoDir = () => resolve(uploadsDir(), 'dishes');
/** 文件名前缀按菜 id 分组：换图时把旧文件一并清掉，目录不会越攒越多 */
const photoPrefix = (id: number) => `dish-${id}-`;
const ALLOWED_PHOTO_MIME = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
/** 解码后的图片上限。客户端会先压到 ≤720px（通常 100KB 左右），这里是防误传的护栏 */
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

/** 文件头校验：不要把任意字节伪装成 image/jpeg 落盘（纵深防御，客户端压缩不是安全边界）。 */
function hasImageMagic(buffer: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/png') {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return buffer.length >= png.length && png.every((byte, index) => buffer[index] === byte);
  }
  if (mime === 'image/webp') {
    return buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function removeDishPhotos(id: number, keep?: string): void {
  const dir = dishPhotoDir();
  readdir(dir)
    .then((files) =>
      Promise.all(
        files
          .filter((file) => file.startsWith(photoPrefix(id)) && file !== keep)
          .map((file) => unlink(resolve(dir, file))),
      ),
    )
    .catch(() => undefined);
}

function shuffle<T>(input: T[]): T[] {
  const array = [...input];
  for (let index = array.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [array[index], array[target]] = [array[target], array[index]];
  }
  return array;
}

/**
 * 按人数与餐次推导配菜结构：3 人 → 4 菜 1 汤。
 * 早餐不套「荤素汤」结构，只配 2 样（主食 + 一样搭配），所以单独返回。
 */
function recommendStructure(
  headcount: number,
  mealType: MealType = 'lunch',
): { mains: number; soups: number } {
  if (mealType === 'breakfast') return { mains: 2, soups: 0 };
  const people = Math.min(Math.max(Math.round(headcount) || 3, 1), 8);
  return {
    mains: Math.min(Math.max(people + 1, 2), 6),
    soups: people >= 3 ? 1 : 0,
  };
}

/** 分层洗牌：标了当前餐别的菜整堆放前，其余（含没标的通用菜）垫底，各堆内部随机 */
function shuffleTiered(pool: Dish[], mealType: MealType): Dish[] {
  const preferred: Dish[] = [];
  const rest: Dish[] = [];
  for (const dish of pool) {
    (dish.meal_types.includes(mealType) ? preferred : rest).push(dish);
  }
  return [...shuffle(preferred), ...shuffle(rest)];
}

function buildCombination(headcount: number, exclude: number[], mealType: MealType = 'lunch'): Dish[] {
  const pool = listDishes().filter((dish) => !exclude.includes(dish.id));
  const { mains, soups } = recommendStructure(headcount, mealType);

  const picked: Dish[] = [];
  const used = new Set<number>();

  const take = (from: Dish[], count: number) => {
    for (const dish of from) {
      if (picked.length >= mains + soups) return;
      if (count <= 0) return;
      if (used.has(dish.id)) continue;
      picked.push(dish);
      used.add(dish.id);
      count -= 1;
    }
  };

  // 每个子池都走分层洗牌：标了当前餐别的菜先被挑走（早餐的主食别摇成糖醋里脊），
  // 挑不满自动落回池子里剩下的菜
  if (mealType === 'breakfast') {
    take(shuffleTiered(pool.filter((dish) => dish.category === '主食'), mealType), 1);
    take(shuffleTiered(pool, mealType), mains);
    return picked.slice(0, mains);
  }

  const soupsPool = shuffleTiered(pool.filter((dish) => dish.category === '汤'), mealType);
  take(soupsPool, soups);

  const mainsLeft = mains;
  const meatCount = Math.max(1, Math.round(mainsLeft * 0.5));
  const vegCount = Math.max(0, mainsLeft - meatCount);
  take(shuffleTiered(pool.filter((dish) => dish.category === '荤菜'), mealType), meatCount);
  take(shuffleTiered(pool.filter((dish) => dish.category === '素菜'), mealType), vegCount);
  take(shuffleTiered(pool.filter((dish) => dish.category === '主食'), mealType), 1);
  take(shuffleTiered(pool, mealType), mains + soups);

  return picked.slice(0, mains + soups);
}

dishesRouter.get('/random', (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count ?? 1) || 1, 1), 8);
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const mealType = (MEAL_TYPES as string[]).includes(String(req.query.mealType))
    ? (req.query.mealType as MealType)
    : undefined;
  const exclude = String(req.query.exclude ?? '')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  // 先从标了当前餐别的菜里随机（早餐摇到粥而不是炒菜），这层为空再落回全菜单
  const candidates = listDishes({ category }).filter((dish) => !exclude.includes(dish.id));
  if (mealType) {
    const ordered = shuffleTiered(candidates, mealType);
    const preferred = ordered.filter((dish) => dish.meal_types.includes(mealType));
    res.json({ dishes: (preferred.length > 0 ? preferred : ordered).slice(0, count) });
    return;
  }
  res.json({ dishes: shuffle(candidates).slice(0, count) });
});

/** 按人数与餐次推荐一桌菜，用于点菜页的「帮我配一桌」；早餐另有一套结构 */
dishesRouter.get('/recommend', (req, res) => {
  const headcount = Number(req.query.headcount ?? 3) || 3;
  const mealType = (MEAL_TYPES as string[]).includes(String(req.query.mealType))
    ? (req.query.mealType as MealType)
    : 'lunch';
  const exclude = String(req.query.exclude ?? '')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  const dishes = buildCombination(headcount, exclude, mealType);
  const structure = recommendStructure(headcount, mealType);
  const totalKcal = dishes.reduce((sum, dish) => sum + dish.nutrition.kcal, 0);
  res.json({ dishes, structure, per_serving_kcal: Math.round(totalKcal) });
});

dishesRouter.get('/', (req, res) => {
  // 默认只出在售的菜；includeInactive=1 用于「菜品管理」里把下架的捞回来
  const includeInactive = req.query.includeInactive === '1';
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const dishes = listDishes({
    category: typeof req.query.category === 'string' ? req.query.category : undefined,
    q,
    tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
    maxMinutes: req.query.maxMinutes ? Number(req.query.maxMinutes) : undefined,
    spicy: req.query.spicy ? Number(req.query.spicy) : undefined,
    onlyActive: !includeInactive,
  });
  const allTags = Array.from(new Set(dishes.flatMap((dish) => dish.tags))).slice(0, 24);
  res.json({
    dishes,
    tags: allTags,
    total: dishes.length,
    inactive_total: includeInactive ? dishes.filter((dish) => !dish.active).length : 0,
    // 实际参与匹配的词（含联想展开的别名），前端用它给卡片标「含 xx」
    search_terms: q ? expandSearchTerms(q) : [],
  });
});

/**
 * 新建菜品（内容即数据）：加菜走这里，不再改种子文件。
 * 校验与入库语义见 dishService.createDish（BOM 按食材名关联，缺的食材放
 * newIngredients 连营养一起入库 / 补全，同一事务）；重名 409，绝不覆盖已有菜。
 * 返回与列表同形的完整菜品（含配料与每人份营养），手机端靠 SSE 刷新菜单。
 */
dishesRouter.post('/', (req, res) => {
  const dish = createDish(req.body);
  broadcast('dish:updated', { id: dish.id, created: true });
  res.status(201).json({ dish });
});

/**
 * 彻底删除一道菜（物理删除，日常移除请走下面的 PATCH active=false）。
 *
 * 历史订单不受影响：下单那一刻的菜名 / 分类 / 每人份热量 / BOM 都冻结在订单行上，
 * order_items.dish_id 是 ON DELETE SET NULL，删掉菜品后历史订单、营养与统计照常出数。
 * 返回 kept_orders（关联的历史订单行数）只是让界面能告诉用户「影响了几条记录」。
 * 实拍图文件顺手清掉，别在 uploads/dishes 里留孤儿图。
 */
dishesRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = deleteDish(id);
  removeDishPhotos(id);
  broadcast('dish:deleted', { id });
  res.json({ ok: true, ...result });
});

/**
 * 更新一道菜的属性（改动清单与校验见 dishService.updateDish）：
 *   name / category / spicy / difficulty / minutes / baseServings / emoji / description / tags / steps
 *   active（下架 / 恢复）/ season_months（季节窗口）/ hide_until（歇菜到某月）/ meal_types（餐别）
 * 只处理显式传了的键；历史订单与营养汇总不受影响（订单行存的是下单那一刻的快照）。
 */
dishesRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const dish = updateDish(id, body);
  broadcast('dish:updated', { id, ...(typeof body.active === 'boolean' ? { active: body.active } : {}) });
  res.json({ dish });
});

/**
 * 整表替换配料表：能表达「加一行 / 删一行 / 改用量」，整份提交、天然幂等。
 * 库里没有的食材放 newIngredients（与建菜同一套语义）；先删后插在同一事务里。
 * 改动会影响采购量与营养报告（历史订单不受影响——存的是下单时的 BOM 快照）。
 */
dishesRouter.put('/:id/ingredients', (req, res) => {
  const id = Number(req.params.id);
  const dish = replaceDishIngredients(id, req.body ?? {});
  broadcast('dish:updated', { id });
  res.json({ dish });
});

/**
 * 设置某道菜某个配料的「必有 / 可选」。
 * 必有缺了这道菜不成立（点菜页据此把核心齐的排前面），可选缺了只是口味打折、跳过就行；
 * 标记挂在「菜品 × 食材」的关联行上，同一食材在不同菜里身份可以不同
 * （大葱在番茄炒蛋里可有可无，在葱油拌面里是主角）。
 * 只影响点菜页排序、采购分组与备料展示；历史订单按下单时的 BOM 快照走，不受影响。
 */
dishesRouter.patch('/:id/ingredients/:ingredientId', (req, res) => {
  const id = Number(req.params.id);
  const ingredientId = Number(req.params.ingredientId);
  const { required } = req.body ?? {};
  if (typeof required !== 'boolean') throw badRequest('required 需要是布尔值（true 必有 / false 可选）');

  const dish = setIngredientRequired(id, ingredientId, required);
  broadcast('dish:updated', { id });
  res.json({ dish });
});

/**
 * 上传菜品实拍图：客户端已在本地把图压到 ≤720px 的 JPEG（通常几十 KB），
 * 这里收 data URL。全局 JSON 解析器（1mb）在 app.ts 里对这条路径豁免，
 * 下面的路由级 10mb 限制才真正生效（body-parser 对已消费的请求体会跳过，
 * 不豁免的话这行永远轮不到）。
 * 落盘到 <db 目录>/uploads/dishes/ 并把 image_url 指向新文件。
 * 文件名带时间戳：换图即换 URL，配 immutable 长缓存也不会看到旧图。
 */
dishesRouter.post('/:id/photo', express.json({ limit: '10mb' }), async (req, res) => {
  const id = Number(req.params.id);
  const row = get<DishRow>('SELECT id FROM dishes WHERE id = ?', id);
  if (!row) throw notFound('菜品不存在');

  const data = typeof (req.body as { data?: unknown })?.data === 'string' ? (req.body as { data: string }).data : '';
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!match) throw badRequest('请传 data:image/jpeg;base64,… 格式的图片');
  const [, mime, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw badRequest('图片内容是空的');
  if (buffer.length > MAX_PHOTO_BYTES) throw badRequest('图片太大了（3MB 以内），换张小点的');
  if (!hasImageMagic(buffer, mime)) throw badRequest('图片内容与声明格式不符，请重新选择图片');

  const dir = dishPhotoDir();
  await mkdir(dir, { recursive: true });
  const filename = `${photoPrefix(id)}${Date.now()}.${ALLOWED_PHOTO_MIME.get(mime)}`;
  await writeFile(resolve(dir, filename), buffer);
  // 新图落盘后清理旧图（保留新文件本身）：中途失败也不至于两头空
  removeDishPhotos(id, filename);

  const imageUrl = `/uploads/dishes/${filename}`;
  run('UPDATE dishes SET image_url = ? WHERE id = ?', imageUrl, id);
  broadcast('dish:updated', { id });
  const dish = getDishById(id);
  res.json({ dish });
});

/** 移除实拍图：删文件 + 清字段，回退到 emoji 展示 */
dishesRouter.delete('/:id/photo', (req, res) => {
  const id = Number(req.params.id);
  const row = get<DishRow>('SELECT id FROM dishes WHERE id = ?', id);
  if (!row) throw notFound('菜品不存在');

  removeDishPhotos(id);
  run('UPDATE dishes SET image_url = ? WHERE id = ?', '', id);
  broadcast('dish:updated', { id });
  const dish = getDishById(id);
  res.json({ dish });
});
