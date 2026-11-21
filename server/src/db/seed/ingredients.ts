/**
 * 预置食材主数据。
 * 营养值口径对齐《中国食物成分表（第 6 版）》每 100g 可食部：
 *   kcal 千卡 / protein 蛋白质 g / fat 脂肪 g / carb 碳水化合物 g / sodium 钠 mg / fiber 膳食纤维 g
 * buyUnit + buyFactor 决定采购清单怎么念：如鸡蛋按「个，约 50g」、大葱按「根，约 60g」。
 * pantry = true 表示家中常备，采购清单默认折叠、不计入采购任务。
 * price 为参考单价（元 / 100g），用于成本估算，可留空。
 *
 * 这里只列示意菜用到的食材与少量常备主数据，作开箱示例；
 * 后续在「食材」页签里补全自己家的常用食材即可。
 */

interface SeedIngredient {
  name: string;
  category: string;
  buyUnit?: string;
  buyFactor?: number;
  pantry?: boolean;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
  price?: number;
}

export const SEED_INGREDIENTS: SeedIngredient[] = [
  // ------------------------------- 蔬果 -------------------------------
  { name: '番茄', category: '蔬果', kcal: 20, protein: 0.9, fat: 0.2, carb: 4.0, sodium: 5.0, fiber: 0.5, price: 0.6 },
  { name: '大葱', category: '蔬果', buyUnit: '根', buyFactor: 60, kcal: 33, protein: 1.7, fat: 0.3, carb: 6.5, sodium: 4.8, fiber: 1.3, price: 0.5 },
  { name: '小葱', category: '蔬果', buyUnit: '把', buyFactor: 50, kcal: 24, protein: 1.4, fat: 0.3, carb: 4.6, sodium: 90.0, fiber: 1.4, price: 1.0 },
  { name: '土豆', category: '蔬果', kcal: 81, protein: 2.6, fat: 0.2, carb: 17.8, sodium: 5.9, fiber: 1.1, price: 0.35 },
  { name: '青椒', category: '蔬果', kcal: 22, protein: 1.4, fat: 0.3, carb: 5.4, sodium: 3.3, fiber: 1.4, price: 0.7 },
  { name: '生菜', category: '蔬果', buyUnit: '把', buyFactor: 250, kcal: 15, protein: 1.3, fat: 0.3, carb: 2.0, sodium: 32.8, fiber: 0.7, price: 0.5 },
  { name: '黄瓜', category: '蔬果', buyUnit: '根', buyFactor: 200, kcal: 16, protein: 0.8, fat: 0.2, carb: 2.9, sodium: 4.9, fiber: 0.5, price: 0.4 },
  // ------------------------------ 肉禽蛋 ------------------------------
  { name: '鸡胸肉', category: '肉禽蛋', kcal: 133, protein: 19.4, fat: 5.0, carb: 2.5, sodium: 34.4, fiber: 0, price: 3.0 },
  { name: '鸡蛋', category: '肉禽蛋', buyUnit: '个', buyFactor: 50, kcal: 144, protein: 13.3, fat: 8.8, carb: 2.8, sodium: 131.5, fiber: 0, price: 2.4 },
  { name: '猪肉馅', category: '肉禽蛋', kcal: 265, protein: 13.0, fat: 24.0, carb: 0.9, sodium: 60.0, fiber: 0, price: 2.2 },
  // ------------------------------- 粮油 -------------------------------
  { name: '大米', category: '粮油', kcal: 346, protein: 7.4, fat: 0.8, carb: 77.9, sodium: 3.8, fiber: 0.7, price: 0.6 },
  { name: '面粉', category: '粮油', kcal: 344, protein: 11.2, fat: 1.5, carb: 73.6, sodium: 3.1, fiber: 2.1, price: 0.5 },
  { name: '面条(生)', category: '粮油', kcal: 286, protein: 8.5, fat: 0.7, carb: 61.9, sodium: 3.4, fiber: 1.5, price: 0.9 },
  { name: '食用油', category: '粮油', buyUnit: '瓶', buyFactor: 900, pantry: true, kcal: 899, protein: 0, fat: 99.9, carb: 0, sodium: 0, fiber: 0, price: 1.2 },
  // ------------------------------- 调料 -------------------------------
  { name: '盐', category: '调料', buyUnit: '袋', buyFactor: 400, pantry: true, kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 39311, fiber: 0, price: 0.3 },
  { name: '生抽', category: '调料', buyUnit: '瓶', buyFactor: 500, pantry: true, kcal: 63, protein: 5.6, fat: 0.1, carb: 10.1, sodium: 5757, fiber: 0, price: 0.8 },
  { name: '老抽', category: '调料', buyUnit: '瓶', buyFactor: 500, pantry: true, kcal: 70, protein: 5.6, fat: 0.1, carb: 12.0, sodium: 6200, fiber: 0, price: 0.9 },
  { name: '白糖', category: '调料', buyUnit: '袋', buyFactor: 400, pantry: true, kcal: 400, protein: 0.1, fat: 0, carb: 99.9, sodium: 0.4, fiber: 0, price: 0.7 },
  { name: '芝麻油', category: '调料', buyUnit: '瓶', buyFactor: 200, pantry: true, kcal: 898, protein: 0, fat: 99.7, carb: 0.2, sodium: 1.1, fiber: 0, price: 2.0 },
  { name: '番茄酱', category: '调料', buyUnit: '瓶', buyFactor: 300, pantry: true, kcal: 81, protein: 4.9, fat: 0.2, carb: 16.9, sodium: 37.0, fiber: 0.6, price: 1.2 },
  // ------------------------------- 干货 -------------------------------
  { name: '紫菜(干)', category: '干货', buyUnit: '袋', buyFactor: 50, kcal: 250, protein: 26.7, fat: 1.1, carb: 44.1, sodium: 710.5, fiber: 21.6, price: 6.0 },
  // ------------------------------- 其他 -------------------------------
  { name: '番茄罐头', category: '其他', buyUnit: '罐', buyFactor: 400, kcal: 20, protein: 0.9, fat: 0.2, carb: 4.0, sodium: 130, fiber: 0.9, price: 1.2 },
];
