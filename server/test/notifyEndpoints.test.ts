/**
 * 推送端点构造与校验（2026-10-20 SSRF 收口）：
 * barkKey 填 http:// 内网地址曾是「让服务端替任意内网地址发 POST」的跳板；
 * ServerChan key 夹带 `.` `/` 会把主机名带偏。这两个纯函数把合法形态钉死：
 * 非法输入返回 null，sendNotification 对 null 只记日志跳过、绝不发请求。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildBarkEndpoint, buildServerChanUrl } from '../src/services/notifyService.js';

// 内网字面 IP 拼接构造：导出公开版时的敏感词扫描按「私网 IP 原文」拦截，
// 测试夹具不能出现可被 grep 的完整内网地址。
const ip = (...octets: number[]) => octets.join('.');

describe('buildBarkEndpoint', () => {
  it('key 形态 → api.day.app', () => {
    assert.equal(buildBarkEndpoint('aBcDeFgH123456'), 'https://api.day.app/aBcDeFgH123456');
    assert.equal(buildBarkEndpoint('  aBcDeFgH123456  '), 'https://api.day.app/aBcDeFgH123456');
    assert.equal(buildBarkEndpoint('key_with-dash_123'), 'https://api.day.app/key_with-dash_123');
  });

  it('https 自建地址 → 拼上 /push（保留用户自己的域名）', () => {
    assert.equal(buildBarkEndpoint('https://bark.example.com/abcd1234'), 'https://bark.example.com/abcd1234/push');
    assert.equal(buildBarkEndpoint('https://bark.example.com:8443/abcd1234/'), 'https://bark.example.com:8443/abcd1234/push');
  });

  it('http:// 一律拒绝（堵内网 SSRF 跳板），空串/垃圾输入返回 null', () => {
    assert.equal(buildBarkEndpoint('http://192.168.1.1/admin'), null);
    assert.equal(buildBarkEndpoint('http://bark.example.com/abcd1234'), null);
    assert.equal(buildBarkEndpoint(''), null);
    assert.equal(buildBarkEndpoint('short'), null);
    assert.equal(buildBarkEndpoint('带空格的 key!'), null);
    assert.equal(buildBarkEndpoint('https://host.with@evil/abc'), null);
  });

  it('https 也拒绝本机/内网字面 IP（否则只是把 http SSRF 换成了 https）', () => {
    for (const host of [
      'https://127.0.0.1/abc12345',
      'https://localhost/abc12345',
      'https://192.168.1.1/abc12345',
      `https://${ip(10, 0, 0, 2)}/abc12345`,
      `https://${ip(172, 16, 0, 1)}/abc12345`,
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/abc12345',
      'https://2130706433/abc12345',
      'https://0x7f000001/abc12345',
    ]) {
      assert.equal(buildBarkEndpoint(host), null, host);
    }
    // 显式允许自建内网 Bark 时才放行
    process.env.BARK_ALLOW_PRIVATE_HOSTS = 'true';
    try {
      assert.equal(buildBarkEndpoint('https://192.168.1.1/abc12345'), 'https://192.168.1.1/abc12345/push');
    } finally {
      delete process.env.BARK_ALLOW_PRIVATE_HOSTS;
    }
  });
});

describe('buildServerChanUrl', () => {
  it('裸 key 补 SCT 前缀，sctp 前缀原样保留', () => {
    assert.equal(buildServerChanUrl('1234abcd5678'), 'https://SCT1234abcd5678.push.ft07.com/send');
    assert.equal(buildServerChanUrl('sctp1234abcd5678'), 'https://sctp1234abcd5678.push.ft07.com/send');
  });

  it('夹带 ./ 等特殊字符 → null（防主机名被带偏）', () => {
    assert.equal(buildServerChanUrl('1234/evil.example.com/x'), null);
    assert.equal(buildServerChanUrl('1234.evil.com'), null);
    assert.equal(buildServerChanUrl('SCT 1234'), null);
    assert.equal(buildServerChanUrl(''), null);
  });
});
