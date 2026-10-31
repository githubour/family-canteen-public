import type { ReactNode } from 'react';

/** 设置项外壳：标题 + 说明 + 内容。基本 / 通知两个页签共用，保证间距与字号一致 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-xl2 border border-cream-300 bg-white p-3.5">
      <p className="text-[14px] font-semibold">{label}</p>
      {hint ? <p className="mb-2 text-[11px] text-ink-400">{hint}</p> : <div className="h-2" />}
      {children}
    </div>
  );
}
