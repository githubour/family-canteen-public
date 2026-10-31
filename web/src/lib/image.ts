/**
 * 上传前的本地压缩：最长边压到 maxDim、转 JPEG（透明图会先铺白底）。
 * 家里拍一张原图动辄 3-5MB，直接传既慢又占空间；压完通常 60-120KB，
 * 卡片 104px 高、详情弹窗也才几十像素，720px 足够 2 倍屏清晰度。
 */
export async function resizeToDataUrl(file: File, maxDim = 720, quality = 0.82): Promise<string> {
  const bitmap = await loadImage(file);

  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持图片处理');
  // JPEG 没有透明通道：先铺白底，避免 PNG 截图压出来一块黑
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  if (dataUrl.length > 4 * 1024 * 1024) {
    // 极少数超大图压完仍超服务端护栏：降一档质量再压一次
    return canvas.toDataURL('image/jpeg', 0.65);
  }
  return dataUrl;
}

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap 会按 EXIF 方向解码（手机竖拍照片不会躺倒）；老浏览器回退 <img>
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // 继续走 <img> 兜底
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('这张图读不出来，换一张试试'));
      image.src = url;
    });
    return image;
  } finally {
    // <img> 已完成解码后再 revoke 也不影响绘制
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
