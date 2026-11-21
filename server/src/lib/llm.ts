/**
 * 大语言模型（DeepSeek，OpenAI 兼容格式）最小客户端。
 *
 * 三条与项目边界一致的取舍：
 * 1. **不加 SDK 依赖**：一次 `chat/completions` 用内置 fetch 就够了，
 *    守住「一个 Node 进程 + 一个 SQLite 文件」这条线（也多一个包都没装）。
 * 2. **未配置即整体关闭**：没有 DEEPSEEK_API_KEY 时 isLlmEnabled() 为 false，
 *    前端直接隐藏入口，点菜 / 下单 / 采购等主流程零影响——与 Bark / Server酱 的降级方式一致。
 * 3. **失败只影响当前这次请求**：抛 ApiError，由 app.ts 的错误中间件转成 JSON。
 *    模型抽风绝不拖慢或打断任何写操作（写操作本来也不在这里，见 aiService 的「只产草稿」）。
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY  必填；不填 = 功能整体关闭
 *   AI_MODEL          默认 deepseek-flash（加菜是填空式任务，快模型足够且省钱）
 *   AI_BASE_URL       默认 https://api.deepseek.com
 *   AI_ENABLED=false  强制关闭（即使配了 key）
 */
import { ApiError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('llm');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';
/** 加菜这类任务模型通常几秒返回；给足余量，但别让前端无限转圈 */
const TIMEOUT_MS = 45_000;
/** 空 content 是 DeepSeek JSON Output 的已知毛病，重试一次比把错直接丢给用户划算 */
const MAX_ATTEMPTS = 2;

export function llmModel(): string {
  return (process.env.AI_MODEL ?? '').trim() || DEFAULT_MODEL;
}

/** AI 功能是否可用：配了 key 且没被显式关闭 */
export function isLlmEnabled(): boolean {
  if (process.env.AI_ENABLED === 'false') return false;
  return (process.env.DEEPSEEK_API_KEY ?? '').trim().length > 0;
}

export interface ChatJsonOptions {
  /** 必须包含 "json" 字样并给出输出样例：DeepSeek 的 JSON Output 对提示词有这个硬要求 */
  system: string;
  user: string;
  maxTokens?: number;
  /** 默认 0.2：加菜是「按规则填空」，稳定压倒创造力 */
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // AbortSignal.timeout 触发时名字是 TimeoutError，中文说人话
    return error.name === 'TimeoutError' ? '等待模型超时' : error.message;
  }
  return String(error);
}

/** 读服务端返回的错误说明（DeepSeek 会带 { error: { message } }），截断后拼进提示里 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return '';
    const parsed = JSON.parse(text) as ChatCompletionResponse;
    const message = parsed.error?.message ?? text;
    return `：${String(message).slice(0, 120)}`;
  } catch {
    return '';
  }
}

/** 模型调用失败统一回 503：对前端来说「稍后再试」是唯一正确的动作 */
function unavailable(message: string): ApiError {
  return new ApiError(503, 'AI_UNAVAILABLE', message);
}

/**
 * 调一次 chat/completions 并把 content 当 JSON 解析后返回。
 *
 * 走 JSON Output（`response_format: json_object`）而不是 function calling：
 * 前者是文档明确支持的，且我们只要一份结构化对象，少一层不确定性。
 * 重试覆盖三类「换一次就可能好」的失败：网络/超时、5xx 与 429、以及解析不出 JSON。
 * 4xx（除 429）说明是我们自己的请求写错了，重试没有意义，直接抛。
 */
export async function chatJson<T>(options: ChatJsonOptions): Promise<T> {
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!isLlmEnabled() || apiKey === '') {
    throw unavailable('AI 功能没有开启（服务端缺 DEEPSEEK_API_KEY）');
  }

  const baseUrl = ((process.env.AI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const body = {
    model: llmModel(),
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ],
    response_format: { type: 'json_object' },
    max_tokens: options.maxTokens ?? 2000,
    temperature: options.temperature ?? 0.2,
    stream: false,
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        if (response.status < 500 && response.status !== 429) {
          throw unavailable(`模型服务拒绝了这次请求（HTTP ${response.status}）${detail}`);
        }
        lastError = new Error(`HTTP ${response.status}${detail}`);
      } else {
        const payload = (await response.json()) as ChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content ?? '';
        if (content.trim() === '') {
          // 已知行为：JSON Output 有概率返回空 content，重试一次
          lastError = new Error('模型返回了空内容');
        } else {
          try {
            return JSON.parse(content) as T;
          } catch {
            lastError = new Error('模型返回的不是合法 JSON');
          }
        }
      }
    } catch (error) {
      // 上面主动抛出的 ApiError 不要重试
      if (error instanceof ApiError) throw error;
      lastError = error;
    }
    if (attempt < MAX_ATTEMPTS) log.warn(`第 ${attempt} 次调用失败，重试一次：${describe(lastError)}`);
  }

  log.error('调用模型失败', lastError);
  throw unavailable(`模型没能给出可用结果（${describe(lastError)}），稍后再试`);
}
