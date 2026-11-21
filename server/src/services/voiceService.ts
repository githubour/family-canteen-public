/**
 * 语音转写服务：把浏览器录的一小段音频转给语音网关（OpenAI 形状的
 * `POST /v1/audio/transcriptions`），只返回文字，不落盘、不入库。
 *
 * 为什么由服务端转发而不是浏览器直连网关：
 *   1. 网关 token 只放在容器环境变量 `VOICEGW_TOKEN` 里，永远不进浏览器；
 *   2. 浏览器同源调用 `/api/voice/transcribe`，没有 CORS 与混合内容问题；
 *   3. 网关的错误体（401/413/415/429/502/504）在这里统一翻译成给家人看的中文，
 *      前端只负责展示，不需要认识上游的状态码。
 *
 * 环境变量：
 *   VOICEGW_TOKEN  必填；为空 = 走「未配置」分支，返回 503，主流程零影响
 *   VOICEGW_URL    默认 http://192.168.1.10:8644（NAS 上的语音网关）
 */
import { ApiError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('voice');

const DEFAULT_BASE_URL = 'http://192.168.1.10:8644';
/** 10 秒音频本身只有几十 KB，给足网关排队 + 转码 + 上游重试的余量 */
const TIMEOUT_MS = 30_000;

/** 所有给用户看的文案集中在这里：路由与前端都不用再各写一份 */
export const VOICE_COPY = {
  unconfigured: '语音服务暂时不可用，可以直接打字',
  unauthorized: '语音服务未授权，请联系维护者',
  tooLong: '说话太长了，10 秒以内再说一次',
  unrecognized: '没听清，再说一次，或者直接打字',
  busy: '语音服务忙，等几秒再试',
  unavailable: '语音服务暂时不可用，可以直接打字',
} as const;

/** 配了 token 才认为可用；否则按钮仍在，但点按后会得到「暂时不可用」 */
export function isVoiceEnabled(): boolean {
  return (process.env.VOICEGW_TOKEN ?? '').trim().length > 0;
}

function baseUrl(): string {
  return ((process.env.VOICEGW_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** 网关按文件名后缀判断容器格式，这里只挑它认的扩展名 */
const CONTAINERS = new Set(['wav', 'mp3', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm', 'flac']);

export function containerFor(file: File): string {
  const fromName = (file.name.split('.').pop() ?? '').toLowerCase();
  if (CONTAINERS.has(fromName)) return fromName;
  const type = file.type.toLowerCase();
  // 注意顺序：`audio/webm;codecs=opus` 同时含 opus，必须先判 webm
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg') || type.includes('opus')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return 'webm';
}

function unavailable(message: string): ApiError {
  return new ApiError(502, 'VOICE_UPSTREAM_UNAVAILABLE', message);
}

/** 日志里只写格式/体积线索，不写音频内容，也不写 token */
function describeAudio(file: File): string {
  return `mime=${file.type || 'unknown'} bytes=${file.size} container=${containerFor(file)}`;
}

/** 取网关错误正文里的 message（截断），方便定位 415 具体是格式还是解码失败 */
async function readUpstreamMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } };
    const message = payload.error?.message;
    return typeof message === 'string' ? message.trim().slice(0, 200) : '';
  } catch {
    return '';
  }
}

/** 把网关状态码翻译成前端约定的那套文案；未知状态一律按「暂时不可用」 */
function fromUpstreamStatus(status: number): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError(status, 'VOICE_UNAUTHORIZED', VOICE_COPY.unauthorized);
  }
  if (status === 413) return new ApiError(413, 'VOICE_TOO_LONG', VOICE_COPY.tooLong);
  if (status === 429) return new ApiError(429, 'VOICE_BUSY', VOICE_COPY.busy);
  if (status === 504) return new ApiError(504, 'VOICE_UPSTREAM_TIMEOUT', VOICE_COPY.unavailable);
  if (status === 400 || status === 415) {
    return new ApiError(400, 'VOICE_UNRECOGNIZED', VOICE_COPY.unrecognized);
  }
  return unavailable(VOICE_COPY.unavailable);
}

/**
 * 转发一段录音并返回转写文字。
 * 失败抛 ApiError（由 app.ts 统一转 JSON）；成功返回非空字符串。
 */
export async function transcribeAudio(file: File): Promise<string> {
  const token = (process.env.VOICEGW_TOKEN ?? '').trim();
  if (token === '') {
    throw new ApiError(503, 'VOICE_NOT_CONFIGURED', VOICE_COPY.unconfigured);
  }

  const form = new FormData();
  // 复用收到的 File：字节不动，只把文件名规范化成网关认的扩展名
  form.append('file', file, `speech.${containerFor(file)}`);
  form.append('model', 'voicegw-stt');
  form.append('language', 'zh-CN');
  form.append('response_format', 'json');

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      log.warn(`语音网关超时 ${describeAudio(file)}`);
      throw new ApiError(504, 'VOICE_UPSTREAM_TIMEOUT', VOICE_COPY.unavailable);
    }
    log.warn(`语音网关不可达 ${describeAudio(file)}`);
    throw unavailable(VOICE_COPY.unavailable);
  }

  if (!response.ok) {
    // 不记录音频内容与 token，只记录格式线索和网关自己给的错误原因
    const detail = await readUpstreamMessage(response);
    log.warn(
      `语音网关返回 HTTP ${response.status} ${describeAudio(file)}${detail ? ` upstream=${detail}` : ''}`,
    );
    throw fromUpstreamStatus(response.status);
  }

  let payload: { text?: unknown };
  try {
    payload = (await response.json()) as { text?: unknown };
  } catch {
    log.warn(`语音网关返回了非 JSON 内容 ${describeAudio(file)}`);
    throw unavailable(VOICE_COPY.unavailable);
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  // 网关 200 但空文本（纯静音/噪音）也按「没听清」处理
  if (text === '') throw new ApiError(400, 'VOICE_UNRECOGNIZED', VOICE_COPY.unrecognized);
  return text;
}
