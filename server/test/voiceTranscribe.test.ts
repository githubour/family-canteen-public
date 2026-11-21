/**
 * 语音转写链路：multipart → 服务端转发 → 网关状态翻译 → 与 AI 共用限流桶。
 * 用本地假网关代替真语音服务，只验证自家这段代码，不依赖 NAS。
 *
 * 每个用例用独立 X-Forwarded-For 隔离限流桶（TRUST_PROXY=1 时 req.ip 取该头），
 * 共用桶的用例单独占一个 IP。
 */
import './setup.js';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { startTestServer, type TestServer } from './testServer.js';

process.env.TRUST_PROXY = '1';

interface Captured {
  authorization: string;
  contentType: string;
  body: string;
}

let gateway: Server | undefined;
let server: TestServer | undefined;
let base = '';
let captured: Captured | null = null;
let replyStatus = 200;
let replyBody = '{"text":"加个番茄炒蛋"}';

before(async () => {
  gateway = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured = {
        authorization: String(req.headers.authorization ?? ''),
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(replyStatus, { 'Content-Type': 'application/json' });
      res.end(replyBody);
    });
  });
  await new Promise<void>((resolve) => gateway?.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  if (!address || typeof address !== 'object') throw new Error('假网关没拿到端口');

  process.env.VOICEGW_URL = `http://127.0.0.1:${address.port}`;
  process.env.VOICEGW_TOKEN = 'test-token';

  server = await startTestServer();
  base = server.base;
});

after(() => {
  server?.close();
  gateway?.closeAllConnections();
  gateway?.close();
});

function postVoice(ip: string, type = 'audio/webm', bytes = new Uint8Array([1, 2, 3])): Promise<Response> {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type }), 'speech.webm');
  return fetch(`${base}/api/voice/transcribe`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    body,
  });
}

function postAi(ip: string): Promise<Response> {
  return fetch(`${base}/api/ai/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ text: '加个番茄炒蛋' }),
  });
}

describe('POST /api/voice/transcribe', () => {
  it('录音 → 网关 → 返回 text，且带 Bearer token 与 OpenAI 形状字段', async () => {
    captured = null;
    replyStatus = 200;
    replyBody = '{"text":"加个番茄炒蛋"}';

    const res = await postVoice('192.0.2.1');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: '加个番茄炒蛋' });

    const seen = captured as Captured | null;
    assert.ok(seen);
    assert.equal(seen.authorization, 'Bearer test-token');
    assert.match(seen.contentType, /^multipart\/form-data/);
    assert.match(seen.body, /filename="speech.webm"/);
    assert.match(seen.body, /name="model"[\s\S]*voicegw-stt/);
    assert.match(seen.body, /name="language"[\s\S]*zh-CN/);
    assert.match(seen.body, /name="response_format"[\s\S]*json/);
  });

  it('未配置 VOICEGW_TOKEN → 503，提示可以直接打字', async () => {
    process.env.VOICEGW_TOKEN = '';
    try {
      const res = await postVoice('192.0.2.2');
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'VOICE_NOT_CONFIGURED');
      assert.match(body.error.message, /直接打字/);
    } finally {
      process.env.VOICEGW_TOKEN = 'test-token';
    }
  });

  it('网关 200 但空文本 → 400「没听清」', async () => {
    replyStatus = 200;
    replyBody = '{"text":"   "}';
    const res = await postVoice('192.0.2.3');
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /没听清/);
  });

  // 上游状态码 → 自家状态码与文案
  const CASES: { upstream: number; ours: number; copy: RegExp }[] = [
    { upstream: 401, ours: 401, copy: /未授权/ },
    { upstream: 403, ours: 403, copy: /未授权/ },
    { upstream: 413, ours: 413, copy: /10 秒/ },
    { upstream: 400, ours: 400, copy: /没听清/ },
    { upstream: 415, ours: 400, copy: /没听清/ },
    { upstream: 429, ours: 429, copy: /等几秒/ },
    { upstream: 502, ours: 502, copy: /暂时不可用/ },
    { upstream: 504, ours: 504, copy: /暂时不可用/ },
  ];

  for (const item of CASES) {
    it(`网关 ${item.upstream} → ${item.ours}`, async () => {
      replyStatus = item.upstream;
      replyBody = '{"error":{"message":"upstream","type":"x","code":"y"}}';
      const res = await postVoice(`198.51.100.${item.upstream}`);
      assert.equal(res.status, item.ours);
      const body = (await res.json()) as { error: { message: string } };
      assert.match(body.error.message, item.copy);
    });
  }

  it('非 multipart 请求 → 400', async () => {
    const res = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.4' },
      body: '{}',
    });
    assert.equal(res.status, 400);
  });

  it('与 AI 路由共用 20 次/分/IP 的限流桶', async () => {
    const ip = '203.0.113.9';
    replyStatus = 200;
    replyBody = '{"text":"加个番茄炒蛋"}';

    for (let i = 0; i < 20; i += 1) {
      const res = i % 2 === 0 ? await postVoice(ip) : await postAi(ip);
      assert.notEqual(res.status, 429, `第 ${i + 1} 次不应被限流`);
      await res.arrayBuffer();
    }

    const limited = await postVoice(ip);
    assert.equal(limited.status, 429);
    const body = (await limited.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'VOICE_RATE_LIMITED');
  });
});
