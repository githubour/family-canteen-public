/**
 * 用 Canvas 生成可保存/转发的海报图。
 * 采购清单和大厨菜单都需要「一眼能看、能直接发微信」的形态，纯文本不够，
 * 因此这里手绘一张暖色系图片，不依赖任何外部服务。
 */

interface PosterSection {
  heading: string;
  rows: string[];
}

interface PosterOptions {
  title: string;
  subtitle: string;
  sections: PosterSection[];
  footer?: string;
}

const WIDTH = 720;
const PADDING = 40;

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    const next = current + char;
    if (ctx.measureText(next).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function buildPoster(options: PosterOptions): string {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const contentWidth = WIDTH - PADDING * 2;
  const font = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  ctx.font = `500 26px ${font}`;
  const prepared = options.sections.map((section) => ({
    heading: section.heading,
    rows: section.rows.flatMap((row) => wrapLines(ctx, row, contentWidth - 26)),
  }));

  const headerHeight = 168;
  const bodyHeight = prepared.reduce((sum, section) => sum + 46 + section.rows.length * 40 + 14, 0);
  const footerHeight = options.footer ? 72 : 32;
  const height = headerHeight + bodyHeight + footerHeight;

  canvas.width = WIDTH;
  canvas.height = height;

  // 背景
  ctx.fillStyle = '#FFF8F3';
  ctx.fillRect(0, 0, WIDTH, height);

  // 顶部渐变头
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, headerHeight);
  gradient.addColorStop(0, '#FF8A3D');
  gradient.addColorStop(1, '#F0521B');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, headerHeight);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 40px ${font}`;
  ctx.fillText(options.title, PADDING, 76);

  ctx.globalAlpha = 0.85;
  ctx.font = `400 24px ${font}`;
  ctx.fillText(options.subtitle, PADDING, 120);
  ctx.globalAlpha = 1;

  let y = headerHeight + 34;

  for (const section of prepared) {
    ctx.fillStyle = '#FF6B35';
    ctx.font = `600 28px ${font}`;
    ctx.fillText(section.heading, PADDING, y);
    y += 16;

    ctx.fillStyle = '#EADFD6';
    ctx.fillRect(PADDING, y + 4, contentWidth, 2);
    y += 34;

    ctx.fillStyle = '#1F1B18';
    ctx.font = `400 25px ${font}`;
    for (const row of section.rows) {
      ctx.fillText(row, PADDING + 6, y);
      y += 40;
    }
    y += 14;
  }

  if (options.footer) {
    ctx.fillStyle = '#9C948C';
    ctx.font = `400 21px ${font}`;
    ctx.fillText(options.footer, PADDING, y + 18);
  }

  // 底部品牌条
  ctx.fillStyle = '#F5EDE6';
  ctx.fillRect(0, height - 6, WIDTH, 6);

  return canvas.toDataURL('image/png');
}

export function downloadPoster(dataUrl: string, filename: string): void {
  if (!dataUrl) return;
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

/** 复制文本到剪贴板，失败时回退到 execCommand，保证微信粘贴可用 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      (error: unknown) => {
        console.error('[poster] 剪贴板写入失败', error);
        return fallbackCopy(text);
      },
    );
  }
  return fallbackCopy(text);
}

function fallbackCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  return ok;
}
