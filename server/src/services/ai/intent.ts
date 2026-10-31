/**
 * AI 入口分流：一句话 → 「加菜」还是「登记库存」。**不产草稿、不写库**。
 *
 * 为什么单独一次调用而不是把两个流程塞进一个巨型提示词：
 *   · 两条流程的证据不同（加菜要整张食材库 + 营养参考表，库存只要食材名），
 *     合成一个 prompt 会让每次加菜都多背一份用不上的上下文，也更容易互相干扰；
 *   · 分流只输出一个词，maxTokens 只需要几十个，成本可以忽略；
 *   · 判错了代价很低——两条流程都只产草稿，人还能在弹层里改判，
 *     所以这里不报错、不重试第二次：模型给了个没听过的词就按 dish 处理。
 */
import { badRequest } from '../../lib/errors.js';
import { chatJson, llmModel } from '../../lib/llm.js';
import { createLogger } from '../../lib/logger.js';
import { INTENT_SYSTEM_PROMPT, MAX_PROMPT_LENGTH } from './prompts.js';
import { readString } from './readers.js';

const log = createLogger('ai');

export type AiIntent = 'dish' | 'fridge';

export interface AiRouteResult {
  intent: AiIntent;
  /** 模型给的一句判断依据，显示在草稿顶上「按加菜处理 · 你点名了一道菜」 */
  reason: string;
  model: string;
}

export async function routeAiText(text: string): Promise<AiRouteResult> {
  const prompt = text.trim();
  if (prompt === '') throw badRequest('先说一句想做什么，例如「加个小炒肉」或「我有西红柿、土豆」');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw badRequest(`描述太长了（${MAX_PROMPT_LENGTH} 字以内），一句话就够`);
  }

  const raw = await chatJson<{ intent?: unknown; reason?: unknown }>({
    system: INTENT_SYSTEM_PROMPT,
    user: prompt,
    maxTokens: 80,
  });

  const intent: AiIntent = readString(raw.intent) === 'fridge' ? 'fridge' : 'dish';
  const reason = readString(raw.reason);
  // 分流结果进日志：判错时能对着原话复盘提示词，不用让用户复现
  log.info(`AI 分流 → ${intent}${reason ? `（${reason}）` : ''}｜${prompt.slice(0, 40)}`);
  return { intent, reason, model: llmModel() };
}
