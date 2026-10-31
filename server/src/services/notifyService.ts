/**
 * 手机推送通知（Bark / ServerChan）。
 * 约束：失败必须静默降级，绝不能影响下单主流程；因此全程 try/catch + 超时。
 */
import { readSetting } from './settingsService.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('notify');
const TIMEOUT_MS = 5000;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) log.warn(`推送返回 ${response.status}`);
  } catch (error) {
    log.error('推送失败（已忽略，不影响业务流程）', error);
  } finally {
    clearTimeout(timer);
  }
}

interface OrderNotification {
  title: string;
  body: string;
  url?: string;
}


/** 是否是内网/回环/链路本地主机名；SSRF 收口用。字面 IP 与 localhost 直接拦。 */
function isPrivateBarkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // 单标签主机名（含 2130706433 这类十进制 IP、0x7f000001 这类十六进制写法）不是公网域名
  if (!host.includes('.') && !host.includes(':')) return true;

  const mapped = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  const ipv4 = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }

  // IPv6 回环 / 唯一本地地址（fc00::/7）/ 链路本地（fe80::/10）
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

/**
 * 构造并校验 Bark 推送端点（纯函数，供单测）：
 * - key 形态（字母/数字/下划线/连字符，≥8 位）→ https://api.day.app/<key>
 * - 自建地址只接受 https + 正常 host(:port)/path —— 明确拒绝 http://；
 *   默认也拒绝 localhost / 内网字面 IP（阻断「设置里填个 https://192.168.1.1/... 让服务端
 *   替任意内网地址发 POST」）。确实要连自建内网 Bark 时，显式设 BARK_ALLOW_PRIVATE_HOSTS=true。
 * - 非法输入一律返回 null，调用方跳过推送
 *
 * 说明：这里不解析 DNS，域名指向内网 IP 的变体仍可能绕过；要彻底防住需在发送前解析并校验 IP。
 */
export function buildBarkEndpoint(rawKey: string): string | null {
  const trimmed = rawKey.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (/^https:\/\//.test(trimmed)) {
    const ok = /^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(:\d{1,5})?(\/[a-zA-Z0-9._~_-]+)+$/.test(trimmed);
    if (!ok) return null;
    const allowPrivate = (process.env.BARK_ALLOW_PRIVATE_HOSTS ?? '').trim().toLowerCase() === 'true';
    if (!allowPrivate && isPrivateBarkHost(new URL(trimmed).hostname)) return null;
    return `${trimmed}/push`;
  }
  if (/^http:/i.test(trimmed)) return null;
  return /^[a-zA-Z0-9_-]{8,}$/.test(trimmed) ? `https://api.day.app/${trimmed}` : null;
}

/**
 * 构造并校验 ServerChan 发送地址（纯函数，供单测）：
 * key 只认 SCT/sctp 前缀的字母数字串 —— key 里夹带 `.` `/` 会把主机名带偏（SSRF），
 * 一律返回 null。
 */
export function buildServerChanUrl(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  const sendKey = trimmed.startsWith('sctp') ? trimmed : `SCT${trimmed}`;
  if (!/^(SCT|sctp)[a-zA-Z0-9]+$/.test(sendKey)) return null;
  return `https://${sendKey}.push.ft07.com/send`;
}

/** 触发通知；enabled 未开启或未配置 key 时直接跳过 */
export async function sendNotification(message: OrderNotification): Promise<void> {
  // 设置值的首尾空白在粘贴 key 时很容易带上，统一在这里清掉
  if (readSetting('notify.enabled').trim() !== 'true') return;

  const barkKey = readSetting('notify.barkKey').trim();
  const serverchanKey = readSetting('notify.serverchanKey').trim();

  const tasks: Promise<void>[] = [];

  const barkEndpoint = buildBarkEndpoint(barkKey);
  if (barkKey && barkEndpoint === null) {
    // 配置不合法（http 内网地址 / 夹带特殊字符）：宁可跳过推送也不替它发请求
    log.warn('Bark key 配置不合法，已跳过推送（只接受 key 或 https 自建地址）');
  }
  if (barkEndpoint) {
    tasks.push(
      postJson(barkEndpoint, {
        title: message.title,
        body: message.body,
        group: '今日菜单',
        icon: 'https://api.day.app/icon/icon.png',
        level: 'active',
        sound: 'bell',
      }),
    );
  }

  const serverChanUrl = buildServerChanUrl(serverchanKey);
  if (serverchanKey && serverChanUrl === null) {
    log.warn('ServerChan key 配置不合法，已跳过推送（只认 SCT/sctp 前缀的字母数字串）');
  }
  if (serverChanUrl) {
    tasks.push(
      postJson(serverChanUrl, {
        title: message.title,
        desp: message.body,
      }),
    );
  }

  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}
