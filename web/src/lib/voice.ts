/**
 * 语音输入的纯逻辑：录制上限与「MIME → 网关认的扩展名」。
 * 放在 lib 里是为了能直接测（不依赖 MediaRecorder / DOM）。
 */

/** 按住说话的硬上限：到点自动停，松不松手都结束 */
export const MAX_VOICE_MS = 10_000;

/** 依次尝试：Chrome/Android 用 webm-opus，Safari/iOS 只认 mp4 */
export const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** 服务端/网关按文件名后缀判断容器，Blob 的 MIME 决定我们该给什么后缀 */
export function extensionForMime(type: string): string {
  const mime = type.toLowerCase();
  // 注意顺序：`audio/webm;codecs=opus` 同时含 opus，必须先判 webm
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}
