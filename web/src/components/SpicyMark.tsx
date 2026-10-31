export function SpicyMark({ spicy }: { spicy: number }) {
  if (spicy <= 0) return <span className="shrink-0 text-[10px] text-ink-200">不辣</span>;
  return (
    <span className="shrink-0 text-[11px] leading-5" title={`辣度 ${spicy}`}>
      {'🌶️'.repeat(Math.min(spicy, 3))}
    </span>
  );
}
