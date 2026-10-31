import { useRef } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { Dish } from '../api/types';
import { DishPanelShell } from './DishPanelShell';
import { Button } from './ui/base';
import { useDishPatch } from '../hooks/useDishPatch';
import { resizeToDataUrl } from '../lib/image';

/**
 * 菜品实拍图：选完图在本地压好直接上传，不需要「预览 → 确认」两步——
 * 选错再换一张就是了。没有图的菜继续用 emoji，谁也不受影响。
 */
export function DishPhotoEditor({ dish, onUpdated }: { dish: Dish; onUpdated?: (dish: Dish) => void }) {
  const { current, busy, patch } = useDishPatch(dish, onUpdated);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await patch(
        async () => {
          const dataUrl = await resizeToDataUrl(file);
          return api.dishes.uploadPhoto(current.id, dataUrl);
        },
        { error: '没传上，请重试', success: () => `已给「${current.name}」换上实拍图` },
      );
    } finally {
      // 同一张图再选一次也要触发 change：用完就清空
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = () =>
    patch(() => api.dishes.removePhoto(current.id), {
      error: '没移除，请重试',
      success: () => `已移除「${current.name}」的实拍图`,
    });

  return (
    <DishPanelShell icon={<ImageUp size={14} className="text-brand-500" />} title="实拍图">
      <div className="mt-2.5 flex items-center gap-3">
        {current.image_url ? (
          <img
            src={current.image_url}
            alt={current.name}
            decoding="async"
            className="h-20 w-20 shrink-0 rounded-xl2 object-cover"
          />
        ) : (
          <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl2 bg-linear-to-br from-cream-200 to-brand-50 text-[34px]">
            {current.emoji}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="soft" disabled={busy} onClick={() => fileInput.current?.click()}>
              <ImageUp size={13} />
              {current.image_url ? '换一张' : '上传照片'}
            </Button>
            {current.image_url ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
                <Trash2 size={13} />
                移除
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-[11px] leading-4 text-ink-400">
            做好了这道菜拍一张，点菜页的卡片就会用实拍图代替 emoji。
            <br />
            上传前会自动压到 720px（约几十 KB），手机相册原图也不怕。
          </p>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
    </DishPanelShell>
  );
}
