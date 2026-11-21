/**
 * 语音输入的纯函数：Blob 的 MIME 决定交给网关的文件后缀。
 * 选错后缀会被网关按 415 拒掉，所以把 webm / mp4 / ogg 的边界钉住。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extensionForMime, MAX_VOICE_MS } from '../src/lib/voice';

describe('语音录音', () => {
  it('硬上限是 10 秒', () => {
    assert.equal(MAX_VOICE_MS, 10_000);
  });

  it('MIME → 网关认的后缀（opus 同时出现在 webm 与 ogg 里，先判 webm）', () => {
    assert.equal(extensionForMime('audio/webm;codecs=opus'), 'webm');
    assert.equal(extensionForMime('audio/webm'), 'webm');
    assert.equal(extensionForMime('audio/mp4'), 'm4a');
    assert.equal(extensionForMime('audio/mp4;codecs=mp4a.40.2'), 'm4a');
    assert.equal(extensionForMime('audio/ogg;codecs=opus'), 'ogg');
    assert.equal(extensionForMime('audio/wav'), 'wav');
    assert.equal(extensionForMime('audio/mpeg'), 'mp3');
    // 认不出来时退回 webm，而不是把空后缀交给网关
    assert.equal(extensionForMime(''), 'webm');
    assert.equal(extensionForMime('application/octet-stream'), 'webm');
  });
});
