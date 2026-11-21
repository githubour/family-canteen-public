/**
 * 语音转写入口。
 *
 *   POST /api/voice/transcribe   multipart/form-data（字段 `file`）→ { text }
 *
 * 浏览器只知道这一个地址；网关 token 与网关地址都留在服务端。
 * 录音只经过内存：不落盘、不入库、不写日志。
 *
 * 限流与 `/api/ai/*` 共用同一个 20 次/分钟/IP 的桶（lib/rateLimit.ts）。
 */
import { Readable } from 'node:stream';
import { Router } from 'express';
import type { Request } from 'express';
import { ApiError } from '../lib/errors.js';
import { createIpRateLimit } from '../lib/rateLimit.js';
import { isVoiceEnabled, transcribeAudio, VOICE_COPY } from '../services/voiceService.js';

export const voiceRouter = Router();

voiceRouter.use(
  createIpRateLimit({
    code: 'VOICE_RATE_LIMITED',
    message: () => VOICE_COPY.busy,
  }),
);

/** 10 秒 webm/opus 通常不到 200KB；8MB 足够兜住异常客户端，又不至于把内存吃穿 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function unrecognized(): ApiError {
  return new ApiError(400, 'VOICE_UNRECOGNIZED', VOICE_COPY.unrecognized);
}

function tooLarge(): ApiError {
  return new ApiError(413, 'VOICE_TOO_LONG', VOICE_COPY.tooLong);
}

/**
 * 用 Node 自带的 Request.formData 解析 multipart，不引入 multer / busboy：
 * 本项目的部署特性是「一个 Node 进程 + 一个 SQLite 文件」，能不加依赖就不加。
 */
async function readAudioFile(req: Request): Promise<File> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw unrecognized();

  const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw tooLarge();

  let form: FormData;
  try {
    form = await new Request('http://mealtime.local/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      // 流式请求体在 undici 里必须显式声明半双工
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }).formData();
  } catch {
    // multipart 边界损坏、请求体被截断等，都归到「没听清」
    throw unrecognized();
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) throw unrecognized();
  if (file.size > MAX_UPLOAD_BYTES) throw tooLarge();
  return file;
}

voiceRouter.post('/transcribe', async (req, res, next) => {
  try {
    // 没配 token 就不必把上传读进内存了；文案与 service 保持一致
    if (!isVoiceEnabled()) {
      throw new ApiError(503, 'VOICE_NOT_CONFIGURED', VOICE_COPY.unconfigured);
    }
    const text = await transcribeAudio(await readAudioFile(req));
    res.json({ text });
  } catch (error) {
    next(error);
  }
});
