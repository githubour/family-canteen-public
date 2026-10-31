/**
 * AI 起草服务：把「一句话」变成一份**草稿**（加菜 / 改菜 / 登记库存），
 * 外加一个只判断意图、不产草稿的分流（intent）。
 *
 * 这个模块最重要的一条设计是「只产草稿，绝不写库」：
 *   · 幻觉菜名、AI 现编的营养值、听错的口味，全都止步于草稿卡片，人点确认才可能落库；
 *   · 落库仍然走 dishService.createDish 等既有写入路径（同一套校验、同一事务、同一套 SSE 广播），
 *     所以 AI 加菜与手工加菜在数据上完全没有区别，也不存在第二条写入路径需要维护。
 *
 * 第二重要的是「优先复用库里已有食材」，而且是**由服务端确定性判定的**，不靠模型自觉：
 *   模型返回的配料名统一过一遍 resolveIngredient（精确匹配 + synonyms 别名归并），
 *   命中的用库里的规范名与现成营养（顺带避开 AI 编数字），没命中的才进「新食材」并黄标待复核。
 *
 * 实现按工作流拆在 ./ai/ 下，路由只认本文件的导出：
 *   · catalog      食材目录快照 + 《成分表》参考表 + 名字归并（resolveIngredient）
 *   · readers      模型输出的宽容读取（数字 / 数组 / 营养各兜一手）
 *   · prompts      四套系统提示词与 user prompt 拼装
 *   · dishDraft    加菜：draftDishFromText
 *   · revisionDraft 改菜：draftDishRevision
 *   · fridgeDraft  登记库存：draftFridgeFromText
 *   · intent       分流：routeAiText（只判断该走加菜还是库存）
 */
import { isLlmEnabled, llmModel } from '../lib/llm.js';

export { draftDishFromText } from './ai/dishDraft.js';
export { draftDishRevision } from './ai/revisionDraft.js';
export { draftFridgeFromText } from './ai/fridgeDraft.js';
export { routeAiText } from './ai/intent.js';

export function aiStatus(): { enabled: boolean; model: string } {
  // 这里只报「配没配 key / 用哪个模型」，不外泄任何 key 片段
  return { enabled: isLlmEnabled(), model: llmModel() };
}
