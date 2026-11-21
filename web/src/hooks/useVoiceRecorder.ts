import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { toast } from '../components/ui/toast';
import { extensionForMime, MAX_VOICE_MS, PREFERRED_MIME_TYPES } from '../lib/voice';

/** 挑一个当前浏览器支持的录音格式；都不支持就交给 MediaRecorder 默认值 */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * 「按住说话」：按下开始录，松手（或到 10 秒）停止并上传转写。
 *
 * 录音只在内存里：stop 后立刻停掉麦克风轨道，Blob 交给 /api/voice/transcribe，
 * 不写 IndexedDB、不落盘，也不在组件外保留。
 */
export function useVoiceRecorder(onTranscribed: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  /** 「延迟露出录音态」的计时器：首页长按用，避免轻点闪一下红色录音按钮 */
  const revealTimerRef = useRef<number | null>(null);
  /** 手指还按着吗：等 getUserMedia 期间就松手的话，拿到流也直接放弃 */
  const heldRef = useRef(false);
  /** 上传中：避免连点重复转写 */
  const busyRef = useRef(false);
  /** 组件卸载（关弹层）时丢弃这次录音，不触发上传 */
  const discardRef = useRef(false);
  const mountedRef = useRef(true);
  const callbackRef = useRef(onTranscribed);

  useEffect(() => {
    callbackRef.current = onTranscribed;
  }, [onTranscribed]);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** 取消「延迟露出」：轻点松手后不能让 400ms 的定时器再把录音态点亮 */
  const clearReveal = () => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const finish = useCallback(async (recorder: MediaRecorder) => {
    clearTimer();
    clearReveal();
    releaseStream();
    recorderRef.current = null;
    heldRef.current = false;

    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (mountedRef.current) setRecording(false);

    // 极短的一次点按可能一个数据块都没有：按「没听清」处理，不浪费一次网关调用
    const type = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    if (blob.size === 0) {
      toast('没听清，再说一次，或者直接打字', 'error');
      return;
    }

    busyRef.current = true;
    if (mountedRef.current) setTranscribing(true);
    try {
      const { text } = await api.voice.transcribe(blob, `speech.${extensionForMime(type)}`);
      if (mountedRef.current) callbackRef.current(text);
    } catch (error) {
      // 服务端已按 401/413/415/429/502/504 翻译成给家人看的文案，这里直接展示
      toast(error instanceof Error ? error.message : '语音服务暂时不可用，可以直接打字', 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setTranscribing(false);
    }
  }, []);

  const stop = useCallback(() => {
    heldRef.current = false;
    clearReveal();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  /** 丢弃这次录音：停掉麦克风、不上传、不提示。轻点 AI 按钮时用 */
  const cancel = useCallback(() => {
    heldRef.current = false;
    clearReveal();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      discardRef.current = true;
      recorder.stop();
      return;
    }
    // 还在等 getUserMedia：heldRef 已置 false，拿到流之后 start 会自行释放
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
    if (mountedRef.current) setRecording(false);
  }, []);

  const start = useCallback(async ({ revealAfterMs = 0 }: { revealAfterMs?: number } = {}) => {
    if (heldRef.current || busyRef.current) return;
    heldRef.current = true;

    // getUserMedia 只在安全上下文可用：局域网 HTTP 地址在手机上会被浏览器禁掉
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      heldRef.current = false;
      toast('手机浏览器只允许在 HTTPS 下录音，请用 https:// 地址打开后再试', 'error');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      heldRef.current = false;
      toast('没拿到麦克风权限，允许后重试，或者直接打字', 'error');
      return;
    }
    // 等权限弹窗期间已经松手：别偷偷录
    if (!heldRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      heldRef.current = false;
      toast('这个浏览器不支持录音，可以直接打字', 'error');
      return;
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    discardRef.current = false;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      if (discardRef.current) {
        discardRef.current = false;
        clearTimer();
        clearReveal();
        releaseStream();
        recorderRef.current = null;
        chunksRef.current = [];
        heldRef.current = false;
        if (mountedRef.current) setRecording(false);
        return;
      }
      void finish(recorder);
    };

    recorder.start();
    if (revealAfterMs > 0) {
      // 首页长按：麦克风已经开了，但先不点亮录音态，避免轻点闪一下
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = null;
        if (mountedRef.current) setRecording(true);
      }, revealAfterMs);
    } else {
      setRecording(true);
    }
    // 硬上限：按满 10 秒自动结束，松不松手都一样
    timerRef.current = window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, MAX_VOICE_MS);
  }, [finish]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardRef.current = true;
      clearTimer();
      clearReveal();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      releaseStream();
      recorderRef.current = null;
      chunksRef.current = [];
    };
  }, []);

  /**
   * 切后台 / 来电 / 离开页面：直接丢弃正在录的这段并释放麦克风。
   * 只在「确实在录」时出手——首次授权弹窗也可能让页面失焦，那时 recorder
   * 还没建起来，不能误判成中断。
   */
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    const abort = (notify: boolean) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') return;
      cancelRef.current();
      if (notify) toast('录音已取消，需要时再按一次', 'info');
    };
    const onVisibility = () => {
      if (document.hidden) abort(true);
    };
    const onPageHide = () => abort(false);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  return { recording, transcribing, start, stop, cancel };
}

export type VoiceRecorder = ReturnType<typeof useVoiceRecorder>;
