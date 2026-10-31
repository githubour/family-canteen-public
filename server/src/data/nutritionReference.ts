/**
 * 新食材营养参考表——《中国食物成分表》口径的常见食物参考值（每 100g 可食部）。
 *
 * 用途：AI 加菜碰到食材库里没有的名字时，营养不再只靠模型凭记忆估。
 *   1. 这份表会拼进加菜提示词，要求模型「优先照抄表里的数值」；
 *   2. 服务端还会拿模型给的名字在本表上**确定性**再对一遍（resolveIngredient 同一套匹配），
 *      命中就以表里的数值覆盖模型输出——即使模型没读到表，结果也以表为准。
 * 命中的行入库时 nutrition_source 标 'seed'（成分表口径，不再挂「待复核」），
 * 没命中的才走老路：模型估的数 + 'ai' + 后台黄标待复核。
 *
 * 数值单位：kcal 为千卡，protein/fat/carb/fiber 为克，sodium 为毫克。
 * 覆盖原则：只收库里高频出现、而食材库 137 种又没覆盖的常见食物；宁缺毋滥。
 */
export interface NutritionReferenceEntry {
  name: string;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  sodium: number;
  fiber: number;
}

export const NUTRITION_REFERENCE: NutritionReferenceEntry[] = [
  // 蔬菜
  { name: '莴笋', kcal: 15, protein: 1.0, fat: 0.1, carb: 2.8, sodium: 31, fiber: 0.6 },
  { name: '空心菜', kcal: 20, protein: 2.2, fat: 0.3, carb: 2.2, sodium: 94, fiber: 1.4 },
  { name: '油麦菜', kcal: 15, protein: 1.4, fat: 0.4, carb: 1.5, sodium: 80, fiber: 0.6 },
  { name: '苋菜', kcal: 25, protein: 2.8, fat: 0.3, carb: 4.1, sodium: 32, fiber: 2.2 },
  { name: '圆白菜', kcal: 24, protein: 1.5, fat: 0.2, carb: 4.6, sodium: 27, fiber: 1.0 },
  { name: '紫甘蓝', kcal: 25, protein: 1.4, fat: 0.1, carb: 5.7, sodium: 27, fiber: 2.0 },
  { name: '秋葵', kcal: 37, protein: 2.0, fat: 0.1, carb: 7.1, sodium: 4, fiber: 3.9 },
  { name: '苦瓜', kcal: 19, protein: 1.0, fat: 0.1, carb: 4.9, sodium: 3, fiber: 1.4 },
  { name: '丝瓜', kcal: 20, protein: 1.0, fat: 0.2, carb: 4.2, sodium: 3, fiber: 0.6 },
  { name: '南瓜', kcal: 23, protein: 0.7, fat: 0.1, carb: 5.3, sodium: 1, fiber: 0.8 },
  { name: '西葫芦', kcal: 19, protein: 0.8, fat: 0.2, carb: 3.8, sodium: 5, fiber: 0.6 },
  { name: '白萝卜', kcal: 21, protein: 0.9, fat: 0.1, carb: 5.0, sodium: 62, fiber: 1.0 },
  { name: '豌豆苗', kcal: 34, protein: 4.0, fat: 0.8, carb: 4.6, sodium: 59, fiber: 1.9 },
  { name: '黄豆芽', kcal: 44, protein: 4.5, fat: 1.6, carb: 4.5, sodium: 15, fiber: 1.5 },
  { name: '平菇', kcal: 20, protein: 1.9, fat: 0.3, carb: 4.6, sodium: 4, fiber: 2.3 },
  { name: '杏鲍菇', kcal: 35, protein: 1.3, fat: 0.1, carb: 8.3, sodium: 4, fiber: 2.1 },
  // 肉禽蛋
  { name: '鸭肉', kcal: 240, protein: 15.5, fat: 19.7, carb: 0.2, sodium: 69, fiber: 0 },
  { name: '鹅肉', kcal: 251, protein: 17.9, fat: 19.9, carb: 0, sodium: 59, fiber: 0 },
  { name: '兔肉', kcal: 102, protein: 19.7, fat: 2.2, carb: 0.9, sodium: 37, fiber: 0 },
  { name: '猪肝', kcal: 129, protein: 19.3, fat: 3.5, carb: 5.0, sodium: 68, fiber: 0 },
  { name: '鸡肝', kcal: 121, protein: 16.6, fat: 4.8, carb: 2.8, sodium: 92, fiber: 0 },
  { name: '猪血', kcal: 55, protein: 12.2, fat: 0.3, carb: 0.4, sodium: 56, fiber: 0 },
  { name: '鸭血', kcal: 108, protein: 13.6, fat: 0.4, carb: 12.4, sodium: 162, fiber: 0 },
  { name: '羊肉卷', kcal: 203, protein: 19.0, fat: 14.1, carb: 0, sodium: 69, fiber: 0 },
  // 水产
  { name: '虾仁', kcal: 48, protein: 10.4, fat: 0.7, carb: 0, sodium: 165, fiber: 0 },
  { name: '虾皮', kcal: 153, protein: 30.7, fat: 2.2, carb: 2.5, sodium: 5057, fiber: 0 },
  { name: '三文鱼', kcal: 139, protein: 17.2, fat: 7.8, carb: 0, sodium: 59, fiber: 0 },
  { name: '金枪鱼', kcal: 132, protein: 23.5, fat: 1.0, carb: 0, sodium: 47, fiber: 0 },
  { name: '扇贝', kcal: 60, protein: 11.1, fat: 0.2, carb: 2.6, sodium: 84, fiber: 0 },
  { name: '蟹肉', kcal: 62, protein: 11.6, fat: 1.1, carb: 1.1, sodium: 270, fiber: 0 },
  { name: '墨鱼', kcal: 83, protein: 15.2, fat: 0.9, carb: 3.4, sodium: 165, fiber: 0 },
  { name: '蛏子', kcal: 40, protein: 7.3, fat: 0.3, carb: 2.1, sodium: 176, fiber: 0 },
  { name: '海带', kcal: 13, protein: 1.2, fat: 0.1, carb: 2.1, sodium: 9, fiber: 0.5 },
  // 豆与豆制品
  { name: '黄豆', kcal: 359, protein: 35.0, fat: 16.0, carb: 34.2, sodium: 2, fiber: 15.5 },
  { name: '毛豆', kcal: 123, protein: 13.1, fat: 5.0, carb: 10.5, sodium: 4, fiber: 4.0 },
  { name: '豌豆', kcal: 111, protein: 7.4, fat: 0.3, carb: 21.2, sodium: 1, fiber: 3.0 },
  { name: '豇豆', kcal: 29, protein: 2.7, fat: 0.2, carb: 5.9, sodium: 4, fiber: 1.8 },
  { name: '鹰嘴豆', kcal: 334, protein: 19.0, fat: 6.0, carb: 61.0, sodium: 10, fiber: 12.0 },
  { name: '豆浆', kcal: 16, protein: 1.8, fat: 0.7, carb: 1.1, sodium: 3, fiber: 1.0 },
  { name: '内酯豆腐', kcal: 50, protein: 5.0, fat: 1.9, carb: 3.3, sodium: 3, fiber: 0.4 },
  { name: '油豆腐', kcal: 244, protein: 17.0, fat: 17.6, carb: 4.9, sodium: 15, fiber: 1.0 },
  // 主食
  { name: '挂面', kcal: 348, protein: 10.3, fat: 0.6, carb: 75.1, sodium: 183, fiber: 1.5 },
  { name: '馒头', kcal: 223, protein: 7.0, fat: 1.1, carb: 47.0, sodium: 165, fiber: 1.3 },
  { name: '油条', kcal: 388, protein: 6.9, fat: 17.6, carb: 51.0, sodium: 585, fiber: 1.4 },
  { name: '荞麦面', kcal: 336, protein: 11.3, fat: 2.3, carb: 70.0, sodium: 60, fiber: 3.0 },
  { name: '意面', kcal: 350, protein: 12.0, fat: 1.5, carb: 72.0, sodium: 6, fiber: 3.0 },
  { name: '玉米面', kcal: 350, protein: 8.1, fat: 3.3, carb: 73.1, sodium: 3, fiber: 5.5 },
  { name: '糯米粉', kcal: 360, protein: 7.3, fat: 0.8, carb: 82.5, sodium: 2, fiber: 0.8 },
  { name: '藜麦', kcal: 368, protein: 14.1, fat: 6.1, carb: 64.2, sodium: 5, fiber: 7.0 },
  // 水果
  { name: '苹果', kcal: 53, protein: 0.4, fat: 0.2, carb: 13.7, sodium: 2, fiber: 1.2 },
  { name: '香蕉', kcal: 93, protein: 1.4, fat: 0.2, carb: 22.0, sodium: 1, fiber: 1.2 },
  { name: '葡萄', kcal: 45, protein: 0.4, fat: 0.3, carb: 10.3, sodium: 2, fiber: 0.4 },
  { name: '西瓜', kcal: 26, protein: 0.5, fat: 0.3, carb: 5.8, sodium: 3, fiber: 0.3 },
  { name: '哈密瓜', kcal: 34, protein: 0.5, fat: 0.1, carb: 7.9, sodium: 26, fiber: 0.2 },
  { name: '桃', kcal: 42, protein: 0.9, fat: 0.1, carb: 10.9, sodium: 6, fiber: 0.6 },
  { name: '李子', kcal: 38, protein: 0.7, fat: 0.2, carb: 8.7, sodium: 4, fiber: 0.9 },
  { name: '杏', kcal: 38, protein: 0.9, fat: 0.1, carb: 9.1, sodium: 2, fiber: 1.3 },
  { name: '樱桃', kcal: 46, protein: 1.1, fat: 0.2, carb: 10.2, sodium: 8, fiber: 0.3 },
  { name: '荔枝', kcal: 71, protein: 0.9, fat: 0.2, carb: 16.6, sodium: 2, fiber: 0.5 },
  { name: '龙眼', kcal: 71, protein: 1.2, fat: 0.1, carb: 16.6, sodium: 4, fiber: 0.4 },
  { name: '猕猴桃', kcal: 61, protein: 0.8, fat: 0.6, carb: 14.5, sodium: 10, fiber: 2.6 },
  { name: '火龙果', kcal: 55, protein: 1.1, fat: 0.2, carb: 13.3, sodium: 3, fiber: 1.6 },
  { name: '榴莲', kcal: 150, protein: 2.6, fat: 3.3, carb: 28.3, sodium: 3, fiber: 1.7 },
  { name: '柿子', kcal: 74, protein: 0.4, fat: 0.1, carb: 18.5, sodium: 1, fiber: 1.4 },
  { name: '鲜枣', kcal: 122, protein: 1.1, fat: 0.3, carb: 30.5, sodium: 1, fiber: 2.2 },
  // 坚果种子
  { name: '核桃', kcal: 646, protein: 14.9, fat: 58.8, carb: 19.1, sodium: 6, fiber: 9.5 },
  { name: '腰果', kcal: 552, protein: 17.3, fat: 36.7, carb: 41.6, sodium: 251, fiber: 3.6 },
  { name: '巴旦木', kcal: 578, protein: 21.0, fat: 50.0, carb: 21.0, sodium: 10, fiber: 12.0 },
  { name: '开心果', kcal: 631, protein: 20.6, fat: 53.0, carb: 21.9, sodium: 756, fiber: 8.2 },
  { name: '黑芝麻', kcal: 559, protein: 19.1, fat: 46.1, carb: 24.0, sodium: 8, fiber: 14.0 },
  { name: '白芝麻', kcal: 517, protein: 18.4, fat: 39.6, carb: 31.5, sodium: 8, fiber: 9.8 },
  { name: '葵花籽仁', kcal: 606, protein: 19.1, fat: 53.4, carb: 12.5, sodium: 6, fiber: 4.5 },
  // 调味与干货
  { name: '蚝油', kcal: 114, protein: 4.7, fat: 0.3, carb: 23.4, sodium: 2600, fiber: 0 },
  { name: '老抽', kcal: 100, protein: 5.0, fat: 0, carb: 15.0, sodium: 5700, fiber: 0 },
  { name: '醋', kcal: 31, protein: 2.1, fat: 0.3, carb: 4.9, sodium: 262, fiber: 0 },
  { name: '番茄酱', kcal: 83, protein: 1.9, fat: 0.2, carb: 18.9, sodium: 902, fiber: 0.6 },
  { name: '豆瓣酱', kcal: 178, protein: 13.6, fat: 6.8, carb: 17.1, sodium: 6012, fiber: 1.5 },
  { name: '甜面酱', kcal: 137, protein: 5.5, fat: 0.6, carb: 28.5, sodium: 1900, fiber: 0.9 },
  { name: '味噌', kcal: 181, protein: 10.7, fat: 6.0, carb: 28.5, sodium: 3700, fiber: 2.3 },
  { name: '鱼露', kcal: 33, protein: 5.0, fat: 0.1, carb: 0, sodium: 7100, fiber: 0 },
  { name: '藕粉', kcal: 372, protein: 0.2, fat: 0, carb: 93.0, sodium: 21, fiber: 0.1 },
  { name: '椰浆', kcal: 230, protein: 2.3, fat: 24.5, carb: 5.5, sodium: 15, fiber: 0 },
  { name: '枸杞', kcal: 258, protein: 13.9, fat: 1.5, carb: 64.1, sodium: 252, fiber: 16.9 },
  { name: '红枣', kcal: 276, protein: 3.2, fat: 0.5, carb: 67.8, sodium: 8, fiber: 9.5 },
  { name: '葡萄干', kcal: 341, protein: 2.5, fat: 0.4, carb: 83.4, sodium: 19, fiber: 1.6 },
  { name: '银耳', kcal: 200, protein: 10.0, fat: 1.4, carb: 67.3, sodium: 82, fiber: 30.4 },
  { name: '莲子', kcal: 350, protein: 17.2, fat: 2.0, carb: 67.2, sodium: 5, fiber: 3.0 },
  { name: '百合', kcal: 346, protein: 3.2, fat: 0.1, carb: 79.8, sodium: 6, fiber: 1.7 },
  { name: '薏米', kcal: 361, protein: 12.8, fat: 3.3, carb: 71.1, sodium: 3, fiber: 2.0 },
];
