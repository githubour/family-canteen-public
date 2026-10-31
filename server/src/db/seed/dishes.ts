/**
 * 预置示意菜与配料表（BOM）。
 * ingredients 中每项为 [食材名, 每人份用量(克), 备注?]，单位为食材基准单位 g。
 * 采购清单与营养摄入都由这份 BOM 派生，因此配比直接决定清单是否好用。
 * steps 是家常做法（一行一步），存库时用换行拼成一段文本；
 * 已有的库不会覆盖用户编辑——迁移 v10 只回填 steps 为空的行。
 * mealTypes 是适用餐别（可多选）：热炒/汤菜归午晚，面条三餐皆宜，汤归午晚。
 *
 * optionals 标出这道菜里「可有可无」的食材（存库时 required = 0），没列出来的都是必有。
 *
 * 判定口径（只对非调料食材有意义；常备调料 is_pantry 在库存匹配里本来就被排除）：
 *   必有 —— 决定这道菜是什么的食材：主料（肉/鱼/蛋/豆腐/主食），以及菜名点名的配菜
 *           （番茄炒蛋的番茄、葱油拌面的大葱）。
 *   可选 —— 只作点缀/收尾（葱花、香菜）或只作爆香/去腥（大蒜、生姜），且菜名没点名。
 *
 * 这里只放 3 道通用示意菜作为开箱示例；装好后在「菜单」页签里增删改
 * 成自己家的菜谱即可——种子只在空库时导入，不会覆盖用户编辑过的库。
 */

import type { MealType } from '../../types.js';

interface SeedDish {
  name: string;
  category: string;
  /** 适用餐别（breakfast/lunch/dinner 子集，可多选）；空数组 = 通用菜，点菜页所有餐别同档 */
  mealTypes: MealType[];
  /** 辣度 0~3 */
  spicy: number;
  tags: string[];
  minutes: number;
  /** 难度 1~3 */
  difficulty: number;
  baseServings: number;
  emoji: string;
  description: string;
  fried?: boolean;
  ingredients: [string, number][];
  /** 可选食材名（必须出现在 ingredients 里）：缺了照样能做，只影响口味；存库时 required = 0 */
  optionals?: string[];
  steps: string[];
}

export const SEED_DISHES: SeedDish[] = [
  {
    name: '番茄炒蛋', category: '荤菜', mealTypes: ['lunch', 'dinner'], spicy: 0, tags: ['家常', '快手', '下饭'], minutes: 12, difficulty: 1, baseServings: 2, emoji: '🍅',
    description: '国民下饭菜，酸甜挂汁，拌饭一绝。',
    ingredients: [['番茄', 150], ['鸡蛋', 75], ['食用油', 8], ['盐', 1], ['白糖', 3], ['大葱', 5], ['番茄罐头', 200]],
    optionals: ['大葱', '番茄罐头'],
    steps: ['番茄顶部划十字，开水烫一下去皮切块；鸡蛋加少许盐打散', '热锅倒油，蛋液炒至刚凝固就盛出', '余油下番茄中火炒出汁水，加糖和盐调味；用番茄罐头时先把罐头下锅炒到出沙收水，再调味', '倒回鸡蛋翻匀，让蛋块裹上茄汁即可'],
  },
  {
    name: '葱油拌面', category: '主食', mealTypes: ['breakfast', 'lunch', 'dinner'], spicy: 0, tags: ['快手', '家常', '碳水'], minutes: 20, difficulty: 2, baseServings: 2, emoji: '🍜',
    description: '葱段熬到焦香，酱油一拌就是灵魂。',
    ingredients: [['面条(生)', 120], ['大葱', 25], ['生抽', 10], ['老抽', 5], ['白糖', 5], ['食用油', 15]],
    steps: ['大葱切段擦干；生抽、老抽、糖加两勺水调成酱汁', '冷油下葱段，小火慢熬到焦黄捞出（油留在锅里）', '倒入酱汁烧开冒泡即关火，成葱油酱', '面条煮熟捞出，拌上葱油酱，撒脆葱即可'],
  },
  {
    name: '紫菜蛋花汤', category: '汤', mealTypes: ['lunch', 'dinner'], spicy: 0, tags: ['快手', '清淡', '低脂'], minutes: 8, difficulty: 1, baseServings: 3, emoji: '🍲',
    description: '五分钟出锅的应急汤，鲜味全靠紫菜。',
    ingredients: [['紫菜(干)', 5], ['鸡蛋', 50], ['大葱', 3], ['盐', 1.5], ['芝麻油', 2]],
    optionals: ['大葱'],
    steps: ['紫菜撕小块放进汤碗，备好葱花', '锅中水烧开加盐，转圈淋蛋液成蛋花', '连汤冲入装紫菜的碗里，滴几滴芝麻油即可'],
  },
];
